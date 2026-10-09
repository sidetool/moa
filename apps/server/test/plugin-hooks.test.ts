import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCatalogHook, transformPluginCatalog } from '../../web/src/lib/plugin-hooks.js';

test('catalog hooks apply bounded presentation patches and isolate failures, profiles, and revoked registrations', async () => {
  const value = { items: [{ id: 'one', title: 'Original', type: 'movie', provider: { id: 'local', name: 'Local' }, poster: '/api/images/poster', playTarget: { episodeId: 'episode' } }] };
  const remove: Array<() => void> = [];
  try {
    remove.push(registerCatalogHook('good', { profile: 'owner', run: async ({ items }) => {
      assert.equal((items[0] as any).poster, undefined);
      assert.equal((items[0] as any).playTarget, undefined);
      return [{ id: 'one', title: 'Changed', badge: 'Selected' }];
    } }));
    remove.push(registerCatalogHook('broken', { profile: 'owner', run: async () => { throw new Error('broken'); } }));
    remove.push(registerCatalogHook('foreign', { profile: 'other', run: async () => [{ id: 'one', title: 'Other profile' }] }));
    for (const [id, patch] of [['url', { id: 'one', poster: 'https://example.com' }], ['id', { id: 'missing', title: 'Bad' }], ['huge', { id: 'one', overview: 'x'.repeat(4001) }], ['duplicate', [{ id: 'one', title: 'First' }, { id: 'one', title: 'Second' }]]] as const)
      remove.push(registerCatalogHook(id, { profile: 'owner', run: async () => Array.isArray(patch) ? patch : [patch] }));
    const output = await transformPluginCatalog('/api/media?page=1', value, 'owner');
    assert.equal(output.items[0].title, 'Changed');
    assert.equal(output.items[0].poster, value.items[0].poster);
    assert.deepEqual(output.items[0].playTarget, value.items[0].playTarget);
    assert.equal(value.items[0].title, 'Original');
    assert.equal(await transformPluginCatalog('/api/settings', value, 'owner'), value);
    assert.equal(await transformPluginCatalog('/api/media', value, null), value);
    const revoke = registerCatalogHook('pending', { profile: 'owner', run: async () => { revoke(); return [{ id: 'one', title: 'Revoked' }]; } });
    remove.push(revoke);
    assert.equal((await transformPluginCatalog('/api/media', value, 'owner')).items[0].title, 'Changed');
    remove.push(registerCatalogHook('timeout', { profile: 'owner', run: async () => new Promise(() => {}) }));
    const start = Date.now();
    assert.equal((await transformPluginCatalog('/api/media', value, 'owner')).items[0].title, 'Changed');
    assert.ok(Date.now() - start < 3000);
  } finally { for (const dispose of remove) dispose(); }
});
