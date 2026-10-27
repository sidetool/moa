import { isIP, Socket } from 'node:net';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import type { ClientRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { SocksClient } from 'socks';

// MOA outbound proxy implementation; GPL-3.0-or-later. See NOTICE.md.
export function parseOutboundProxy(value: unknown): string | undefined {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('compatibility_preferences_invalid');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('compatibility_preferences_invalid');
  }
  if (
    !['http:', 'https:', 'socks5:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    (url.port && Number(url.port) < 1)
  )
    throw new Error('compatibility_preferences_invalid');
  return url.href;
}

/** Keep the approved destination IP, original Host header, TLS hostname and certificate verification. */
export function pinnedProxyAgent(proxy: string | undefined, destination: URL, address: string, signal: AbortSignal): Agent | undefined {
  const normalized = parseOutboundProxy(proxy);
  if (!normalized) return undefined;
  const hostname = destination.hostname.replace(/^\[|\]$/g, '');
  const tlsOptions = {
    servername: isIP(hostname) ? undefined : hostname,
    checkServerIdentity: (_name: string, certificate: import('node:tls').PeerCertificate) =>
      checkServerIdentity(hostname, certificate),
  };
  if (normalized.startsWith('socks5:')) {
    const proxyUrl = new URL(normalized);
    return new (class extends Agent {
      async connect(_req: ClientRequest, options: AgentConnectOpts) {
        signal.throwIfAborted();
        const socket = new Socket({ signal });
        try {
          const connected = once(socket, 'connect', { signal });
          socket.connect(Number(proxyUrl.port || 1080), proxyUrl.hostname.replace(/^\[|\]$/g, ''));
          await connected;
          await SocksClient.createConnection({
            proxy: { host: proxyUrl.hostname, port: Number(proxyUrl.port || 1080), type: 5 },
            destination: { host: address, port: Number(options.port) },
            command: 'connect',
            existing_socket: socket,
            timeout: 15000,
          });
          signal.throwIfAborted();
          return options.secureEndpoint ? connectTls({ ...options, ...tlsOptions, socket }) : socket;
        } catch (error) {
          socket.destroy();
          throw Object.assign(new Error('source_connection_failed'), { cause: error });
        }
      }
    })();
  }
  const agent = new HttpsProxyAgent(normalized, { signal, timeout: 15000 });
  const connect = agent.connect.bind(agent);
  agent.connect = async (req, options) => {
    signal.throwIfAborted();
    const pinnedOptions = { ...options, host: address, ...tlsOptions };
    const socket = await connect(req, pinnedOptions);
    if (signal.aborted) {
      socket.destroy();
      signal.throwIfAborted();
    }
    return socket;
  };
  return agent;
}
