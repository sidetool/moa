# 배포 고지와 대응 소스

MOA 자체 코드는 GPL-3.0-or-later로 배포합니다. 제3자 파일에는 원래 라이선스를 적용합니다. JASSUB가 사용하는 rvfc-polyfill에는 이후 GPL 버전 사용 권한이 확인되지 않았으므로 결합된 웹 배포물은 GPLv3 조건을 따릅니다. [전체 고지와 미확정 항목](../THIRD_PARTY_NOTICES.md)을 함께 확인해 주세요.

루트 Dockerfile은 `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `LICENSES/`를 앱 이미지와 웹의 `/licenses/`에 포함합니다. APK 이미지에는 빌드 중 생성한 실제 수정 소스 `/app/build/src`, POM과 구성 목록도 포함합니다. `pnpm build`로 웹만 따로 배포할 때도 같은 고지를 넣어야 합니다. 고지를 포함하더라도 저작권 표시와 대응 소스 제공 의무는 남습니다.

## APK 실행 도구의 원본 소스

`services/aniyomi-worker/build.py`는 아래 압축 파일의 해시를 확인한 뒤 필요한 소스를 선택하고 수정합니다. 정확한 선택 조건과 수정 방법은 이 파일에서 관리합니다.

| 원본 | 버전 / SHA-256 |
| --- | --- |
| [Suwayomi](https://codeload.github.com/Suwayomi/Suwayomi-Server/zip/refs/tags/v2.3.2243) | `v2.3.2243` / `e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2` |
| [Aniyomi](https://codeload.github.com/aniyomiorg/aniyomi/zip/97414446b8a95994c72dd33c41c971a89d4d25b8) | `97414446b8a95994c72dd33c41c971a89d4d25b8` / `e9bae19c0387b0aa7f977e61ffc35712f0711c7ec877d606bd1bce2ff2193521` |

Suwayomi의 `androidx/preference/*.java`, `MemoryCookieJar.kt`, `RxCoroutineBridge.kt`는 MPL을 따릅니다. `JsonObject.kt`도 보수적으로 MPL로 취급하며 Preference/ListPreference/TwoStatePreference 수정분에 같은 조건을 유지합니다. AOSP URI/annotation/LruCache/UriCodec와 Tachiyomi의 Apache 코드 고지는 별도로 보존합니다. Aniyomi API의 import/Compose/PreferenceScreen 변환에도 Apache 조건과 수정 표시를 유지합니다.

릴리스와 같은 커밋의 빌드 방법, 원본 압축 파일, 수정 소스, 구성 목록, POM과 잠금 파일을 소스 압축 파일로 함께 제공합니다. 이미지의 수정 소스는 컨테이너를 시작하지 않고 `docker create`와 `docker cp`로 추출할 수 있습니다. 배포 버전에 맞는 소스를 받을 수 있도록 릴리스 URL을 게시합니다. 생성 소스만 제공한다고 의존 JAR·브라우저·JRE의 소스 제공 의무가 모두 해결되는 것은 아닙니다.

## 웹·네이티브·이미지 릴리스

웹 JS/WASM, JASSUB/libass/FreeType/기본 글꼴, sharp/libvips와 하위 라이브러리의 정확한 버전·전체 고지·원본 소스·수정분·빌드 옵션을 릴리스별로 보관합니다. GPL 대응 소스와 LGPL 라이브러리의 교체·재링크에 필요한 자료와 방법도 제공합니다. 잠금 파일이나 외부 패키지의 LICENSE만으로 내부 WASM·사전 빌드 파일 전체의 조건을 확인했다고 간주하지 않습니다.

Maven JAR는 `dependencies.lock.json`의 좌표·해시와 내부 `META-INF` 고지를 보존합니다. OS 이미지에는 `/usr/share/doc` 등의 저작권 자료를 유지하고 FFmpeg의 실제 설정·라이선스, Chromium, OpenJDK와 글꼴 버전을 기록합니다. `xpp3`, 구형 W3C/SAX 및 다른 코드를 합친 JAR의 미확정 항목은 바이너리 공개 전에 확인해야 합니다. 사용 권한을 확인하지 못한 외부 미디어·자막·API 데이터는 릴리스에 넣지 않습니다.

## 기본 이미지의 선택 실행 도구

- **ByeDPI**: [고정 소스](https://github.com/hufrea/byedpi/tree/ba532298de7b28cfe854aea83d061369d13ca290), MIT (`LICENSES/ByeDPI-MIT.txt`). tar SHA-256은 `c7211cfc0729d213219be9b67d774e375d75ae53bbf18b6af1967f06919bbac4`입니다. 정적으로 연결한 musl 1.2.5 고지는 `LICENSES/musl-COPYRIGHT.txt`에 보존합니다. 소스 변경 없이 Alpine에서 `make LDFLAGS=-static`, `strip ciadpi`로 빌드합니다.
- **yt-dlp**: [2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19), Unlicense (`LICENSES/yt-dlp-Unlicense.txt`). Unix zipapp SHA-256은 `1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6`입니다. 포함된 EJS 0.8.0도 Unlicense이며 압축 파일 내부 고지를 유지합니다. Python3와 기존 Node로 실행하고 원본 압축 파일은 수정하지 않습니다.

정확한 다운로드·해시·빌드 명령은 Dockerfile에서 관리합니다. 두 도구는 비활성 상태에서 실행하지 않습니다.
