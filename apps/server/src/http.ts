import type { Account } from '@moa/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

declare module 'fastify' { interface FastifyRequest { moaProfile?: string; moaAccount: Account } }
const TYPES = ['movie', 'series', 'anime'];
export const string = { type: 'string', minLength: 1, maxLength: 200 };
export const idParams = (key = 'id') => ({ type: 'object', required: [key], properties: { [key]: string } });
export const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const pageQuery = { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 };
export const typeQuery = { type: 'string', enum: TYPES };
export const profile = (req: FastifyRequest) => req.moaProfile!;
export const params = (req: FastifyRequest) => req.params as Record<string, string>;
export const query = (req: FastifyRequest) => req.query as Record<string, any>;

export async function sendFile(reply: FastifyReply, file: string, mime: string, range?: string) {
  const info = await stat(file), size = info.size;
  reply.type(mime).header('Accept-Ranges', 'bytes');
  if (!range) return reply.header('Content-Length', size).send(createReadStream(file));
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid = () => reply.code(416).header('Content-Range', `bytes */${size}`).send();
  if (!match || !size || (!match[1] && !match[2])) return invalid();
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!(suffix > 0)) return invalid(); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return invalid();
  return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(createReadStream(file, { start, end }));
}
