# 배포 고지와 대응 소스

소스 checkout의 자체 코드는 GPL-3.0-or-later다. QuickJS host·확장 호환·proxy·worker/browser 구현도 MOA 자체 코드다. 제3자 파일은 원조건을 유지한다. JASSUB가 import하는 rvfc-polyfill의 later 권한은 확인되지 않았으므로 해당 결합 웹 산출물은 GPLv3 조건으로 배포한다. [전체 고지와 미확정 항목](../THIRD_PARTY_NOTICES.md)을 먼저 확인한다.

루트 Dockerfile은 `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `LICENSES/`를 앱 이미지와 웹의 `/licenses/`에 포함한다. APK 이미지도 고지와 **빌드 중 생성한 실제 수정 소스** `/app/build/src`, POM, inventory를 포함한다. 일반 `pnpm build`로 웹만 별도 배포하는 경우 같은 고지를 배포물에 포함해야 한다. 고지 포함은 원저작권·대응 소스 제공 의무를 대신하지 않는다.

## APK worker의 선택 소스

`services/aniyomi-worker/build.py`는 다음 고정 소스 archive를 해시 확인 후 선택·수정한다. 정확한 patch recipe와 선택 조건은 이 파일을 따른다.

| 원본 | 버전 / SHA-256 |
| --- | --- |
| [Suwayomi archive](https://codeload.github.com/Suwayomi/Suwayomi-Server/zip/refs/tags/v2.3.2243) | `v2.3.2243` / `e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2` |
| [Aniyomi archive](https://codeload.github.com/aniyomiorg/aniyomi/zip/97414446b8a95994c72dd33c41c971a89d4d25b8) | `97414446b8a95994c72dd33c41c971a89d4d25b8` / `e9bae19c0387b0aa7f977e61ffc35712f0711c7ec877d606bd1bce2ff2193521` |

Suwayomi의 `androidx/preference/*.java`, `MemoryCookieJar.kt`, `RxCoroutineBridge.kt`는 MPL이다. `JsonObject.kt`는 보수적으로 MPL로 취급한다. Preference/ListPreference/TwoStatePreference 수정분도 MPL 조건을 유지한다. AOSP URI/annotation/LruCache/UriCodec와 Tachiyomi 하위 Apache 코드의 고지는 별도로 보존한다. Aniyomi API의 import/Compose/PreferenceScreen 변환은 Apache 조건과 수정 표시를 유지한다.

같은 release commit의 build recipe·원archive·수정 source tree·inventory·POM과 lock을 source archive로 함께 제공한다. 이미지에 있는 수정 소스는 컨테이너를 시작하지 않고 `docker create`/`docker cp`로 추출할 수 있다. 수신자가 실제 배포 버전에 대응하는 소스를 받을 수 있는 release URL을 게시한다. 생성 소스만 제공하면 의존 JAR·브라우저·JRE의 소스 제공이 자동으로 해결되는 것은 아니다.

## 웹·네이티브·이미지 릴리스

웹 JS와 WASM, JASSUB/libass/FreeType/default font, sharp/libvips 및 포함된 하위 라이브러리의 **정확한 버전·전체 고지·원소스·수정분·빌드 옵션**을 릴리스별로 확보한다. GPL Corresponding Source와 LGPL의 라이브러리 교체/재링크에 필요한 자료·방식을 함께 제공한다. 잠금 파일이나 wrapper LICENSE만으로 WASM/prebuilt 구성 전체를 인증하지 않는다.

Maven JAR는 `dependencies.lock.json`의 좌표/해시와 embedded META-INF 고지를 보존한다. OS 이미지에는 `/usr/share/doc` 등의 copyright 자료를 유지하고, FFmpeg의 실제 configure/license, Chromium, OpenJDK, 폰트 버전을 기록한다. `xpp3`, legacy W3C/SAX와 shaded JAR의 미확정 항목은 바이너리 공개 전에 확인해야 한다. 권한을 확인하지 못한 외부 미디어·자막·API 데이터는 릴리스에 넣지 않는다.

## 기본 이미지의 요청 시 실행 도구

- ByeDPI: [고정 소스](https://github.com/hufrea/byedpi/tree/ba532298de7b28cfe854aea83d061369d13ca290), MIT (`LICENSES/ByeDPI-MIT.txt`). tar SHA-256 `c7211cfc0729d213219be9b67d774e375d75ae53bbf18b6af1967f06919bbac4`. 정적으로 연결한 musl 1.2.5 고지는 `LICENSES/musl-COPYRIGHT.txt`에 보존한다. 소스 변경 없이 Alpine에서 `make LDFLAGS=-static`, `strip ciadpi`로 빌드한다.
- yt-dlp: [2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19), Unlicense (`LICENSES/yt-dlp-Unlicense.txt`). Unix zipapp SHA-256 `1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6`. 포함된 EJS 0.8.0도 Unlicense이며 archive 내부 고지를 유지한다. Python3와 기존 Node로 실행하고 원본 archive를 수정하지 않는다.

Dockerfile이 정확한 다운로드·해시·빌드 명령을 정의한다. 두 도구는 비활성 상태에서 프로세스를 실행하지 않는다.
