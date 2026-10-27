# 국내 박스오피스

홈에 KOBIS의 국내 극장 관객 수 순위 1~10위를 표시합니다. 일간은 한국 시간 기준 어제, 주간은 마지막으로 완료된 월~일입니다. 관객 수·누적 관객 수·순위 변화를 보여 주며 작품을 누르면 MOA에서 제목을 검색합니다.

## 설치와 설정

MOA `0.1.2-beta.3` 이상과 `moa.discovery.boxOffice`가 필요합니다. 키즈 프로필에서는 제공하지 않습니다.

1. [KOBIS 오픈API](https://www.kobis.or.kr/kobisopenapi/)에서 키를 발급받습니다.
2. 서버의 `MOA_KOBIS_API_KEY`에 키를 지정하고 다시 시작합니다. Compose에서는 `.env`에 설정합니다.
3. 관리자 설정에서 플러그인을 설치하고 필요한 권한을 승인합니다.

키는 서버에만 보관합니다. 자세한 설치는 [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

## 데이터와 권한

극장 관객 수 기준이며 OTT 순위가 아닙니다. 검색 결과가 해당 영화의 재생을 보장하지는 않습니다. 서버는 결과를 30분, 실패를 60초간 보관합니다. 기간 변경·실패·권한 거부 시 이전 목록을 지웁니다.

`boxoffice.read`는 순위 조회, `app.navigate`는 검색 이동, `ui`는 패널 높이 조절에 사용합니다. 외부 연결 권한은 없으며 KOBIS 요청은 서버에서 처리합니다. 화면에 영화진흥위원회 영화관입장권 통합전산망(KOBIS) 출처를 표시합니다.

## 빌드와 검사

저장소 루트에서 실행합니다. 브라우저 검사에는 `MOA_PLAYWRIGHT_PATH`와 `MOA_BROWSER_EXECUTABLE`을 지정합니다.

```sh
node plugins/template/build.mjs ../korean-boxoffice
pnpm --filter @moa/server exec tsx scripts/verify-news-boxoffice.mts
```

검사에는 실제 KOBIS 키 대신 합성 응답을 사용합니다.
