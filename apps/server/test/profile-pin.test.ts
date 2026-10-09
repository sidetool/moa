import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';

const member = { 'x-moa-account': 'member', 'x-moa-role': 'member', 'x-moa-permissions': 'video.watch,subtitles.add,subtitles.translate' };
const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

test('profile PIN protects profile APIs, editing, asset owners and login sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-profile-pin-'));
  const mediaRoot = path.join(dir, 'media'); await mkdir(mediaRoot);
  const { app, db, online } = await buildApp({ dataDir: dir, mediaRoot, webDir: path.join(dir, 'web'), requireAccount: true }, false);
  try {
    for (const pin of ['123', '123456789', '123a']) assert.equal((await app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Invalid', pin } })).statusCode, 400);
    const create = await app.inject({ method: 'POST', url: '/api/profiles', headers: { ...member, cookie: 'moa_session=first-login', 'x-forwarded-proto': 'https' }, payload: { name: 'Private', pin: '0123' } });
    assert.equal(create.statusCode, 201);
    const p = create.json();
    assert.equal(p.hasPin, true); assert.equal(p.pin_hash, undefined); assert.equal(p.pin, undefined);
    const hash = db.get('SELECT pin_hash FROM profiles WHERE id=?', p.id)!.pin_hash;
    assert.match(hash, /^[a-f0-9]{32}:[a-f0-9]{64}$/); assert.notEqual(hash, '0123');
    assert.match(String(create.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.match(String(create.headers['set-cookie']), /; Secure/);
    const h = { ...member, 'x-moa-profile': p.id };
    const authorized = { ...h, cookie: `${cookie(create)}; moa_session=first-login` };
    const locked = await app.inject({ url: '/api/settings', headers: h });
    assert.equal(locked.statusCode, 401); assert.equal(locked.json().error, 'profile-locked');
    assert.equal((await app.inject({ url: '/api/settings', headers: authorized })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/settings', headers: { ...h, cookie: `${cookie(create)}; moa_session=next-login` } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/settings', headers: { ...h, cookie: cookie(create) } })).statusCode, 401);
    for (const method of ['PATCH', 'DELETE'] as const) {
      assert.equal((await app.inject({ method, url: `/api/profiles/${p.id}`, headers: member, ...(method === 'PATCH' ? { payload: { name: 'Bypass', pin: null } } : {}) })).statusCode, 401);
      assert.equal((await app.inject({ method, url: `/api/profiles/${p.id}`, headers: { 'x-moa-account': 'other', 'x-moa-role': 'admin' }, ...(method === 'PATCH' ? { payload: { name: 'Bypass' } } : {}) })).statusCode, 404);
    }
    const publicProfile = (await app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Public' } })).json();
    (online as any).assets.set('pin-asset', { profileId: p.id });
    for (const url of ['/api/playback/pin-asset/protected', '/%61pi/playback/pin-asset/protected']) {
      assert.equal((await app.inject({ url, headers: member })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { ...member, 'x-moa-profile': publicProfile.id } })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { ...member, cookie: authorized.cookie } })).statusCode, 404);
      assert.equal((await app.inject({ url, headers: { 'x-moa-account': 'other', 'x-moa-role': 'admin', cookie: authorized.cookie } })).statusCode, 403);
    }
    const unlock = (pin: string, headers = member) => app.inject({ method: 'POST', url: `/api/profiles/${p.id}/unlock`, headers, payload: { pin } });
    assert.equal((await unlock('9999')).json().error, 'profile-pin-invalid');
    assert.equal((await unlock('0123', { 'x-moa-account': 'other', 'x-moa-role': 'member', 'x-moa-permissions': 'video.watch,subtitles.add,subtitles.translate' })).statusCode, 404);
    const unlocked = await unlock('0123'); assert.equal(unlocked.statusCode, 204);
    const first = { ...h, cookie: cookie(unlocked) };
    const changed = await app.inject({ method: 'PATCH', url: `/api/profiles/${p.id}`, headers: first, payload: { pin: '456789', name: 'Changed' } });
    assert.equal(changed.statusCode, 200); assert.equal(changed.json().name, 'Changed');
    assert.notEqual(db.get('SELECT pin_hash FROM profiles WHERE id=?', p.id)!.pin_hash, hash);
    assert.equal((await app.inject({ url: '/api/settings', headers: first })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/settings', headers: authorized })).statusCode, 401);
    assert.equal((await unlock('0123')).statusCode, 401);
    const second = { ...h, cookie: cookie(await unlock('456789')) };
    const lockedAgain = await app.inject({ method: 'POST', url: '/api/profiles/lock', headers: second });
    assert.equal(lockedAgain.statusCode, 204); assert.notEqual(cookie(lockedAgain), second.cookie);
    assert.equal((await app.inject({ url: '/api/settings', headers: second })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/settings', headers: { ...h, cookie: cookie(lockedAgain) } })).statusCode, 401);
    const third = { ...h, cookie: cookie(await unlock('456789')) };
    const removed = await app.inject({ method: 'PATCH', url: `/api/profiles/${p.id}`, headers: third, payload: { pin: null } });
    assert.equal(removed.statusCode, 200); assert.equal(removed.json().hasPin, false);
    assert.equal(db.get('SELECT pin_hash FROM profiles WHERE id=?', p.id)!.pin_hash, null);
    assert.equal((await app.inject({ url: '/api/settings', headers: h })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/profiles/${p.id}`, headers: member })).statusCode, 204);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('profile PIN throttling survives a server restart and blocks concurrent guesses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moa-profile-pin-rate-'));
  const mediaRoot = path.join(dir, 'media'); await mkdir(mediaRoot);
  const config = { dataDir: dir, mediaRoot, webDir: path.join(dir, 'web'), requireAccount: true };
  let server = await buildApp(config, false);
  try {
    const create = await server.app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Private', pin: '1234' } });
    const id = create.json().id;
    const unlock = (pin: string) => server.app.inject({ method: 'POST', url: `/api/profiles/${id}/unlock`, headers: member, payload: { pin } });
    const guesses = await Promise.all(Array.from({ length: 8 }, () => unlock('9999')));
    assert.equal(guesses.filter(result => result.statusCode === 401).length, 5);
    assert.equal(guesses.filter(result => result.statusCode === 429).length, 3);
    await server.app.close(); server = await buildApp(config, false);
    assert.equal((await unlock('1234')).statusCode, 429);
    assert.equal((await server.app.inject({ url: '/api/settings', headers: { ...member, 'x-moa-profile': id, cookie: cookie(create) } })).statusCode, 401);
    server.db.run('UPDATE profile_pin_attempts SET expires=? WHERE profile_id=?', Date.now() - 1, id);
    const success = await unlock('1234'); assert.equal(success.statusCode, 204);
    assert.equal(server.db.get('SELECT 1 FROM profile_pin_attempts WHERE profile_id=?', id), undefined);
    const lock = await server.app.inject({ method: 'POST', url: '/api/profiles/lock', headers: { ...member, cookie: cookie(success) } });
    const pending = server.app.inject({ method: 'POST', url: `/api/profiles/${id}/unlock`, headers: { ...member, cookie: cookie(lock) }, payload: { pin: '1234' } });
    const started = Date.now();
    while (!server.db.get('SELECT 1 FROM profile_pin_attempts WHERE profile_id=?', id) && Date.now() - started < 2000) await new Promise(resolve => setImmediate(resolve));
    assert.ok(server.db.get('SELECT 1 FROM profile_pin_attempts WHERE profile_id=?', id));
    await server.app.inject({ method: 'POST', url: '/api/profiles/lock', headers: { ...member, cookie: cookie(lock) } });
    assert.equal((await pending).json().error, 'profile-locked');
    const final = await unlock('1234');
    assert.equal((await server.app.inject({ method: 'DELETE', url: `/api/profiles/${id}`, headers: { ...member, cookie: cookie(final) } })).statusCode, 204);
  } finally { await server.app.close(); await rm(dir, { recursive: true, force: true }); }
});
