# MOA 서버

Fastify와 SQLite로 미디어 목록, 프로필, 영상 소스, 재생, 자막을 관리합니다. 재생 환경에 따라 직접 재생·포맷 변환·재인코딩을 선택하며, 계정별 재생 세션을 발급합니다.

## 코드 위치

- `src/app.ts`: 서비스 연결, 공통 인증·권한 검사, 시작·종료 처리입니다.
- 각 기능 폴더의 `routes.ts`: 프로필·작품·소스·메타데이터·네트워크·쇼츠·라이브러리·재생·자막·번역·다운로드 API입니다.
- `src/profiles/settings.ts`: 프로필·기기 설정 API와 입력 검증입니다.
- `src/http.ts`: 공통 요청·스키마·파일 전송 처리입니다.

[개발 안내](../../docs/DEVELOPMENT.md), [API](../../docs/DEVELOPMENT.md#api-개요), [배포 안내](../../docs/DEPLOYMENT.md)를 참고해 주세요. `MOA_DATA_DIR`에는 서버 전용 쓰기 경로를, `MOA_MEDIA_ROOT`에는 읽을 수 있는 미디어 경로를 지정합니다. 운영 DB를 테스트 자료로 사용하지 않습니다.

```sh
corepack pnpm --filter @moa/server typecheck
corepack pnpm --filter @moa/server test
corepack pnpm --filter @moa/server build
```
