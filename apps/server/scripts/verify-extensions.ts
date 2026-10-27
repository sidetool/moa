import { mkdir, writeFile } from 'node:fs/promises';
import { fetchRepository, fetchExtension, invokeMangayomi } from '../src/sources/extensions/index.js';

const outboundProxy = process.env.MOA_OUTBOUND_PROXY;
const repository = process.env.MOA_EXTENSION_REPOSITORY;
const selected = process.argv.slice(2);
if (!repository || !selected.length) throw new Error('Set MOA_EXTENSION_REPOSITORY and pass one or more source IDs.');
const entries = await fetchRepository(repository);
const targets = selected.map(id => {
  const entry = entries.find(entry => entry.id === id);
  if (!entry) throw new Error('Requested source ID is absent from the supplied repository.');
  return entry;
});
const results: unknown[] = [];
for (const entry of targets) {
  const started = Date.now();
  try {
    const code = await fetchExtension(entry);
    const call = (action: string, params = {}) => invokeMangayomi({ entry, source: code.source, action, params, outboundProxy, signal: AbortSignal.timeout(60_000) });
    const preferences = await call('preferences');
    const page = (await call('list')).result as any;
    const items = page.list ?? [];
    let title: string | undefined, episodes = 0, videoCount = 0, stream: string | undefined;
    const failures: string[] = [];
    for (const item of items.slice(0, 8)) {
      try {
        const detail = (await call('detail', { workUrl: item.link ?? item.url })).result as any;
        if (!detail?.chapters?.length) continue;
        const videos = (await call('videos', { episodeUrl: detail.chapters[0].url })).result as any[];
        if (!Array.isArray(videos) || !videos.length) continue;
        title = detail.name ?? item.name; episodes = detail.chapters.length; videoCount = videos.length;
        // Record the hostname only; stream query tokens do not belong in reports.
        stream = new URL(videos[0].url).hostname;
        break;
      } catch (error) { failures.push(String(error)); }
    }
    const result = { id: entry.id, name: entry.name, version: entry.version, sha256: code.sha256, items: items.length, preferences: Array.isArray(preferences.result) ? preferences.result.length : 0, title, episodes, videoCount, stream, failures, elapsedMs: Date.now() - started };
    results.push(result); console.log(JSON.stringify(result));
  } catch (error) { const result = { name: entry.name, error: String(error), elapsedMs: Date.now() - started }; results.push(result); console.log(JSON.stringify(result)); }
}
const output = process.env.MOA_VERIFY_OUTPUT || 'data/verification';
await mkdir(output, { recursive: true });
await writeFile(`${output}/extensions-live.json`, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
