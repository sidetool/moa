# MOA 디자인 시스템

어두운 화면, 보라색 강조, Pretendard 한글 글꼴을 공통으로 사용합니다. 설정·플레이어·소스 탐색의 조작 요소를 한곳에서 관리합니다.

- [스타일 규칙](style-guide.md): 색상·크기·배치·접근성입니다.
- [공통 컴포넌트](component-library.md): 속성과 조작 가능한 예제입니다.
- [화면 구성](pattern-library.md): 설정 저장·필터·확인 흐름입니다.

## 코드 위치

| 위치 | 역할 |
| --- | --- |
| `apps/web/src/components/ui/` | 공통 UI의 공개 진입점입니다. |
| `apps/web/src/styles/` | `_tokens.scss`, `_ui.scss`, `base.scss`, `app.scss`를 관리합니다. |
| `apps/web/src/features/` | 설정 등 기능별 데이터와 화면을 관리합니다. |
| `apps/web/design-system/` | 문서 앱과 미리보기입니다. |
| `tools/design-lint/` | 스타일 검사 도구입니다. |

앱에서 `app.scss`와 Pretendard를 한 번 불러옵니다. Sass는 기존 스타일 순서를 연결하며 사용자 설정용 CSS 변수는 유지합니다. 공통 UI는 서버 요청이나 프로필 상태를 직접 관리하지 않습니다. 설치 버전은 `pnpm-lock.yaml`을 기준으로 합니다.

## 실행

Node.js 22.17 이상과 프로젝트 pnpm을 사용합니다.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev:design-system
```

개발 화면은 `http://127.0.0.1:8797`입니다. 운영 데이터와 분리되며 Markdown 수정이 바로 반영됩니다. `preview` 코드 블록은 `previews.ts`에 등록한 컴포넌트만 실행합니다.

```sh
corepack pnpm build:design-system
corepack pnpm --filter @moa/web exec vite preview --config design-system/vite.config.ts
```

빌드 결과는 `data/design-system-dist/`, 미리보기 주소는 `http://127.0.0.1:8798`입니다.

## 검사와 변경

```sh
corepack pnpm --dir tools/design-lint install --ignore-workspace --frozen-lockfile
corepack pnpm --dir tools/design-lint typecheck
corepack pnpm lint:design-system
corepack pnpm verify:design-system
```

브라우저 검사에는 Playwright가 필요합니다. `MOA_PLAYWRIGHT_PATH`와 `MOA_BROWSER_EXECUTABLE`로 경로를 지정할 수 있으며 결과는 `MOA_VERIFY_DIR`로 지정한 폴더에 저장하며, 지정하지 않으면 운영체제의 임시 폴더를 사용합니다.

스타일 검사는 `base.scss`와 문서 스타일을 임시 CSS로 바꿔 검사하므로 보고서 줄 번호도 생성된 CSS 기준입니다. 기능별 화면은 앱 빌드에서 컴파일합니다. 이 검사는 사이트 전체의 접근성 인증을 대신하지 않습니다.

공통 UI의 속성·크기·포커스·키보드 동작을 바꾸면 사용하는 화면과 미리보기·문서를 함께 수정합니다. 기능별 API 호출은 해당 기능에 두며, 새 스타일 값과 검사 예외는 필요한 이유가 있을 때만 추가합니다.
