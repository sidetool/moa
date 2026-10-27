# 제3자 소프트웨어 고지

MOA에서 작성한 코드는 GPL-3.0-or-later입니다. 외부 코드·의존성·데이터·사용자가 설치한 확장에는 각자의 라이선스가 적용됩니다. MOA의 라이선스가 이를 바꾸지는 않습니다. 원문 라이선스와 저작권 고지는 [LICENSES](LICENSES/)에 있습니다. 이 목록은 고정된 의존성 버전을 기준으로 하며, 다른 버전·플랫폼의 실행 파일까지 재배포가 허용된다는 뜻은 아닙니다.

QuickJS 호스트, 소스 호환 모듈, 외부 연결 프록시, MOA worker·브라우저 구현은 MOA가 작성한 GPL-3.0-or-later 코드입니다. 외부 실행 환경과 빌드에 포함한 원본 파일에는 아래 라이선스가 적용됩니다.

## 복사하거나 빌드에 포함한 소스

| 구성 요소·출처 | 사용 범위와 라이선스 |
| --- | --- |
| [Noto Sans CJK JP Regular 2.004](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf) | 자막 대체 글꼴로 사용합니다. 글자 모양은 수정하지 않고 WOFF2로 변환했습니다. SIL OFL-1.1이며 [라이선스와 저작권 고지](apps/web/public/licenses/OFL-NotoSansCJK.txt)를 웹 빌드에 포함합니다. |
| [Suwayomi Server v2.3.2243](https://github.com/Suwayomi/Suwayomi-Server/tree/v2.3.2243) | SHA-256 `e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2`. 선택한 Android 설정 파일, MemoryCookieJar, RxCoroutineBridge는 MPL-2.0입니다. JsonObject에는 파일별 고지가 없어 보수적으로 MPL-2.0으로 취급합니다. Preference/ListPreference/TwoStatePreference는 `build.py`에서 수정합니다. |
| Android Open Source Project / Apache Software Foundation | Suwayomi에서 가져온 NonNull/Nullable(2013), Uri(2007), LruCache(2011), UriCodec은 Apache-2.0이며 원문 고지를 유지합니다. Uri에서는 에뮬레이션 저장소 경로 변경 기능을 제거했습니다. UriCodec이 참조하는 ASF NOTICE의 정확한 원문은 **UNKNOWN**입니다. |
| Tachiyomi에서 파생된 Suwayomi 도우미 | HttpException, OkHttpExtensions, ProgressListener, ProgressResponseBody, Requests, JsoupExtensions에는 하위 폴더의 Apache-2.0 고지(Copyright 2015 Javier Tomás)가 적용됩니다. 개별 파일에 고지가 없으므로 관리자가 적용 범위를 확인해야 합니다. MemoryCookieJar에는 파일에 명시된 MPL 고지가 우선합니다. Requests에는 JVM facade 주석을 추가했습니다. [하위 폴더의 원문 고지](LICENSES/Tachiyomi-Apache-2.0.txt)를 참고해 주세요. |
| [Aniyomi](https://github.com/aniyomiorg/aniyomi/tree/97414446b8a95994c72dd33c41c971a89d4d25b8) | 소스 API 커밋은 `97414446b8a95994c72dd33c41c971a89d4d25b8`, SHA-256은 `e9bae19c0387b0aa7f977e61ffc35712f0711c7ec877d606bd1bce2ff2193521`이며 Apache-2.0입니다. 선택한 Kotlin API 소스에서 Compose 주석을 빼고 coroutine import와 PreferenceScreen 별칭을 조정했습니다. 원본 HttpServer는 제외하며 Aniyomi 앱·APK는 포함하지 않습니다. |
| MOA ABI 호환 코드 (`mihon/.../Json.kt`, `RequestsCompat.kt`, `HttpServer.kt`) | 작성자·복사 출처는 **UNKNOWN**입니다. 이름 공간만으로 외부 라이선스를 판단할 수 없습니다. 관리자가 직접 작성한 코드인지 확인하거나 정확한 출처와 유지한 고지를 기록해야 합니다. |

## 웹·네이티브 의존성, 글꼴, 아이콘

| 구성 요소 | 출처·라이선스·배포 시 확인 사항 |
| --- | --- |
| rvfc-polyfill 1.0.8 | [원본](https://github.com/ThaUnknown/rvfc-polyfill)은 `GPL-3.0`을 선언합니다. 이후 버전 허용을 추정하지 않고 보수적으로 GPL-3.0-only로 취급합니다. JASSUB에서 가져오며, MOA 자체 코드의 or-later 조건과 별개로 합쳐진 브라우저 배포물은 GPLv3를 충족해야 합니다. |
| JASSUB 2.5.16 | [원본](https://github.com/ThaUnknown/jassub)의 JS 연결 코드는 MIT입니다. WASM 선언은 `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`이며, JS의 LICENSE가 모든 WASM 구성 요소에 적용되지는 않습니다. 배포할 실행 파일에 필요한 정확한 libass·FreeType·기본 글꼴 소스, 고지, 빌드 옵션, 재연결·교체 자료는 **UNKNOWN**입니다. 선택한 배포물에 맞게 확보해야 합니다. |
| sharp 0.34.5 / libvips 사전 빌드 1.2.4 | [sharp](https://github.com/lovell/sharp)는 Apache-2.0, 설치한 [libvips](https://github.com/libvips/libvips) 사전 빌드는 LGPL-3.0-or-later입니다. 포함된 모든 라이브러리의 고지, 정확한 소스, 교체·재연결에 필요한 자료를 보존해야 합니다. 사전 빌드 전체 구성 요소의 고지·소스 목록은 **UNKNOWN**입니다. |
| Pretendard 1.3.9 | [원본](https://github.com/orioncactus/pretendard)은 OFL-1.1이며 Copyright Kil Hyung-jin, Reserved Font Name Pretendard를 유지합니다. `dist/LICENSE.txt`의 전체 글꼴 라이선스를 복사했습니다. 글꼴에는 GPL을 적용하지 않습니다. |
| lucide-react 1.49.0 | [Lucide](https://github.com/lucide-icons/lucide)는 ISC이며 Feather에서 파생된 MIT 고지도 포함합니다. 두 저작권 고지가 있는 LICENSE 전체를 보존해야 합니다. |
| QuickJS WASM / LinkeDOM | [QuickJS](https://bellard.org/quickjs/)와 [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)의 연결 코드는 MIT, [LinkeDOM](https://github.com/WebReflection/linkedom)은 ISC입니다. 연결 코드 고지뿐 아니라 원본 컴파일러·실행 환경·WASM의 저작권 고지도 보존해야 합니다. |
| lightningcss 1.33.0 | [원본](https://github.com/parcel-bundler/lightningcss)은 MPL-2.0입니다. 빌드 의존성이 실행 이미지에도 남을 수 있으므로 재배포 시 소스와 고지를 보존해야 합니다. |
| Patchright 1.61.1 | [원본](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)은 Apache-2.0입니다. 브라우저 의존성 목록에는 socks/smart-buffer/ip-address와 선택 항목인 fsevents(MIT)도 있습니다. Chromium에는 별도의 구성 요소 라이선스가 적용됩니다. |
| 컨테이너 구성 요소 | Node, nginx, Cloudflare 클라이언트, OpenJDK/Temurin(GPLv2 with Classpath Exception), Chromium, Debian/Ubuntu/Alpine 패키지, 나눔 글꼴은 각자의 고지를 유지합니다. 최종 이미지의 정확한 버전·구성 요소별 라이선스는 빌드 후 목록을 확인하기 전까지 **UNKNOWN**입니다. OS 패키지의 저작권 파일도 보존해야 합니다. |
| FFmpeg / Chromaprint | [FFmpeg](https://ffmpeg.org/legal.html)의 라이선스는 빌드 옵션에 따라 달라지며, [Chromaprint](https://github.com/acoustid/chromaprint)는 LGPL-2.1-or-later입니다. 별도 실행 파일이 MOA의 라이선스를 바꾸지는 않습니다. 이미지 공개 전에 포함할 실행 파일, 소스, 빌드 옵션을 확인해야 합니다. |

고정된 설치 버전에서 확보한 npm 라이선스 원문은 `LICENSES/npm`에 복사했습니다. 원문이 없는 항목은 아래에 표시했습니다. 패키지 정보만으로 필수 저작권·라이선스 고지를 대신할 수 없습니다. 실행 파일의 소스 제공 범위는 [제3자 소스 안내](docs/THIRD-PARTY-SOURCES.md)를 참고해 주세요.

## npm 패키지 목록

| 패키지 | 버전 | 선언된 라이선스 | 출처 | 전체 고지 포함 여부 |
| --- | --- | --- | --- | --- |
| `@esbuild/linux-x64` | 0.28.2 | MIT | [원본](https://github.com/evanw/esbuild#readme) | **UNKNOWN / 원문 없음** |
| `@fastify/accept-negotiator` | 2.1.0 | MIT | [원본](https://github.com/fastify/accept-negotiator#readme) | 포함 |
| `@fastify/ajv-compiler` | 4.0.6 | MIT | [원본](https://github.com/fastify/ajv-compiler#readme) | 포함 |
| `@fastify/error` | 4.2.0 | MIT | [원본](https://github.com/fastify/fastify-error#readme) | 포함 |
| `@fastify/fast-json-stringify-compiler` | 5.1.0 | MIT | [원본](https://github.com/fastify/fast-json-stringify-compiler#readme) | 포함 |
| `@fastify/forwarded` | 3.0.2 | MIT | [원본](https://github.com/fastify/forwarded#readme) | 포함 |
| `@fastify/merge-json-schemas` | 0.2.1 | MIT | [원본](https://github.com/fastify/merge-json-schemas#readme) | 포함 |
| `@fastify/proxy-addr` | 5.1.1 | MIT | [원본](https://github.com/fastify/proxy-addr#readme) | 포함 |
| `@fastify/send` | 4.1.1 | MIT | [원본](https://github.com/fastify/send#readme) | 포함 |
| `@fastify/static` | 8.3.0 | MIT | [원본](https://github.com/fastify/fastify-static) | 포함 |
| `@img/colour` | 1.1.0 | MIT | [원본](https://github.com/lovell/colour#readme) | 포함 |
| `@img/sharp-libvips-linux-x64` | 1.2.4 | LGPL-3.0-or-later | [원본](https://sharp.pixelplumbing.com) | **UNKNOWN / 원문 없음** |
| `@img/sharp-libvips-linuxmusl-x64` | 1.2.4 | LGPL-3.0-or-later | [원본](https://sharp.pixelplumbing.com) | **UNKNOWN / 원문 없음** |
| `@img/sharp-linux-x64` | 0.34.5 | Apache-2.0 | [원본](https://sharp.pixelplumbing.com) | 포함 |
| `@img/sharp-linuxmusl-x64` | 0.34.5 | Apache-2.0 | [원본](https://sharp.pixelplumbing.com) | 포함 |
| `@isaacs/cliui` | 9.0.0 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/cliui#readme) | 포함 |
| `@jitl/quickjs-ffi-types` | 0.32.0 | MIT | [원본](https://github.com/justjake/quickjs-emscripten#readme) | 포함 |
| `@jitl/quickjs-wasmfile-release-sync` | 0.32.0 | MIT | [원본](https://github.com/justjake/quickjs-emscripten#readme) | 포함 |
| `@lukeed/ms` | 2.0.2 | MIT | [원본](https://github.com/lukeed/ms#readme) | 포함 |
| `@nodable/entities` | 3.1.0 | MIT | [원본](https://github.com/nodable/val-parsers#readme) | **UNKNOWN / 원문 없음** |
| `@oxc-project/types` | 0.152.0 | MIT | [원본](https://oxc.rs) | 포함 |
| `@pinojs/redact` | 0.4.0 | MIT | [원본](https://github.com/pinojs/redact#readme) | 포함 |
| `@rolldown/binding-linux-x64-gnu` | 1.2.12 | MIT | [원본](https://rolldown.rs/) | **UNKNOWN / 원문 없음** |
| `@rolldown/binding-linux-x64-musl` | 1.2.12 | MIT | [원본](https://rolldown.rs/) | **UNKNOWN / 원문 없음** |
| `@rolldown/pluginutils` | 1.0.1 | MIT | [원본](https://github.com/rolldown/plugins/tree/main/packages/pluginutils#readme) | 포함 |
| `@tanstack/query-core` | 5.104.0 | MIT | [원본](https://tanstack.com/query) | 포함 |
| `@tanstack/react-query` | 5.104.0 | MIT | [원본](https://tanstack.com/query) | 포함 |
| `@types/node` | 22.20.5 | MIT | [원본](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | 포함 |
| `@types/react` | 19.3.0 | MIT | [원본](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react) | 포함 |
| `@types/react-dom` | 19.3.0 | MIT | [원본](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom) | 포함 |
| `@types/yauzl` | 2.10.3 | MIT | [원본](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/yauzl) | 포함 |
| `@typescript/typescript-linux-x64` | 7.0.2 | Apache-2.0 | [원본](https://www.typescriptlang.org/) | 포함 |
| `@vitejs/plugin-react` | 6.1.1 | MIT | [원본](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme) | 포함 |
| `abslink` | 1.3.0 | Apache-2.0 | [원본](https://github.com/ThaUnknown/abslink#readme) | **UNKNOWN / 원문 없음** |
| `abstract-logging` | 2.0.1 | MIT | [원본](https://github.com/jsumners/abstract-logging#readme) | **UNKNOWN / 원문 없음** |
| `agent-base` | 7.1.4 | MIT | [원본](https://github.com/TooTallNate/proxy-agents#readme) | 포함 |
| `ajv` | 8.20.0 | MIT | [원본](https://ajv.js.org) | 포함 |
| `ajv-formats` | 3.0.1 | MIT | [원본](https://github.com/ajv-validator/ajv-formats#readme) | 포함 |
| `anynum` | 1.0.1 | MIT | [원본](https://github.com/NaturalIntelligence/anynum#readme) | 포함 |
| `atomic-sleep` | 1.0.0 | MIT | [원본](https://github.com/davidmarkclements/atomic-sleep#readme) | 포함 |
| `avvio` | 9.3.0 | MIT | [원본](https://github.com/fastify/avvio#readme) | 포함 |
| `balanced-match` | 4.0.4 | MIT | [원본](https://github.com/juliangruber/balanced-match#readme) | 포함 |
| `boolbase` | 1.0.0 | ISC | [원본](https://github.com/fb55/boolbase) | **UNKNOWN / 원문 없음** |
| `brace-expansion` | 5.0.12 | MIT | [원본](https://github.com/juliangruber/brace-expansion#readme) | 포함 |
| `cheerio` | 1.2.0 | MIT | [원본](https://cheerio.js.org/) | 포함 |
| `cheerio-select` | 2.1.0 | BSD-2-Clause | [원본](https://github.com/cheeriojs/cheerio-select#readme) | 포함 |
| `content-disposition` | 0.5.4 | MIT | [원본](https://github.com/jshttp/content-disposition#readme) | 포함 |
| `cookie` | 1.1.1 | MIT | [원본](https://github.com/jshttp/cookie#readme) | 포함 |
| `cross-spawn` | 7.0.6 | MIT | [원본](https://github.com/moxystudio/node-cross-spawn) | 포함 |
| `css-select` | 5.2.2 | BSD-2-Clause | [원본](https://github.com/fb55/css-select#readme) | 포함 |
| `css-what` | 6.2.2 | BSD-2-Clause | [원본](https://github.com/fb55/css-what#readme) | 포함 |
| `cssom` | 0.5.0 | MIT | [원본](https://github.com/NV/CSSOM#readme) | 포함 |
| `csstype` | 3.2.3 | MIT | [원본](https://github.com/frenic/csstype#readme) | 포함 |
| `debug` | 4.4.3 | MIT | [원본](https://github.com/debug-js/debug#readme) | 포함 |
| `depd` | 2.0.0 | MIT | [원본](https://github.com/dougwilson/nodejs-depd#readme) | 포함 |
| `dequal` | 2.0.3 | MIT | [원본](https://github.com/lukeed/dequal#readme) | 포함 |
| `detect-libc` | 2.1.2 | Apache-2.0 | [원본](https://github.com/lovell/detect-libc#readme) | 포함 |
| `dom-serializer` | 2.0.0 | MIT | [원본](https://github.com/cheeriojs/dom-serializer#readme) | 포함 |
| `domelementtype` | 2.3.0 | BSD-2-Clause | [원본](https://github.com/fb55/domelementtype#readme) | 포함 |
| `domhandler` | 5.0.3 | BSD-2-Clause | [원본](https://github.com/fb55/domhandler#readme) | 포함 |
| `domutils` | 3.2.2 | BSD-2-Clause | [원본](https://github.com/fb55/domutils#readme) | 포함 |
| `encoding-sniffer` | 0.2.1 | MIT | [원본](https://github.com/fb55/encoding-sniffer#readme) | 포함 |
| `entities` | 4.5.0, 6.0.1, 7.0.1 | BSD-2-Clause | [원본](https://github.com/fb55/entities#readme) | 포함 |
| `esbuild` | 0.28.2 | MIT | [원본](https://github.com/evanw/esbuild#readme) | 포함 |
| `escape-html` | 1.0.3 | MIT | [원본](https://github.com/component/escape-html#readme) | 포함 |
| `fast-decode-uri-component` | 1.0.1 | MIT | [원본](https://github.com/delvedor/fast-decode-uri-component#readme) | 포함 |
| `fast-deep-equal` | 3.1.3 | MIT | [원본](https://github.com/epoberezkin/fast-deep-equal#readme) | 포함 |
| `fast-json-stringify` | 7.0.1 | MIT | [원본](https://github.com/fastify/fast-json-stringify#readme) | 포함 |
| `fast-querystring` | 1.1.2 | MIT | [원본](https://github.com/anonrig/fast-querystring#readme) | 포함 |
| `fast-uri` | 3.1.8, 4.2.1 | BSD-3-Clause | [원본](https://github.com/fastify/fast-uri) | 포함 |
| `fast-xml-builder` | 1.3.1 | MIT | [원본](https://github.com/NaturalIntelligence/fast-xml-builder#readme) | 포함 |
| `fast-xml-parser` | 5.11.2 | MIT | [원본](https://github.com/NaturalIntelligence/fast-xml-parser#readme) | 포함 |
| `fastify` | 5.12.5 | MIT | [원본](https://fastify.dev/) | 포함 |
| `fastify-plugin` | 5.1.0 | MIT | [원본](https://github.com/fastify/fastify-plugin#readme) | 포함 |
| `fastq` | 1.20.3 | ISC | [원본](https://github.com/mcollina/fastq#readme) | 포함 |
| `fdir` | 6.5.0 | MIT | [원본](https://github.com/thecodrr/fdir#readme) | 포함 |
| `find-my-way` | 9.9.0 | MIT | [원본](https://github.com/delvedor/find-my-way#readme) | 포함 |
| `foreground-child` | 3.3.1 | ISC | [원본](https://github.com/tapjs/foreground-child#readme) | 포함 |
| `glob` | 11.1.0 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/node-glob#readme) | 포함 |
| `hls.js` | 1.7.3 | Apache-2.0 | [원본](https://github.com/video-dev/hls.js) | 포함 |
| `html-escaper` | 3.0.3 | MIT | [원본](https://github.com/WebReflection/html-escaper) | 포함 |
| `htmlparser2` | 10.1.0 | MIT | [원본](https://github.com/fb55/htmlparser2#readme) | 포함 |
| `http-errors` | 2.0.1 | MIT | [원본](https://github.com/jshttp/http-errors#readme) | 포함 |
| `https-proxy-agent` | 7.0.6 | MIT | [원본](https://github.com/TooTallNate/proxy-agents#readme) | 포함 |
| `iconv-lite` | 0.6.3, 0.7.0, 0.7.3 | MIT | [원본](https://github.com/pillarjs/iconv-lite) | 포함 |
| `inherits` | 2.0.4 | ISC | [원본](https://github.com/isaacs/inherits#readme) | 포함 |
| `ip-address` | 10.7.3 | MIT | [원본](https://github.com/beaugunderson/ip-address#readme) | 포함 |
| `ipaddr.js` | 2.5.0 | MIT | [원본](https://github.com/whitequark/ipaddr.js#readme) | 포함 |
| `is-unsafe` | 2.0.2 | MIT | [원본](https://github.com/NaturalIntelligence/is-unsafe#readme) | 포함 |
| `isexe` | 2.0.0 | ISC | [원본](https://github.com/isaacs/isexe#readme) | 포함 |
| `jackspeak` | 4.2.3 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/jackspeak#readme) | 포함 |
| `jassub` | 2.5.16 | LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 | [원본](https://github.com/ThaUnknown/jassub) | 포함 |
| `json-schema-ref-resolver` | 3.0.0 | MIT | [원본](https://github.com/fastify/json-schema-ref-resolver#readme) | 포함 |
| `json-schema-traverse` | 1.0.0 | MIT | [원본](https://github.com/epoberezkin/json-schema-traverse#readme) | 포함 |
| `lfa-ponyfill` | 1.1.1 | MIT | [원본](https://github.com/ThaUnknown/lfa-ponyfill) | **UNKNOWN / 원문 없음** |
| `light-my-request` | 6.6.0 | BSD-3-Clause | [원본](https://github.com/fastify/light-my-request#readme) | 포함 |
| `lightningcss` | 1.33.0 | MPL-2.0 | [원본](https://github.com/parcel-bundler/lightningcss#readme) | 포함 |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | [원본](https://github.com/parcel-bundler/lightningcss#readme) | 포함 |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | [원본](https://github.com/parcel-bundler/lightningcss#readme) | 포함 |
| `linkedom` | 0.18.12 | ISC | [원본](https://github.com/WebReflection/linkedom#readme) | 포함 |
| `lru-cache` | 11.5.3 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/node-lru-cache#readme) | 포함 |
| `lucide-react` | 1.49.0 | ISC | [원본](https://lucide.dev) | 포함 |
| `mime` | 3.0.0 | MIT | [원본](https://github.com/broofa/mime#readme) | 포함 |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/minimatch#readme) | 포함 |
| `minipass` | 7.1.3 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/minipass#readme) | 포함 |
| `ms` | 2.1.3 | MIT | [원본](https://github.com/vercel/ms#readme) | 포함 |
| `nanoid` | 3.3.19 | MIT | [원본](https://github.com/ai/nanoid#readme) | 포함 |
| `nth-check` | 2.1.1 | BSD-2-Clause | [원본](https://github.com/fb55/nth-check) | 포함 |
| `on-exit-leak-free` | 2.1.2 | MIT | [원본](https://github.com/mcollina/on-exit-or-gc#readme) | 포함 |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/package-json-from-dist#readme) | 포함 |
| `parse5` | 7.3.0 | MIT | [원본](https://parse5.js.org) | 포함 |
| `parse5-htmlparser2-tree-adapter` | 7.1.0 | MIT | [원본](https://parse5.js.org) | 포함 |
| `parse5-parser-stream` | 7.1.2 | MIT | [원본](https://github.com/inikulin/parse5) | 포함 |
| `path-expression-matcher` | 1.6.2 | MIT | [원본](https://github.com/NaturalIntelligence/path-expression-matcher#readme) | 포함 |
| `path-key` | 3.1.1 | MIT | [원본](https://github.com/sindresorhus/path-key#readme) | 포함 |
| `path-scurry` | 2.0.2 | BlueOak-1.0.0 | [원본](https://github.com/isaacs/path-scurry#readme) | 포함 |
| `pend` | 1.2.0 | MIT | [원본](https://github.com/andrewrk/node-pend#readme) | 포함 |
| `picocolors` | 1.1.1 | ISC | [원본](https://github.com/alexeyraspopov/picocolors#readme) | 포함 |
| `picomatch` | 4.0.7 | MIT | [원본](https://github.com/micromatch/picomatch) | 포함 |
| `pino` | 10.3.1 | MIT | [원본](https://getpino.io) | 포함 |
| `pino-abstract-transport` | 3.0.0 | MIT | [원본](https://github.com/pinojs/pino-abstract-transport#readme) | 포함 |
| `pino-std-serializers` | 7.1.0 | MIT | [원본](https://github.com/pinojs/pino-std-serializers#readme) | 포함 |
| `postcss` | 8.5.28 | MIT | [원본](https://postcss.org/) | 포함 |
| `pretendard` | 1.3.9 | OFL-1.1 | [원본](https://cactus.tistory.com/306) | 포함 |
| `process-warning` | 4.0.1, 5.1.0 | MIT | [원본](https://github.com/fastify/fastify-warning#readme) | 포함 |
| `quick-format-unescaped` | 4.0.4 | MIT | [원본](https://github.com/davidmarkclements/quick-format#readme) | 포함 |
| `quickjs-emscripten-core` | 0.32.0 | MIT | [원본](https://github.com/justjake/quickjs-emscripten#readme) | 포함 |
| `react` | 19.3.0 | MIT | [원본](https://react.dev/) | 포함 |
| `react-dom` | 19.3.0 | MIT | [원본](https://react.dev/) | 포함 |
| `react-router` | 7.18.4 | MIT | [원본](https://github.com/remix-run/react-router#readme) | 포함 |
| `react-router-dom` | 7.18.4 | MIT | [원본](https://github.com/remix-run/react-router#readme) | 포함 |
| `real-require` | 0.2.0, 1.0.0 | MIT | [원본](https://github.com/pinojs/real-require) | 포함 |
| `require-from-string` | 2.0.2 | MIT | [원본](https://github.com/floatdrop/require-from-string#readme) | 포함 |
| `ret` | 0.5.0 | MIT | [원본](https://github.com/fent/ret.js#readme) | 포함 |
| `reusify` | 1.1.0 | MIT | [원본](https://github.com/mcollina/reusify#readme) | 포함 |
| `rfdc` | 1.4.1 | MIT | [원본](https://github.com/davidmarkclements/rfdc#readme) | 포함 |
| `rolldown` | 1.2.12 | MIT | [원본](https://rolldown.rs/) | 포함 |
| `rvfc-polyfill` | 1.0.8 | GPL-3.0 | [원본](https://github.com/ThaUnknown/rvfc-polyfill#readme) | 포함 |
| `safe-buffer` | 5.2.1 | MIT | [원본](https://github.com/feross/safe-buffer) | 포함 |
| `safe-regex2` | 5.1.1 | MIT | [원본](https://github.com/fastify/safe-regex2) | 포함 |
| `safe-stable-stringify` | 2.5.0 | MIT | [원본](https://github.com/BridgeAR/safe-stable-stringify#readme) | 포함 |
| `safer-buffer` | 2.1.2 | MIT | [원본](https://github.com/ChALkeR/safer-buffer#readme) | 포함 |
| `scheduler` | 0.28.0 | MIT | [원본](https://react.dev/) | 포함 |
| `secure-json-parse` | 4.1.0 | BSD-3-Clause | [원본](https://github.com/fastify/secure-json-parse#readme) | 포함 |
| `semver` | 7.8.5 | ISC | [원본](https://github.com/npm/node-semver#readme) | 포함 |
| `set-cookie-parser` | 2.7.2 | MIT | [원본](https://github.com/nfriedly/set-cookie-parser) | 포함 |
| `setprototypeof` | 1.2.0 | ISC | [원본](https://github.com/wesleytodd/setprototypeof) | 포함 |
| `sharp` | 0.34.5 | Apache-2.0 | [원본](https://sharp.pixelplumbing.com) | 포함 |
| `shebang-command` | 2.0.0 | MIT | [원본](https://github.com/kevva/shebang-command#readme) | 포함 |
| `shebang-regex` | 3.0.0 | MIT | [원본](https://github.com/sindresorhus/shebang-regex#readme) | 포함 |
| `signal-exit` | 4.1.0 | ISC | [원본](https://github.com/tapjs/signal-exit#readme) | 포함 |
| `smart-buffer` | 4.2.0 | MIT | [원본](https://github.com/JoshGlazebrook/smart-buffer/) | 포함 |
| `socks` | 2.8.10 | MIT | [원본](https://github.com/JoshGlazebrook/socks/) | 포함 |
| `sonic-boom` | 4.2.1 | MIT | [원본](https://github.com/pinojs/sonic-boom#readme) | 포함 |
| `source-map-js` | 1.2.2 | BSD-3-Clause | [원본](https://github.com/7rulnik/source-map-js) | 포함 |
| `split2` | 4.2.0 | ISC | [원본](https://github.com/mcollina/split2#readme) | 포함 |
| `statuses` | 2.0.2 | MIT | [원본](https://github.com/jshttp/statuses#readme) | 포함 |
| `strnum` | 2.4.2 | MIT | [원본](https://github.com/NaturalIntelligence/strnum#readme) | 포함 |
| `thread-stream` | 4.2.0 | MIT | [원본](https://github.com/mcollina/thread-stream#readme) | 포함 |
| `throughput` | 1.0.2 | MIT | [원본](https://github.com/ThaUnknown/throughput#readme) | **UNKNOWN / 원문 없음** |
| `tinyglobby` | 0.2.17 | MIT | [원본](https://superchupu.dev/tinyglobby) | 포함 |
| `toad-cache` | 3.7.4 | MIT | [원본](https://github.com/kibertoad/toad-cache) | 포함 |
| `toidentifier` | 1.0.1 | MIT | [원본](https://github.com/component/toidentifier#readme) | 포함 |
| `tsx` | 4.23.15 | MIT | [원본](https://tsx.hirok.io) | 포함 |
| `typescript` | 5.9.3, 7.0.2 | Apache-2.0 | [원본](https://www.typescriptlang.org/) | 포함 |
| `uhyphen` | 0.2.0 | ISC | [원본](https://github.com/WebReflection/uhyphen#readme) | 포함 |
| `undici` | 7.30.0 | MIT | [원본](https://undici.nodejs.org) | 포함 |
| `undici-types` | 6.21.0 | MIT | [원본](https://undici.nodejs.org) | 포함 |
| `vite` | 8.3.2 | MIT | [원본](https://vite.dev) | 포함 |
| `whatwg-encoding` | 3.1.1 | MIT | [원본](https://github.com/jsdom/whatwg-encoding#readme) | 포함 |
| `whatwg-mimetype` | 4.0.0 | MIT | [원본](https://github.com/jsdom/whatwg-mimetype#readme) | 포함 |
| `which` | 2.0.2 | ISC | [원본](https://github.com/isaacs/node-which#readme) | 포함 |
| `xml-naming` | 0.3.0 | MIT | [원본](https://github.com/NaturalIntelligence/xml-naming#readme) | 포함 |
| `yauzl` | 3.4.0 | MIT | [원본](https://github.com/thejoshwolfe/yauzl) | 포함 |

## Maven 실행용 JAR 목록

고정한 패키지 주소와 해시는 `services/aniyomi-worker/pom.xml` 및 `dependencies.lock.json`에 있습니다. JAR은 빌드 중 내려받으며 내부 `META-INF` 고지를 유지합니다. POM의 선언만으로 JAR에 합쳐진 다른 구성 요소의 조건을 확인할 수는 없습니다. 릴리스 이미지에 내부 라이선스와 NOTICE 파일 전체를 보존해야 합니다.

**실행 파일 재배포 전에 확인해야 할 항목:** `xpp3`에는 이전 Indiana University·Apache-1.1·public-domain 자료가 섞여 있습니다. `xmlParserAPIs`에는 W3C DOM·SAX 조건이 적용됩니다. `d2j-external`에 합쳐진 구성 요소의 출처 고지는 불완전하며, ANTLR의 정확한 BSD 고지도 확보해야 합니다. 이 항목들이 모두 Apache/GPL과 호환된다는 뜻은 아닙니다.

| 고정한 JAR | 패키지 주소·출처 | 라이선스·확인 근거 |
|---|---|---|
| `android-4.1.1.4.jar` | [com.google.android:android:4.1.1.4](https://repo.maven.apache.org/maven2/com/google/android/android/4.1.1.4/android-4.1.1.4.pom) | Apache 2.0 — POM |
| `annotations-13.0.jar` | [org.jetbrains:annotations:13.0](https://repo.maven.apache.org/maven2/org/jetbrains/annotations/13.0/annotations-13.0.pom) | The Apache Software License, Version 2.0 — POM |
| `antlr-runtime-3.5.3.jar` | [org.antlr:antlr-runtime:3.5.3](https://repo.maven.apache.org/maven2/org/antlr/antlr-runtime/3.5.3/antlr-runtime-3.5.3.pom) | BSD — antlr-master 3.5.3 상위 POM; 세부 조항 원문은 미확인입니다 |
| `antlr4-runtime-4.13.2.jar` | [org.antlr:antlr4-runtime:4.13.2](https://repo.maven.apache.org/maven2/org/antlr/antlr4-runtime/4.13.2/antlr4-runtime-4.13.2.pom) | BSD-3-Clause — antlr4-master 4.13.2 상위 POM |
| `apk-parser-2.6.10.jar` | [net.dongliu:apk-parser:2.6.10](https://repo.maven.apache.org/maven2/net/dongliu/apk-parser/2.6.10/apk-parser-2.6.10.pom) | The BSD 2-Clause License — POM |
| `apksig-8.10.1.jar` | [com.android.tools.build:apksig:8.10.1](https://dl.google.com/dl/android/maven2/com/android/tools/build/apksig/8.10.1/apksig-8.10.1.pom) | The Apache Software License, Version 2.0 — POM |
| `asm-analysis-9.10.1.jar` | [org.ow2.asm:asm-analysis:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-analysis/9.10.1/asm-analysis-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-commons-9.10.1.jar` | [org.ow2.asm:asm-commons:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-commons/9.10.1/asm-commons-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-tree-9.10.1.jar` | [org.ow2.asm:asm-tree:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-tree/9.10.1/asm-tree-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-util-9.10.1.jar` | [org.ow2.asm:asm-util:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-util/9.10.1/asm-util-9.10.1.pom) | BSD-3-Clause — POM |
| `commons-codec-1.3.jar` | [commons-codec:commons-codec:1.3](https://repo.maven.apache.org/maven2/commons-codec/commons-codec/1.3/commons-codec-1.3.pom) | Apache-2.0 — 해시가 고정된 JAR 원문을 확인했습니다; Logging NOTICE가 포함되어 있습니다 |
| `commons-logging-1.1.1.jar` | [commons-logging:commons-logging:1.1.1](https://repo.maven.apache.org/maven2/commons-logging/commons-logging/1.1.1/commons-logging-1.1.1.pom) | Apache-2.0 — 해시가 고정된 JAR 원문을 확인했습니다; Logging NOTICE가 포함되어 있습니다 |
| `d2j-base-cmd-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-base-cmd:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-base-cmd/2.4.37/d2j-base-cmd-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `d2j-external-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-external:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-external/2.4.37/d2j-external-2.4.37.pom) | Apache-2.0 — POM 선언이며 합쳐진 구성 요소의 세부 고지는 미확정입니다 |
| `d2j-jasmin-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-jasmin:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-jasmin/2.4.37/d2j-jasmin-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `d2j-smali-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-smali:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-smali/2.4.37/d2j-smali-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-ir-2.4.37.jar` | [de.femtopedia.dex2jar:dex-ir:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-ir/2.4.37/dex-ir-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-reader-2.4.37.jar` | [de.femtopedia.dex2jar:dex-reader:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-reader/2.4.37/dex-reader-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-reader-api-2.4.37.jar` | [de.femtopedia.dex2jar:dex-reader-api:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-reader-api/2.4.37/dex-reader-api-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-tools-2.4.37.jar` | [de.femtopedia.dex2jar:dex-tools:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-tools/2.4.37/dex-tools-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-translator-2.4.37.jar` | [de.femtopedia.dex2jar:dex-translator:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-translator/2.4.37/dex-translator-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-writer-2.4.37.jar` | [de.femtopedia.dex2jar:dex-writer:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-writer/2.4.37/dex-writer-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `httpclient-4.0.1.jar` | [org.apache.httpcomponents:httpclient:4.0.1](https://repo.maven.apache.org/maven2/org/apache/httpcomponents/httpclient/4.0.1/httpclient-4.0.1.pom) | Apache License — POM |
| `httpcore-4.0.1.jar` | [org.apache.httpcomponents:httpcore:4.0.1](https://repo.maven.apache.org/maven2/org/apache/httpcomponents/httpcore/4.0.1/httpcore-4.0.1.pom) | Apache License — POM |
| `injekt-koin-ee267b2e27.jar` | [com.github.null2264:injekt-koin:ee267b2e27](https://jitpack.io/com/github/null2264/injekt-koin/ee267b2e27/injekt-koin-ee267b2e27.pom) | MIT — POM |
| `jackson-annotations-2.20.jar` | [com.fasterxml.jackson.core:jackson-annotations:2.20](https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-annotations/2.20/jackson-annotations-2.20.pom) | The Apache Software License, Version 2.0 — POM |
| `json-20250517.jar` | [org.json:json:20250517](https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.pom) | Public Domain — POM |
| `jsoup-1.22.2.jar` | [org.jsoup:jsoup:1.22.2](https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.22.2/jsoup-1.22.2.pom) | The MIT License — POM |
| `koin-core-jvm-4.0.0.jar` | [io.insert-koin:koin-core-jvm:4.0.0](https://repo.maven.apache.org/maven2/io/insert-koin/koin-core-jvm/4.0.0/koin-core-jvm-4.0.0.pom) | The Apache Software License, Version 2.0 — POM |
| `kotlin-reflect-2.4.0.jar` | [org.jetbrains.kotlin:kotlin-reflect:2.4.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-reflect/2.4.0/kotlin-reflect-2.4.0.pom) | Apache-2.0 — POM |
| `kotlin-stdlib-2.4.0.jar` | [org.jetbrains.kotlin:kotlin-stdlib:2.4.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.4.0/kotlin-stdlib-2.4.0.pom) | Apache-2.0 — POM |
| `kotlinx-coroutines-core-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.11.0/kotlinx-coroutines-core-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-core-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-core-jvm/1.11.0/kotlinx-serialization-core-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-json-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json-jvm/1.11.0/kotlinx-serialization-json-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-json-okio-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-json-okio-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json-okio-jvm/1.11.0/kotlinx-serialization-json-okio-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `okhttp-jvm-5.4.0.jar` | [com.squareup.okhttp3:okhttp-jvm:5.4.0](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp-jvm/5.4.0/okhttp-jvm-5.4.0.pom) | The Apache Software License, Version 2.0 — POM |
| `okio-jvm-3.17.0.jar` | [com.squareup.okio:okio-jvm:3.17.0](https://repo.maven.apache.org/maven2/com/squareup/okio/okio-jvm/3.17.0/okio-jvm-3.17.0.pom) | The Apache Software License, Version 2.0 — POM |
| `opengl-api-gl1.1-android-2.1_r1.jar` | [org.khronos:opengl-api:gl1.1-android-2.1_r1](https://repo.maven.apache.org/maven2/org/khronos/opengl-api/gl1.1-android-2.1_r1/opengl-api-gl1.1-android-2.1_r1.pom) | Apache 2.0 — POM |
| `rxjava-1.3.8.jar` | [io.reactivex:rxjava:1.3.8](https://repo.maven.apache.org/maven2/io/reactivex/rxjava/1.3.8/rxjava-1.3.8.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-concurrency-jvm-2.1.0.jar` | [co.touchlab:stately-concurrency-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-concurrency-jvm/2.1.0/stately-concurrency-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-concurrent-collections-jvm-2.1.0.jar` | [co.touchlab:stately-concurrent-collections-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-concurrent-collections-jvm/2.1.0/stately-concurrent-collections-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-strict-jvm-2.1.0.jar` | [co.touchlab:stately-strict-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-strict-jvm/2.1.0/stately-strict-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `xmlParserAPIs-2.6.2.jar` | [xerces:xmlParserAPIs:2.6.2](https://repo.maven.apache.org/maven2/xerces/xmlParserAPIs/2.6.2/xmlParserAPIs-2.6.2.pom) | W3C DOM 소프트웨어·문서 고지 + SAX public domain — 해시가 고정된 JAR을 확인했습니다 |
| `xpp3-1.1.4c.jar` | [xpp3:xpp3:1.1.4c](https://repo.maven.apache.org/maven2/xpp3/xpp3/1.1.4c/xpp3-1.1.4c.pom) | Indiana University Extreme! Lab 1.1.1 + Public Domain + Apache 1.1 — POM에 나열되어 있으며 파일별 적용·호환 여부는 미확정입니다 |

## 데이터와 배포 시 준수 사항

TMDB/AniList/AniSkip/Anissia/Jimaku 응답, 사용자 영상, 자막, 번역은 외부 데이터이며 MOA 코드 라이선스의 적용 대상이 아닙니다. 별도로 확보하지 않은 재배포 권한은 **UNKNOWN**입니다. 테스트에는 직접 만든 자료를 사용해 주세요.

실행 파일을 공개할 때는 적용되는 고지 전체, 해당 버전에 정확히 대응하는 소스(Corresponding Source), 수정 사항, 빌드 방법을 함께 제공해야 합니다. GPL 브라우저 코드, MPL 수정 파일, LGPL WASM·네이티브 소스와 필요한 교체·재연결 자료도 포함해야 합니다. 버전을 고정하지 않은 원본 저장소 링크나 이 목록만으로는 의무를 충족하지 못합니다. 위의 **UNKNOWN** 항목은 관리자가 확인할 과제이며, 사용 허가를 뜻하지 않습니다.
