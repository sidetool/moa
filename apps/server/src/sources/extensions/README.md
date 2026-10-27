# 영상 소스 확장

Mangayomi 형식 JavaScript를 QuickJS의 별도 프로세스에서 실행합니다. 저장소 목록 읽기, `getVideoList` 등 소스 호출, 필터·환경설정 변환, 공개 HTTP 요청과 프록시를 지원합니다. 원래 앱의 모든 기능을 지원하지는 않습니다.

기본 저장소는 없으며 사용자가 선택한 저장소 URL과 설치 항목을 받습니다. APK는 별도 작업 서버가 처리합니다. [확장 사용 안내](../../../../../docs/SOURCES.md#확장-실행)와 [출처 고지](NOTICE.md)를 참고해 주세요.

```sh
corepack pnpm --filter @moa/server build
corepack pnpm --filter @moa/server typecheck
corepack pnpm --filter @moa/server test
```

테스트에는 로컬 HTTP 서버와 합성 소스를 사용합니다. 내려받은 코드·환경설정·쿠키는 서버의 비공개 데이터로 보관합니다.
