import { randomUUID, randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const passwordHash = async (password, salt) => (await derive(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
export const passwordValid = value => typeof value === 'string' && value.length >= 8 && value.length <= 1024;
export const permissions = ['video.watch', 'subtitles.add', 'subtitles.translate'];
export const accountView = row => ({ id: row.id, username: row.username, role: row.role, permissions: row.role === 'admin' ? [...permissions] : JSON.parse(row.permissions) });
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function migrateAccounts(db, credentials, now) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS auth_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member')), disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, invite_id TEXT, last_login_at INTEGER);
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, max_uses INTEGER,
      uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  transaction(db, () => {
    if (!db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'permissions')) db.exec(`ALTER TABLE accounts ADD COLUMN permissions TEXT NOT NULL DEFAULT '${JSON.stringify(permissions)}'`);
    if (!db.prepare("SELECT 1 FROM auth_migrations WHERE id='accounts-v1'").get()) {
      for (const user of credentials.users ?? []) db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), user.username, user.salt, user.hash, 'admin', now());
      // Legacy fingerprint sessions are deliberately invalidated once, never on later account changes.
      db.exec('DROP TABLE IF EXISTS sessions');
      db.prepare("INSERT INTO auth_migrations VALUES('accounts-v1')").run();
    }
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL, refreshed INTEGER NOT NULL, remember INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);`);
  });
}
export function accountsService(db, origin, now) {
  const get = id => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  const invalidate = id => db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);
  const inviteView = (row, requestOrigin = origin) => ({ id: row.id, code: row.code, url: `${requestOrigin}/__moa/join?code=${encodeURIComponent(row.code)}`,
    label: row.label, maxUses: row.max_uses, uses: row.uses, expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revoked: Boolean(row.revoked), createdAt: new Date(row.created_at).toISOString(),
    status: row.revoked ? 'revoked' : row.expires_at !== null && row.expires_at <= now() ? 'expired' : row.max_uses !== null && row.uses >= row.max_uses ? 'used-up' : 'active' });
  async function verify(user, password) {
    const salt = user?.salt ?? '00'.repeat(30);
    const derived = await passwordHash(typeof password === 'string' && password.length <= 1024 ? password : '', salt);
    return Boolean(user && !user.disabled && timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(user.hash, 'hex')));
  }
  async function changePassword(user, next, admin) {
    if (!passwordValid(next)) fail(400, 'invalid-password');
    const salt = randomBytes(30).toString('hex'), hash = await passwordHash(next, salt);
    transaction(db, () => {
      // An in-flight password change cannot undo another reset or disable.
      const current = get(user.id);
      if (admin) { const actor = get(admin.id); if (!actor || actor.disabled || actor.role !== 'admin' || !db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?').get(admin.token_hash, now())) fail(403, 'admin-required'); }
      if (!current || (!admin && current.disabled) || current.hash !== user.hash) fail(409, 'account-changed');
      db.prepare('UPDATE accounts SET salt=?,hash=? WHERE id=?').run(salt, hash, user.id);
      invalidate(user.id);
    });
  }
  async function setup(code, username, password) {
    username = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) fail(400, 'invalid-username');
    if (!passwordValid(password)) fail(400, 'invalid-password');
    const salt = randomBytes(30).toString('hex'), hash = await passwordHash(password, salt);
    return transaction(db, () => {
      if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) fail(409, 'already-set-up');
      const stored = db.prepare("SELECT value FROM auth_state WHERE key='setup-code'").get()?.value;
      const candidate = String(code ?? '').trim().toUpperCase();
      if (!stored || !timingSafeEqual(createHash('sha256').update(stored).digest(), createHash('sha256').update(candidate).digest())) fail(400, 'invalid-setup-code');
      const id = randomUUID();
      db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id, username, salt, hash, 'admin', now());
      db.prepare("DELETE FROM auth_state WHERE key='setup-code'").run();
      return get(id);
    });
  }
  async function join(code, username, password) {
    username = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) fail(400, 'invalid-username');
    if (!passwordValid(password)) fail(400, 'invalid-password');
    const salt = randomBytes(30).toString('hex'), hash = await passwordHash(password, salt);
    return transaction(db, () => {
      const invite = db.prepare('SELECT * FROM invites WHERE code=?').get(String(code).trim().toUpperCase());
      if (!invite || inviteView(invite).status !== 'active') fail(400, 'invalid-invite');
      if (db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username)) fail(409, 'username-taken');
      const id = randomUUID();
      db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at,invite_id) VALUES(?,?,?,?,?,?,?)').run(id, username, salt, hash, 'member', now(), invite.id);
      db.prepare('UPDATE invites SET uses=uses+1 WHERE id=?').run(invite.id);
      return get(id);
    });
  }
  async function api(method, path, actor, body, requestOrigin = origin) {
    if (method === 'GET' && path === 'me') return accountView(actor);
    if (method === 'POST' && path === 'password') {
      if (!await verify(actor, body.current)) fail(400, 'incorrect-password');
      await changePassword(actor, body.next); return null;
    }
    if (actor.role !== 'admin') fail(403, 'admin-required');
    if (path === 'invites' && method === 'GET') return db.prepare('SELECT * FROM invites ORDER BY created_at DESC,id').all().map(row => inviteView(row, requestOrigin));
    if (path === 'invites' && method === 'POST') {
      const { label = '', maxUses, expiresInDays } = body;
      if (typeof label !== 'string' || label.length > 200 || !(maxUses === null || Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100) ||
        !(expiresInDays === null || Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 90)) fail(400, 'invalid-request');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      // 16 independent characters (~79 bits), grouped for manual entry.
      const code = Array.from(randomBytes(16), b => alphabet[b % alphabet.length]).join('').match(/.{4}/g).join('-');
      const id = randomUUID();
      db.prepare('INSERT INTO invites(id,code,label,max_uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id, code, label, maxUses, expiresInDays === null ? null : now() + expiresInDays * 86400000, actor.id, now());
      return inviteView(db.prepare('SELECT * FROM invites WHERE id=?').get(id), requestOrigin);
    }
    const invite = /^invites\/([^/]+)$/.exec(path);
    if (invite && method === 'DELETE') {
      if (!db.prepare('UPDATE invites SET revoked=1 WHERE id=?').run(invite[1]).changes) fail(404, 'invite-not-found');
      return null;
    }
    if (path === 'accounts' && method === 'GET') return db.prepare('SELECT a.*,i.label AS invite_label FROM accounts a LEFT JOIN invites i ON i.id=a.invite_id ORDER BY a.created_at,a.id').all().map(a => ({
      ...accountView(a), disabled: Boolean(a.disabled), createdAt: new Date(a.created_at).toISOString(), lastLoginAt: a.last_login_at === null ? null : new Date(a.last_login_at).toISOString(), inviteLabel: a.invite_label ?? null,
    }));
    const match = /^accounts\/([^/]+)(\/reset-password)?$/.exec(path);
    if (!match) fail(404, 'not-found');
    const user = get(match[1]);
    if (!user) fail(404, 'account-not-found');
    if (match[2] && method === 'POST') {
      const temporaryPassword = randomBytes(18).toString('base64url');
      await changePassword(user, temporaryPassword, actor); return { temporaryPassword };
    }
    if (!match[2] && ['PATCH', 'DELETE'].includes(method)) return transaction(db, () => {
      const user = get(match[1]);
      if (!user) fail(404, 'account-not-found');
      const currentActor = get(actor.id);
      if (!currentActor || currentActor.disabled || currentActor.role !== 'admin') fail(403, 'admin-required');
      const role = Object.hasOwn(body, 'role') ? body.role : user.role, disabled = Object.hasOwn(body, 'disabled') ? body.disabled : Boolean(user.disabled);
      if (method === 'PATCH' && (!Object.keys(body).length || Object.keys(body).some(k => !['role','disabled','permissions'].includes(k)) || !['admin','member'].includes(role) || typeof disabled !== 'boolean')) fail(400, 'invalid-request');
      const allowed = Object.hasOwn(body, 'permissions') ? body.permissions : JSON.parse(user.permissions);
      if (!Array.isArray(allowed) || allowed.some(value => !permissions.includes(value)) || new Set(allowed).size !== allowed.length) fail(400, 'invalid-request');
      if (user.id === actor.id && (method === 'DELETE' || disabled)) fail(409, 'self-protected');
      if (user.role === 'admin' && !user.disabled && (method === 'DELETE' || role !== 'admin' || disabled) && db.prepare("SELECT count(*) AS n FROM accounts WHERE role='admin' AND disabled=0").get().n <= 1) fail(409, 'last-admin');
      if (method === 'DELETE') db.prepare('DELETE FROM accounts WHERE id=?').run(user.id);
      else {
        db.prepare('UPDATE accounts SET role=?,disabled=?,permissions=? WHERE id=?').run(role, Number(disabled), JSON.stringify(allowed), user.id);
        if (disabled || role !== user.role) invalidate(user.id);
      }
      return null;
    });
    fail(404, 'not-found');
  }
  return { get, verify, join, setup, api };
}
