# 스킵 구간

AniSkip의 구간 정보와 FFmpeg·fpcalc의 반복 오디오 분석을 제공합니다. `index.ts`에서 분석·비교·병합·캐시·프로세스 실행 함수를 내보냅니다. 로컬 분석에는 FFmpeg·Chromaprint와 파일 읽기 권한이 필요합니다.

## 서버 연결

서버는 작품·회차 ID와 영상 길이로 외부 구간과 로컬 캐시를 연결합니다. 플레이어는 확인된 구간과 신뢰도로 오프닝·엔딩 버튼을 표시합니다. 시청 진행도와 계정·키즈 권한은 별도로 확인합니다.

캐시에는 파일 변경, 분석 설정, 알고리즘 버전을 반영합니다. 분석의 자원·동시 실행·취소 제한을 유지하고 실패해도 재생은 계속할 수 있어야 합니다. 영상 판본이나 반복 장면 때문에 잘못된 구간이 나올 수 있으므로 낮은 신뢰도의 결과를 확정하지 않습니다.

[자막·스킵 안내](../../../../../docs/PLAYBACK.md#자막-번역과-스킵)를 참고해 주세요. 테스트에는 합성 시즌과 오디오를 사용합니다.

```sh
corepack pnpm --filter @moa/server build
corepack pnpm --filter @moa/server test
```

기술 출처는 [Chromaprint](https://acoustid.org/chromaprint), [AniSkip](https://api.aniskip.com/api-docs), [AniList](https://docs.anilist.co/guide/graphql/)입니다. 외부 데이터의 이용 조건은 소프트웨어 라이선스와 별개입니다.
