// Synthetic WatchPage, actual alignment worker, native text tracks and the installed JASSUB worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const scratch = await mkdtemp(join(tmpdir(), 'seg-sync-'));
const root = fileURLToPath(new URL('..', import.meta.url));
const reference = [];
let time = 10, random = 1729;
for (let i = 0; i < 110; i++) {
  random = (random * 1664525 + 1013904223) >>> 0;
  time += 1.7 + random / 2 ** 32 * 7;
  reference.push(Math.round((time + (i >= 16 ? 60 : 0)) * 100) / 100);
}
const candidate = reference.map((t, i) => i < 16 ? t : t - 18);
function documentFor(times, format) {
  const stamp = t => {
    const iso = new Date(Math.round(t * 1000)).toISOString().slice(11, 23);
    return format === 'ass' ? iso.slice(1, -1) : iso;
  };
  if (format === 'vtt') return 'WEBVTT\n\n' + times.map((t, i) => `${stamp(t)} --> ${stamp(t + 1.4)}\nLine ${i}\n\n`).join('');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Pretendard,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + times.map((t, i) => `Dialogue: 0,${stamp(t)},${stamp(t + 1.4)},Default,,0,0,0,,Line ${i}\n`).join('');
}

let server, browser;
try {
  const clip = join(scratch, 'screen.mp4');
  execFileSync(process.env.MOA_FFMPEG || 'ffmpeg', ['-v','error','-f','lavfi','-i','color=c=black:s=160x90:r=2','-t',String(Math.ceil(reference.at(-1) + 10)),'-c:v','libx264','-threads','1','-g','2','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
  const video = await readFile(clip);
  process.env.VITE_MOCK = '0';
  server = await createServer({ root, cacheDir: join(scratch, 'vite'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { include: ['jassub', 'jassub/dist/worker/worker.js'] },
    plugins: [{ name: 'isolated-subtitle-test', configureServer(s) {
      s.middlewares.use('/api', (_req, res) => { res.statusCode = 503; res.end(); });
    } }] });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  async function scenario(format, { interrupt = false, segmented = true, uniform = false } = {}) {
    const authored = uniform ? reference.map(time => time - 3.25) : candidate;
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    await context.addInitScript(() => {
      localStorage.setItem('moa.profile', 'synthetic');
      localStorage.setItem('moa.compatibility', '1');
      const create = URL.createObjectURL.bind(URL);
      window.copies = [];
      window.Worker = class extends Worker {
        constructor(url, options) {
          super(url, options);
          if (String(url).includes('subtitle-sync-worker')) this.addEventListener('message', event => {
            window.syncResult = { status: event.data.status, offset: event.data.offsetSeconds, segmented: !!event.data.step };
          });
        }
      };
      URL.createObjectURL = blob => {
        const url = create(blob);
        if (/^text\/(plain|vtt)/.test(blob.type)) window.copies.push(url);
        return url;
      };
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const target = { id: 'ko', label: '한국어', lang: 'ko', format, source: 'online', url: '/fixture/candidate.' + format };
    const original = { id: 'en', label: 'English', lang: 'en', format: 'vtt', source: 'extension', url: '/fixture/reference.vtt' };
    await context.route(url => url.pathname.startsWith('/fixture/'), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('video.mp4')) {
        const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = Number(range?.[1] || 0), end = Math.min(video.length - 1, range?.[2] ? Number(range[2]) : video.length - 1);
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: video.subarray(start, end + 1),
          headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${video.length}` } : {}) } });
      }
      if (path.endsWith('reference.vtt')) {
        if (interrupt || format === 'ass') await gate;
        return route.fulfill({ contentType: 'text/vtt', body: documentFor(reference, 'vtt') }).catch(() => {});
      }
      return route.fulfill({ contentType: format === 'vtt' ? 'text/vtt' : 'text/plain', body: documentFor(authored, format) });
    });
    await context.route(url => url.pathname.startsWith('/api/'), route => {
      const path = new URL(route.request().url()).pathname;
      const json = data => route.fulfill({ json: data });
      if (path === '/api/me') return json({ id: 'synthetic', role: 'admin' });
      if (path === '/api/playback') {
        const { episodeId } = route.request().postDataJSON();
        return json({ sessionId: `s-${episodeId}`, episodeId, mediaId: 'm', mediaTitle: 'Fixture', mediaType: 'anime', mode: 'direct', mime: 'video/mp4',
          url: '/fixture/video.mp4', startPosition: 0, duration: reference.at(-1) + 10, subtitles: episodeId === 'e1' ? [target, original] : [original], audioTracks: [] });
      }
      if (path === '/api/settings') return json({ defaultSubtitleLang: 'ko', autoFetchSubtitles: false, autoplayNext: false, translationMode: 'manual', experimentalSubtitleSync: true, experimentalSegmentedSubtitleSync: segmented, subtitlePreserveAss: true });
      if (path === '/api/media/m') return json({ id: 'm', title: 'Fixture', type: 'anime', provider: { id: 'test', kind: 'local', name: 'local' }, seasons: [] });
      if (path.endsWith('/markers')) return json({ status: 'unavailable' });
      if (path.endsWith('/preference')) return json({});
      if (path.endsWith('/config')) return json({ enabled: false, configured: false });
      if (path.endsWith('/plugins') || path.endsWith('/plugin-runtime') || path.endsWith('/translations') || path.endsWith('/uploads')) return json([]);
      return route.fulfill({ status: 204 });
    });
    const page = await context.newPage();
    const referenceRequested = interrupt || format === 'ass' ? page.waitForRequest(req => req.url().endsWith('/fixture/reference.vtt')) : undefined;
    page.on('pageerror', e => errors.push(String(e)));
    const messages = [];
    page.on('console', msg => messages.push(msg.text()));
    page.on('requestfailed', req => messages.push(req.url() + ' ' + req.failure()?.errorText));
    page.on('response', res => { if (res.status() >= 400) messages.push(res.status() + ' ' + res.url()); });
    try {
      await page.goto(new URL('tests/fixtures/player.html', base).href);
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      if (interrupt) {
        await referenceRequested;
        await page.evaluate(() => window.testNavigate('/watch/e2'));
        await page.waitForFunction(() => document.querySelector('track')?.label === 'English');
        release();
        await page.waitForFunction(() => document.querySelector('track')?.readyState === 2);
        assert.deepEqual(await page.evaluate(() => window.copies), []);
        return;
      }
      await page.evaluate(() => document.querySelector('video').pause());
      async function seek(t) {
        await page.evaluate(t => { document.querySelector('video').currentTime = t; }, t);
        await page.waitForFunction(t => {
          const video = document.querySelector('video');
          return !video.seeking && Math.abs(video.currentTime - t) < .01;
        }, t);
      }
      if (!segmented || uniform) {
        await page.waitForFunction(() => window.syncResult);
        const result = await page.evaluate(() => window.syncResult);
        assert.equal(result.segmented, false);
        if (uniform) assert.deepEqual(result, { status: 'aligned', offset: 3.25, segmented: false });
        const expectedFirst = authored[0] + result.offset;
        await page.waitForFunction(first => Math.abs(document.querySelector('track')?.track.cues?.[0]?.startTime - first) < .001, expectedFirst);
        assert.deepEqual(await page.evaluate(() => window.copies), []);
        return;
      }
      if (format === 'ass') {
        await referenceRequested;
        await page.waitForFunction(() => parseFloat(document.querySelector('canvas.JASSUB')?.style.width) > 0);
        await seek(reference[16] + .7);
        await page.evaluate(() => { window.originalCanvas = document.querySelector('canvas.JASSUB'); });
        release();
      }
      await page.waitForFunction(() => window.copies.length > 0);
      const prepared = await page.evaluate(async target => {
        const { readTrack } = await import('/src/player/translation/subtitle-translation.ts');
        const { cueTimes } = await import('/src/player/subtitles/subtitle-timing.ts');
        const { content } = await readTrack({ ...target, url: window.copies.at(-1) }, new AbortController().signal);
        return cueTimes(content).map(cue => cue.start);
      }, target);
      assert.equal(prepared.length, reference.length);
      assert.ok(prepared.every((time, i) => Math.abs(time - reference[i]) < .001), 'the existing cast reader gets corrected content for both spans');
      if (format === 'vtt') {
        await page.waitForFunction(() => document.querySelector('track')?.src.startsWith('blob:') && document.querySelector('track').readyState === 2);
        for (const i of [15, 16, 8, 65, 15, 16]) {
          await seek(reference[i] + .7);
          assert.deepEqual(await page.evaluate(() => [...document.querySelector('track').track.activeCues].map(c => c.text)), ['Line ' + i]);
        }
      } else {
        // Isolate the actual libass canvas in a screenshot. Black video has no white pixels.
        const css = await page.addStyleTag({ content: '.player > :not(video):not(canvas):not(:has(canvas.JASSUB)) { visibility:hidden !important }' });
        const canvas = page.locator('canvas.JASSUB');
        await canvas.waitFor();
        await page.waitForFunction(() => {
          const rendered = document.querySelector('canvas.JASSUB');
          return rendered !== window.originalCanvas && parseFloat(rendered?.style.width) > 0;
        });
        async function visible(t, expected) {
          if (t !== null) await seek(t);
          await page.waitForTimeout(180);
          const screenshot = await canvas.screenshot();
          const pixels = await page.evaluate(async data => {
            const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
            const buffer = document.createElement('canvas');
            buffer.width = image.width; buffer.height = image.height;
            const context = buffer.getContext('2d'); context.drawImage(image, 0, 0);
            const rgba = context.getImageData(0, 0, buffer.width, buffer.height).data;
            let white = 0;
            for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 180 && rgba[i + 1] > 180 && rgba[i + 2] > 180) white++;
            return white;
          }, screenshot.toString('base64'));
          assert.equal(pixels > 15, expected, `libass at ${t} seconds, ${pixels} white pixels`);
        }
        // Worker finished after the seek. The paused frame must paint without another seek.
        await visible(null, true);
        for (const i of [15, 16, 7, 65, 15, 16]) {
          await visible(reference[i] + .7, true);
          await visible(reference[i] + 1.95, false);
        }
        await css.evaluate(style => style.remove());
      }
      // Reset from a corrected part of the edition, then persist and seek with both manual signs.
      await seek(reference[20] + .7);
      await page.getByRole('button', { name: '자막 및 음성', exact: true }).dispatchEvent('click');
      await page.getByRole('button', { name: /자막 설정/ }).click();
      const value = page.locator('.sync-value');
      assert.equal(await value.textContent(), '+18.0초');
      const oldUrl = await page.evaluate(() => window.copies.at(-1));
      await value.click();
      for (const [label, expected] of [['-0.5','-0.5초'], ['+0.5','0.0초'], ['+0.5','+0.5초']]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        assert.equal(await value.textContent(), expected);
      }
      await seek(reference[5] + .7);
      assert.equal(await value.textContent(), '+0.5초');
      assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, oldUrl), false);
      if (format === 'vtt') {
        await page.waitForFunction(() => document.querySelector('track')?.readyState === 2);
        const actual = await page.evaluate(() => [...document.querySelector('track').track.cues].map(c => c.startTime));
        assert.ok(actual.every((time, i) => Math.abs(time - candidate[i] - .5) < .0011));
      }
    } catch (error) { console.error(messages.slice(-25), errors); throw error; } finally { release(); await context.close(); }
  }
  await scenario('vtt');
  await scenario('ass');
  await scenario('vtt', { interrupt: true });
  await scenario('vtt', { segmented: false });
  await scenario('vtt', { uniform: true });
  assert.deepEqual(errors, []);
  console.log('Segmented subtitle replay passed for VTT and JASSUB, manual override and cancelled source switch.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(scratch, { recursive: true, force: true });
}
