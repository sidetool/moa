import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildApp } from '../../server/dist/app.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.MOA_SUBTITLE_EVIDENCE_DIR || await mkdtemp(path.join(tmpdir(), 'moa-subtitle-'));
await mkdir(evidence, { recursive: true });
const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nSYNC 자막\n';
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Pretendard,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\bord0\\shad0\\3a&HFF&}SYNC 자막 ｢日本語｣ ★→
`;
const directory = await mkdtemp(path.join(tmpdir(), 'moa-subtitle-rendering-'));
const backend = await buildApp({ dataDir: directory, mediaRoot: directory }, false);
const profileId = (await backend.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '자막 검증' } })).json().id;
backend.db.run("INSERT INTO media VALUES('m',NULL,'자막 검증','movie','{}','2026')");
backend.db.run("INSERT INTO episodes VALUES('e','m',1,1,'회차',8,NULL)");
const tracks = {};
for (const [format, content] of Object.entries({ ass, vtt, srt: '1\n00:00:02,000 --> 00:00:04,000\nSYNC 자막\n' })) {
  const imported = await backend.app.inject({ method: 'POST', url: '/api/subtitles/import', headers: { 'x-moa-profile': profileId }, payload: { episodeId: 'e', filename: `fixture.${format}`, data: Buffer.from(content).toString('base64') } });
  assert.equal(imported.statusCode, 200, imported.body); tracks[format] = imported.json()[0];
}
let clip;
const server = await createServer({
  root: webRoot,
  cacheDir: path.join(evidence, 'vite-cache'),
  configFile: path.join(webRoot, 'vite.config.ts'),
  server: { port: 0, open: false, hmr: false },
  optimizeDeps: { include: ['jassub', 'jassub/dist/worker/worker.js', 'hls.js'] },
  plugins: [{
    name: 'subtitle-verification-fixtures',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname.startsWith('/api/playback/upload-')) {
          const response = await backend.app.inject({ url: pathname });
          res.statusCode = response.statusCode; res.setHeader('Content-Type', response.headers['content-type']); return res.end(response.body);
        }
        if (pathname === '/__subtitle_verify') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><style>
            body { margin: 0; background: #000; } .stage { position: relative; width: 640px; height: 360px; }
            video { width: 640px; height: 360px; } canvas.JASSUB { position: absolute; pointer-events: none; transform:translateY(calc(-1 * var(--subtitle-lift,0%))); }
            </style></head><body><div class="stage"><video preload="auto"></video></div>
            <script type="module">
            import '/src/styles/player.css';
            import { SubtitleController } from '/src/player/engine.ts';
            window.video = document.querySelector('video');
            window.controller = new SubtitleController(window.video);
            window.track = format => (${JSON.stringify(tracks)})[format];
            </script></body></html>`);
          return;
        }
        const body = pathname === '/fixture.vtt' ? Buffer.from(vtt)
          : pathname === '/fixture.ass' ? Buffer.from(ass)
          : pathname === '/fixture.webm' ? clip : null;
        if (!body) return next();
        res.setHeader('Content-Type', pathname.endsWith('.webm') ? 'video/webm' : pathname.endsWith('.vtt') ? 'text/vtt' : 'text/plain');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
          res.setHeader('Content-Length', end - start + 1);
          res.end(body.subarray(start, end + 1));
        } else {
          res.setHeader('Content-Length', body.length);
          res.end(body);
        }
      });
    }
  }]
});
let browser;
const errors = [], external = [], samples = [];
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.MOA_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...(process.env.MOA_SOFTWARE_RENDER ? ['--disable-webgl'] : [])] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== base) { external.push(url.href); return route.abort(); }
    }
    return route.continue();
  });
  page.on('pageerror', error => { errors.push(String(error)); });
  page.on('console', message => { if (message.type() === 'error' || message.text().includes('failed to find any fallback with glyph')) errors.push(message.text()); });
  if (process.env.MOA_COMPATIBILITY) await page.addInitScript(() => localStorage.setItem('moa.compatibility','1'));
  await page.goto(`${base}/__subtitle_verify`);
  await page.waitForFunction(() => window.controller);
  // Encode 160 locally created blue JPEG frames as an eight-second VP8 WebM.
  const frame = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#174c80'; ctx.fillRect(0, 0, 160, 90);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  }), 'base64');
  const clipPath = path.join(evidence, 'fixture.webm');
  if (!process.env.MOA_TEST_CLIP) execFileSync(process.env.MOA_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '20', '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libvpx', '-b:v', '40k', '-an', '-y', clipPath
  ], { input: Buffer.concat(Array(160).fill(frame)), maxBuffer: 8 * 1024 * 1024 });
  clip = await readFile(process.env.MOA_TEST_CLIP || clipPath);
  await page.evaluate(async () => {
    video.src = '/fixture.webm';
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Local clip failed')), { once: true });
    });
  });
  assert.ok(await page.evaluate(() => video.duration >= 7.9 && video.duration <= 8.1));

  async function show(format) {
    await Promise.race([page.evaluate(async format => { await controller.show(format ? track(format) : null); }, format), new Promise((_, reject) => setTimeout(() => reject(new Error('Subtitle ready timed out: ' + JSON.stringify(errors))), 25000).unref())]);
    if (format === 'vtt' || format === 'srt') await page.waitForFunction(() => video.querySelector('track')?.readyState === 2);
  }
  async function sample(name, time, visible) {
    await page.evaluate(async time => {
      if (video.currentTime === time) return;
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = time; await seeked;
    }, time);
    // Allow native cues and the worker renderer to finish the seek frame.
    await page.waitForTimeout(200);
    await page.waitForFunction(() => !window.controller.ass?.busy);
    const pixels = await page.locator('.stage').screenshot();
    await writeFile(path.join(evidence, `${name}.png`), pixels);
    const measurement = await page.evaluate(async data => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
      const stage = document.querySelector('.stage').getBoundingClientRect(), rect = video.getBoundingClientRect();
      const videoHeight = Math.min(rect.height, rect.width * video.videoHeight / video.videoWidth);
      const y = Math.max(0, Math.min(img.height - 1, Math.floor((rect.top - stage.top + (rect.height - videoHeight) / 2 + videoHeight * .1) * img.height / stage.height)));
      const background = Array.from(ctx.getImageData(Math.floor(img.width / 2), y, 1, 1).data);
      let white = 0, dark = 0, minY = img.height, maxY = -1;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] < background[0] * .75 && rgba[i + 1] < background[1] * .75 && rgba[i + 2] < background[2] * .75) dark++;
        if (rgba[i] > 150 && rgba[i + 1] > 150 && rgba[i + 2] > 150) {
          white++; const y = Math.floor(i / 4 / img.width); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      return { background, white, dark, minY, maxY, time: video.currentTime, activeCues: video.textTracks[0]?.activeCues?.length ?? 0,
        ass: controller.ass ? { offset: controller.ass.timeOffset, demand: controller.ass._lastDemandTime, busy: controller.ass.busy, width: controller.ass._canvas.width, height: controller.ass._canvas.height, style: controller.ass._canvas.style.cssText } : null };
    }, pixels.toString('base64'));
    samples.push({ name, ...measurement });
    if (!process.env.MOA_TEST_CLIP) assert.ok(measurement.background[2] > 95 && measurement.background[1] > 45, `${name}: subtitle surface obscures the blue video`);
    assert.equal(measurement.white > 50, visible, `${name}: ${JSON.stringify(measurement)}`);
    return measurement;
  }

  await page.evaluate(() => { controller.setOffset(0); controller.setLift(true); });
  await show('vtt');
  assert.ok(await page.evaluate(() => video.textTracks[0].cues[0].snapToLines && video.textTracks[0].cues[0].line < 0));
  const raised = await sample('vtt-zero-raised', 2.5, true);
  await page.evaluate(() => { controller.setLift(false); controller.setHeight(0); });
  const lowered = await sample('vtt-zero-lowered', 2.6, true);
  assert.ok(raised.maxY < lowered.minY, 'VTT cues did not move above the control area');
  await page.evaluate(() => controller.setOffset(1));
  await sample('vtt-plus1-before', 2.5, false);
  await sample('vtt-plus1-visible', 3.5, true);
  await sample('vtt-plus1-after', 5.5, false);
  await page.evaluate(() => controller.setOffset(-1));
  await sample('vtt-minus1-visible', 1.5, true);
  await sample('vtt-minus1-after', 3.5, false);
  await page.evaluate(() => controller.setOffset(0));
  const baselineVtt=await sample('vtt-reset-visible', 2.5, true);
  await page.evaluate(()=>controller.setHeight(25));
  const movedVtt=await sample('vtt-height25',2.5,true);
  assert.ok(movedVtt.maxY<baselineVtt.minY,'VTT manual height must move active cues');
  await page.evaluate(()=>controller.setHeight(0));

  await page.evaluate(() => controller.setOffset(1));
  await show('ass');
  assert.equal(await page.evaluate(() => controller.ass.timeOffset), -1);
  await sample('ass-plus1-before', 2.5, false);
  const baselineAss=await sample('ass-plus1-visible', 3.5, true);
  await page.evaluate(() => { document.querySelector('.stage').className = 'stage player is-chrome'; video.className = 'player-video'; });
  const controlsAss=await sample('ass-default-controls',3.5,true);
  assert.equal(controlsAss.minY, baselineAss.minY, 'ASS defaults must retain authored position when controls appear');
  assert.equal(controlsAss.maxY, baselineAss.maxY, 'ASS defaults must retain authored size when controls appear');
  await page.evaluate(() => { document.querySelector('.stage').className = 'stage player is-idle'; });
  await page.evaluate(()=>document.documentElement.style.setProperty('--subtitle-lift','25%'));
  const movedAss=await sample('ass-height25',3.5,true);
  assert.ok(movedAss.maxY<baselineAss.minY,'ASS manual height must move active canvas');
  await page.evaluate(()=>document.documentElement.style.setProperty('--subtitle-lift','0%'));
  await page.evaluate(()=>controller.setAppearance({size:'medium',background:'soft'}));
  const softAss=await sample('ass-inline-soft',3.5,true);
  assert.ok(softAss.dark > baselineAss.dark + 1000, 'ASS background must render despite transparent inline border tags');
  await page.evaluate(()=>controller.setAppearance({size:'medium',background:'solid'}));
  const solidAss=await sample('ass-inline-solid',3.5,true);
  assert.ok(solidAss.dark > baselineAss.dark + 1000, 'ASS solid background must render despite inline border tags');
  await page.evaluate(()=>controller.setAppearance({size:'large',background:'soft'}));
  const largeAss=await sample('ass-large-soft',3.5,true);
  assert.ok(largeAss.maxY-largeAss.minY > baselineAss.maxY-baselineAss.minY, 'ASS font size must visibly increase');
  const styles=await page.evaluate(()=>controller.ass.renderer.getStyles());
  assert.equal(styles.find(s=>s.Name==='Default').BorderStyle,4);
  await page.evaluate(()=>controller.setAppearance({size:'xlarge',background:'soft'}));
  const xlargeAss=await sample('ass-xlarge-soft',3.5,true);
  assert.ok(xlargeAss.maxY-xlargeAss.minY > largeAss.maxY-largeAss.minY, 'extra large must be visibly larger than large');
  await page.evaluate(()=>controller.setAppearance({size:'small',background:'solid'}));
  const smallAss=await sample('ass-small-solid',3.5,true);
  assert.ok(smallAss.maxY-smallAss.minY < largeAss.maxY-largeAss.minY);
  await page.evaluate(()=>controller.setAppearance({size:'medium',background:'original'}));
  const resetAss=await sample('ass-appearance-reset',3.5,true);
  assert.equal(resetAss.maxY-resetAss.minY,baselineAss.maxY-baselineAss.minY);
  assert.equal(resetAss.dark, baselineAss.dark, 'Original ASS appearance must restore the authored inline tags');
  assert.equal(resetAss.maxY, baselineAss.maxY, 'Original ASS position must remain unchanged');
  await sample('ass-plus1-after', 5.5, false);
  await page.evaluate(() => controller.setOffset(-1));
  await sample('ass-minus1-visible', 1.5, true);
  await sample('ass-minus1-after', 3.5, false);

  await page.evaluate(async () => {
    const pending = controller.show(track('ass'));
    await controller.show(track('vtt'));
    await pending;
  });
  await page.waitForFunction(() => video.querySelector('track')?.readyState === 2);
  assert.equal(await page.locator('canvas.JASSUB').count(), 0);
  assert.equal(await page.locator('track').count(), 1);
  await sample('rapid-ass-to-vtt', 1.5, true);
  await page.evaluate(async () => {
    const pending = controller.show(track('ass')); controller.clear(); await pending;
  });
  assert.equal(await page.locator('canvas.JASSUB, track').count(), 0);
  await sample('cleared', 2.5, false);

  // Exercise the actual VTT CSS against a solid video, including inherited
  // custom properties inside the browser's native ::cue renderer.
  await page.evaluate(async () => {
    const stage = document.querySelector('.stage');
    stage.style.position = 'relative';
    stage.className = 'stage player cue-large';
    stage.style.setProperty('--video-height', '360px');
    video.className = 'player-video';
    controller.setOffset(0);
    controller.setHeight(0);
  });
  await show('vtt');
  const largeVtt = await sample('vtt-css-large', 2.5, true);
  await page.evaluate(() => controller.setAppearance({ size: 'large', background: 'original', padding: 20 }));
  await sample('vtt-original-padding', 2.5, true);
  assert.equal(await page.locator('.subtitle-cue > span').first().evaluate(element => getComputedStyle(element).paddingLeft), '20px');
  await page.evaluate(() => controller.setAppearance({ size: 'large', background: 'original' }));
  assert.equal(await page.locator('.subtitle-overlay').count(), 0);

  let noBackground;
  for (const background of ['none', 'soft', 'solid']) {
    await page.evaluate(background => { document.querySelector('.stage').className = `stage player cue-large cue-bg-${background}`; return controller.setAppearance({size:'large',background}); }, background);
    const measured = await sample(`vtt-background-${background}`, 2.5, true);
    if (background === 'none') { noBackground = measured; assert.ok(measured.dark < largeVtt.dark / 2); }
    else assert.ok(measured.dark > noBackground.dark + 300, `${background}: VTT background changes must affect the active cue`);
  }
  await show('srt');
  await page.evaluate(() => controller.setAppearance({ size: 'large', background: 'none' }));
  const srtNone = await sample('server-srt-none', 2.5, true);
  await page.evaluate(() => controller.setAppearance({ size: 'large', background: 'solid' }));
  const srtSolid = await sample('server-srt-solid', 2.5, true);
  assert.ok(srtSolid.dark > srtNone.dark + 300);
  await page.evaluate(() => { document.querySelector('.stage').style.width = '480px'; });
  await page.waitForFunction(() => Math.abs(document.querySelector('.subtitle-overlay').getBoundingClientRect().width - 480) < 1);
  assert.equal(await page.evaluate(() => document.querySelector('.subtitle-overlay').getBoundingClientRect().height), 270);
  await sample('server-srt-paused-resize', 2.5, true);
  await page.evaluate(() => { video.style.transform = 'scale(1.5)'; });
  await page.waitForFunction(() => Math.abs(document.querySelector('.subtitle-overlay').getBoundingClientRect().height - 360) < 1);
  await sample('server-srt-paused-fill', 2.5, true);
  await page.evaluate(() => {
    video.style.transform = '';
    document.querySelector('.stage').style.width = '640px';
    const text = video.textTracks[0];
    for (const cue of Array.from(text.cues)) text.removeCue(cue);
    const cue = new VTTCue(2, 4, '<c.player><b>｢다국어 日本語｣</b></c>');
    cue.line = 20; cue.snapToLines = false; cue.position = 25; cue.positionAlign = 'line-left'; cue.size = 50; cue.align = 'left';
    text.addCue(cue); controller.setHeight(0);
  });
  await page.waitForFunction(() => Math.abs(document.querySelector('.subtitle-overlay').getBoundingClientRect().width - 640) < 1);
  await sample('server-vtt-positioned', 2.5, true);
  assert.equal(await page.locator('.subtitle-cue .player').count(), 0);
  assert.ok(await page.evaluate(() => {
    const box = document.querySelector('.subtitle-overlay').getBoundingClientRect(), cue = document.querySelector('.subtitle-cue').getBoundingClientRect();
    return Math.abs(cue.top - box.top - box.height * .2) < 1 && Math.abs(cue.left - box.left - box.width * .25) < 1;
  }));
  await show('srt');
  await page.evaluate(() => controller.setAppearance({ size: 'large', background: 'original' }));
  assert.equal(await page.locator('.subtitle-overlay').count(), 0);
  assert.equal(await page.evaluate(() => video.textTracks[0].mode), 'showing');
  await page.evaluate(() => { document.querySelector('.stage').className = 'stage player cue-xlarge'; controller.setAppearance({size:'xlarge',background:'original'}); });
  const xlargeVtt = await sample('vtt-css-xlarge', 2.6, true);
  assert.ok(xlargeVtt.maxY-xlargeVtt.minY > largeVtt.maxY-largeVtt.minY, 'VTT extra large must increase visible glyph height');
  await page.setViewportSize({ width: 640, height: 900 });
  const portraitVtt = await sample('vtt-css-tall-viewport', 2.7, true);
  assert.equal(portraitVtt.maxY-portraitVtt.minY, xlargeVtt.maxY-xlargeVtt.minY, 'Same video height must keep subtitle size when viewport becomes taller');

  for (const height of [1080, 2160]) {
    await page.setViewportSize({ width: height * 16 / 9, height });
    await page.evaluate(height => {
      const stage = document.querySelector('.stage');
      stage.style.width = `${height * 16 / 9}px`;
      stage.style.height = `${height}px`;
      stage.style.setProperty('--video-height', `${height}px`);
    }, height);
    const tvVtt = await sample(`vtt-css-tv-${height}`, 2.8, true);
    const ratio = (tvVtt.maxY-tvVtt.minY) / (xlargeVtt.maxY-xlargeVtt.minY);
    assert.ok(Math.abs(ratio-height/360) < .7, `VTT must scale with TV resolution: ${ratio}`);
  }
  await page.evaluate(() => controller.setAppearance({size:'xlarge',background:'original'}));
  await show('ass');
  let assBaseHeight;
  for (const height of [360, 1080, 2160]) {
    await page.setViewportSize({ width: height * 16 / 9, height });
    await page.evaluate(height => {
      const stage = document.querySelector('.stage');
      stage.style.width = `${height * 16 / 9}px`;
      stage.style.height = `${height}px`;
    }, height);
    await page.waitForTimeout(350);
    const tvAss = await sample(`ass-css-tv-${height}`, 2.9 + height / 10000, true);
    const glyphHeight = tvAss.maxY-tvAss.minY;
    if (height === 360) assBaseHeight = glyphHeight;
    else assert.ok(Math.abs(glyphHeight/assBaseHeight-height/360) < .7, 'ASS must scale with TV resolution');
  }
  await page.setViewportSize({width: 844, height: 390});
  await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    stage.style.width = '844px'; stage.style.height = '390px';
    stage.style.setProperty('--video-height', '390px');
    stage.className = 'stage player cue-xlarge';
    controller.setOffset(0); controller.setHeight(0); controller.setLift(false);
  });
  await show('vtt');
  let oneLineWhite;
  for (const lines of [1, 2, 3]) {
    await page.evaluate(lines => {
      const t = video.textTracks[0], c = t.cues[0];
      t.removeCue(c); c.text = Array(lines).fill('Subtitle 한글 확인').join('\n'); t.addCue(c); controller.setHeight(0);
    }, lines);
    const measured = await sample(`multiline-${lines}`, 2.5 + lines*.1, true);
    if (lines === 1) oneLineWhite = measured.white;
    assert.ok(measured.white >= oneLineWhite * lines * .98, 'Every line must be completely visible');
    assert.ok(measured.maxY < 389, 'All subtitle lines must stay inside the viewport');
  }
  await page.evaluate(() => {
    document.querySelector('.stage').className = 'stage player cue-small';
    const t=video.textTracks[0], c=t.cues[0];
    t.removeCue(c); c.text='원하신다면 목욕탕도\n이용하실 수 있습니다'; t.addCue(c);
  });
  await sample('multiline-small', 2.8, true);
  await page.evaluate(() => { document.querySelector('.stage').className = 'stage player cue-xlarge'; controller.setAppearance({size:'xlarge',background:'original'}); });
  const changed = await sample('multiline-active-enlarged', 2.8, true);
  await page.evaluate(() => { const t=video.textTracks[0], c=t.cues[0]; t.removeCue(c); t.addCue(c); });
  const refreshed = await sample('multiline-active-refreshed', 2.8, true);
  assert.ok(changed.white >= refreshed.white * .98, 'Changing size must not crop the active subtitle');
  for (const size of ['large', 'xlarge']) for (const height of [0, 8, 30]) {
    await page.evaluate(({size,height}) => {
      document.querySelector('.stage').className = `stage player cue-${size}`;
      controller.setAppearance({size,background:'soft'});
      controller.setHeight(height);
    }, {size,height});
    let reference;
    for (const lines of [1,2,3]) {
      await page.evaluate(({lines,height}) => {
        const t=video.textTracks[0],c=t.cues[0];
        t.removeCue(c);c.text=Array(lines).fill('원하신다면 목욕탕도').join('\n');t.addCue(c);
        controller.setHeight(height);
      }, {lines,height});
      const measured=await sample(`bounds-${size}-${height}-${lines}`,2.8,true);
      if (!reference) reference=measured;
      assert.ok(measured.white >= reference.white*lines*.98,'Multiline glyphs must not be cropped');
      assert.ok(measured.maxY <= reference.maxY+2,'Extra lines must expand upwards, not below the bottom inset');
    }
  }
  await page.evaluate(() => {
    document.querySelector('.stage').className='stage player cue-large';
    const t=video.textTracks[0],c=t.cues[0];
    t.removeCue(c);c.text='긴 자막도 화면 아래로 벗어나지 않도록 자동 줄바꿈을 확인합니다. '.repeat(3);t.addCue(c);
    controller.setAppearance({size:'large',background:'soft'});controller.setHeight(8);
  });
  const wrapped=await sample('bounds-large-8-wrapped',2.8,true);
  assert.ok(wrapped.maxY < 390 * .92,'Automatically wrapped subtitles must keep the bottom inset');
  assert.deepEqual(external, [], 'External network request attempted');
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(JSON.stringify({ result: 'passed', browser: await browser.version(), duration: 8, samples, external, errors, evidence }, null, 2));
} finally {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ samples, errors, external }, null, 2));
  await browser?.close();
  await server.close();
  await backend.app.close();
  await rm(directory, { recursive: true, force: true });
}
