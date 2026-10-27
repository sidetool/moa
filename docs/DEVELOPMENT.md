# 개발과 검증

Node.js 22.13 이상, Corepack과 저장소의 고정 pnpm을 사용합니다. 압축 자막에는 `bsdtar`가 필요합니다(macOS 기본 제공, Debian/Ubuntu는 `libarchive-tools`). 배포 이미지에는 포함됩니다.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @moa/server build
corepack pnpm build:auth:css
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node --test deploy/auth/server.test.mjs
```

서버 개발 시 쓰기 가능한 `MOA_DATA_DIR`, 읽기 가능한 `MOA_MEDIA_ROOT`, 필요하면 `MOA_WEB_DIR`, `MOA_FFMPEG`, `MOA_FFPROBE`를 직접 지정합니다. `corepack pnpm dev:server`와 `corepack pnpm dev:web`로 시작합니다. 계정 헤더를 신뢰하는 개발 API를 외부에 열지 않습니다. 기본 Compose의 인증 게이트웨이를 쓰는 통합 개발은 [배포 문서](DEPLOYMENT.md)를 따릅니다.

테스트는 가상 작품·소스·ID, 메모리 DB, 로컬 HTTP 테스트 자료와 직접 생성한 미디어를 사용합니다. 개인 DB, 실서비스 응답, 확장 APK, 쿠키, 포스터, 자막을 테스트 자료로 복사하지 않습니다. 합성 영상 예:

```sh
mkdir -p data/verification
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440 \
  -t 12 -c:v libx264 -pix_fmt yuv420p -c:a aac data/verification/sample.mp4
```

APK 실행 도구의 프로세스 잠금과 중계 검증은 Linux에서 실행합니다. 브라우저 의존성은 pnpm workspace와 별개이므로 먼저 설치합니다. 아래 단위 테스트는 실제 Chromium을 실행하지 않습니다.

```sh
npm ci --prefix services/aniyomi-worker/browser --ignore-scripts
node --test services/aniyomi-worker/*.test.mjs
```

브라우저·FFmpeg·JVM이 필요한 검증은 별도 준비가 필요합니다. `deploy/tests/accounts-e2e.py`는 별도 Compose 프로젝트로 컨테이너를 시작하므로 운영 환경에서 무심코 실행하지 않습니다. 실제 환경 검증은 자신이 허가한 설치본에만 명시적으로 실행하며 기본 단위 테스트와 구분합니다. 결과물은 Git 추적에서 제외된 `data/`, `test-results/` 또는 저장소 밖의 비공개 폴더에 둡니다.

API 타입은 `packages/shared/src/index.ts`, 요청 형식은 `apps/server/src/`의 기능별 `routes.ts`와 전용 설정·스키마 모듈이 기준입니다. 새 기능은 계정·프로필 격리, 취소·시간 초과, 실패 시 기존 설치 보존처럼 사용자에게 의미 있는 동작을 검증합니다. [기여 정책](../CONTRIBUTING.md)을 따릅니다.

## 공통 UI와 문서

공통 컴포넌트는 `apps/web/src/components/ui/index.ts`에서 내보내며 기능 화면은 `components/ui` 경로로 사용합니다. 설정 화면의 데이터·저장 동작은 `apps/web/src/features/settings/`에 둡니다. 서버 번역 모듈을 포함한 책임 구분은 [구조](DEVELOPMENT.md#구조)를 참고합니다.

[디자인 시스템 문서](../spec/design-system/README.md)가 스타일·컴포넌트·패턴의 기준입니다. 미리보기는 같은 컴포넌트와 스타일을 사용합니다.

```sh
corepack pnpm dev:design-system
corepack pnpm build:design-system
corepack pnpm lint:design-system
```

개발 미리보기는 `http://127.0.0.1:8797`에서 엽니다. 공통 UI를 바꾸면 관련 Markdown·미리보기·적용 화면을 함께 갱신하고 좁은 화면·키보드·동작 줄이기 설정을 확인합니다.

스타일 원본은 SCSS로 관리합니다. 웹은 `apps/web/src/styles/app.scss`의 `@use` 순서로 빌드하고, 로그인 화면은 `deploy/auth/login.scss`를 `corepack pnpm build:auth:css`로 컴파일합니다. 로그인 서버를 직접 실행하거나 테스트할 때 먼저 이 명령을 실행합니다. 생성된 `deploy/auth/dist/login.css`는 수정하지 않습니다. 인증 Docker 이미지는 같은 Sass 버전으로 빌드 단계에서 CSS를 생성합니다.

## 구조

MOA는 로컬 미디어와 사용자가 설치한 확장을 하나의 카탈로그와 플레이어로 연결합니다.

| 구성 | 역할 |
| --- | --- |
| `apps/web` | React UI, 기기별 설정, HLS/native 재생, ASS/VTT 자막, 리모컨 탐색 |
| `apps/server` | Fastify API, SQLite, 미디어 스캔, FFmpeg 세션, 메타데이터·이미지 캐시 |
| `packages/shared` | 클라이언트와 서버의 API 타입 |
| `apps/server/src/sources/extensions` | Mangayomi 형식 JS 호환 실행, HTTP 제한·프록시 |
| `services/aniyomi-worker` | 선택 Aniyomi APK JVM 실행기와 Chromium 브리지 |
| `apps/server/src/subtitles/korean`, `apps/server/src/playback/skip-markers` | 자막 검색·변환, 외부 마커 조회와 로컬 반복 구간 분석 |
| `deploy/auth`, `deploy/gateway` | 계정·세션 인증, 신뢰하는 계정 헤더를 앱에 전달 |

미디어는 읽기 전용 `/media` 아래에 마운트합니다. 앱 DB, 설치한 확장, 자막, 번역과 캐시는 `/data`에 저장합니다. 인증 DB와 APK worker 데이터는 별도 저장소입니다. 시청 기록·설정은 프로필 단위이고 카탈로그·메타데이터 캐시는 공유합니다.

로컬 재생은 브라우저가 지원하는 형식에 따라 직접 재생, 컨테이너 변환 또는 코덱 변환을 선택합니다. 원격 재생은 서버가 발급한 세션 URL로 중계합니다. 임의 외부 URL을 받는 공개 프록시를 제공하지 않습니다. 세션 자산 URL은 접근 토큰이므로 공개하지 않습니다.

확장은 신뢰 경계 밖의 실행 코드입니다. JS에는 프로세스/QuickJS 격리와 네트워크 제한이 있고 APK에는 별도 컨테이너·자원 제한이 있습니다. APK가 일반 JVM 코드를 실행한다는 점은 변하지 않습니다. 전체 Android 앱이나 모든 확장 ABI의 호환성을 보장하지 않습니다.

TMDB, AniList, AniSkip, Anissia, Jimaku와 선택한 번역 서비스는 외부 API를 사용할 수 있습니다. 요청한 제목·식별자·자막이 외부로 전송될 수 있습니다. [자막과 스킵](PLAYBACK.md#자막-번역과-스킵), [확장](SOURCES.md#확장-실행), [보안](../SECURITY.md)을 참고합니다.

### 서버 모듈

`apps/server/src/app.ts`는 서비스 구성, 인증과 종료 처리를 연결하고 `index.ts`는 서버를 실행합니다. API 등록은 각 기능 폴더의 `routes.ts`에 둡니다. 공통 요청 처리는 `http.ts`, 프로필 설정은 `profiles/settings.ts`, 소스 입력 검증은 `sources/schema.ts`에서 관리합니다. `config.ts`, `db.ts`, `util.ts`는 공통 설정·DB·기본 도구입니다.

| 폴더 | 책임 |
| --- | --- |
| `catalog/` | 작품 조회, 묶기, 시즌·회차 식별 |
| `sources/` | 영상 소스 저장소, 설치, 탐색, 세션과 캐시. `extensions/`에 JS 호환 실행 포함 |
| `playback/` | 로컬·원격 재생, HLS, 미리보기, 캐스팅과 구간 분석. `skip-markers/`에 마커 조회·오디오 분석 포함 |
| `subtitles/` | 자막 저장·업로드·재사용. `korean/`에 온라인 검색·변환과 제작자 목록 포함 |
| `translation/` | 번역 작업과 공급자별 요청 |
| `metadata/` | TMDB·AniList·YouTube 정보와 이미지 캐시 |
| `library/`, `downloads/` | 파일 스캔과 영상 저장 |
| `plugins/` | 웹사이트 플러그인 설치·실행과 기능별 데이터 |
| `profiles/`, `shorts/` | 프로필 기록·추천·권한과 쇼츠 세션 |
| `network/`, `system/` | 네트워크·원격 접속과 업데이트·상태 관리 |

서버에서만 쓰던 확장·한국어 자막·스킵 마커는 기능 폴더에 포함합니다. 공개 API 타입을 공유하는 `packages/shared`는 웹과 서버가 함께 사용합니다. 기능 이동 시 상대 import, worker 실행 경로, JSON·MJS 빌드 자산과 테스트를 함께 옮깁니다.

### 웹 모듈

| 경로 | 책임 |
| --- | --- |
| `apps/web/src/components/` | 여러 기능이 함께 쓰는 작품 이미지·카드·목록·프로필 이미지 |
| `apps/web/src/components/ui/` | 버튼·선택·확인 모달·입력·피드백 등 재사용 UI. 공개 진입점은 `index.ts` |
| `apps/web/src/styles/_tokens.scss`, `_ui.scss` | 공통 스타일 값과 UI 규칙. `app.scss`가 `@use`로 기본·공통·화면·플레이어·쇼츠 스타일을 순서대로 연결 |
| `apps/web/src/features/` | `catalog`, `title`, `shorts`, `sources`, `plugins`, `layout`, `settings`별 화면·데이터 처리 |
| `apps/web/src/pages/` | 경로별 페이지 구성 |
| `apps/web/src/player/` | `playback`, `subtitles`, `translation`, `casting`별 재생·자막·번역·TV 전송 |
| `apps/web/design-system/` | 실제 공통 컴포넌트를 사용하는 문서·미리보기 앱 |

공통 UI에는 서버·프로필·특정 페이지의 상태를 넣지 않습니다. 기능 컴포넌트에서 데이터를 읽고 공통 UI의 속성과 이벤트로 연결합니다. 새 기능은 관련 코드와 함께 정리하며 파일 수를 늘리기 위한 공통 래퍼는 추가하지 않습니다. 시각 규칙과 사용 예시는 [디자인 시스템](../spec/design-system/README.md)을 따릅니다.

### 번역 모듈

`apps/server/src/translation/`은 자막 작업 수명과 외부 서비스 프로토콜을 분리합니다.

| 모듈 | 책임 |
| --- | --- |
| `service.ts` | 설정·키 순환·번역 작업·재시도·저장 |
| `client.ts` | 선택한 제공자로 모델 조회·번역 요청을 보내고 자막 응답을 검증 |
| `endpoint.ts` | 기본 주소와 모델·키·엔드포인트 검증 |
| `transport.ts` | 제한된 HTTP 전송, 취소·시간 초과·응답 크기·오류 처리 |
| `providers/gemini.ts`, `providers/openai.ts` | 제공자별 인증·요청·모델 목록·응답 형식 |
| `subtitle.ts`, `jimaku.ts` | 자막 문서 처리와 Jimaku 자막 조회 |

제공자를 나누어도 API 경로·저장된 설정·키 순환 정책은 유지합니다. 새 제공자는 공통 전송의 검증·취소·크기 제한을 우회하지 않습니다.

## API 개요

현재 API 타입은 `packages/shared/src/index.ts`, 입력 검증은 서버의 기능별 `routes.ts`와 전용 설정·스키마 모듈을 따릅니다. 아래는 주요 경로이며 완전한 OpenAPI 명세는 아닙니다.

계정 게이트웨이가 확인한 `X-Moa-Account`, `X-Moa-Role`, `X-Moa-Username`만 앱이 신뢰합니다. 프로필을 사용하는 JSON API는 해당 계정 소유의 `X-Moa-Profile`이 필요합니다. 이미지·발급된 재생 자산 URL은 브라우저의 헤더 없는 요청을 지원하되 세션 소유 계정을 검사합니다. 오류는 일반적으로 `{ "error": "code" }`입니다.

| 영역 | 주요 경로 |
| --- | --- |
| 상태·프로필 | `GET /api/health`, `GET /api/me`, CRUD `/api/profiles` |
| 계정·초대 | `/__moa/api/…` (인증 서버) |
| 카탈로그 | `GET /api/home`, `/api/media`, `/api/search`, `/api/media/:id` |
| 작품 그룹 | `POST /api/media/groups/resolve`, `GET/PATCH /api/media/:id/group` |
| 시즌 | `GET /api/media/:id/franchise` |
| 저장소·확장 | `GET/DELETE /api/source-repositories`, `POST /api/sources/refresh`, `/api/sources/:id/install`, `/check`, `/rollback` |
| 확장 탐색 | `GET/POST /api/sources/:id/browse`, `GET/PATCH /preferences`, `GET /filters` |
| 로컬 라이브러리 | `/api/library/folders`, `/browse`, `/scan`, `/status` |
| 재생 | `POST /api/playback`, `POST /api/playback/:sessionId/heartbeat`, `DELETE /api/playback/:sessionId` |
| 자막·마커 | `/api/episodes/:id/subtitles/…`, `GET /api/episodes/:id/markers` |
| 번역 | `/api/translations/:id`, `/api/translation/config`, 관리자 `/api/admin/translation/…` |
| 캐시 진단 | `GET /api/admin/cache-stats` |

재생 생성은 `episodeId`, `capabilities`와 선택 `audioTrackId`, `streamId`, `startPosition`을 받습니다. `capabilities`에는 h264/hevc/av1 지원 여부와 선택 항목 vp9/audioCodecs/maxHeight를 전달합니다. 반환된 URL을 그대로 사용하고 `sessionId`를 외부에 공유하지 않습니다. 주기적인 상태 알림(heartbeat)과 재생 파일 접근은 세션 수명을 갱신합니다.

소스·메타데이터·라이브러리·전역 설정의 변경은 관리자 권한이 필요합니다. 시청 기록·찜·개인 그룹 변경은 소유 프로필 범위입니다. 인증 서버의 JSON 변경 호출에는 동일 출처 Origin과 `X-Moa-Request: 1`이 필요합니다. [계정](ACCOUNTS.md), [그룹](CATALOG.md#검색과-작품-묶기)을 참고합니다.

## 설치 UI 계약

### 첫 관리자

- `GET /__moa/login`: 계정이 없으면 303 `/__moa/setup`.
- `GET /__moa/setup`: 계정이 없을 때 HTML 200과 CSRF 쿠키. 이미 계정이 있으면 404.
- `POST /__moa/setup`: `application/x-www-form-urlencoded`. 필드 `csrf`, `code`, `username`, `password`, `confirm`, 선택 `remember=on`.
- 코드는 앞뒤 공백 제거·대문자 변환 후 비교합니다. 아이디는 앞뒤 공백 제거·소문자 변환 후 `[a-z0-9._-]{2,32}`. 비밀번호는 8~1024자.
- 성공: 첫 admin 계정 생성, 코드 삭제, 세션 쿠키 발급, 303 `/__moa/continue?next=%2F` → `/`. 일반 로그인과 같은 세션·CSRF·Secure-cookie 로직을 사용합니다.
- 실패: 같은 HTML을 해당 HTTP 상태로 다시 표시합니다. `#setup-error[data-error]`에 안정적인 오류 코드를 제공합니다. 비밀번호와 설정 코드는 다시 표시하지 않습니다.

| 상태 | data-error |
| --- | --- |
| 400 | `invalid-setup-code`, `invalid-username`, `invalid-password`, `password-mismatch` |
| 403 | `csrf-required` |
| 409 | `already-set-up` (동시 요청 중 다른 요청이 먼저 성공) |
| 429 | `too-many-attempts`, `Retry-After: 900` |

동일 IP는 인증 시도를 15분당 8번 할 수 있습니다. 로그인·가입 제한을 공유하며 동시에 해시를 검증하는 요청은 최대 4개입니다. 재시작 시 메모리의 제한은 초기화됩니다. 잘못된 미디어 타입은 415, 너무 큰 본문은 413 JSON 오류를 반환합니다.

스타일링 대상: `deploy/auth/setup.html`. `#setup`, `#setup-form.setup-form`, `#setup-error.error`, 입력 `#code`, `#username`, `#password`, `#confirm`, `#remember`, 버튼 `#setup-submit`. 템플릿 변수 `CSRF`, `USERNAME`, `ERROR`, `ERROR_CODE`는 HTML 특수 문자를 변환해 표시합니다. CSP는 같은 출처의 별도 CSS/JS 파일만 허용하므로 인라인 코드 대신 정적 파일로 등록합니다.

### TMDB 관리자 설정

`GET /api/admin/tmdb/config`와 `PATCH /api/admin/tmdb/config`는 관리자 전용이며 프로필 헤더가 필요 없습니다. 게이트웨이 세션 인증과 기존 앱 API 보호를 사용합니다. 응답은 `Cache-Control: private, no-store`이고 실제 키를 포함하지 않습니다.

PATCH JSON은 다음 중 **하나만** 보냅니다.

```json
{"token":"TMDB_READ_ACCESS_TOKEN"}
```

```json
{"apiKey":"0123456789abcdef0123456789abcdef"}
```

```json
{"clear":true}
```

토큰은 16~4096자의 영문·숫자·점·밑줄·하이픈, API 키는 32자리 16진수입니다. 저장 시 DB의 기존 인증 정보를 교체하며 `clear`는 DB 값만 삭제합니다. 환경변수에 토큰이나 키가 있으면 환경변수 설정 전체가 우선하고, 토큰이 키보다 우선합니다.

GET/PATCH 200 응답 예:

```json
{"configured":true,"source":"database","credentialType":"token","hasSavedCredential":true}
```

`source`: `environment | database | none`. `credentialType`: `token | apiKey | null`. `configured`는 키 존재 여부이며 원격 API 유효성 검증 결과가 아닙니다. `hasSavedCredential`은 환경변수로 덮어쓰는 중에도 DB 키 존재 여부를 보여줍니다. 저장 후 새 요청부터 바로 적용되며 진행 중인 요청은 이전 키를 사용할 수 있습니다. 기존 `GET /api/metadata/status`의 `{ "tmdb": boolean }`도 현재 활성 상태를 반영합니다.

오류 JSON `{ "error": "..." }`: 400 `invalid-request`, 401 `login-required`, 403 `admin-required`. 키는 DB에 저장되므로 데이터 백업도 비공개로 관리합니다.
