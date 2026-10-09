import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pluginCompatibility, pluginPackage, unpackPlugin } from '../src/website-plugins.js';
import { buildApp } from '../src/app.js';

const template = { ...JSON.parse(await readFile(new URL('../../../plugins/template/examples/subtitle-helper/manifest.json', import.meta.url), 'utf8')), html: '<p>Plugin test</p>' };

test('plugin packages validate permissions, sizes, origins and API versions', () => {
  assert.deepEqual(pluginPackage(template), template);
  for (const patch of [{ apiVersion: 0 }, { id: '../x' }, { permissions: ['admin'] }, { permissions: ['player.context', 'player.context'] }, { placements: [] }, { connect: ['http://example.org'] }, { connect: ['https://example.org/path'] }, { connect: ['https://user:pass@example.org'] }, { html: 'x'.repeat(200 * 1024 + 1) }, { future: true }]) {
    assert.throws(() => pluginPackage({ ...template, ...patch }));
  }
  assert.doesNotThrow(() => pluginPackage({ ...template, connect: ['https://example.org'] }));
  const { html: _, ...manifest } = template;
  const script = { ...manifest, script: 'moa.on("ready", () => {});', placements: ['app', 'player'], permissions: ['app.context', 'app.navigate', 'ui', 'storage', 'notifications', 'player.control'], actions: [{ id: 'bookmark', label: '책갈피' }] };
  assert.deepEqual(pluginPackage(script), script);
  assert.deepEqual(pluginPackage({ ...script, placements: ['home'] }).placements, ['home']);
  assert.deepEqual(pluginPackage({ ...script, placements: ['app', 'home'] }).placements, ['app', 'home']);
  assert.throws(() => pluginPackage({ ...script, placements: ['homepage'] }));
  for (const patch of [{ html: '<p>Mixed</p>' }, { script: '' }, { script: '가'.repeat(70 * 1024) }, { actions: [{ id: 'bad/id', label: 'Bad' }] }, { actions: [{ id: 'valid', label: '' }] }, { actions: [{ id: 'one', label: 'One' }, { id: 'one', label: 'Two' }] }, { actions: Array.from({ length: 9 }, (_, i) => ({ id: `action-${i}`, label: 'Action' })) }]) assert.throws(() => pluginPackage({ ...script, ...patch }));
  assert.throws(() => pluginPackage({ ...template, actions: script.actions }));
  const hooked = { ...script, apiVersion: 2, placements: ['app', 'detail'], permissions: ['catalog.modify'], hooks: ['catalog.transform'], minMoaVersion: '1.2.0-beta.2' };
  assert.deepEqual(pluginPackage(hooked), hooked);
  for (const patch of [{ apiVersion: 1 }, { permissions: [] }, { hooks: ['server.exec'] }, { minMoaVersion: 'latest' }, { minMoaVersion: '1.2.0-01' }, { minMoaVersion: '01.2.0' }]) assert.throws(() => pluginPackage({ ...hooked, ...patch }));
  for (const current of ['1.2.0-beta.2', '1.2.0-beta.10', 'v1.2.0', '1.2.0+build.5', '1.3.0', '9007199254740993.0.0']) assert.equal(pluginCompatibility(pluginPackage(hooked), current).supported, true);
  for (const current of ['1.2.0-beta.1', '1.1.9', 'unknown', 'latest']) assert.equal(pluginCompatibility(pluginPackage(hooked), current).supported, false);
  assert.equal(pluginCompatibility(pluginPackage({ ...hooked, minMoaVersion: '1.2.0' }), '1.2.0-beta.10').supported, false);
  assert.equal(pluginCompatibility(pluginPackage({ ...template, apiVersion: 3 })).supported, false);
  assert.equal(pluginCompatibility(pluginPackage({ ...hooked, minMoaVersion: '9007199254740993.0.0' }), '9007199254740992.0.0').supported, false);
  assert.equal(pluginCompatibility(pluginPackage({ ...hooked, minMoaVersion: '1.2.0-9007199254740993' }), '1.2.0-9007199254740992').supported, false);
  assert.equal(pluginCompatibility(pluginPackage({ ...hooked, minMoaVersion: '1.2.0+build.1' }), '1.2.0+build.2').supported, true);
});

test('whole plugin folders and ZIPs select their root manifest and reject unsafe or incomplete packages', async () => {
  const { html, ...manifest } = template;
  const files = [{ name: 'root/manifest.json', content: '\uFEFF' + JSON.stringify(manifest) }, { name: 'root/index.html', content: html }, { name: 'root/examples/manifest.json', content: JSON.stringify({ ...manifest, id: 'example' }) }, { name: 'root/examples/index.html', content: '<p>Example</p>' }];
  assert.deepEqual(await unpackPlugin({ files }), template);
  assert.deepEqual(await unpackPlugin({ files: [{ name: 'old.moa-plugin.json', content: JSON.stringify(template) }] }), template);
  const script = files.slice(0, 2).map(file => file.name.endsWith('index.html') ? { name: 'root/plugin.js', content: 'moa.on("ready", () => {});' } : file);
  assert.equal((await unpackPlugin({ files: script })).script, script[1].content);
  for (const invalid of [null, {}, { files: [] }, { files: [files[0]] }, { files: [files[1]] }, { files: [...files, files[0]] }, { files: [...files, { name: 'root/plugin.js', content: 'void 0;' }] }, { files: [{ name: '../manifest.json', content: '{}' }] }, { files: [{ name: 'manifest.json', content: '{' }] }, { files: [{ name: 'plugin.moa-plugin.json', content: 'null' }] }, { files: [{ ...files[0], content: 'x'.repeat(256 * 1024 + 1) }] }, { archive: '!!!!' }, { archive: Buffer.from('not zip').toString('base64') }]) await assert.rejects(unpackPlugin(invalid));
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-package-'));
  try {
    for (const file of files) { await mkdir(path.dirname(path.join(directory, file.name)), { recursive: true }); await writeFile(path.join(directory, file.name), file.content); }
    await writeFile(path.join(directory, 'root/README.md'), 'Package documentation');
    const archive = (...names: string[]) => { const output = path.join(directory, 'test.zip'); execFileSync('bsdtar', ['-cf', output, '--format', 'zip', '-C', directory, ...names]); return readFileSync(output); };
    const zip = archive('root');
    assert.deepEqual(await unpackPlugin({ archive: zip.toString('base64') }), template);
    await assert.rejects(unpackPlugin({ archive: archive('root/manifest.json').toString('base64') }), { error: 'plugin-entry-missing' });
    await assert.rejects(unpackPlugin({ archive: archive('root/manifest.json', 'root/manifest.json', 'root/index.html').toString('base64') }));
    await assert.rejects(unpackPlugin({ archive: Buffer.from(zip.toString('latin1').replaceAll('root/', '../x/'), 'latin1').toString('base64') }));
    await symlink('index.html', path.join(directory, 'root/link.html'));
    await assert.rejects(unpackPlugin({ archive: archive('root').toString('base64') }));
    const templateRoot = new URL('../../../plugins/template/', import.meta.url).pathname;
    execFileSync(process.execPath, [path.join(templateRoot, 'build.mjs')]);
    const built = await unpackPlugin({ archive: (await readFile(path.join(templateRoot, 'dist/playback-bookmark.zip'))).toString('base64') });
    assert.equal(built.id, 'playback-bookmark');
    assert.equal(built.script, await readFile(path.join(templateRoot, 'plugin.js'), 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('script plugin storage enforces permission, revision, profile boundaries, size and deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-storage-'));
  let env = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false);
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' }, viewer = { 'x-moa-account': 'viewer', 'x-moa-role': 'admin' };
  const { html: _, ...manifest } = template;
  const script = { ...manifest, script: 'moa.on("ready", () => {});', permissions: ['storage'], actions: [{ id: 'mark', label: '책갈피' }] };
  try {
    const profiles = [];
    for (const name of ['First', 'Second']) profiles.push((await env.app.inject({ method: 'POST', url: '/api/profiles', headers: viewer, payload: { name } })).json());
    const headers = profiles.map(profile => ({ ...viewer, 'x-moa-profile': profile.id }));
    const endpoint = `/api/plugins/${script.id}/storage`;
    const install = async (payload: object) => (await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload })).json();
    let revision = (await install(script)).revision;
    const storage = (profile: number, value?: unknown, version = revision) => env.app.inject({ method: 'POST', url: endpoint, headers: headers[profile], payload: { revision: version, ...(value === undefined ? {} : { value }) } });
    const listing = (await env.app.inject({ url: '/api/plugins', headers: headers[0] })).json()[0];
    assert.equal(listing.kind, 'script'); assert.equal(listing.script, undefined); assert.deepEqual(listing.actions, script.actions);
    assert.deepEqual((await storage(0)).json(), {});
    assert.deepEqual((await storage(0, { position: 42, name: '첫 프로필' })).json(), { position: 42, name: '첫 프로필' });
    assert.deepEqual((await storage(1)).json(), {});
    assert.deepEqual((await storage(1, { position: 7 })).json(), { position: 7 });
    assert.deepEqual((await storage(0)).json(), { position: 42, name: '첫 프로필' });
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint, headers: viewer, payload: { revision } })).statusCode, 401);
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint, headers: { ...admin, 'x-moa-profile': profiles[0].id }, payload: { revision } })).statusCode, 401);
    assert.equal((await storage(0, { text: '가'.repeat(5500) })).statusCode, 413);
    assert.equal((await storage(0, Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i])))).statusCode, 400);
    for (const value of [null, [], 'text']) assert.equal((await storage(0, value)).statusCode, 400);
    const previous = revision;
    revision = (await install({ ...script, version: '1.0.1' })).revision;
    assert.equal((await storage(0, { overwritten: true }, previous)).statusCode, 409);
    assert.deepEqual((await storage(0)).json(), { position: 42, name: '첫 프로필' });
    revision = (await install({ ...script, permissions: [] })).revision;
    assert.equal((await storage(0)).statusCode, 403);
    assert.equal((await storage(0, {})).statusCode, 403);
    revision = (await install(script)).revision;
    await env.app.inject({ method: 'PATCH', url: `/api/admin/plugins/${script.id}`, headers: admin, payload: { enabled: false } });
    assert.equal((await storage(0)).statusCode, 404);
    await env.app.inject({ method: 'PATCH', url: `/api/admin/plugins/${script.id}`, headers: admin, payload: { enabled: true } });
    await env.app.close(); env = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false);
    assert.deepEqual((await storage(0)).json(), { position: 42, name: '첫 프로필' });
    await env.app.inject({ method: 'DELETE', url: `/api/profiles/${profiles[0].id}`, headers: viewer });
    assert.equal(env.db.get('SELECT count(*) AS n FROM website_plugin_data')!.n, 1);
    assert.deepEqual((await storage(1)).json(), { position: 7 });
    await env.app.inject({ method: 'DELETE', url: `/api/admin/plugins/${script.id}`, headers: admin });
    assert.equal(env.db.get('SELECT count(*) AS n FROM website_plugin_data')!.n, 0);
    assert.equal((await storage(1)).statusCode, 404);
  } finally { await env.app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('plugin installation persists, admin controls are protected and network access is limited', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moa-plugin-'));
  let env = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false);
  const admin = { 'x-moa-account': 'owner', 'x-moa-role': 'admin' }, member = { 'x-moa-account': 'member', 'x-moa-role': 'member' };
  try {
    const p = (await env.app.inject({ method: 'POST', url: '/api/profiles', headers: admin, payload: { name: 'Admin' } })).json();
    const memberProfile = (await env.app.inject({ method: 'POST', url: '/api/profiles', headers: member, payload: { name: 'Member' } })).json();
    const runtimeHeaders = { ...member, 'x-moa-profile': memberProfile.id };
    const profile = { ...admin, 'x-moa-profile': p.id };
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: member, payload: template })).statusCode, 403);
    const preview = { files: [{ name: 'package.moa-plugin.json', content: JSON.stringify(template) }] };
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/admin/plugins/preview', headers: member, payload: preview })).statusCode, 403);
    assert.deepEqual((await env.app.inject({ method: 'POST', url: '/api/admin/plugins/preview', headers: admin, payload: preview })).json(), template);
    assert.equal(env.db.get('SELECT count(*) AS n FROM website_plugins')!.n, 0);
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/admin/plugins', payload: template })).statusCode, 401);
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: template })).statusCode, 200);
    assert.equal((await env.app.inject({ url: '/api/plugins', headers: member })).statusCode, 403);
    const listing = (await env.app.inject({ url: '/api/plugins', headers: profile })).json();
    assert.equal(listing.length, 1); assert.equal(listing[0].html, undefined);
    const runtime = await env.app.inject({ url: '/api/plugin-runtime', headers: runtimeHeaders });
    assert.equal(runtime.statusCode, 200, runtime.body);
    assert.equal(runtime.json()[0].id, template.id);
    for (const field of ['version', 'description', 'connect', 'minMoaVersion', 'compatibility', 'html']) assert.equal(runtime.json()[0][field], undefined);
    assert.equal((await env.app.inject({ url: `/api/plugin-runtime/${template.id}`, headers: runtimeHeaders })).json().html, template.html);
    assert.equal((await env.app.inject({ method: 'POST', url: `/api/plugin-runtime/${template.id}/storage`, headers: runtimeHeaders, payload: { revision: listing[0].revision, value: {} } })).statusCode, 403);
    const endpoint = `/api/plugins/${template.id}`;
    for (const url of ['/api/plugins', endpoint]) assert.equal((await env.app.inject({ url, headers: member })).statusCode, 403);
    for (const url of [endpoint + '/storage', endpoint + '/request']) assert.equal((await env.app.inject({ method: 'POST', url, headers: member, payload: {} })).statusCode, 403);
    let revision = listing[0].revision;
    assert.equal((await env.app.inject({ url: endpoint, headers: profile })).json().html, template.html);
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint + '/request', headers: profile, payload: { url: 'https://example.org/file.srt', revision } })).statusCode, 403);
    await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...template, connect: ['https://127.0.0.1'] } });
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint + '/request', headers: profile, payload: { url: 'https://127.0.0.1/file.srt', revision } })).statusCode, 409);
    revision = (await env.app.inject({ url: endpoint, headers: profile })).json().revision;
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint + '/request', headers: profile, payload: { url: 'https://127.0.0.1/file.srt', revision } })).statusCode, 502);
    assert.equal((await env.app.inject({ method: 'POST', url: endpoint + '/request', headers: profile, payload: { url: 'https://127.0.0.1/file.srt', method: 'POST' } })).statusCode, 400);
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/admin/plugins/${template.id}`, headers: member, payload: { enabled: false } })).statusCode, 403);
    await env.app.inject({ method: 'PATCH', url: `/api/admin/plugins/${template.id}`, headers: admin, payload: { enabled: false } });
    await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...template, version: '1.0.1' } });
    assert.equal((await env.app.inject({ url: endpoint, headers: profile })).statusCode, 404);
    assert.deepEqual((await env.app.inject({ url: '/api/plugin-runtime', headers: runtimeHeaders })).json(), []);
    assert.equal((await env.app.inject({ url: '/api/plugins', headers: profile })).json()[0].enabled, false);
    await env.app.close();
    env = await buildApp({ dataDir: directory, mediaRoot: directory, requireAccount: true }, false);
    const saved = env.db.get('SELECT * FROM website_plugins WHERE id=?', template.id)!;
    assert.equal(JSON.parse(saved.package).version, '1.0.1'); assert.equal(saved.enabled, 0);
    await env.app.inject({ method: 'PATCH', url: `/api/admin/plugins/${template.id}`, headers: admin, payload: { enabled: true } });
    assert.equal((await env.app.inject({ url: endpoint, headers: profile })).statusCode, 200);
    await env.app.inject({ method: 'POST', url: '/api/admin/plugins', headers: admin, payload: { ...template, apiVersion: 3 } });
    const future = (await env.app.inject({ url: '/api/plugins', headers: profile })).json()[0];
    assert.equal(future.compatibility.supported, false);
    assert.equal(future.compatibility.apiVersion, 2);
    assert.deepEqual((await env.app.inject({ url: '/api/plugin-runtime', headers: runtimeHeaders })).json(), []);
    assert.equal((await env.app.inject({ url: `/api/plugin-runtime/${template.id}`, headers: runtimeHeaders })).statusCode, 409);
    await env.app.inject({ method: 'DELETE', url: `/api/admin/plugins/${template.id}`, headers: admin });
    assert.equal((await env.app.inject({ url: endpoint, headers: profile })).statusCode, 404);
  } finally { await env.app.close(); await rm(directory, { recursive: true, force: true }); }
});
