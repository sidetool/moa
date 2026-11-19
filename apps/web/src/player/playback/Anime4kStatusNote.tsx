const fallbackReasons = {
  waiting: '영상 준비 중',
  preparing: '보정 준비 중',
  paused: '일시정지',
  ended: '재생 종료',
  seeking: '탐색 중',
  hidden: '화면이 숨겨짐',
  captions: '브라우저 자막 표시 중',
  resolution: '보정 지원 해상도 초과',
  media: '이 영상은 보정 미지원',
  unsupported: '이 기기는 보정 미지원',
  live: '실시간 방송',
  fullscreen: '기본 플레이어로 재생 중',
  pip: '화면 속 화면',
  remote: '외부 기기에서 재생 중',
  videoError: '영상 재생 오류',
  filterError: '화질 보정 오류',
  performance: '처리 속도 부족',
};

export type Anime4kFailure = 'unsupported' | 'filterError' | 'performance';
export type Anime4kStatus = 'active' | keyof typeof fallbackReasons;

export function Anime4kStatusNote({ status }: { status: Anime4kStatus }) {
  return <p className="panel-note" role="status">Anime4K {status === 'active' ? '적용 중' : `원본 재생 · ${fallbackReasons[status]}`}</p>;
}
