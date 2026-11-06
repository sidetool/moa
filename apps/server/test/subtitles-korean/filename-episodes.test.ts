import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisodes, parseSubtitleFilenameEpisodes } from '../../src/subtitles/korean/normalize.js';

test('file-only episode parser recognizes bracketed, attached-group and technical-suffix releases', () => {
  for (const extension of ['ass', 'srt', 'smi', 'vtt', 'zip', '7z', 'rar']) {
    for (const name of ['Example TV [01]', 'Example TV - 01Group', 'Example_TV_01_1080p_x264']) {
      assert.deepEqual(parseSubtitleFilenameEpisodes(`${name}.${extension}`), [1], `${name}.${extension}`);
    }
  }
  assert.deepEqual(parseSubtitleFilenameEpisodes('[Release] Example TV [12.5].ass'), [12.5]);
  assert.deepEqual(parseSubtitleFilenameEpisodes('Example TV S02E03.ass'), [3]);
  assert.deepEqual(parseSubtitleFilenameEpisodes('Example TV 2기 03화.zip'), [3]);
  assert.deepEqual(parseSubtitleFilenameEpisodes('Example TV 01~03.zip'), [1, 2, 3]);
});

test('file-only episode parser does not promote title, year, season, resolution or checksum numbers', () => {
  for (const name of [
    '86 [1080p].ass', 'Robot No. 8.ass', 'Example TV [2024].ass', 'Example TV (2024).srt',
    'Example TV [12345678].ass', 'Example TV [ABCDEF12].ass', 'Example_TV_1080p_x264.ass',
    'Example TV S02.ass', 'Example TV Season 2.ass', 'Example TV 2기.ass',
    'Example TV [720p] [1080p].ass',
  ]) assert.deepEqual(parseSubtitleFilenameEpisodes(name), [], name);
});

test('multiple independent file episode candidates remain unverified', () => {
  for (const name of ['Example TV [01] [02].ass', 'Example_TV_01_02_1080p.ass', 'Example TV - 01Group [02].srt']) {
    assert.deepEqual(parseSubtitleFilenameEpisodes(name).sort((a, b) => a - b), [1, 2], name);
  }
});

test('file-only syntax does not broaden the global post-title episode parser', () => {
  for (const name of ['Example TV [01].ass', 'Example TV - 01Group.ass', 'Example_TV_01_1080p_x264.ass']) {
    assert.deepEqual(parseEpisodes(name), [], name);
  }
  assert.deepEqual(parseEpisodes('Example TV S02E03.ass'), [3]);
  assert.deepEqual(parseEpisodes('Example TV 01~03.zip'), [1, 2, 3]);
  assert.deepEqual(parseEpisodes('로봇 8호.ass'), []);
});
