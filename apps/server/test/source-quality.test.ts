import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preferredResolutionIndex } from '@moa/shared';
import { sourceVideoHeight, preferredSourceIndex } from '../src/playback/quality.js';
import { RemotePlayback } from '../src/playback/remote.js';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { Sources } from '../src/sources/service.js';

test('source quality reads explicit pixels without interpreting server names as resolutions', () => {
  for (const [label, expected] of [['Server A · 1080p', 1080], ['1920×1080', 1080], ['1280x720 AVC', 720], ['720', 720], ['1080p60', 1080], ['1920x1080 · 1080p', 1080]] as const) {
    assert.equal(sourceVideoHeight(label), expected);
  }
  for (const label of ['HD', 'HD-1', 'FHD', '4K Server', 'Server 1080', 'auto', '1080p / 720p', '0x0', '', undefined, 1080]) {
    assert.equal(sourceVideoHeight(label), undefined, String(label));
  }
});

test('fixed quality chooses available pixels while auto and unknown sources preserve order', () => {
  const heights = [undefined, 1080, 360, 720, 720];
  assert.equal(preferredSourceIndex(heights, 'auto'), 0);
  assert.equal(preferredSourceIndex(heights, '1080'), 1);
  assert.equal(preferredSourceIndex(heights, '720'), 3);
  assert.equal(preferredSourceIndex(heights, '480'), 2);
  assert.equal(preferredSourceIndex([1080, 720, 720], '480'), 1);
  assert.equal(preferredSourceIndex([undefined, undefined], '720'), 0);
  assert.equal(preferredResolutionIndex([0, NaN, undefined], 720), undefined);
  assert.equal(preferredResolutionIndex([360, 720], undefined), undefined);
});

test('remote playback applies profile quality, exposes explicit heights and honors manual stream selection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moa-source-quality-'));
  const db = new Store(directory), catalog = new Catalog(db);
  const videos = ['HD-1', 'Server A · 1080p', 'Server A · 720p', 'Server B · 720p', 'Server A · 360p']
    .map((quality, index) => ({ quality, url: `https://media.test/${index}.mp4` }));
  const sources = new Sources(db, catalog, async () => ({ result: videos, changes: {} }));
  const remote = new RemotePlayback(db, catalog, sources);
  try {
    const entry = JSON.stringify({ id: 'fixture', name: 'Fixture', version: '1', baseUrl: 'https://source.test' });
    db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)', 'source', 'repo', entry, entry, 'fixture');
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'm', 'Quality fixture', 'anime', '{}', '2026');
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'e', 'm', 1, 1, 'Episode', 1440, null);
    db.run('INSERT INTO source_media VALUES(?,?,?,0)', 'm', 'source', 'show');
    db.run('INSERT INTO source_episodes VALUES(?,?)', 'e', 'episode');
    for (const id of ['a', 'b']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,0,?)', id, id, 'blue', '2026');
    db.run('INSERT INTO settings VALUES(?,?)', 'a', JSON.stringify({ preferredQuality: '720' }));
    const fixed = await remote.create('a', 'e', 123);
    assert.equal(fixed.streamId, '2');
    assert.equal(fixed.startPosition, 123);
    assert.deepEqual(fixed.streams?.map(stream => stream.height), [undefined, 1080, 720, 720, 360]);
    assert.equal(fixed.streams?.[0].label, 'HD-1');
    assert.equal(Object.hasOwn(fixed.streams![0], 'height'), false);
    assert.equal((await remote.create('b', 'e')).streamId, '0', 'other profile retains source default');
    assert.equal((await remote.create('a', 'e', 456, '1')).streamId, '1', 'manual stream wins over profile preference');
    assert.equal((await remote.create('a', 'e', 456, '0')).streamId, '0', 'unknown-resolution server stays selectable');
    await assert.rejects(remote.create('a', 'e', 0, '99'), /invalid-stream/);
  } finally { remote.close(); await sources.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
