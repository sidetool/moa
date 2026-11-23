import { useState } from 'react';
import { ResumeSceneSetting } from '../src/features/settings/ResumeSceneSetting';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { MediaCard } from '@moa/shared';
import { LandscapeCard } from '../src/components/Cards';

const base: MediaCard = { id: 'screening', title: '화면 테스트 영상', type: 'series', provider: { id: 'local', kind: 'local', name: '로컬' } };
const samples: MediaCard[] = [
  { ...base, resume: { kind: 'resume', label: '이어보기 S1:E1', position: 660, episodeId: 'episode-1', thumb: new URL('./resume-still.webp', import.meta.url).href }, progress: { episodeId: 'episode-1', label: 'S1:E1 · 14분 남음', ratio: .44 } },
  { ...base, id: 'projector', title: '영사실의 밤', resume: { kind: 'next', label: '다음 회차 S1:E2', position: 0, episodeId: 'episode-2' } },
];

function Examples() {
  const { pathname } = useLocation();
  const [showResumeScene, setShowResumeScene] = useState(true);
  const [cards, setCards] = useState(samples);
  async function hide(card: MediaCard) {
    setCards(current => current.filter(item => item.id !== card.id));
  }
  return <>
    <ResumeSceneSetting checked={showResumeScene} save={async enabled => setShowResumeScene(enabled)} />
    <div className="preview-grid">
      {cards.map(card => <LandscapeCard key={card.id} card={card} showResumeScene={showResumeScene} onHideContinue={hide} />)}
    </div>
    <output>{pathname.startsWith('/watch/') ? (pathname.endsWith('episode-1') ? '1화 11분부터 재생' : '2화 처음부터 재생') : pathname.startsWith('/title/') ? '작품 상세' : ''}</output>
  </>;
}

export function ContinueArtPreview() {
  return <MemoryRouter><Examples /></MemoryRouter>;
}
