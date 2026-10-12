import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createAuthServer } from './server.mjs';
import { migrateAccounts } from './accounts.mjs';

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
