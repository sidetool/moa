import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';
import { TitleGroups } from '../src/catalog/title-groups.js';

async function fixture(run: (value: { db: Store; catalog: Catalog; groups: TitleGroups; directory: string }) => void | Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-search-groups-'));
  const db = new Store(directory), catalog = new Catalog(db);
  new Sources(db, catalog);
  const groups = new TitleGroups(catalog);
  for (const id of ['p', 'other']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', id, id, 'blue', 0, '2026');
  for (const [id, lang] of [['ko', 'ko'], ['en', 'en']]) {
    db.run('INSERT INTO source_entries(id,repository,entry,enabled) VALUES(?,?,?,1)', id, 'synthetic-fixture', JSON.stringify({ lang }));
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', id, '합성 검증 작품', 'anime', JSON.stringify({ provider: { id, name: id, kind: 'mangayomi-js' } }), '2026');
    for (let n = 1; n <= 2; n++) db.run('INSERT INTO episodes VALUES(?,?,1,?,?,600,NULL)', `${id}-${n}`, id, n, `${n}화`);
  }
  try { await run({ db, catalog, groups, directory }); }
  finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}

function progress(db: Store, source: string, episode: number, at: string, completed = false, position = 120, profile = 'p') {
  db.run('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)', profile, `${source}-${episode}`, position, 600, Number(completed), at);
}

test('search resume uses the latest actually watched allowed member while representative identity stays stable', () => fixture(({ db, catalog, groups }) => {
  const before = groups.resolve(['en', 'ko'], 'p', '합성')[0];
  progress(db, 'ko', 1, '2026-01-01');
  progress(db, 'en', 1, '2026-01-02', false, 240);
  let card = groups.resolve(['en', 'ko'], 'p', '합성')[0];
  assert.equal(card.id, 'ko');
  assert.equal(card.groupId, before.groupId);
  assert.equal(card.resumeMediaId, 'en');
  assert.equal(card.resume?.episodeId, 'en-1');
  assert.equal(card.progress?.episodeId, 'en-1');
  assert.equal(card.sourceCount, 2);
  // The source-filtered search card can still find personal history on another allowed member.
  card = groups.resolve(['ko'], 'p', '합성')[0];
  assert.equal(card.resumeMediaId, 'en');
  assert.equal(card.sourceCount, 1);
  assert.deepEqual(card.langs, ['ko']);
  // A new manual source playback supersedes that remembered source immediately.
  progress(db, 'ko', 2, '2026-01-03', false, 300);
  assert.equal(groups.resolve(['en', 'ko'], 'p', '합성')[0].resumeMediaId, 'ko');
  assert.equal(catalog.detail('en', 'p').playTarget?.episodeId, 'en-1', 'manual detail retains its own source target');
  assert.equal(groups.resolve(['en', 'ko'], 'other', '합성')[0].resume, undefined);
  assert.equal(groups.resolve(['en', 'ko'], 'p')[0].resume?.episodeId, 'ko-2', 'ordinary catalog cards retain their own representative history');
}));

test('latest completed viewing advances on that source and final completion suppresses older unfinished history', () => fixture(({ db, groups }) => {
  progress(db, 'ko', 1, '2026-01-01');
  progress(db, 'en', 1, '2026-01-02', true, 600);
  let card = groups.resolve(['ko', 'en'], 'p', '합성')[0];
  assert.equal(card.resumeMediaId, 'en');
  assert.equal(card.resume?.episodeId, 'en-2');
  assert.equal(card.resume?.kind, 'next');
  assert.equal(card.progress, undefined, 'unseen next episode has no progress bar');
  progress(db, 'en', 2, '2026-01-03', true, 600);
  card = groups.resolve(['ko', 'en'], 'p', '합성')[0];
  assert.equal(card.resumeMediaId, 'en');
  assert.equal(card.resume, undefined);
  assert.equal(card.progress, undefined);
  progress(db, 'ko', 2, '2026-01-04', false, 0);
  assert.equal(groups.resolve(['ko', 'en'], 'p', '합성')[0].resumeMediaId, 'en', 'zero-position records are not viewing activity');
  db.run("UPDATE source_entries SET enabled=0 WHERE id='en'");
  card = groups.resolve(['ko', 'en'], 'p', '합성')[0];
  assert.equal(card.resumeMediaId, 'ko', 'disabled source history is not offered');
  assert.equal(card.resume?.episodeId, 'ko-1');
}));

test('group mapping is reused without writes and invalidates source, media, override, metadata and kids changes', () => fixture(({ db, groups }) => {
  const original = groups.mapping('p');
  assert.strictEqual(groups.mapping('p'), original);
  assert.notStrictEqual(groups.mapping('other'), original, 'profile caches are isolated');
  progress(db, 'ko', 1, '2026-01-01');
  db.run('INSERT INTO settings VALUES(?,?)', 'p', JSON.stringify({ autoplayNext: false }));
  db.run('INSERT INTO enrichment_cache VALUES(?,?,?)', 'synthetic-cache', '{}', Date.now() + 1000);
  assert.strictEqual(groups.mapping('p'), original, 'progress, preferences and enrichment writes preserve structural grouping cache');
  db.run("UPDATE source_entries SET enabled=0 WHERE id='en'");
  assert.equal(groups.mapping('p').has('en'), false);
  db.run("UPDATE source_entries SET enabled=1 WHERE id='en'");
  assert.equal(groups.mapping('p').get('ko'), groups.mapping('p').get('en'));
  groups.change('en', 'p', 'separate');
  assert.notEqual(groups.mapping('p').get('ko'), groups.mapping('p').get('en'));
  assert.equal(groups.mapping('other').get('ko'), groups.mapping('other').get('en'));
  groups.change('en', 'p', 'reset');
  db.run("UPDATE media SET title='다른 합성 작품' WHERE id='en'");
  assert.notEqual(groups.mapping('p').get('ko'), groups.mapping('p').get('en'));
  for (const id of ['ko', 'en']) db.run('INSERT INTO tmdb_links VALUES(?,?,?,NULL,?,100,?)', id, 'tv', 42, 'auto', Date.now());
  assert.equal(groups.mapping('p').get('ko'), groups.mapping('p').get('en'));
  db.run("UPDATE profiles SET kids=1 WHERE id='p'");
  assert.equal(groups.mapping('p').size, 0);
  db.run('INSERT INTO tmdb_titles VALUES(?,?,?,?,?)', 'tv', 42, JSON.stringify({ title: '합성 작품', certification: 'ALL' }), '{}', Date.now());
  assert.equal(groups.mapping('p').size, 2);
  db.run("UPDATE tmdb_titles SET card=?", JSON.stringify({ title: '합성 작품', certification: '19' }));
  assert.equal(groups.mapping('p').size, 0, 'cached mapping cannot retain newly restricted titles');
}));

test('mapping built inside a rolled-back transaction cannot escape into later requests', () => fixture(({ db, groups }) => {
  assert.equal(groups.mapping('p').size, 2);
  assert.throws(() => db.transaction(() => {
    db.run("UPDATE source_entries SET enabled=0 WHERE id='en'");
    assert.equal(groups.mapping('p').size, 1);
    throw new Error('rollback synthetic edit');
  }), /rollback synthetic edit/);
  assert.equal(groups.mapping('p').size, 2);
}));

test('mapping observes commits made by another SQLite connection', () => fixture(({ groups, directory }) => {
  assert.equal(groups.mapping('p').size, 2);
  const external = new DatabaseSync(path.join(directory, 'moa.db'));
  try { external.prepare("UPDATE source_entries SET enabled=0 WHERE id='en'").run(); }
  finally { external.close(); }
  assert.equal(groups.mapping('p').size, 1);
}));
