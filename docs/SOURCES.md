# 영상 소스와 확장

MOA는 사용자가 설치한 확장을 실행합니다. 신뢰하는 출처의 확장만 설치하고 외부 사이트의 이용 권한을 확인해 주세요. 웹사이트 기능을 추가하는 플러그인은 [별도 안내](PLUGINS.md)를 참고해 주세요.

## 확장 실행

Mangayomi 형식 JS는 서버의 격리된 실행 환경에서, Aniyomi APK는 별도 JVM 컨테이너에서 실행합니다. 전체 Android 앱이나 모든 확장의 호환성을 보장하지 않습니다. APK 실행 환경은 [worker 안내](../services/aniyomi-worker/README.md), 라이선스·대응 소스는 [배포 고지](THIRD-PARTY-SOURCES.md)를 참고해 주세요.

소스·저장소는 기본 등록·추천하지 않습니다. 영상 소스 화면에서 신뢰하는 저장소 URL과 형식을 직접 선택하고 필요한 확장만 설치합니다. 인기·최신·검색·필터·회차 등은 확장이 제공하는 범위만 지원하며 분류·실시간 여부·확장 설정은 관리 화면에서 바꿉니다.

업데이트는 사용자가 적용하며 검사에 실패하면 기존 설치를 유지합니다. 직전 설치로 되돌릴 수 있고 저장소 등록 해제와 설치 소스 삭제는 별개입니다. 삭제 전 기록 영향을 확인해 주세요. JS에는 공개 IP·크기·시간 제한이 있지만 APK는 JVM 코드를 실행하므로 컨테이너만으로 완전한 격리를 보장하지 않습니다.

APK worker는 API14/API16의 일부 source/filter/preference ABI와 WebView를 제공합니다. Android 에뮬레이터·원래 앱 UI는 제공하지 않습니다. WebView Chromium과 JVM은 필요할 때 시작하며 비활성 JVM은 기본 10분 뒤 종료합니다. 재생 중인 worker는 유지하고 기본 제한은 메모리 1GiB·CPU 2개·PID 192개입니다.

APK는 v0.1.2부터 선택 설치입니다. 설정 → 정보 → 추가 기능 또는 `compose.apk.yaml`로 설치합니다. 공유 토큰만 자동 생성하며 저장소·APK를 자동 설치하지 않습니다. 관리자 `GET /api/admin/apk/status`는 `{available,state,workers}`, 상태 `ready | disabled | unreachable`을 반환하고 토큰·내부 오류는 숨깁니다.

원격 영상·이미지·자막은 서버가 중계·캐시할 수 있습니다. 프록시 변경은 새 재생 세션부터 적용하며 세션 주소·설정·쿠키는 비공개로 관리합니다. [이용 안내](../README.md#이용-안내)와 [출처 고지](../THIRD_PARTY_NOTICES.md)를 확인해 주세요.

## 주소가 바뀌어도 기록 유지

작품 `link`와 회차 `url`은 확장에 원래 형식으로 전달하며 새 필드나 설정을 요구하지 않습니다. 주소가 바뀌어도 `media.id`·`episodes.id`, 프로필별 진행·찜·자막·링크를 유지합니다.

서버는 이전·새 주소를 별칭으로 저장합니다. 정확한 주소를 먼저 찾고, 알려진 같은 사이트 안에서 경로·쿼리·조각을 비교합니다. 작품은 설치된 소스, 회차는 해당 작품 안에서만 찾습니다. 후보가 여러 개면 합치지 않으며 제목·시즌·회차 이름만으로 같은 작품이라고 판단하지 않습니다. 새 항목은 별칭을 찾지 못한 뒤에만 기존 방식의 ID를 만듭니다.

- 설치된 확장의 기본 주소가 바뀌고 기본 경로가 같으면 이전·새 도메인을 연결합니다. 저장소 목록 새로고침만으로 실행 중 확장 주소를 바꾸지 않습니다.
- 확장을 되돌리면 해당 버전 주소를 사용하며 이전 별칭은 보존합니다.
- 숫자가 붙은 같은 사이트 도메인은 새 목록·상세 응답으로 확인합니다. 가장 큰 숫자를 무조건 선택하거나 오래된 응답의 폐기 주소로 되돌아가지 않습니다. 이는 호환성을 위한 추정이며 모든 사이트의 동일성을 보장하지 않습니다.
- 상세 응답이 같은 경로의 새 주소를 반환하면 해당 작품만 연결합니다. 관련 없는 다른 호스트까지 옮기지 않습니다.

서버가 도메인을 만들거나 바뀐 기본 경로를 추측하지 않습니다. JSON·단순 ID·HTTP 이외 주소는 그대로 취급하며 쿼리·조각·인코딩을 제거·정렬하지 않습니다. 절대·상대 주소를 비교해도 확장에는 원래 표현을 전달합니다. 폐기 주소 복귀는 명시적 설치 상태 변경이나 확장 자체 해결이 필요합니다.

이어보기는 알려진 주소를 사용하며 목록·상세를 매번 다시 요청하지 않습니다. 확인된 관계의 탐색용 절대 주소만 바꾸고 영상·HLS·자막·이미지·인증 헤더는 바꾸지 않습니다. 새 주소에서 추출 실패 또는 영상 없음이면 원래 주소로 한 번 시도합니다. 실패 조합은 5분 동안 재시도를 제한하고 소스 변경 시 초기화합니다. 사용할 영상 확인 후에만 주소를 저장합니다. 취소·교체된 요청은 주소를 갱신하거나 재시도하지 않으며 미사용 APK 작업을 해제합니다.

별칭은 `source_work_alias`·`source_episode_alias`, 주소 상태는 `source_address_state`·`source_address_sites`·`source_address_origins`에 저장합니다. 최초 변환은 `source_identity_migrations`로 한 트랜잭션에서 한 번만 수행합니다. 소스 삭제 시 주소 상태·별칭을 정리합니다. 예전 숫자 도메인 자료는 임의 도메인 이동 근거로 쓰지 않습니다.

구버전은 별칭을 몰라 주소 변경 후 중복 작품을 만들 수 있습니다. 설치 실패 복구 선언은 실제 사용 후 임의로 구버전으로 내려가도 안전하다는 뜻이 아닙니다. 사이트 구조·경로·회차 ID·저장소/소스 ID 변경이나 기존 중복 기록 합치기는 자동 처리하지 않습니다. 초기 변환은 실제 주소 전환이 확인되기 전까지 기존 최신 주소를 보존합니다.

참고: [Mangayomi의 회차 동기화](https://github.com/kodjodevf/mangayomi/blob/e479d28ac601594b6768ff343035ed6486babc17/lib/modules/manga/detail/providers/update_manga_detail_providers.dart)는 기존 DB ID를 유지하며 주소·회차 정보를 비교합니다. MOA는 제목만으로 합치거나 기존 항목을 삭제하는 방식을 사용하지 않습니다.

## 소스별 프록시와 브라우저 인증

소스의 **연결** 설정에서 프록시와 **브라우저 인증 사용**을 정합니다. 프록시를 비우면 서버 기본값을 씁니다. 브라우저 인증은 기본 꺼짐이며 선택한 JS 소스에만 적용합니다. APK·일반 소스 요청과 영상 중계는 유지합니다.

릴리스 설치는 설정 → 정보 → 추가 기능에서 설치할 수 있습니다. 수동 설치는 기존 Compose 파일들과 함께 다음 추가 파일을 지정합니다.

```sh
docker compose -f compose.yaml -f compose.source-browser.yaml up -d
```

`MOA_VERSION`과 같은 이미지와 `MOA_SOURCE_BROWSER_URL`·`MOA_SOURCE_BROWSER_SECRET_FILE`을 연결합니다. RPC 비밀 파일은 별도 저장소에 0600으로 만들고 앱에는 읽기 전용 연결합니다. 호스트 폴더는 UID 1000이 쓸 수 있는 `MOA_SOURCE_BROWSER_SECRET_PATH`를 지정합니다. 브라우저 포트는 공개하지 않습니다.

### 인증 정보와 요청

쿠키와 브라우저 User-Agent는 MOA 메모리에만 보관합니다. 설치 소스·설정 버전·프록시·정확한 HTTPS 출처별로 구분하며 프로필별 사이트 계정은 제공하지 않습니다. 최대 64개 세션, 60분 유휴 만료, 쿠키 수·크기 제한을 적용합니다. 앱 재시작이나 소스 설정·프록시·설치·삭제·중지·되돌리기는 관련 인증을 초기화합니다. 뒤늦게 끝난 요청은 이전 인증을 복원하지 못합니다.

```js
const client = new Client({
  timeout: 85,
  browserSession: { url: 'https://example.com/catalogue', readOnly: true }
});
const response = await client.get('https://example.com/catalogue');
```

`url`은 요청과 같은 출처의 공개 HTTPS 페이지여야 합니다. GET·HEAD는 읽기이며 POST는 확장이 읽기 작업임을 확인하고 `readOnly: true`를 지정해야 합니다. PUT·PATCH·DELETE는 허용하지 않습니다. 일반 Client·WebView를 자동 변환하지 않습니다.

처음에는 브라우저 인증을 하고 이후에는 DNS·공개 IP를 검증하는 HTTP 전송을 사용합니다. 이동 경로마다 맞는 쿠키만 보내며 다른 출처에 인증 정보를 넘기지 않습니다. `Set-Cookie`는 서버만 처리합니다. 명확한 Cloudflare 인증 요구일 때만 동시 인증 갱신을 합쳐 한 번 수행하고 한 번 재시도합니다. 일반 401·403·429·5xx나 불명확한 통신 실패로 POST를 반복하지 않습니다. 갱신 실패는 30초 대기합니다. 일부 취소는 다른 요청을 중단하지 않고 모두 취소하면 인증도 중단합니다. 사이트 AJAX nonce 만료는 해당 소스가 처리합니다.

이미지·referer 출처가 같으면 같은 세션을 쓰며 기존 브라우저 이미지 대체 경로도 유지합니다. 영상 DOM·JS 추출은 브라우저, 재생은 기존 중계에서 처리합니다.

### 자원과 보안

- 컨텍스트는 최대 2개이고 소스 설정 버전·프록시·출처별로 순서대로 처리합니다. 30초 유휴 컨텍스트를 10초 주기로 닫습니다. 요청·대기·정리가 끝나면 Python 프로세스 그룹을 종료하며 HTTP 인증 상태만 MOA에 남깁니다.
- 인증된 `POST /evaluate`는 서버가 발급한 범위·프록시·공개 HTTPS URL·헤더·스크립트와 최대 90초 제한을 받습니다. 인증·업로드·대기도 포함합니다. 요청은 512KiB, 응답은 4MiB, 확장용 WebView 결과는 1MiB입니다.
- `captureSession: true`의 쿠키·User-Agent는 서버만 받고 확장에는 결과만 전달합니다. 이전 결과 전용 요청도 지원합니다.
- DNS·공개 IP 고정, TLS 검증, 32MiB·512연결 예산, 소켓 정리·RPC 인증을 유지합니다. 유휴 로컬 중계는 연결을 거부합니다. 같은 컨테이너에 신뢰하지 않는 프로세스를 넣지 마세요.
- 쿠키·토큰·주소 상세·원본 진단은 로그에 남기지 않습니다. 프록시 실패 시 직접 연결하지 않으며 미디어·팝업·WebRTC·DoH·미리 읽기 제한을 유지합니다. locale·timezone은 명시하고 geo-IP 조회는 끕니다. service-worker 호환 처리는 사이트 동작에 영향을 줄 수 있습니다.

Camoufox `152.0.4-beta.30`, Python wrapper `0.4.11`, Playwright `1.58.0`, Linux amd64를 사용합니다. 빌드 시 고정 파일의 SHA256을 확인하고 실행 중 브라우저·추가기능을 받지 않습니다. 버전 변경 시 인증을 다시 검증해야 합니다. 출처는 [고지](../services/source-browser/NOTICE.md)를 참고해 주세요.

되돌리려면 이전 앱·브라우저 이미지와 소스 버전을 함께 보관합니다. 인증을 끄면 일반 경로로 돌아가며 실험 API가 필요한 확장은 사용 불가로 표시합니다. 상태 검사는 RPC 준비 여부이며 외부 접속·장기 인증 유지의 보장이 아닙니다.

### 검증

```sh
node --test services/source-browser/tests/*.test.mjs
python3 -m unittest discover -s services/source-browser/tests -p 'test_*.py'
corepack pnpm --filter @moa/server exec tsx --test test/source-session.test.ts test/source-browser.test.ts test/source-network.test.ts
docker compose -f compose.yaml -f compose.source-browser.yaml config --quiet
```

실제 접속 검사는 별도 컨테이너·테스트 자료로 수행합니다. 비공개 소스·쿠키·운영 자료를 공개 테스트·저장소·이미지에 넣지 마세요.
