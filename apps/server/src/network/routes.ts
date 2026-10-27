import type { FastifyInstance } from 'fastify';
import { object } from '../http.js';
import type { Sources } from '../sources/service.js';
import { ApiFailure } from '../util.js';
import type { RemoteAccess } from './remote-access.js';

export function registerNetworkRoutes(app: FastifyInstance, { remoteAccess, sources }: {
  remoteAccess: RemoteAccess; sources: Sources;
}) {
  app.get('/api/admin/remote-access', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(remoteAccess.status()));
  const remoteConfigSchema = object({ mode: { type: 'string', enum: ['off', 'cloudflare-quick', 'cloudflare-token', 'tailscale'] }, publicHostname: { type: 'string', maxLength: 253 }, funnel: { type: 'boolean' }, cloudflareToken: { type: ['string', 'null'], minLength: 1, maxLength: 8192 }, tailscaleAuthKey: { type: ['string', 'null'], minLength: 1, maxLength: 1024 } }, ['mode']);
  for (const action of ['configure', 'start', 'stop'] as const) {
    app.post(`/api/admin/remote-access/${action}`, { schema: { body: action === 'configure' ? remoteConfigSchema : object({}) } }, async (req, reply) => {
      // Require a JSON request and same-origin browser mutations; no form POST CSRF.
      if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiFailure(415, 'json-required');
      if (req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`) throw new ApiFailure(403, 'csrf-required');
      return reply.header('Cache-Control', 'private, no-store').send(await remoteAccess.mutate(action, req.body as import('@moa/shared').RemoteAccessConfigure));
    });
  }
  app.get('/api/network', async () => sources.network());
  app.patch('/api/network', { schema: { body: object({ defaultProxy: { type: 'string', maxLength: 2048 }, byedpiEnabled: { type: 'boolean' }, revision: { type: 'integer', minimum: 0 } }, ['defaultProxy','revision']) } }, async req => { const body = req.body as { defaultProxy: string; revision: number; byedpiEnabled?: boolean }; return sources.configureNetwork(body.defaultProxy,body.revision,body.byedpiEnabled); });
  app.post('/api/network/test', { schema: { body: object({ defaultProxy: { type: 'string', maxLength: 2048 }, byedpiEnabled: { type: 'boolean' } }, ['defaultProxy']) } }, async req => { const b = req.body as { defaultProxy: string; byedpiEnabled?: boolean }; return sources.testNetwork(b.defaultProxy, b.byedpiEnabled); });
}
