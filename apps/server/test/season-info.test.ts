import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonInfo, seasonIdentity, searchRelevance } from '../src/catalog/season-info.js';
import type { MediaCard } from '@moa/shared';

for (const [title,label] of [
  ['하늘 탐험대 1기','시즌 1'], ['하늘 탐험대 2기','시즌 2'], ['하늘 탐험대 시즌 2','시즌 2'],
  ['하늘 탐험대 Season 3','시즌 3'], ['하늘 탐험대 part 2','파트 2'], ['하늘 탐험대 파트1','파트 1'],
  ['하늘 탐험대 3기 파트2','시즌 3 · 파트 2'], ['하늘 탐험대 The Final Season','파이널 시즌'],
  ['하늘 탐험대 4기','시즌 4'], ['하늘 탐험대 완결편 전편','파이널 시즌 · 파트 3'],
  ['하늘 탐험대 완결편 후편','파이널 시즌 · 파트 3'], ['극장판 하늘 탐험대','극장판'],
  ['[극장판]하늘 탐험대','극장판'], ['하늘 탐험대 Movie','극장판'], ['하늘 탐험대 OAD','OAD'],
  ['하늘 탐험대 OVA','OVA'], ['[OAD]하늘 탐험대','OAD'], ['하늘 탐험대 특별편','특별편'], ['하늘 탐험대 Special','특별편'],
  ['Sky Explorers Season 3 Part 2','시즌 3 · 파트 2'], ['Sky Explorers Final Season','파이널 시즌'],
]) test(`source season parser: ${title}`,()=>{
  const parsed = parseSeasonInfo(title);
  assert.equal(parsed.seasonInfo?.label,label);
  assert.equal(parsed.baseTitle,title.startsWith('Sky') ? 'Sky Explorers' : '하늘 탐험대');
});

test('metadata seasons distinguish unmarked first season from a single-season work',()=>{
  assert.equal(parseSeasonInfo('작품').seasonInfo,undefined);
  assert.equal(parseSeasonInfo('작품',{season:1,seasons:[1]}).seasonInfo,undefined);
  assert.equal(parseSeasonInfo('작품',{season:1,seasons:[1,2]}).seasonInfo?.label,'시즌 1');
  assert.equal(parseSeasonInfo('작품',{seasons:[1,2]}).seasonInfo,undefined,'absent link season is not proof of season one');
  assert.equal(parseSeasonInfo('작품 Final Season',{seasons:[1,2,3,4]}).seasonInfo?.season,4);
});

test('season key retains parts, final halves and edition kind',()=>{
  const key = (s: string) => JSON.stringify(seasonIdentity(parseSeasonInfo(s,{season:3})));
  assert.equal(key('작품 3기 파트2'),key('Show Season 3 Part 2'));
  const variants = ['작품 3기','작품 3기 파트1','작품 3기 파트2','작품 OAD','작품 특별편','작품 극장판','작품 완결편 전편','작품 완결편 후편'];
  assert.equal(new Set(variants.map(key)).size,variants.length);
  assert.notEqual(seasonIdentity(parseSeasonInfo('작품 Final Season'))[1],1);
});

test('relevance rewards the franchise and penalizes a matching unrelated subtitle',()=>{
  const card = (title: string): MediaCard => ({id:'a',title,type:'anime',provider:{id:'a',name:'a',kind:'mangayomi-js'},...parseSeasonInfo(title)});
  assert.equal(searchRelevance(card('하늘 탐험대 2기'),'하늘 탐험대'),1);
  assert.ok(searchRelevance(card('구름 마을: 하늘 탐험대'),'하늘 탐험대') < 0.5);
});

test('Final inside a franchise name is not a final season marker',()=>{
  assert.equal(parseSeasonInfo('Final Example Quest').seasonInfo,undefined);
  assert.equal(parseSeasonInfo('Final Example Quest').baseTitle,'Final Example Quest');
});


test('plain movies have no theatrical label, but retain movie identity',()=>{
  assert.equal(parseSeasonInfo('우주 구조대',{kind:'movie'}).seasonInfo,undefined);
  assert.notDeepEqual(seasonIdentity(parseSeasonInfo('우주 구조대',{kind:'movie'})),seasonIdentity(parseSeasonInfo('우주 구조대')));
  for (const title of ['극장판 작품','劇場版 작품','작품 The Movie','작품 더 무비']) assert.equal(parseSeasonInfo(title).seasonInfo?.label,'극장판');
});
test('audio markers are display metadata and remain in grouping identity',()=>{
  for (const [title,audio] of [['(더빙)작품 2기','dub'],['작품 2기 더빙판','dub'],['작품 2기 (자막)','sub'],['작품 2기 자막판','sub']] as const) {
    const parsed = parseSeasonInfo(title);
    assert.equal(parsed.audio,audio);
    assert.equal(parsed.season,2);
    assert.notEqual(parsed.identityTitle,'작품');
  }
  assert.equal(parseSeasonInfo('작품 2기').audio,undefined);
});
