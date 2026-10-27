import { BlockList, isIP } from 'node:net';
import type { TranslationConfig } from '@moa/shared';
import { ApiFailure } from '../util.js';

export const DEFAULT_MODEL = 'gemini-flash-latest';
export const ENDPOINTS = { gemini: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1' };
export type Endpoint = Pick<TranslationConfig, 'provider' | 'baseUrl'>;
export const DEFAULT_ENDPOINT: Endpoint = { provider: 'gemini', baseUrl: ENDPOINTS.gemini };
export const validModel = (model: string) => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model);
export const validKey = (key: unknown): key is string => typeof key === 'string' && /^[\x21-\x7e]{1,512}$/.test(key);
const localAddresses = new BlockList();
for (const [network, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const)
  localAddresses.addSubnet(network, prefix);
localAddresses.addAddress('::1', 'ipv6');
localAddresses.addSubnet('fc00::', 7, 'ipv6');
localAddresses.addSubnet('fe80::', 10, 'ipv6');
export const localEndpoint = (url: URL) => {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return ['localhost', 'host.docker.internal'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local') ||
    Boolean(isIP(host) && localAddresses.check(host, isIP(host) === 6 ? 'ipv6' : 'ipv4'));
};
export function normalizeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    if (raw.length > 2048 || !(url.protocol === 'https:' || url.protocol === 'http:' && localEndpoint(url)) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new ApiFailure(400, 'translation-endpoint-invalid');
  }
}
