# 인물 정보 플러그인 통합 인계

작업 브랜치: `feat/people-plugin`, 기반: `feat/discovery-plugin`의 `aefecaf`.
인기 플러그인 호스트 기반을 포함한다. 운영 배포·설치·push 기록이 아니다.

## 범위

- 별도 패키지 `plugins/title-people/`, 작품 상세에 출연진·배역·제작진 표시.
- 인물 선택 → 다른 참여작 → MOA 제목 검색. 재생 가능 여부를 보증하지 않는다.
- TMDB 기존 작품 연결 사용. AniList 성우/캐릭터 연결은 미구현이며 후속 검토.
- 공급자 중립 `moa.metadata` API. 기존 `MetadataCandidate` 계약은 변경하지 않는다.
- 신규 권한 `metadata.read`. 기존 플러그인이나 내장 추천에 자동 부여하지 않는다.
- 현재 키즈는 지원하지 않음. 내장 추천/시청기록/서버 저장과 독립적이다.
- 기본 TMDB 인물 패널을 삭제하거나 변환하지 않는다. 플러그인을 끄면 기존 화면만 남는다.

## 다른 에이전트와 통합

`feat/next-media-features` 작업 트리를 직접 수정하지 않는다. 인기 플러그인의
`PLUGIN-DISCOVERY-HANDOFF.md`에 기재한 공통 파일 충돌에 더해 아래를 유지한다.

- `registerWebsitePlugins(app,db,discovery?,people?)`: 네 번째 인자는 `PluginPeople`.
  다른 인자/API가 추가됐으면 최종 통합에서 양쪽 서비스가 연결되도록 조정한다.
- 권한 whitelist·shared union·UI label·SDK에서 `history.read`, `discovery.read`,
  `metadata.read`를 모두 보존한다. 서로 대체 권한이 아니다.
- `Tmdb`에는 연결 조회와 두 개의 고정 엔드포인트만 추가. 키 설정 revision은
  인기 API와 공유하며, 다른 작업의 기존 메타데이터/추천 코드를 보존한다.
- 신규 소스: `plugin-people.ts`, `tmdb-people.ts`; 신규 검사: `plugin-people.test.ts`.
- 패키지 최소 버전 `0.1.2-beta.1`은 미출시 후보다. 실제 통합 릴리스에 맞춘다.

## 필수 확인

서버의 신규 테스트 및 인기/TMDB/기존 플러그인 검사, 전체 타입 검사, 웹 빌드,
독립 UI 검사와 실제 SDK/API 격리 브라우저 검사를 통합 후 실행한다. 운영 서버에
자동 설치하지 않는다. ZIP만 현재 v0.1.1에 설치해도 새 호스트 API는 생기지 않는다.

검사 데이터는 합성 자료다. 공급자 문서의 TV 시리즈 전체 범위를 명시하고,
한국어 이름·voice 표기만으로 한국어 더빙 성우라고 표시하지 않는다.
사진/포스터는 기존 MOA 컴포넌트로 표시하고 iframe CSP를 변경하지 않는다. 플러그인은 데이터 hook만 제공하며 자체 UI나 connect 권한을 요구하지 않는다.

## 검증 명령

```sh
corepack pnpm --filter @moa/server exec tsx --test test/plugin-people.test.ts test/plugin-discovery.test.ts test/tmdb.test.ts
corepack pnpm typecheck
corepack pnpm --filter @moa/web build
MOA_PLAYWRIGHT_PATH=/path/to/playwright-core MOA_BROWSER_EXECUTABLE=/path/to/chromium \
  corepack pnpm --filter @moa/server exec tsx scripts/verify-people-plugin.mts
node --test plugins/title-people/test/plugin.test.mjs
MOA_PLAYWRIGHT_PATH=/path/to/playwright-core MOA_BROWSER_EXECUTABLE=/path/to/chromium \
  node plugins/title-people/test/host-ui.smoke.mjs
node plugins/template/build.mjs ../title-people
```

서버 검사 8개는 정규화·역할/판본 구분, bounded cache/backoff/coalescing,
키즈·매핑/설정 변경 경쟁, 인물 멤버십, 계정/권한/revision/비활성화 경계를
다룬다. 기존 인기/TMDB 8개, 플러그인/카탈로그 hook 4개도 통과했다.
`bsdtar`가 없는 로컬 환경에서는 기존 whole-folder archive fixture 검사를
제외하며, 새로 빌드한 실제 ZIP은 별도로 `unpackPlugin`으로 확인한다.
플러그인 hook 단위 검사 6개, 네이티브 UI 상태 전환 검사도 통과했다.
완성된 폴더의 중첩 test/host/index.html 대신 루트 plugin.js가 선택되는지 확인했다.
브라우저 검사는 외부 요청 없이 임시 DB·서버와 합성 응답을 사용하며,
그림 바이트만 가짜 PNG로 제공한다. 실제 공급자 수록률·더빙 정보 검증을
의미하지 않는다. 결과 캡처는 기본 `/tmp/moa-people-verify/`에 저장한다.


## UI 최종 연결

사용자 요청에 따라 별도 패널은 폐기했다. `title.people` hook은 기존
`PeopleRow`와 `TitlePeople` 네이티브 시트로 연결되며 패키지 ID를 하드코딩하지
않는다. `people-hooks.ts`는 활성 프로필의 등록·취소/시간 제한을 담당한다.
기존 `Person`에는 optional `identity`만 추가했다. 기존 캐시의 이름을 ID로
추정하지 않는다. 권한·hook union/parser/SDK를 통합할 때 기존 catalog hook을
같이 보존한다. `TitleExtras.tsx`, `TitlePage.tsx`, `styles/pages.css`도 이제
통합 대상이다. 다른 에이전트의 해당 변경을 덮어쓰지 않는다.

## 로컬 통합 결과 — 2026-10-11

`feat/people-plugin`의 `0c28beb`까지 `feat/next-media-features`에 통합했다.
위 충돌 해결 지침을 적용하여 세 권한과 SDK/API를 함께 보존했고, 작품 상세의
서버 저장 UI 및 업데이트 전 저장 작업 중단 연결을 유지했다.
관련 서버 검사 38개와 플러그인 검사 6개, 전체 타입 검사, 웹 빌드가 통과했다.
합성 데이터로 실제 앱·SDK를 연결한 인물/인기 플러그인 시험도 통과했다.
실사이트 요청, 운영 플러그인 설치, push, 릴리스 발행은 수행하지 않았다.
