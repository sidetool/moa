import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../db.js';
import { ApiFailure } from '../util.js';

const derive = promisify(scrypt);
const LIFETIME = 12 * 60 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
const tokenOf = (request: FastifyRequest) => /(?:^|;\s*)moa_profile_unlock=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || '')?.[1] || '';
const sessionOf = (request: FastifyRequest) => createHash('sha256').update(/(?:^|;\s*)(?:__Host-)?moa_session=([^;]+)/.exec(request.headers.cookie || '')?.[1] || '').digest('hex');

export async function hashPin(pin: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(pin, salt, 32) as Buffer).toString('hex')}`;
}

export class ProfilePins {
  private grants = new Map<string, { profile: string; account: string; session: string; hash: string; expires: number }>();
  constructor(private db: Store) {
    db.db.exec('CREATE TABLE IF NOT EXISTS profile_pin_attempts(profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)');
  }
  assert(id: string, request: FastifyRequest) {
    const hash = this.db.get('SELECT pin_hash FROM profiles WHERE id=?', id)?.pin_hash;
    if (!hash) return;
    const grant = this.grants.get(tokenOf(request));
    if (!grant || grant.profile !== id || grant.account !== request.moaAccount.id || grant.session !== sessionOf(request) || grant.hash !== hash || grant.expires <= Date.now()) throw new ApiFailure(401, 'profile-locked');
  }
  async unlock(id: string, pin: string, request: FastifyRequest, reply: FastifyReply) {
    const token = tokenOf(request), grant = this.grants.get(token);
    const hash: string | null = this.db.get('SELECT pin_hash FROM profiles WHERE id=? AND account_id=?', id, request.moaAccount.id)?.pin_hash;
    if (hash) {
      const now = Date.now(), previous = this.db.get('SELECT * FROM profile_pin_attempts WHERE profile_id=?', id);
      const attempts = previous && previous.expires > now ? previous.attempts : 0;
      if (attempts >= 5) throw new ApiFailure(429, 'profile-pin-rate-limit');
      this.db.run('INSERT OR REPLACE INTO profile_pin_attempts VALUES(?,?,?)', id, attempts + 1, attempts ? previous!.expires : now + WINDOW);
      const [salt, value] = hash.split(':');
      const expected = Buffer.from(value, 'hex'), actual = await derive(pin, salt, 32) as Buffer;
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || this.db.get('SELECT pin_hash FROM profiles WHERE id=?', id)?.pin_hash !== hash) throw new ApiFailure(401, 'profile-pin-invalid');
      if (grant && this.grants.get(token) !== grant) throw new ApiFailure(401, 'profile-locked');
      this.db.run('DELETE FROM profile_pin_attempts WHERE profile_id=?', id);
    }
    this.grant(id, request, reply);
  }
  grant(id: string, request: FastifyRequest, reply: FastifyReply) {
    const hash = this.db.get('SELECT pin_hash FROM profiles WHERE id=?', id)?.pin_hash || '';
    this.grants.delete(tokenOf(request));
    for (const [token, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(token);
    while (this.grants.size >= 4096) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, { profile: id, account: request.moaAccount.id, session: sessionOf(request), hash, expires: Date.now() + LIFETIME });
    this.cookie(token, request, reply);
  }
  lock(request: FastifyRequest, reply: FastifyReply) {
    this.grant('', request, reply);
  }
  invalidate(id: string) {
    for (const [token, grant] of this.grants) if (grant.profile === id) this.grants.delete(token);
    this.db.run('DELETE FROM profile_pin_attempts WHERE profile_id=?', id);
  }
  private cookie(token: string, request: FastifyRequest, reply: FastifyReply) {
    const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
    reply.header('Set-Cookie', `moa_profile_unlock=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME / 1000}${secure ? '; Secure' : ''}`);
    reply.header('Cache-Control', 'no-store');
  }
}
