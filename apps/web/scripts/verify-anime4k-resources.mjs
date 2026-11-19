// Step decoded frames and idle deadlines independently, using the real renderer and WebGL context.
export async function verifyAnime4kResources(context, base) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.route('**/fixture/resources', route => route.fulfill({
      contentType: 'text/html', body: '<video preload="auto" muted src="/fixture/first.mp4"></video>'
    }));
    await page.goto(base + '/fixture/resources');
    await page.waitForFunction(() => document.querySelector('video').readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    await page.evaluate(async () => {
      const { attachAnime4k } = await import('/src/player/playback/anime4k.ts');
      const video = document.querySelector('video');
      Object.defineProperty(video, 'paused', { configurable: true, value: false });
      video.requestVideoFrameCallback = callback => { window.filterFrame = callback; return 0; };
      video.cancelVideoFrameCallback = () => { window.filterFrame = null; };
      window.stopFilter = attachAnime4k(video, video.currentSrc, () => {});
    });
    await page.waitForFunction(() => typeof window.filterFrame === 'function');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      const layer = () => document.querySelector('.player-anime4k');
      let presentedFrames = 0;
      function check(ok, message) { if (!ok) throw new Error(message); }
      function draw() {
        check(window.filterFrame, 'Expected a pending frame');
        window.filterFrame(performance.now(), { presentedFrames: ++presentedFrames, mediaTime: presentedFrames / 8 });
        check(layer() && !layer().hidden, 'Expected a filtered frame');
        return layer().getContext('webgl');
      }
      const event = name => video.dispatchEvent(new Event(name));
      let gl = draw();
      check(draw() === gl, 'Continuous playback must reuse its context');

      // Only the synchronous transitions below use this clock. Count timers as well as firing them.
      const set = window.setTimeout, clear = window.clearTimeout;
      const timers = new Map();
      let id = 0;
      window.setTimeout = (callback, delay) => {
        check(delay > 0 && delay <= 5000, 'Idle grace must be bounded');
        timers.set(++id, callback);
        return id;
      };
      window.clearTimeout = handle => timers.delete(handle);
      try {
        for (const property of ['hidden', 'videoWidth', 'captions']) {
          const target = property === 'hidden' ? document : video;
          let track;
          function toggle(enabled) {
            if (property === 'captions') {
              track ??= video.addTextTrack('captions', 'Fixture');
              track.mode = enabled ? 'showing' : 'disabled';
              video.textTracks.dispatchEvent(new Event('change'));
            } else {
              if (enabled) Object.defineProperty(target, property, { configurable: true, value: property === 'hidden' ? true : 3840 });
              else delete target[property];
              target.dispatchEvent(new Event(property === 'hidden' ? 'visibilitychange' : 'resize'));
            }
          }
          toggle(true);
          check(!layer() && gl.isContextLost() && !timers.size, property + ' must release its context immediately');
          toggle(false);
          check(!layer(), 'Recovery must wait for a decoded frame');
          gl = draw();
        }

        for (const reason of ['pause', 'seeking', 'waiting']) {
          event(reason);
          const deadline = id;
          event(reason);
          check(layer()?.hidden && timers.size === 1 && id === deadline, 'Repeated idle events must keep the first deadline');
          event('playing');
          check(timers.size === 1, 'An event without a frame must preserve the deadline');
          if (reason === 'seeking') {
            check(draw() === gl && !timers.size, 'A short seek must reuse the context and cancel the deadline');
          } else {
            const expire = timers.get(deadline);
            timers.delete(deadline);
            expire();
            check(!layer() && gl.isContextLost(), 'Extended ' + reason + ' must release its context');
            gl = draw();
          }
        }
        event('waiting');
        event('emptied');
        check(!timers.size && !window.filterFrame && !layer() && gl.isContextLost(), 'A source change must clear pending work');
        event('playing');
        gl = draw();
        event('pause');
        window.stopFilter();
        event('playing');
        check(!timers.size && !window.filterFrame && !layer() && gl.isContextLost(), 'Disposal must clear pending work');
      } finally {
        window.stopFilter();
        window.setTimeout = set;
        window.clearTimeout = clear;
      }
    });
    console.log('PASS WebGL release during fallback, bounded idle grace, frame-driven recovery and timer disposal');
  } finally {
    await page.close();
  }
}
