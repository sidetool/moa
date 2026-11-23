import test from 'node:test';
import assert from 'node:assert/strict';
import { retainPlaybackFragments, previewFragmentOptions, previewBufferedLevel } from '../src/player/playback/preview-fragments.ts';

class NetworkLoader {
  stats = { loading: {}, loaded: 0, total: 0 };
  load(context, _config, callbacks) {
    const bytes = new Uint8Array([7, 8, 9]).buffer;
    this.stats.loading.end = 1;
    this.stats.total = bytes.byteLength;
    callbacks.onProgress?.(this.stats, context, bytes, {});
    callbacks.onSuccess({ data: bytes, code: 200, url: context.url }, this.stats, context, {});
  }
  destroy() {}
  abort() {}
}

function fragment() {
  return { responseType: 'arraybuffer', url: 'fixture:one', rangeStart: 8, rangeEnd: 11, headers: {},
    frag: { cc: 0, sn: 4, level: 2, type: 'main', start: 4, end: 8 }, part: null };
}

test('preview reads only the matching session, full fragment and range, even after demuxer transfer', async () => {
  const main = retainPlaybackFragments('one', NetworkLoader);
  const context = fragment();
  try {
    new main.fLoader().load(context, {}, {
      onProgress(_s, _c, bytes) { structuredClone(bytes, { transfer: [bytes] }); },
      onSuccess() {},
    });
    assert.equal(previewBufferedLevel('one', 5), 2);
    assert.equal(previewBufferedLevel('one', 8), undefined);
    assert.equal(previewFragmentOptions('other', NetworkLoader).fLoader, undefined);
    const Preview = previewFragmentOptions('one', NetworkLoader).fLoader;
    const request = c => new Promise(resolve => new Preview().load(c, {}, { onSuccess: (r, _s, _c, network) => resolve({ bytes: [...new Uint8Array(r.data)], network }) }));
    assert.deepEqual(await request(context), { bytes: [7, 8, 9], network: null });
    assert.deepEqual((await request({ ...context, rangeStart: 9 })).network, {});
    assert.deepEqual((await request({ ...context, frag: { ...context.frag, encrypted: true } })).network, {});
    const hits = [];
    const aborted = new Preview();
    aborted.load(context, {}, { onSuccess: () => hits.push('success'), onAbort: () => hits.push('abort') });
    aborted.abort();
    await Promise.resolve();
    assert.deepEqual(hits, ['abort']);
    main.release();
    assert.deepEqual((await request(context)).network, {});
  } finally { main.release(); }
});
