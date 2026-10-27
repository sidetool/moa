import { AudioSkipAnalyzer, type LocalEpisode } from './skip-markers/index.js';
import { Store } from '../db.js';
import { sqliteCache } from '../subtitles/online.js';
import { safePath } from '../util.js';

// The entire analysis, including JS comparison and child decoders, inherits nice +10.
const [dataDir, ffmpegPath, ffprobePath, mediaRoot] = process.argv.slice(2);
const db = new Store(dataDir), controller = new AbortController();
const analyzer = new AudioSkipAnalyzer({ cache: sqliteCache(db), concurrency: 1, ffmpegPath, ffprobePath });
process.on('SIGTERM', () => controller.abort());
process.on('disconnect', () => controller.abort());
process.once('message', async (episodes: LocalEpisode[]) => {
  try {
    for (const episode of episodes) await safePath(mediaRoot, episode.path);
    const result = await analyzer.analyzeSeason(episodes, { signal: controller.signal, onProgress: progress => process.send?.({ progress }) });
    process.send?.({ result });
  } catch (error) { process.send?.({ error: String(error) }); }
  finally { db.close(); process.disconnect(); }
});
