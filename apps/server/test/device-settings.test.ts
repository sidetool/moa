import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('device settings persist by account, profile and device with validated values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-device-settings-'));
  let server = await buildApp({ dataDir: directory, mediaRoot: directory }, false);
  try {
    const owner = (await server.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Owner' } })).json().id;
    const other = (await server.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Other' } })).json().id;
    const device = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
    const headers = { 'x-moa-profile': owner, 'x-moa-device': device };
    const get = (h = headers) => server.app.inject({ url: '/api/settings/device', headers: h });
    const patch = (settings: unknown, h = headers, migrate = false) => server.app.inject({ method: 'PATCH', url: '/api/settings/device', headers: h, payload: { settings, migrate } });
    assert.deepEqual((await get()).json(), { settings: null });
    const saved = await patch({ subtitleScale: 127, subtitleShadow: 2.3, autoSkip: true, seekStep: 30 });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().settings.subtitleScale, 127);
    assert.equal(saved.json().settings.shortsScreenFit, null);
    assert.deepEqual((await get({ ...headers, 'x-moa-device': second })).json(), { settings: null });
    assert.deepEqual((await get({ ...headers, 'x-moa-profile': other })).json(), { settings: null });
    const secondHeaders = { ...headers, 'x-moa-device': second };
    assert.equal((await patch({ shortsScreenFit: false }, secondHeaders)).statusCode, 200);
    assert.equal((await get()).json().settings.shortsScreenFit, null, 'another device does not change this device');
    assert.equal((await patch({ shortsScreenFit: true })).statusCode, 200);
    assert.equal((await get(secondHeaders)).json().settings.shortsScreenFit, false);
    assert.equal((await server.app.inject({ url: '/api/settings', headers })).json().shortsScreenFit, true, 'device choice does not change shared profile settings');

    const foreign = { ...headers, 'x-moa-account': 'foreign', 'x-moa-role': 'member' };
    assert.equal((await get(foreign)).statusCode, 401);
    assert.equal((await patch({ subtitleScale: 150 }, foreign)).statusCode, 401);
    assert.equal((await get({ ...headers, 'x-moa-device': '../bad' })).statusCode, 400);
    for (const settings of [{ subtitleScale: 251 }, { subtitleShadow: -1 }, { seekStep: 3 }, { autoSkip: 'yes' }, { surprise: true }, { shortsScreenFit: 'yes' }, { shortsScreenFit: {} }]) assert.equal((await patch(settings)).statusCode, 400);
    assert.equal((await patch({ subtitleScale: 80 }, headers, true)).json().settings.subtitleScale, 127);
    assert.equal((await server.app.inject({ url: '/api/settings', headers })).json().subtitleScale, undefined);
    await server.app.close();
    server = await buildApp({ dataDir: directory, mediaRoot: directory }, false);
    assert.deepEqual((await get()).json(), { settings: { ...saved.json().settings, shortsScreenFit: true } });
    assert.equal((await get(secondHeaders)).json().settings.shortsScreenFit, false);
    assert.equal((await patch({ shortsScreenFit: null }, secondHeaders)).json().settings.shortsScreenFit, null);
    await server.app.inject({ method: 'DELETE', url: `/api/profiles/${owner}` });
    assert.equal(server.db.get('SELECT count(*) AS count FROM device_settings')!.count, 0);
  } finally { await server.app.close(); await rm(directory, { recursive: true, force: true }); }
});
