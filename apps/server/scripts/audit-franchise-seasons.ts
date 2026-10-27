/** Offline assertions over an authored synthetic catalog. */
import assert from 'node:assert/strict';
import fixture from '../test/fixtures/franchise-seasons.json' with { type: 'json' };
import { fixtureCatalog } from '../test/fixtures/catalog.js';
import { Franchises } from '../src/catalog/franchise.js';

const { db, catalog, sources, groups } = fixtureCatalog(fixture);
const service = new Franchises(catalog, groups, { browse: async () => ({ items: [], page: 1, hasNextPage: false }) });
try {
  for (const search of fixture.searches) {
    const seasons = service.get(search.currentId, 'fixture').seasons;
    assert.deepEqual(seasons.map(season => season.key), search.expectedSeasons, search.query);
    console.log(JSON.stringify({ query: search.query, seasons: seasons.map(season => season.key) }));
  }
} finally { await service.close(); await sources.close(); db.close(); }
