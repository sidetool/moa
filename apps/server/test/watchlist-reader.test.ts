import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { WatchlistReader } from '../src/profiles/watchlist.js';
import { buildApp } from '../src/app.js';

async function fixture(t: TestContext) {
  const dir=await mkdtemp(path.join(tmpdir(),'moa-watchlist-reader-'));
  const db=new Store(dir,new DatabaseSync(':memory:'));
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  for(const id of ['viewer','other','kids'])db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',Number(id==='kids'),'2026');
  const reader=new WatchlistReader(db);
  const add=(id:string,profile='viewer',rating?:string)=>{
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,id,'anime',JSON.stringify({url:'https://private.example/video',headers:{Cookie:'not-for-plugins'}}),'2026');
    db.run('INSERT INTO watchlist VALUES(?,?,?)',profile,id,'2026-10-11T00:00:00.000Z');
    if(rating){const n=db.get('SELECT COUNT(*) AS n FROM tmdb_titles')!.n+1;
      db.run("INSERT INTO tmdb_links(media_id,kind,tmdb_id,status,checked_at) VALUES(?,'tv',?,'manual',1)",id,n);
      db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)','tv',n,JSON.stringify({certification:rating}),'{}',1);
    }
  };
  return {db,reader,add};
}

test('watchlist pages isolate profiles, preserve tied ordering and reveal only the read contract',async t=>{
  const {reader,add}=await fixture(t);
  for(const id of ['a','b','c'])add(id);
  add('foreign','other');
  const first=reader.list('viewer',{limit:2});
  assert.deepEqual(first.items.map(r=>r.mediaId),['c','b']);
  assert.deepEqual(first.items[0],{mediaId:'c',title:'c',type:'anime',addedAt:'2026-10-11T00:00:00.000Z'});
  const next=reader.list('viewer',{limit:2,cursor:first.nextCursor!});
  assert.deepEqual(next.items.map(r=>r.mediaId),['a']);assert.equal(next.nextCursor,null);
  assert.deepEqual(reader.list('other').items.map(r=>r.mediaId),['foreign']);
  assert.deepEqual(reader.list('viewer',{since:'2026-10-10T23:30:00-02:00'}).items,[],'compare timestamps in UTC, not the input offset');
  const offsetPage=reader.list('viewer',{limit:1,since:'2026-10-11T09:00:00+09:00'});
  assert.equal(reader.list('viewer',{cursor:offsetPage.nextCursor!,since:'2026-10-11T00:00:00Z'}).items.length,2);
  assert.throws(()=>reader.list('other',{cursor:first.nextCursor!}),{error:'watchlist-changed'});
  for(const query of [{limit:101},{limit:0},{limit:1.5},{since:'invalid'},{cursor:'garbage'},{profile:'other'},[]])assert.throws(()=>reader.list('viewer',query as any),{statusCode:400});
});

test('watchlist revision expires cursors on edits and deletion, independently of other profiles',async t=>{
  const {db,reader,add}=await fixture(t);add('a');add('b');
  const first=reader.list('viewer',{limit:1});add('other','other');
  assert.equal(reader.list('viewer').revision,first.revision);
  db.run("UPDATE watchlist SET added_at='2026-10-12' WHERE media_id='a'");
  assert.throws(()=>reader.list('viewer',{cursor:first.nextCursor!}),{error:'watchlist-changed'});
  const second=reader.list('viewer',{limit:1});
  db.run("DELETE FROM media WHERE id='b'");
  assert.notEqual(reader.list('viewer').revision,second.revision);
  assert.deepEqual(reader.list('viewer').items.map(r=>r.mediaId),['a']);
  db.run("DELETE FROM profiles WHERE id='viewer'");
  assert.deepEqual(reader.list('viewer').items,[]);
});

test('kids watchlist skips forbidden pages and seeds without disclosing unsafe titles',async t=>{
  const {reader,add}=await fixture(t);add('z-adult','kids','19');add('y-unknown','kids');add('a-safe','kids','ALL');
  const first=reader.list('kids',{limit:2});assert.deepEqual(first.items,[]);assert.ok(first.nextCursor);
  const second=reader.list('kids',{cursor:first.nextCursor!});assert.deepEqual(second.items.map(r=>r.mediaId),['a-safe']);
  assert.deepEqual(second.items[0].tmdb,{kind:'tv',id:2});
  assert.deepEqual(reader.recent('kids').map(r=>r.id),['a-safe']);
});

test('plugin watchlist endpoint checks permission, package revision, revocation, ownership and lock', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-watchlist-endpoint-'));
  const store = new Store(dir, new DatabaseSync(':memory:'));
  const { app, db } = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web'), requireAccount: true }, false, { store, tmdb: { token: '', key: '' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' };
  const create = async (pin?: string) => (await app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Viewer', ...(pin ? { pin } : {}) } })).json().id;
  const profile = await create(), other = await create(), locked = await create('1234');
  const headers = { ...admin, 'x-moa-profile': profile };
  db.run("INSERT INTO media VALUES('m',NULL,'Private','movie','{}','2026')");
  db.run("INSERT INTO episodes VALUES('e','m',1,1,'Episode',1200,NULL)");
  db.run('INSERT INTO watchlist VALUES(?,?,?)', profile, 'm', '2026-10-10');
  const pkg = { id: 'watchlist-test', name: 'History test', version: '1.0.0', description: '', apiVersion: 1, placements: ['home'], permissions: [] as string[], connect: [], script: 'void 0;' };
  const install = async (permissions: string[]) => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...pkg, permissions } });
    assert.equal(r.statusCode, 200, r.body); return r.json().revision;
  };
  let revision = await install(['history.read']);
  const request = (h = headers, payload: object = { revision }) => app.inject({ method: 'POST', url: '/api/plugin-runtime/watchlist-test/watchlist', headers: h, payload });
  assert.equal((await request()).json().error, 'plugin-permission-denied');
  const stale = revision; revision = await install(['watchlist.read']);
  assert.equal((await request(headers, { revision: stale })).json().error, 'plugin-updated');
  const result = await request(); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['cache-control'], 'private, no-store'); assert.deepEqual(result.json().items.map((r: any) => r.mediaId), ['m']);
  assert.deepEqual((await request({ ...headers, 'x-moa-profile': other })).json().items, []);
  assert.equal((await request({ ...headers, 'x-moa-account': 'foreign' })).json().error, 'profile-required');
  assert.equal((await request({ ...headers, 'x-moa-profile': locked })).json().error, 'profile-locked');
  assert.equal((await request(headers, { revision, query: { profile: other } })).statusCode, 400);
  revision = await install([]); assert.equal((await request()).json().error, 'plugin-permission-denied');
  await app.inject({ method: 'PATCH', url: '/api/admin/plugins/watchlist-test', headers: admin, payload: { enabled: false } });
  assert.equal((await request()).json().error, 'plugin-not-found');
});
