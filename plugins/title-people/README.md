# 출연·제작진

작품 화면에 TMDB 출연·제작진 전체와 인물별 참여 작품을 표시합니다. 기존 출연 줄을 유지하며, TMDB 인물 ID가 있는 배우를 선택하면 배역·직무·참여 작품을 볼 수 있습니다. 참여 작품을 누르면 MOA에서 제목을 검색합니다.

## 동작과 데이터

`title.people` 훅으로 `moa.metadata.credits()`와 `moa.metadata.person({ provider, id })`를 제공합니다. 화면은 본체의 `apps/web/src/features/title/TitleExtras.tsx`(`PeopleRow`)와 `TitlePeople.tsx`(`PeopleSheet`)에서 표시합니다. 같은 훅이 여러 개면 현재 프로필에 등록된 플러그인 중 ID 순서의 첫 항목을 사용합니다.

확정된 TMDB 작품 연결만 사용하며 이름으로 인물을 추측하지 않습니다. TV는 시리즈 전체 기준이고 배역·직무는 원문을 유지합니다. 출연·제작 각 최대 60명, 배역·직무 각 8개, 인물별 참여 작품 최대 40편을 공급자 순서로 표시합니다. 잘린 결과는 화면에 알립니다.

화면을 닫거나 작품을 바꾸면 요청을 취소하고 늦은 응답을 버립니다. 플러그인을 끄면 원래 출연 줄로 돌아갑니다. 본체는 작품·인물 ID와 응답 형식을 확인하며 TMDB의 `w185` 인물 사진과 `w342` 포스터만 표시합니다. 실패·권한 거부 시 이전 정보를 지우고 다시 시도할 수 있게 합니다.

## 설치와 권한

MOA `0.1.2-beta.1` 이상에서 `title.people`과 `metadata.read`를 지원해야 합니다. `metadata.read`만 요청하며 TMDB 키는 서버에 남습니다. 검색 이동과 이미지는 본체에서 처리합니다. [플러그인 안내](../../docs/PLUGINS.md)를 참고해 주세요.

```sh
node plugins/template/build.mjs ../title-people
```

## 검사

저장소 루트에서 실행합니다. 브라우저 검사에는 Playwright와 선택적 Chromium 실행 경로를 지정합니다. 합성 SDK·공급자 응답으로 화면·권한·취소·오류 처리를 확인합니다.

```sh
node --test plugins/title-people/test/plugin.test.mjs
MOA_PLAYWRIGHT_PATH=/path/to/playwright-core MOA_BROWSER_EXECUTABLE=/path/to/chrome   node plugins/title-people/test/host-ui.smoke.mjs
```

## 출처

화면에 TMDB 공식 로고와 다음 문구를 표시합니다.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

정보·이미지 권리는 TMDB와 각 권리자에게 있습니다. 플러그인 라이선스는 [GPL-3.0-or-later](../../LICENSE)를 따릅니다.
