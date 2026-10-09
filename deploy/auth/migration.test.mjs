import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openState } from './state.mjs';
import { createAuthServer } from './server.mjs';

test('pre-setup accounts-v1 HTTPS session survives state migration and repeated restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-upgrade-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, CREDENTIALS_FILE: process.env.CREDENTIALS_FILE };
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expires = Date.now() + 86400000;
  let db, server;
  try {
    // Schema and session format from the existing accounts-v1 auth service,
    // deliberately without first-run setup's auth_state table.
    db = new DatabaseSync(join(dir, 'sessions.sqlite'));
    db.exec(`CREATE TABLE auth_migrations(id TEXT PRIMARY KEY);
      INSERT INTO auth_migrations VALUES('accounts-v1');
      CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,salt TEXT NOT NULL,hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),disabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,invite_id TEXT,last_login_at INTEGER);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL,refreshed INTEGER NOT NULL,remember INTEGER NOT NULL);`);
    db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('existing-admin', 'existing', 'test-salt', 'unchanged-test-hash', 'admin', Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(tokenHash, 'existing-admin', expires, Date.now(), 1);
    db.close(); db = null;
    process.env.DATA_DIR = dir; process.env.CREDENTIALS_FILE = join(dir, 'credentials.json');
    writeFileSync(process.env.CREDENTIALS_FILE, JSON.stringify({ csrfSecret: 'existing-test-csrf', users: [] }));
    for (let restart = 0; restart < 2; restart++) {
      const state = openState(); db = state.database;
      assert.equal(state.credentials.csrfSecret, 'existing-test-csrf');
      server = createAuthServer({ ...state, origin: 'https://moa.example.com', trustProxy: true });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const headers = { 'X-Forwarded-Proto': 'https', Cookie: `__Host-moa_session=${token}` };
      const response = await fetch(origin + '/__moa/check', { headers });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-moa-role'), 'admin');
      assert.equal(response.headers.get('x-moa-permissions'), 'video.watch,subtitles.add,subtitles.translate');
      assert.equal(response.headers.get('x-moa-account'), 'existing-admin');
      assert.equal((await fetch(origin + '/__moa/setup', { headers })).status, 404);
      assert.equal(db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(tokenHash).expires, expires);
      assert.equal(db.prepare('SELECT hash FROM accounts WHERE id=?').get('existing-admin').hash, 'unchanged-test-hash');
      await new Promise(resolve => server.close(resolve)); server = null; db.close(); db = null;
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve)); db?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
