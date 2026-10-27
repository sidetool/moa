import { useEffect, useRef, useState } from 'react';
import plugin from '../../../plugins/anime-schedule/plugin.js?raw';

const fixture = [
  { subject: '별빛 여행', time: '22:00', status: 'ON', startDate: '2020-01-01', endDate: '' },
  { subject: '새로운 모험', time: '23:30', status: 'OFF', startDate: '2020-01-01', endDate: '' },
  ...['달빛 정원', '여름의 약속', '구름 너머', '바다의 노래', '다음 이야기', '밤하늘 우체국'].map((subject, index) => ({ subject, time: `23:${31 + index}`, status: 'ON', startDate: '2020-01-01', endDate: '' })),
];
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240" viewBox="0 0 160 240"><rect width="160" height="240" fill="#30245c"/><circle cx="112" cy="62" r="28" fill="#a78bfa"/><path d="M0 190L70 98L160 210V240H0Z" fill="#655095"/><text x="80" y="218" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">MOA</text></svg>';

// Run the installed plugin source with local fixtures and no network access.
const source = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><body><script>
window.moa = {
  on: (event, listener) => { if (event === 'ready') queueMicrotask(listener); },
  ui: { resize: async value => parent.postMessage({kind:'schedule-height',value}, '*') },
  app: { navigate: async value => parent.postMessage({kind:'schedule-path',value}, '*') },
  metadata: { lookup: async ({title}) => ({ provider:'tmdb', status:'ready', ...(title === '별빛 여행' ? {mediaId:'preview-anime'} : {}), ...(title !== '새로운 모험' ? {poster:'https://image.tmdb.org/t/p/w342/preview-' + ${JSON.stringify(fixture.map(entry => entry.subject))}.indexOf(title) + '.jpg'} : {}) }) },
  fetch: async url => {
    if (!url.startsWith('https://image.tmdb.org/')) return new Response(JSON.stringify({code:'ok',data:${JSON.stringify(fixture)}}));
    await new Promise(resolve => setTimeout(resolve, 200));
    return new Response(${JSON.stringify(poster)}, {headers:{'content-type':'image/svg+xml'}});
  }
};
const script = document.createElement('script');
script.textContent = ${JSON.stringify(plugin).replace(/</g, '\u003c')};
document.head.append(script);
</script>`;

export function AnimeSchedulePreview() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(500), [path, setPath] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const {kind, value} = event.data ?? {};
      if (kind === 'schedule-height' && typeof value === 'number' && Number.isFinite(value)) setHeight(Math.max(120, Math.min(1200, Math.ceil(value))));
      if (kind === 'schedule-path' && typeof value === 'string' && value.startsWith('/') && value.length < 2048) setPath(value);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return <div className="preview-stack">
    <iframe ref={frame} title="요일별 신작 미리보기" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} style={{width:'100%',height,border:0}} />
    <p role="status" className="preview-status">{path ? `이동 경로: ${path}` : '작품을 선택해 이동 경로를 확인하세요.'}</p>
  </div>;
}
