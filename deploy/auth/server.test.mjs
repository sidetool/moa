import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createAuthServer } from './server.mjs';

test('login, persistence, renewal, CSRF, expiry, logout and abuse controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-auth-test-'));
  let clock = Date.now();
  const salt = 'abcdef'.repeat(10);
  const credentials = { csrfSecret: 'test-only-csrf-secret', users: [{ username: 'moa', salt,
    hash: scryptSync('test-password', Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex') }] };
  const jar = new Map();
  let db, server, address;
  async function start() {
    db = new DatabaseSync(join(dir, 'sessions.sqlite'));
    server = createAuthServer({ credentials, database: db, origin: 'https://moa.test',
      allowedOrigins: ['https://moa.test', 'https://moa.test:18443'], now: () => clock });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
  async function request(path, { method = 'GET', form, headers = {}, keepCookies = true } = {}) {
    const data = form ? new URLSearchParams(form).toString() : undefined;
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(address + path, { method, headers: { Host: 'moa.test',
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), Origin: 'https://moa.test' } : {}), ...headers } }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
        });
        incoming.on('error', reject);
      });
      request.on('error', reject);
      request.end(data);
    });
    if (keepCookies) for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return response;
  }
  async function login({ password = 'test-password', next = '/', remember = 'on', headers = {} } = {}) {
    const response = await request('/__moa/login');
    const csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
    return request('/__moa/login', { method: 'POST', form: { csrf, username: 'moa', password, next, remember }, headers });
  }
  try {
    await start();
    let loginPage = await request('/__moa/login');
    assert.ok((await loginPage.text()).includes('rel="manifest"'));
    assert.ok(loginPage.headers.get('content-security-policy').includes("manifest-src 'self'"));
    for (const [asset, type] of [['login.css', 'text/css'], ['login.js', 'text/javascript']]) {
      const response = await request(`/__moa/${asset}?v=20261002-1`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
    }
    let response = await request('/__moa/check');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
    response = await request('/__moa/required', { headers: { 'X-Original-URI': '/chapter?a=1&b=2' } });
    assert.equal(response.headers.get('location'), '/__moa/login?next=%2Fchapter%3Fa%3D1%26b%3D2');
    response = await request('/__moa/required', { headers: { 'X-Original-URI': '/api/state' } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'login-required');
    assert.equal((await request('/__moa/login', { headers: { Host: 'evil.test' } })).status, 400);
    assert.equal((await request('/__moa/login', { headers: { Host: 'moa.test:9999' } })).status, 400);
    assert.equal((await request('/__moa/login', { headers: { Host: 'moa.test:18443' } })).status, 200);
    assert.equal((await request('/__moa/login', { method: 'POST', form: { username: 'moa', password: 'test-password' } })).status, 403);
    const diagnosticPage = await request('/__moa/login');
    const diagnosticToken = (await diagnosticPage.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const diagnosticForm = {csrf: diagnosticToken, username:'moa', password:'test-password'};
    const missingCookie = await request('/__moa/login', {method:'POST', form:diagnosticForm, headers:{Cookie:''}, keepCookies:false});
    assert.equal(missingCookie.status,403);
    assert.match(await missingCookie.text(), /확인 코드: L02/);
    const mismatchedCookie = await request('/__moa/login', {method:'POST', form:diagnosticForm, headers:{Cookie:'__Host-moa_csrf=wrong'}, keepCookies:false});
    assert.match(await mismatchedCookie.text(), /확인 코드: L03/);
    assert.equal((await login({ headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await login({ password: 'incorrect' })).status, 401);
    assert.equal((await request('/__moa/check')).status, 401);
    response = await login({ next: '//evil.test' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/__moa/continue?next=%2F');
    const continued = await request(response.headers.get('location'));
    assert.equal(continued.status, 303);
    assert.equal(continued.headers.get('location'), '/');
    const blockedCookie = await request('/__moa/continue?next=%2F', { headers: { Cookie: '' }, keepCookies: false });
    assert.equal(blockedCookie.status, 403);
    assert.match(await blockedCookie.text(), /쿠키 허용/);
    assert.equal(blockedCookie.headers.get('location'), null);
    assert.equal((await request('/__moa/continue?next=https://evil.test')).headers.get('location'), '/');
    const sessionCookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-moa_session='));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) assert.ok(sessionCookie.includes(flag));
    const token = jar.get('__Host-moa_session');
    assert.equal((await request('/__moa/check')).status, 204);
    assert.equal((await request('/__moa/login')).status, 303);
    assert.ok(!(db.prepare('SELECT * FROM sessions').get().token_hash).includes(token));
    await close();
    credentials.users[0].hash = '0'.repeat(128); // Bootstrap file changes must not overwrite DB accounts or revoke sessions.
    await start();
    assert.equal((await request('/__moa/check')).status, 204, 'login survives server restart');
    clock += 2 * 86400000;
    response = await request('/__moa/check');
    assert.equal(response.status, 204);
    assert.ok(response.headers.get('set-cookie').includes('Max-Age=31536000'), 'active remembered login renews');
    jar.set('__Host-moa_session', 'x'.repeat(43));
    assert.equal((await request('/__moa/check')).status, 401);
    jar.set('__Host-moa_session', token);
    response = await request('/__moa/account');
    const csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
    response = await request('/__moa/logout', { method: 'POST', form: { csrf } });
    assert.equal(response.status, 303);
    jar.set('__Host-moa_session', token);
    assert.equal((await request('/__moa/check')).status, 401, 'logout revokes copied cookie too');
    jar.delete('__Host-moa_session');
    response = await login({ remember: '' });
    assert.equal(response.status, 303);
    assert.ok(!response.headers.getSetCookie().find(c => c.startsWith('__Host-moa_session=')).includes('Max-Age'));
    clock += 13 * 3600000;
    assert.equal((await request('/__moa/check')).status, 401);
    jar.delete('__Host-moa_session');
    for (let i = 0; i < 8; i++) assert.equal((await login({ password: 'wrong' })).status, 401);
    assert.equal((await login()).status, 429);
    clock += 16 * 60000;
    assert.equal((await login()).status, 303);
    clock += 366 * 86400000;
    assert.equal((await request('/__moa/check')).status, 401, 'remembered login expires after inactivity');
    jar.delete('__Host-moa_session');
    const alternate = { Host: 'moa.test:18443', Origin: 'https://moa.test:18443' };
    assert.equal((await login({ headers: { Host: 'moa.test', Origin: 'https://moa.test:18443' } })).status, 403,
      'origin must match the actual request host and port');
    assert.equal((await login({ headers: alternate })).status, 303, 'explicitly allowed alternate port can log in');
    assert.equal((await request('/__moa/check', { headers: alternate })).status, 204);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accounts migration, atomic invites, authorization and per-account session revocation', async () => {
  const db = new DatabaseSync(':memory:');
  let clock = Date.now();
  const salt = 'ab'.repeat(30);
  const verifier = scryptSync('admin-password', Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const credentials = { csrfSecret: 'test-secret', users: [{ username: 'Admin', salt, hash: verifier }] };
  db.exec(`CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,username TEXT,expires INTEGER,refreshed INTEGER,remember INTEGER,fingerprint TEXT);
    INSERT INTO sessions VALUES('old','Admin',9999999999999,0,1,'old');`);
  const server = createAuthServer({ database: db, credentials, origin: 'http://auth.test', secure: false, now: () => clock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  function client(ip) {
    const jar = new Map();
    async function request(path, { method = 'GET', form, json, headers = {} } = {}) {
      const data = form ? new URLSearchParams(form).toString() : json === undefined ? undefined : JSON.stringify(json);
      return new Promise((resolve, reject) => {
        const req = httpRequest(address + path, { method, headers: { Host: 'auth.test', 'X-Real-IP': ip,
          Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '),
          ...(data === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data), Origin: 'http://auth.test', 'X-Moa-Request': '1' }), ...headers } }, res => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
            for (const item of res.headers['set-cookie'] ?? []) { const [k,v] = item.split(';')[0].split('='); if (v) jar.set(k,v); else jar.delete(k); }
            const body = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) });
          });
        }); req.on('error', reject); req.end(data);
      });
    }
    const api = (path, method = 'GET', json, headers) => request(`/__moa/api/${path}`, { method, json: method === 'GET' ? undefined : json ?? {}, headers });
    async function formPost(path, fields) {
      const page = await request(`/__moa/${path}`);
      const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1];
      return request(`/__moa/${path}`, { method: 'POST', form: { csrf, ...fields } });
    }
    return { request, api, formPost, jar };
  }
  const admin = client('admin'), member = client('member'), other = client('other');
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    const a = db.prepare('SELECT * FROM accounts').get();
    assert.equal(a.hash, verifier); assert.equal(a.salt, salt); assert.equal(a.role, 'admin');
    const loginPage = await admin.request('/__moa/login');
    const csrfCookie = loginPage.headers['set-cookie'].find(value => value.startsWith('moa_csrf='));
    assert.ok(csrfCookie, 'HTTP cookie must not use the Secure-only __Host- prefix');
    assert.ok(!csrfCookie.includes('; Secure'));
    const localLogin = await admin.formPost('login', { username: 'ADMIN', password: 'admin-password' });
    assert.equal(localLogin.status, 303);
    assert.ok(localLogin.headers['set-cookie'].some(value => value.startsWith('moa_session=')));
    assert.equal((await admin.api('me')).json().id, a.id);
    assert.equal((await admin.request('/__moa/check')).headers['x-moa-role'], 'admin');
    assert.equal((await member.api('accounts')).status, 401);
    for (const headers of [{ Origin: 'http://evil.test' }, { 'X-Moa-Request': '' }, { 'Content-Type': 'text/plain' }, { Origin: '' }]) {
      assert.ok([403,415].includes((await admin.api('invites', 'POST', { maxUses: 1, expiresInDays: 1 }, headers)).status));
    }
    for (const maxUses of [0,101,'1']) assert.equal((await admin.api('invites', 'POST', { maxUses, expiresInDays: 1 })).status, 400);
    let invite = (await admin.api('invites', 'POST', { label: 'friends', maxUses: 1, expiresInDays: 1 })).json();
    assert.equal(invite.status, 'active'); assert.ok(invite.url.includes(invite.code));
    assert.ok((await member.request(`/__moa/join?code=${invite.code}`)).body.includes(`value="${invite.code}"`));
    assert.equal((await member.formPost('join', { code: invite.code, username: 'short', password: '123', confirm: '123' })).status, 400);
    const joined = await Promise.all([member,other].map((c,i) => c.formPost('join', { code: invite.code, username: `user${i}`, password: 'member-password', confirm: 'member-password' })));
    assert.deepEqual(joined.map(r => r.status).sort(), [303,400]);
    const winner = joined[0].status === 303 ? member : other, loser = winner === member ? other : member;
    const m = (await winner.api('me')).json();
    assert.equal(m.role, 'member');
    assert.deepEqual(m.permissions, ['video.watch', 'subtitles.add', 'subtitles.translate']);
    assert.equal((await winner.api(`accounts/${m.id}`, 'PATCH', { permissions: [] })).status, 403);
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { permissions: ['video.watch'] })).status, 204);
    assert.deepEqual((await winner.api('me')).json().permissions, ['video.watch']);
    assert.equal((await winner.request('/__moa/check')).headers['x-moa-permissions'], 'video.watch');
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { permissions: [] })).status, 204);
    assert.deepEqual((await winner.api('me')).json().permissions, []);
    assert.equal((await winner.request('/__moa/check')).headers['x-moa-permissions'], '');
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { permissions: ['video.watch', 'subtitles.add', 'subtitles.translate'] })).status, 204);
    assert.equal((await winner.request('/__moa/check')).headers['x-moa-account'], m.id);
    assert.equal((await admin.api('invites')).json()[0].uses, 1);
    assert.equal((await admin.api('invites')).json()[0].status, 'used-up');
    for (const [path,method] of [['accounts','GET'],['invites','GET'],['invites','POST'],[`accounts/${a.id}`,'DELETE'],[`accounts/${a.id}/reset-password`,'POST']]) assert.equal((await winner.api(path,method)).status, 403);
    assert.equal((await admin.api(`accounts/${a.id}`, 'PATCH', { role: 'member' })).status, 409);
    assert.equal((await admin.api(`accounts/${a.id}`, 'PATCH', { disabled: true })).status, 409);
    assert.equal((await admin.api(`accounts/${a.id}`, 'DELETE')).status, 409);
    const summary = (await admin.api('accounts')).json().find(x => x.id === m.id);
    assert.equal(summary.inviteLabel, 'friends'); assert.ok(summary.lastLoginAt); assert.equal(summary.hash, undefined);
    for (const body of [{ role: null }, { disabled: null }, { role: 'owner' }, { permissions: null }, { permissions: 'video.watch' }, { permissions: ['admin'] }, { permissions: ['video.watch', 'video.watch'] }, {}]) assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', body)).status, 400);
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { disabled: true })).status, 204);
    assert.equal((await winner.api('me')).status, 401); assert.equal((await admin.api('me')).status, 200);
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { disabled: false })).status, 204);
    assert.equal((await winner.formPost('login', { username: m.username, password: 'member-password' })).status, 303);
    assert.equal((await winner.api('password', 'POST', { current: 'wrong', next: 'new-password' })).status, 400);
    assert.equal((await winner.api('password', 'POST', { current: 'member-password', next: 'new-password' })).status, 204);
    assert.equal((await winner.api('me')).status, 401); assert.equal((await admin.api('me')).status, 200);
    assert.equal((await winner.formPost('login', { username: m.username, password: 'new-password' })).status, 303);
    const reset = (await admin.api(`accounts/${m.id}/reset-password`, 'POST')).json();
    assert.ok(reset.temporaryPassword.length >= 8); assert.equal((await winner.api('me')).status, 401);
    assert.equal((await winner.formPost('login', { username: m.username, password: reset.temporaryPassword })).status, 303);
    assert.equal((await admin.api(`accounts/${m.id}`, 'PATCH', { role: 'admin' })).status, 204);
    assert.equal((await winner.api('me')).status, 401, 'role changes revoke this account only');
    assert.equal((await winner.formPost('login', { username: m.username, password: reset.temporaryPassword })).status, 303);
    assert.equal((await winner.api(`accounts/${m.id}`, 'PATCH', { role: 'member' })).status, 204, 'another active admin makes self demotion valid');
    assert.equal((await winner.api('me')).status, 401);
    assert.equal((await admin.api(`accounts/${m.id}`, 'DELETE')).status, 204);
    assert.equal((await winner.api('me')).status, 401);
    invite = (await admin.api('invites', 'POST', { maxUses: null, expiresInDays: null })).json();
    assert.equal(invite.expiresAt, null);
    assert.equal((await admin.api(`invites/${invite.id}`, 'DELETE')).status, 204);
    assert.equal((await loser.formPost('join', { code: invite.code, username: 'revoked', password: 'test-password', confirm: 'test-password' })).status, 400);
    invite = (await admin.api('invites', 'POST', { maxUses: 2, expiresInDays: 1 })).json();
    clock += 86400001;
    // Renew the non-remembered admin session after moving the test clock.
    assert.equal((await admin.formPost('login', { username: 'admin', password: 'admin-password' })).status, 303);
    assert.equal((await loser.formPost('join', { code: invite.code, username: 'expired', password: 'test-password', confirm: 'test-password' })).status, 400);
    assert.equal((await admin.api('invites')).json().find(i => i.id === invite.id).status, 'expired');
    invite = (await admin.api('invites', 'POST', { maxUses: null, expiresInDays: null })).json();
    assert.equal((await loser.formPost('join', { code: invite.code, username: 'ADMIN', password: 'test-password', confirm: 'test-password' })).status, 409);
    assert.equal(db.prepare('SELECT uses FROM invites WHERE id=?').get(invite.id).uses, 0);
    // Revoke while an API request is still receiving its JSON body.
    let delayed;
    const pending = new Promise((resolve, reject) => {
      delayed = httpRequest(address + '/__moa/api/invites', { method: 'POST', headers: {
        Host: 'auth.test', Origin: 'http://auth.test', 'X-Moa-Request': '1', 'Content-Type': 'application/json',
        Cookie: [...admin.jar].map(([k,v]) => `${k}=${v}`).join('; '),
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      delayed.on('error', reject); delayed.write('{');
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await admin.api('logout', 'POST')).status, 204);
    delayed.end('"maxUses":1,"expiresInDays":1}');
    assert.equal(await pending, 401, 'revoked session cannot complete a buffered mutation');
    assert.equal((await admin.api('me')).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('trusted gateway chooses cookie security per request and accepts current host with same-origin CSRF', async () => {
  const db = new DatabaseSync(':memory:');
  const salt = 'ab'.repeat(32);
  const credentials = { csrfSecret: 'test-csrf', users: [{ username: 'admin', salt, hash: scryptSync('test-password', Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex') }] };
  const secretDir = mkdtempSync(join(tmpdir(), 'moa-safety-'));
  const secretFile = join(secretDir, 'token'); writeFileSync(secretFile, 'test-rpc-token');
  const server = createAuthServer({ credentials, database: db, origin: 'https://moa.example.com', trustProxy: true, connectorSecretFile: secretFile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (host, proto, path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method: options.method || 'GET', headers: { Host: host, 'X-Forwarded-Proto': proto, ...options.headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => {
        const headers = new Headers(); for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers }));
      });
    }); req.on('error', reject); req.end(options.body?.toString());
  });
  try {
    for (const [host, proto] of [['192.168.1.2:8796', 'http'], ['localhost:8796', 'http'], ['example.trycloudflare.com', 'https'], ['moa.example.ts.net', 'https']]) {
      const page = await request(host, proto, '/__moa/login'); assert.equal(page.status, 200);
      const cookie = page.headers.getSetCookie()[0];
      assert.equal(cookie.includes('; Secure'), proto === 'https'); assert.equal(cookie.startsWith('__Host-'), proto === 'https');
      const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
      const headers = { Cookie: cookie.split(';')[0], Origin: `${proto}://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' };
      const body = new URLSearchParams({ csrf, username: 'admin', password: 'test-password', next: '//evil.example' });
      const denied = await request(host, proto, '/__moa/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body });
      assert.equal(denied.status, 403);
      const login = await request(host, proto, '/__moa/login', { method: 'POST', headers, body }); assert.equal(login.status, 303);
      assert.equal(login.headers.get('location'), '/__moa/continue?next=%2F');
      const sessionCookie = login.headers.getSetCookie()[0]; assert.equal(sessionCookie.includes('; Secure'), proto === 'https');
      const check = await request(host, proto, '/__moa/check', { headers: { Cookie: sessionCookie.split(';')[0] } }); assert.equal(check.status, 204);
      if (proto === 'https') {
        const legacy = await request(host, proto, '/__moa/check', { headers: { Cookie: sessionCookie.split(';')[0].replace('__Host-', '') } }); assert.equal(legacy.status, 204);
      }
    }
    const safety = headers => request('localhost', 'http', '/internal/remote-access-safety', { headers });
    assert.equal((await safety({})).status, 401);
    assert.equal((await (await safety({ Authorization: 'Bearer test-rpc-token' })).json()).adminExists, true);
    db.prepare("UPDATE accounts SET disabled=1 WHERE role='admin'").run();
    assert.equal((await (await safety({ Authorization: 'Bearer test-rpc-token' })).json()).adminExists, false);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(secretDir, { recursive: true, force: true }); }
});
