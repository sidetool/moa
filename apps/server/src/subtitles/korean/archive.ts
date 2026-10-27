import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl, { type Entry, type ZipFile } from "yauzl";
import iconv from "iconv-lite";
import type { Readable } from "node:stream";
import { decodeSubtitleBuffer, convertSubtitle } from "./convert.js";
import { parseEpisodes, parseSeason } from "./normalize.js";

export interface ExtractOptions {
  episode: number;
  /** Optional identity validation supplied by the title-aware collector. */
  acceptFilename?: (name: string) => boolean;
  alternateEpisode?: number;
  season?: number;
  /** Only true when the post/title or attachment label established this episode. */
  allowUnnumbered?: boolean;
  maxZipBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}
export interface ExtractedSubtitle { filename: string; format: "ass" | "vtt"; content: string; matchedEpisode: number; exactEpisode: boolean }

export function safeZipPath(name: string): boolean {
  return !!name && !/[\x00-\x1f]/.test(name) && !/^(?:[\\/]|[A-Za-z]:)/.test(name) &&
    !name.replace(/\\/g, "/").split("/").some(part => part === "..") &&
    !name.startsWith("__MACOSX/");
}

function filenameFor(entry: Entry): string {
  const raw = entry.fileName as unknown as Buffer;
  if (entry.generalPurposeBitFlag & 0x800) return iconv.decode(raw, "utf8");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { return iconv.decode(raw, "cp949"); }
}

function rank(name: string, options: ExtractOptions): { rank: number; episode: number; exact: boolean } | undefined {
  if (options.acceptFilename?.(name) === false) return undefined;
  if (options.season && parseSeason(name) && parseSeason(name) !== options.season) return undefined;
  const episodes = parseEpisodes(name);
  if (episodes.length > 1) return undefined; // A range-labelled subtitle is not one confirmed episode.
  const choices = parseSeason(name) ? [options.episode] : [options.episode, options.alternateEpisode];
  const match = choices.find(ep => ep !== undefined && episodes.includes(ep));
  if (match === undefined && (episodes.length || !options.allowUnnumbered)) return undefined;
  const ext = name.split(".").at(-1)?.toLowerCase();
  if (!ext || !["ass", "ssa", "smi", "srt", "vtt"].includes(ext)) return undefined;
  return { rank: (match !== undefined ? 100 : 0) + (ext === "ass" || ext === "ssa" ? 5 : 0), episode: match ?? options.episode, exact: match !== undefined };
}

export async function extractSubtitleBuffer(input: Uint8Array, filename: string, options: ExtractOptions): Promise<ExtractedSubtitle | null> {
  const buf = Buffer.from(input);
  options.signal?.throwIfAborted();
  if (isOtherArchive(buf)) return extractOtherArchive(buf, options);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    if (options.acceptFilename?.(filename) === false) return null;
    const score = rank(filename, options);
    // Unknown filenames from cloud downloads are accepted only with a matched post/label.
    const numbers = parseEpisodes(filename);
    if (!score && (numbers.length || !options.allowUnnumbered)) return null;
    if (options.season && parseSeason(filename) && parseSeason(filename) !== options.season) return null;
    const converted = convertSubtitle(decodeSubtitleBuffer(buf));
    return { ...converted, filename, matchedEpisode: score?.episode ?? options.episode, exactEpisode: score?.exact ?? false };
  }
  const maxBytes = options.maxZipBytes ?? 40 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 300;
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true }, (error, file) => error || !file ? reject(error ?? new Error("Invalid ZIP")) : resolve(file));
  });
  let activeStream: Readable | undefined;
  try {
    const selected = await new Promise<{ entry: Entry; name: string; score: NonNullable<ReturnType<typeof rank>> } | null>((resolve, reject) => {
      let total = 0, count = 0;
      const candidates: { entry: Entry; name: string; score: NonNullable<ReturnType<typeof rank>> }[] = [];
      const abort = () => { zip.close(); reject(options.signal?.reason ?? new Error("Aborted")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      zip.once("error", error => { cleanup(); reject(error); });
      zip.once("end", () => {
        cleanup();
        candidates.sort((a, b) => b.score.rank - a.score.rank || a.name.localeCompare(b.name));
        // Ambiguous unnumbered multi-file archives are not selected.
        resolve(candidates.length > 1 && !candidates[0]?.score.exact ? null : candidates[0] ?? null);
      });
      zip.on("entry", (entry: Entry) => {
        count++; total += entry.uncompressedSize;
        if (count > maxEntries || total > maxBytes || entry.uncompressedSize > maxBytes ||
            entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 250) {
          cleanup(); zip.close(); reject(new Error("ZIP exceeds entry/expansion limit")); return;
        }
        const name = filenameFor(entry);
        const symlink = (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000;
        if (safeZipPath(name) && !symlink && !entry.isEncrypted()) {
          const score = rank(name, options);
          if (score) candidates.push({ entry, name, score });
        }
        zip.readEntry();
      });
      // Keep the in-memory ZIP open until the selected stream is read.
      zip.autoClose = false;
      if (options.signal?.aborted) abort(); else zip.readEntry();
    });
    if (!selected) return null;
    const contents = await new Promise<Buffer>((resolve, reject) => {
      zip.openReadStream(selected.entry, (error, stream) => {
        if (error || !stream) { reject(error ?? new Error("Cannot read ZIP entry")); return; }
        activeStream = stream;
        const abort = () => stream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes || size > selected.entry.uncompressedSize) stream.destroy(new Error("ZIP actual expansion exceeds limit"));
          else chunks.push(chunk);
        });
        stream.once("error", err => { options.signal?.removeEventListener("abort", abort); reject(err); });
        stream.once("end", () => { options.signal?.removeEventListener("abort", abort); resolve(Buffer.concat(chunks, size)); });
      });
    });
    return { ...convertSubtitle(decodeSubtitleBuffer(contents)), filename: selected.name, matchedEpisode: selected.score.episode, exactEpisode: selected.score.exact };
  } finally { activeStream?.destroy(); zip.close(); }
}

function isOtherArchive(buf: Buffer) {
  return ['377abcaf271c', '526172211a07']
    .some(magic => buf.subarray(0, magic.length / 2).toString('hex') === magic)
    || buf.subarray(257, 262).toString() === 'ustar';
}
const execArchive = promisify(execFile);
function runArchive(executable: string, args: string[], options: ExecFileOptionsWithBufferEncoding) {
  // Keep malformed native decoder inputs within a per-process memory/CPU budget.
  return process.platform === 'linux'
    ? execArchive('prlimit', ['--as=268435456', '--cpu=8', '--', executable, ...args], options)
    : execArchive(executable, args, options);
}
let activeArchives = 0;
/** Decode one selected member to stdout. Archive paths are never written to disk. */
async function extractOtherArchive(buf: Buffer, options: ExtractOptions): Promise<ExtractedSubtitle | null> {
  if (activeArchives >= 2) throw new Error('Archive decoder busy');
  activeArchives++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'moa-subtitle-'));
    const path = join(directory, 'input.archive');
    await writeFile(path, buf, {mode: 0o600});
    const executable = process.env.MOA_7ZIP || '7z';
    const settings = { timeout: 8000, signal: options.signal, windowsHide: true };
    if (buf.subarray(0,6).toString('hex') === '526172211a07') {
      const decoder = process.env.MOA_BSDTAR || 'bsdtar';
      const listOptions = {...settings, encoding: 'buffer' as const, maxBuffer: 2 * 1024 * 1024};
      const names = (await runArchive(decoder, ['-tf',path], listOptions)).stdout.toString('utf8').trimEnd().split('\n');
      const details = (await runArchive(decoder, ['-tvf',path], listOptions)).stdout.toString('utf8').trimEnd().split('\n');
      if (names.length !== details.length || names.length > (options.maxEntries ?? 300)) throw new Error('Archive exceeds entry limit');
      const candidates = names.flatMap((name,index) => {
        if (!safeZipPath(name) || /[\[\]*?\\]/.test(name) || !details[index]?.startsWith('-')) return [];
        const score = rank(name,options); return score ? [{name,score}] : [];
      }).sort((a,b) => b.score.rank-a.score.rank || a.name.localeCompare(b.name));
      if (!candidates.length || candidates.length > 1 && !candidates[0]!.score.exact) return null;
      const selected = candidates[0]!;
      const result = await runArchive(decoder, ['-xOf',path,'--',selected.name],
        {...settings, encoding: 'buffer', maxBuffer: options.maxZipBytes ?? 40 * 1024 * 1024});
      return {...convertSubtitle(decodeSubtitleBuffer(result.stdout)), filename:selected.name,
        matchedEpisode:selected.score.episode, exactEpisode:selected.score.exact};
    }
    const listing = await runArchive(executable, ['l','-slt','-sccUTF-8','-pMOA_NO_PASSWORD','--',path], {...settings, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer'});
    const sections = listing.stdout.toString('utf8').split(/^-{10,}\r?$/m);
    if (sections.length !== 2) throw new Error('Invalid archive listing');
    const records = sections[1]!.trim().split(/\r?\n\r?\n/).map(block => Object.fromEntries(block.split(/\r?\n/).map(line => {
      const at = line.indexOf(' = '); return at < 0 ? ['', ''] : [line.slice(0,at), line.slice(at+3)];
    })));
    const limit = options.maxZipBytes ?? 40 * 1024 * 1024;
    let total = 0;
    if (records.length > (options.maxEntries ?? 300)) throw new Error('Archive exceeds entry limit');
    const candidates: { name: string; size: number; score: NonNullable<ReturnType<typeof rank>> }[] = [];
    for (const record of records) {
      const name = record.Path || '', size = Number(record.Size);
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > limit) throw new Error('Archive exceeds expansion limit');
      if (record.Encrypted === '+') throw new Error('Encrypted subtitles are unsupported');
      if (!safeZipPath(name) || record.Folder === '+' || record['Symbolic Link'] || record['Hard Link']) continue;
      const score = rank(name, options);
      if (score) candidates.push({name,size,score});
    }
    candidates.sort((a,b) => b.score.rank - a.score.rank || a.name.localeCompare(b.name));
    if (!candidates.length || candidates.length > 1 && !candidates[0]!.score.exact) return null;
    const selected = candidates[0]!;
    const result = await runArchive(executable,
      ['x','-so','-spd',...(buf.subarray(0,6).toString('hex') === '377abcaf271c' ? ['-mmt=1'] : []),'-pMOA_NO_PASSWORD','--',path,selected.name],
      {...settings, encoding: 'buffer', maxBuffer: Math.min(limit, selected.size) + 1});
    if (result.stdout.length !== selected.size) throw new Error('Archive member size mismatch');
    return {...convertSubtitle(decodeSubtitleBuffer(result.stdout)), filename: selected.name,
      matchedEpisode: selected.score.episode, exactEpisode: selected.score.exact};
  } finally {
    try { if (directory) await rm(directory, {recursive:true,force:true}); } finally { activeArchives--; }
  }
}
