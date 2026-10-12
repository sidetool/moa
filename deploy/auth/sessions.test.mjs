import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createAuthServer } from './server.mjs';
import { migrateAccounts, passwordHash } from './accounts.mjs';

test('existing sessions appear before their next request and gain device names when used', async () => {
  const db = new DatabaseSync(':memory:'), credentials = { users: [], csrfSecret: 'session-migration-test' };
  const timestamp = Date.now();
  migrateAccounts(db, credentials, () => timestamp);
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('owner', 'owner', 'salt', 'hash', 'member', timestamp);
  const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  for (const token of tokens) db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'owner', timestamp + 86400000, timestamp, 1);
  const server = createAuthServer({ database: db, credentials, origin: 'http://localhost', secure: false, allowAnyHost: true, now: () => timestamp + 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM session_devices').get().n, 2);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = async token => (await fetch(`${origin}/__moa/api/sessions`, { headers: { Cookie: `moa_session=${token}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/132' } })).json();
    const list = await request(tokens[0]);
    assert.equal(list.length, 2);
    const unseen = list.find(device => !device.current);
    assert.equal(unseen.name, '브라우저');
    assert.equal(unseen.createdAt, timestamp);
    assert.equal(list.find(device => device.current).name, 'Firefox · Windows');
    const enriched = await request(tokens[1]);
    assert.equal(enriched.find(device => device.current).id, unseen.id);
    assert.equal(enriched.find(device => device.current).name, 'Firefox · Windows');
    migrateAccounts(db, credentials, () => timestamp + 2000);
    assert.equal(db.prepare('SELECT count(*) n FROM session_devices').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 2);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('login devices expose no credentials and revoke only the current account sessions', async () => {
  const db = new DatabaseSync(':memory:');
  const server = createAuthServer({ database: db, credentials: { users: [], csrfSecret: 'session-test' }, origin: 'http://localhost', secure: false, allowAnyHost: true });
  const account = id => db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id, id, 'salt', 'hash', 'member', Date.now());
  account('first'); account('second');
  const issue = id => {
    const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash, id, Date.now() + 86400000, Date.now(), 1);
    return { token, hash };
  };
  const first = issue('first'), otherDevice = issue('first'), second = issue('second');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (session, path = 'sessions', method = 'GET', extra = {}) => fetch(`${origin}/__moa/api/${path}`, { method,
    headers: { Cookie: `moa_session=${session.token}`, 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/131 Safari/537 Edg/131', Origin: origin, 'Content-Type': 'application/json', 'X-Moa-Request': '1', ...extra },
    ...(method === 'GET' ? {} : { body: '{}' }) });
  try {
    await request(otherDevice); await request(second);
    const response = await request(first), list = await response.json();
    assert.equal(response.status, 200); assert.equal(list.length, 2);
    assert.equal(list.filter(device => device.current).length, 1);
    assert.equal(list[0].name, 'Edge · macOS');
    assert.ok(!JSON.stringify(list).includes(first.hash)); assert.ok(!JSON.stringify(list).includes(first.token));
    const foreign = (await (await request(second)).json())[0];
    assert.equal((await request(first, `sessions/${foreign.id}`, 'DELETE')).status, 404);
    assert.equal((await request(first, 'sessions', 'DELETE', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(first, `sessions/${list.find(device => !device.current).id}`, 'DELETE')).status, 204);
    assert.equal((await request(otherDevice)).status, 401);
    assert.equal((await request(first, `sessions/${randomUUID()}`, 'DELETE')).status, 404);
    assert.equal((await request(first, 'sessions', 'DELETE')).status, 204);
    assert.equal((await request(first)).status, 200); assert.equal((await request(second)).status, 200);
    const current = (await (await request(first)).json())[0];
    assert.equal((await request(first, `sessions/${current.id}`, 'DELETE')).status, 204);
    assert.equal((await request(first)).status, 401);
    assert.equal(db.prepare('SELECT count(*) n FROM session_devices').get().n, 1);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('remembered login duration persists per account and controls issuance, renewal and expiry', async () => {
  const db = new DatabaseSync(':memory:'), credentials = { users: [], csrfSecret: 'duration-test' };
  const day = 86400000;
  let clock = Date.now();
  const server = createAuthServer({ database: db, credentials, origin: 'http://localhost', secure: false, allowAnyHost: true, now: () => clock });
  const salt = randomBytes(30).toString('hex'), password = 'test-duration-password';
  const passwordValue = await passwordHash(password, salt);
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id, id, salt, passwordValue, 'member', clock);
  const issue = (id, remember = 1) => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, clock + (remember ? 365 * day : day / 2), clock, remember);
    return token;
  };
  let token = issue('owner');
  issue('owner'); issue('other');
  const temporary = issue('owner', 0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, data, extra = {}) => fetch(`${origin}/__moa/${path}`, {
    redirect: 'manual', method: data ? 'PATCH' : 'GET', headers: { Cookie: `moa_session=${token}`, Origin: origin, 'X-Moa-Request': '1', 'Content-Type': 'application/json', ...extra },
    ...(data ? { body: JSON.stringify(data) } : {})
  });
  const login = async remember => {
    const page = await fetch(`${origin}/__moa/login`);
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
    return fetch(`${origin}/__moa/login`, { redirect: 'manual', method: 'POST', headers: { Cookie: `moa_csrf=${csrf}`, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, username: 'owner', password, remember }) });
  };
  try {
    assert.deepEqual(await (await request('api/session-settings')).json(), { days: 365 });
    for (const data of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { days: '30' }, { days: 7, accountId: 'other' }]) assert.equal((await request('api/session-settings', data)).status, 400);
    assert.equal((await request('api/session-settings', { days: 7 }, { Origin: 'https://evil.example' })).status, 403);
    let response = await request('api/session-settings', { days: 7 });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=604800/);
    assert.deepEqual(db.prepare("SELECT DISTINCT expires FROM sessions WHERE account_id='owner' AND remember=1").all().map(row => row.expires), [clock + 7 * day]);
    assert.equal(db.prepare("SELECT session_days FROM accounts WHERE id='other'").get().session_days, 365);
    assert.equal(db.prepare("SELECT expires FROM sessions WHERE account_id='other'").get().expires, clock + 365 * day);
    const temporaryExpiry = db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(createHash('sha256').update(temporary).digest('hex')).expires;
    assert.equal(temporaryExpiry, clock + day / 2);
    migrateAccounts(db, credentials, () => clock);
    assert.deepEqual(await (await request('api/session-settings')).json(), { days: 7 });
    response = await login('on');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('set-cookie'), /Max-Age=604800/);
    token = response.headers.getSetCookie().find(value => value.startsWith('moa_session=')).split(';')[0].slice('moa_session='.length);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    assert.equal(db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(tokenHash).expires, clock + 7 * day);
    clock += 2 * day;
    response = await request('check');
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie'), /Max-Age=604800/);
    assert.equal(db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(tokenHash).expires, clock + 7 * day);
    response = await request('api/session-settings', { days: 1 });
    assert.equal(response.status, 200);
    clock += day / 2;
    assert.match((await request('check')).headers.get('set-cookie'), /Max-Age=86400/);
    clock += day;
    assert.equal((await request('check')).status, 401);
    response = await login('');
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('moa_session='));
    assert.ok(!sessionCookie.includes('Max-Age'));
    token = sessionCookie.split(';')[0].slice('moa_session='.length);
    response = await request('api/session-settings', { days: 30 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    clock += day / 2;
    assert.equal((await request('check')).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
