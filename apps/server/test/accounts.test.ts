import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';

test('account boundaries, legacy claim, avatars, profile limits and admin routes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-accounts-'));
  const mediaRoot = path.join(dir, 'media'); await mkdir(mediaRoot);
  const old = new DatabaseSync(path.join(dir, 'moa.db'));
  old.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,kids INTEGER NOT NULL,created_at TEXT NOT NULL); INSERT INTO profiles VALUES('legacy','Legacy','blue',0,'2026');"); old.close();
  const { app, db, playback, remotePlayback, online } = await buildApp({ dataDir: dir, mediaRoot, webDir: path.join(dir, 'web'), requireAccount: true }, false,
    { aniSkip: { async lookup() { return { match: null, intervals: [], markers: null }; } } });
  const admin = { 'x-moa-account': 'admin-id', 'x-moa-role': 'admin', 'x-moa-username': encodeURIComponent('관리자') };
  const member = { 'x-moa-account': 'member-id', 'x-moa-role': 'member', 'x-moa-username': 'member', 'x-moa-permissions': 'video.watch,subtitles.add,subtitles.translate' };
  const second = { 'x-moa-account': 'second-id', 'x-moa-role': 'admin' };
  try {
    assert.equal((await app.inject('/api/profiles')).statusCode, 401);
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/%61pi/me')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/%61pi/library/scan' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/%61pi/library/scan', headers: member })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: '/api/profiles', headers: member })).json(), []);
    assert.equal(db.get("SELECT account_id FROM profiles WHERE id='legacy'")!.account_id, null);
    assert.deepEqual((await app.inject({ url: '/api/me', headers: admin })).json(), { id: 'admin-id', username: '관리자', role: 'admin', permissions: ['video.watch', 'subtitles.add', 'subtitles.translate'] });
    assert.equal((await app.inject({ url: '/api/profiles', headers: admin })).json()[0].id, 'legacy');
    assert.deepEqual((await app.inject({ url: '/api/profiles', headers: second })).json(), []);
    const create = (avatar: string | null) => app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Member', avatar } });
    for (const avatar of ['av-001', 'Cat-1', '../cat-1', 'cat', 'cat-1<script>']) assert.equal((await create(avatar)).statusCode, 400);
    const p = (await create('cat-1')).json(); assert.equal(p.avatar, 'cat-1');
    const h = { ...member, 'x-moa-profile': p.id };
    const restricted = { ...h, 'x-moa-permissions': '' };
    assert.deepEqual((await app.inject({ url: '/api/me', headers: restricted })).json().permissions, []);
    assert.equal((await app.inject({ url: '/api/me', headers: { ...h, 'x-moa-permissions': 'admin' } })).statusCode, 401);
    for (const [permission, url] of [['video.watch', '/api/playback'], ['subtitles.add', '/api/subtitles/import'], ['subtitles.add', '/api/episodes/e/subtitles/online'], ['subtitles.translate', '/api/episodes/e/subtitles/translate'], ['subtitles.translate', '/api/episodes/e/subtitles/jimaku/translate'], ['subtitles.translate', '/api/translations/job/priority']]) {
      const denied = await app.inject({ method: 'POST', url, headers: restricted, payload: {} });
      assert.equal(denied.statusCode, 403, url); assert.equal(denied.json().error, 'permission-denied');
      assert.notEqual((await app.inject({ method: 'POST', url, headers: { ...h, 'x-moa-permissions': permission }, payload: {} })).statusCode, 403, url);
    }
    assert.equal((await app.inject({ url: '/api/settings', headers: restricted })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/%70layback', headers: restricted, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/profiles/${p.id}`, headers: member, payload: { avatar: 'robot-2' } })).json().avatar, 'robot-2');
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/profiles/${p.id}`, headers: member, payload: { avatar: null } })).json().avatar, null);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/profiles/${p.id}`, headers: member, payload: { avatar: 'bad' } })).statusCode, 400);
    for (const method of ['PATCH','DELETE'] as const) assert.equal((await app.inject({ method, url: '/api/profiles/legacy', headers: member, ...(method === 'PATCH' ? { payload: { name: 'stolen' } } : {}) })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/settings', headers: { ...member, 'x-moa-profile': 'legacy' } })).statusCode, 401);
    const creates = await Promise.all(Array.from({ length: 5 }, () => create(null)));
    assert.equal(creates.filter(r => r.statusCode === 201).length, 4);
    assert.deepEqual(creates.find(r => r.statusCode === 409)!.json(), { error: 'profile-limit' });
    assert.equal((await app.inject({ url: '/api/admin/remote-access', headers: admin })).json().available, false);
    const adminRoutes = [
      ['GET','/api/network'], ['PATCH','/api/network'], ['POST','/api/network/test'],
      ['GET','/api/source-repositories'], ['DELETE','/api/source-repositories'], ['POST','/api/sources/refresh'],
      ['POST','/api/sources/x/install'], ['POST','/api/sources/x/rollback'], ['POST','/api/sources/x/check'],
      ['PATCH','/api/sources/x'], ['GET','/api/sources/x/preferences'], ['PATCH','/api/sources/x/preferences'],
      ['GET','/api/admin/apk/status'], ['GET','/api/admin/remote-access'], ['POST','/api/admin/remote-access/start'], ['POST','/api/admin/remote-access/stop'], ['POST','/api/admin/remote-access/configure'],
      ['GET','/api/library/folders'], ['POST','/api/library/folders'], ['DELETE','/api/library/folders/x'],
      ['GET','/api/library/browse'], ['POST','/api/library/scan'], ['GET','/api/library/status'],
      ['PATCH','/api/media/x/metadata'], ['DELETE','/api/episodes/x/subtitles/y'], ['DELETE','/api/admin/accounts/admin-id/data'],
    ];
    for (const [method,url] of adminRoutes) {
      const r = await app.inject({ method: method as 'GET', url, headers: h });
      assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`); assert.equal(r.json().error, 'admin-required');
    }
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { autoplayDelay: 17 } });
    assert.equal((await app.inject({ url: '/api/settings', headers: { ...admin, 'x-moa-profile': 'legacy' } })).json().autoplayDelay, 5);
    db.run("INSERT INTO media VALUES('m',NULL,'Show','movie','{}','2026')");
    db.run("INSERT INTO episodes VALUES('e','m',1,1,'Episode',1400,NULL)");
    const file = path.join(mediaRoot, 'test.mp4'); await writeFile(file, 'test-video');
    db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', 'e', file, 10, 0, '', JSON.stringify({ duration: 1400, container: 'mp4', streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }), '[]');
    await app.inject({ method: 'PUT', url: '/api/watchlist/m', headers: h });
    await app.inject({ method: 'POST', url: '/api/progress', headers: h, payload: { episodeId: 'e', position: 300, duration: 1400 } });
    assert.equal((await app.inject({ url: '/api/watchlist', headers: { ...admin, 'x-moa-profile': 'legacy' } })).json().length, 0);
    assert.equal((await app.inject({ url: '/api/history', headers: { ...admin, 'x-moa-profile': 'legacy' } })).json().items.length, 0);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/media/m/group', headers: h, payload: { action: 'separate' } })).statusCode, 200);
    const session = (await app.inject({ method: 'POST', url: '/api/playback', headers: h, payload: { episodeId: 'e', capabilities: { h264: true, hevc: false, av1: false } } })).json();
    assert.ok(session.sessionId);
    for (const method of ['GET', 'HEAD'] as const) assert.equal((await app.inject({ method, url: session.url, headers: restricted })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/playback/${session.sessionId}/heartbeat`, headers: restricted })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/playback/${session.sessionId}/cast`, headers: restricted, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ url: session.url, headers: member })).statusCode, 200);
    assert.equal((await app.inject({ url: session.url, headers: admin })).statusCode, 403);
    assert.equal((await app.inject({ url: session.url.replace('/api/', '/%61pi/'), headers: admin })).statusCode, 403);
    assert.equal((await app.inject({ url: session.url.replace('/api/playback/', '/api/%70layback/'), headers: admin })).statusCode, 403);
    assert.equal((await app.inject(session.url)).statusCode, 401);
    // Remote and standalone subtitle tokens use the same account ownership gate.
    remotePlayback.sessions.set('remote-test', { profile: p.id, abort: new AbortController() } as any);
    (online as any).assets.set('subtitle-test', { profileId: p.id });
    for (const url of ['/api/playback/remote-test/remote/x', '/api/playback/subtitle-test/subtitles/x.vtt']) assert.equal((await app.inject({ url, headers: admin })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/accounts/member-id/data', headers: admin })).statusCode, 204);
    for (const table of ['progress','watchlist','title_group_overrides']) assert.equal(db.get(`SELECT count(*) AS n FROM ${table}`)!.n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM profiles WHERE account_id=?', 'member-id')!.n, 0);
    assert.equal(playback.sessions.size, 0); assert.equal(remotePlayback.sessions.size, 0); assert.equal(online.assetProfile('subtitle-test'), undefined);
    assert.equal((await app.inject({ url: session.url, headers: member })).statusCode, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
