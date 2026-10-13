# Docker 셀프호스팅

Linux는 Docker Engine과 Compose 플러그인, macOS·Windows는 Docker Desktop을 설치한다. Windows는 WSL2와 Linux 컨테이너를 사용한다.

## 새 설치 (다음 베타)

```sh
git clone https://github.com/sidetool/moa.git
cd moa
cp .env.example .env
docker compose up -d
docker compose logs moa-auth
```

브라우저에서 `http://localhost:8796` 또는 `http://서버의-LAN-IP:8796`을 연다. 로그의 `Setup code`를 입력하고 첫 관리자 아이디·비밀번호를 만든다. 예제 `.env`는 베타 채널을 선택한다. 호스트 Python, 로컬 빌드, 수동 권한 변경은 필요 없다. 정식 사용자는 해당 릴리스 태그의 가이드를 따른다. 이미 계정이 있는 설치에는 설정 화면이 나타나지 않는다.

설정 코드는 재시작해도 유지되며 첫 계정 생성과 함께 삭제된다. 인증 DB는 0600 권한으로 보관한다. 코드는 컨테이너 로그에도 남으므로 로그를 비공개로 관리한다.

```sh
docker compose exec moa-auth moa-setup-code
docker compose exec moa-auth moa-setup-code --regenerate
```

기본 gateway는 `0.0.0.0:8796`에 열리고 앱 포트 `8795`는 호스트에 열리지 않는다. 앱은 gateway의 계정 헤더를 신뢰하므로 외부에 직접 노출하지 않는다. gateway를 통한 접속은 LAN IP·localhost·원격 접속 Host를 허용하고, 폼은 같은 Origin과 CSRF 쿠키를 확인한다. 외부 접속에는 아래 HTTPS 구성을 사용한다.

## 데이터와 bind mount

기본 데이터는 Compose 프로젝트별 named volume에 저장한다. 컨테이너를 재생성해도 유지된다. `docker compose down -v`는 데이터를 삭제하므로 일반 중지·업그레이드에 사용하지 않는다. 기본 미디어 volume은 비어 있다. 호스트 영상 폴더를 연결하려면 `.env`에 `MEDIA_PATH=/내/영상/폴더`를 넣고 재생성한 뒤 설정 → 로컬 라이브러리에서 `/media/library`를 등록한다.

기존 `./data` 설치는 **업데이트 전에** `.env`에 다음을 추가한다. 같은 프로젝트 이름과 기존 미디어 경로, 주소, overlay, 비밀 파일 설정을 유지한다.

```dotenv
MOA_DATA_PATH=./data
MOA_AUTH_DATA_PATH=./data/auth/sessions
MOA_AUTH_CONFIG_PATH=./data/auth/config
```

각 변수는 named volume 대신 bind 경로를 선택한다. 기존 `credentials.json`의 계정은 이전과 같은 일회성 이관을 거치며, 이미 인증 DB에 있는 계정은 유지된다. 기존 bind 디렉터리 권한은 바꾸지 않는다. 새 bind 디렉터리를 직접 쓸 때만 앱·인증 UID 1000이 쓸 수 있게 준비한다. named volume 기본 설치에는 이 단계가 없다.

```sh
mkdir -p data/auth/config data/auth/sessions
sudo chown -R 1000:1000 data
sudo chmod 700 data/auth/config data/auth/sessions
```

`.env.example`은 선택 설정의 예시다. 실제 키·DB·비밀 파일은 Git과 이미지 build context에서 제외한다.

connector도 기본 named volume을 사용한다. bind 경로를 쓰려면 `MOA_CONNECTOR_DATA_PATH=./data/connector`, `MOA_CONNECTOR_SECRET_PATH=./data/connector-secret`를 설정하고 **새 두 디렉터리만** UID/GID 1000, mode 0700으로 준비한다. RPC token은 자동 생성되어 앱·인증에 읽기 전용으로 공유된다. 기존 production 설치의 전체 변경·보존 절차는 [setup/remote migration](SETUP-REMOTE-MIGRATION.md)을 따른다.

설정 → 원격 접속은 Cloudflare Quick Tunnel, dashboard token tunnel, Tailscale Serve/Funnel을 지원한다([계약과 제한](REMOTE-ACCESS.md)). `compose.tunnel.yaml`을 쓰는 설치는 외부 관리 상태로 표시하며 기존 정적 터널을 유지한다. connector는 별도 네트워크에서 gateway만 볼 수 있다.

## 관리자 비밀번호 복구

컨테이너 안의 CLI가 비밀번호를 화면에 표시하지 않고 묻는다. 해당 관리자의 세션만 만료시키며 재시작은 필요 없다. 비활성화된 관리자는 다시 활성화한다.

```sh
docker compose exec moa-auth moa-admin reset-password
```

기존 bind 설치에서는 Python 복구 도구도 유지한다. `python3 deploy/auth/set-password.py`를 실행하거나 `--database`와 `--credentials`로 경로를 지정한다. 새 설치는 웹 설정을 사용한다.

## 도메인과 HTTPS

HTTPS reverse proxy를 gateway 앞에 둔다. `.env`의 `PUBLIC_HOST`는 호스트 이름(포트 제외), `PUBLIC_ORIGIN`은 브라우저에서 쓰는 전체 origin, `PUBLIC_SCHEME`은 `https`로 맞춘다. 예: `media.example.com`, `https://media.example.com`, `https`. 프록시는 같은 Host와 정확한 `X-Forwarded-Proto: https` 헤더를 전달해야 한다. 쿠키 보안은 요청별 forwarded scheme을 따르며 `PUBLIC_SCHEME`만으로 결정하지 않는다. 별도 포트라면 origin과 Host 헤더에 그 포트가 포함되어야 한다. nginx의 입력 템플릿은 읽기 전용이며 공식 entrypoint가 `/etc/nginx/conf.d`에 렌더링한다. nginx 런타임 변수는 envsubst 필터로 보존한다.

기본 gateway는 연결 상대의 IP를 사용한다. 신뢰하는 edge 뒤에서만 `GATEWAY_CLIENT_IP`를 해당 edge의 클라이언트 IP 변수로 바꾼다. 예를 들어 Cloudflare 전용 경로는 `GATEWAY_CLIENT_IP='$http_cf_connecting_ip'`다. HTTPS에는 `__Host-moa_session; Secure`, HTTP에는 `moa_session` 쿠키를 사용하며 전환 중 두 이름을 읽는다. 기존 HTTPS 세션은 인증 DB와 계정을 보존하면 계속 유효하다. 원격 접속에는 HTTPS를 사용한다.

## 선택 구성

Linux에서 `.env`의 `COMPOSE_FILE`에 콜론으로 override를 추가한다. 다른 플랫폼은 Compose의 파일 구분자 또는 명시적인 `-f` 인자를 사용한다.

| 구성 | override | 준비 |
| --- | --- | --- |
| 기존 APK token 파일 호환 | `compose.aniyomi.yaml` | 이미 사용 중인 token 파일을 그대로 유지 |
| APK 실행 환경 추가 | `compose.apk.yaml` | APK를 사용할 때만 활성화 |
| 브라우저 인증 추가 | `compose.source-browser.yaml` | Camoufox가 필요한 소스만 사용 |
| APK 실행 환경 끄기 | `compose.no-apk.yaml` | 선택 사항, `apk` profile을 활성화하지 않음 |
| Linux VAAPI | `compose.vaapi.yaml` | render 장치의 GID와 GPU 드라이버 |
| Cloudflare tunnel | `compose.tunnel.yaml` | 배포자 소유 tunnel config와 credentials |
| 기존 호스트 업데이터 유지 | `compose.updates.yaml` | 기본 업데이트 컨테이너 대신 기존 도구와 상태 디렉터리 연결, [설정 안내](UPDATES.md) |

### 기본 기능과 선택 설치

| 기능 | 기본 설치 | 켜는 방법 |
|---|---|---|
| JS 확장·로컬 재생·계정·웹 업데이트 | 포함 | 소스 저장소 또는 영상 폴더 등록 |
| 숏츠 직접 재생 | 추출 도구 포함, 사용 전에는 프로세스 없음 | TMDB 연결 후 실험 기능에서 숏츠 켜기 |
| 서버 다운로드 | 저장 volume 포함, 기본 꺼짐 | 설정에서 한도 지정 후 켜기 |
| ByeDPI | 작은 실행 파일 포함, 기본 꺼짐 | 소스 연결 → ByeDPI 우회 켜기 |
| APK 확장 | 선택 설치, 기본 이미지 다운로드·실행 제외 | 아래 APK 추가 설치 |
| Camoufox 브라우저 인증 | 선택 설치 | `compose.source-browser.yaml` 추가 후 확장 옵션에서 켜기 |

YouTube Data API는 선택 사항이다. 숏츠는 API 키 없이도 후보를 사용하지만, 실제 영상 제공 여부·네트워크 상태에 따라 재생에 실패할 수 있다. 신규 프로필은 도구가 있으면 직접 재생을 기본 선택하고, 기존 프로필의 임베드/직접 재생 선택은 유지한다. `MOA_SHORTS_EXTRACTOR=`를 명시하면 직접 재생을 비활성화한다.

APK가 필요하면 `.env`의 `COMPOSE_FILE`에 `:compose.apk.yaml`을 추가하고 실행한다:

```dotenv
COMPOSE_FILE=compose.yaml:compose.apk.yaml
```

```sh
docker compose up -d
```

토큰은 worker가 자동 생성한다. JVM·Chromium은 요청 시 시작하며, idle JVM은 기본 10분 후 종료된다. APK를 쓰지 않으면 해당 이미지와 컨테이너가 필요 없다. `--profile apk`만으로는 앱 연결 설정이 켜지지 않으므로 위 파일을 사용한다.

브라우저 인증도 같은 방법으로 `:compose.source-browser.yaml`을 추가한다. 둘 다 필요하면 `COMPOSE_FILE=compose.yaml:compose.apk.yaml:compose.source-browser.yaml`을 사용한다. 공개 이미지가 발행된 버전은 로컬 빌드 없이 받는다. 발행 전 개발 브랜치는 별도 테스트 환경에서 빌드해야 한다.

### 기존 APK 설치 보존

웹 릴리스 업데이트는 저장된 Compose와 서비스 목록을 유지하므로 APK·브라우저를 자동으로 끄지 않는다. **Git checkout이나 Compose 파일을 직접 새 버전으로 교체하는 설치**에서 APK를 계속 쓰려면 기존 `COMPOSE_FILE`에 `:compose.apk.yaml`을 추가한다. 이미 `compose.aniyomi.yaml`을 쓰는 경우는 그 파일이 APK를 활성화하므로 그대로 유지한다. 기존 `compose.no-apk.yaml`도 사용할 수 있다.

프로젝트 이름, `moa-apk-data` volume, token volume/파일, 기존 bind 경로를 유지한다. token을 새로 생성하거나 기존 volume을 지우지 않는다. APK를 끌 때는 기존 worker를 `docker compose stop moa-apk`로 중지하고 선택 파일을 제거한 뒤 앱을 재생성한다. 데이터는 유지한다. 일반 업데이트에 `down -v`를 사용하지 않는다.

새 다운로드 volume은 앱 사용자(UID 1000) 소유로 초기화한다. 기존 volume이나 사용자 bind 폴더의 권한은 덮어쓰지 않는다. 기존 폴더가 쓰기 불가능하면 앱 사용자에게 쓰기 권한을 부여한 뒤 활성화한다.

### ByeDPI

소스 연결에서 ByeDPI 우회를 켜면 즉시 저장하고 내장 SOCKS 프록시를 사용한다. 끄면 저장해 둔 수동 프록시로 돌아간다. 확장별 프록시는 이 기본값보다 우선한다. 기능이 켜져 있는데 helper가 실패하면 직접 연결로 몰래 전환하지 않는다. 끄면 ByeDPI를 쓰던 연결이 종료되므로 해당 영상은 다시 열어야 할 수 있다.

내장 proxy는 Docker 내부에서만 열리며 호스트 포트를 공개하지 않는다. 기본 주소 `socks5://moa:1080`은 선택 설치한 APK·Camoufox에서도 접근 가능하다. 커스텀 네트워크에서는 같은 내부 네트워크와 서비스 이름을 유지한다. IPv4 TCP 분할 전략을 사용하며, VPN이나 Cloudflare 인증 대체 기능은 아니다. 추가 설정 없이 모든 회선에서 작동한다고 보장하지 않는다.

VAAPI는 `COMPOSE_FILE`에 `:compose.vaapi.yaml`을 추가하고 `stat -c %g /dev/dri/renderD128`로 확인한 GID를 `MOA_RENDER_GID`에 넣는다. `MOA_VAAPI_DEVICE`, `MOA_DRI_PATH`, 필요하면 `LIBVA_DRIVER_NAME`을 설정한다. GPU가 없으면 기본 구성의 소프트웨어 처리를 사용한다.

터널은 `deploy/cloudflared/config.example.yml`을 `deploy/local/cloudflared/config.yml`로 복사한 뒤 자신의 tunnel ID와 hostname을 넣는다. Cloudflare가 발급한 credentials JSON은 `deploy/local/cloudflared/tunnel.json`에 둔다. JSON을 직접 작성하거나 공개하지 않는다. `TUNNEL_UID/GID`에 읽기 권한을 주고 `COMPOSE_FILE`에 `:compose.tunnel.yaml`을 추가한다. 기존 private 경로를 유지하려면 `CF_TUNNEL_CONFIG_FILE`, `CF_TUNNEL_CREDENTIALS_FILE`로 지정한다. 터널은 필수 구성요소가 아니다.

## 키, 프록시, 백업과 업그레이드

TMDB 키는 관리자 API `PATCH /api/admin/tmdb/config`로 DB에 저장할 수 있고 재시작 없이 적용된다([UI 계약](SETUP-API.md)). `MOA_TMDB_TOKEN` 또는 `MOA_TMDB_API_KEY`를 `.env`에 넣으면 DB 설정보다 우선한다. 키가 없으면 작품 정보 기능만 꺼지며 설치·로그인은 가능하다. 승인된 귀속 표시·API 이용 조건은 [TMDB FAQ](https://developer.themoviedb.org/docs/faq)를 따른다. README 문구만으로 앱 귀속 표시를 충족한다고 간주하지 않는다.

기본 outbound proxy는 앱의 설정 → 소스 연결에서 관리한다. 빈 값은 직접 연결이고 HTTP(S) CONNECT와 SOCKS5를 지원한다. 기존 proxy 설정은 앱 SQLite에 저장되므로 데이터 디렉터리를 보존한다. Gemini·OpenAI 및 호환 API의 키도 관리자 화면에서 관리하며 관련 비밀 파일은 `/data`에 저장한다. 번역은 자막과 문맥을 설정한 API로 보내며 제공자에 따라 비용이 발생할 수 있다.

업그레이드 전 앱·인증 DB, `.env`, `deploy/local`, APK named volume과 token을 비공개로 백업한다. SQLite 파일은 일관된 backup API를 쓰거나 서비스를 멈춘 상태에서 복사하고 WAL/SHM도 고려한다. 미디어는 별도로 보존한다. 기존 설치의 `MEDIA_CONTAINER_PATH`를 바꾸면 DB에 저장된 로컬 경로가 달라질 수 있다. 개발 이미지는 main의 `edge`, 정식 릴리스는 `stable`/`latest`와 버전 태그(예: `v1.0.0`)로 배포한다. 정식/베타 채널과 자동 업데이트 설치는 [업데이트 안내](UPDATES.md#정식베타-릴리스-설치)를 참고한다. `.env`의 `MOA_VERSION`으로 네 이미지의 버전을 함께 고정할 수 있다. 최초 GHCR 발행 후 각 패키지의 공개 접근 권한을 확인해야 한다. 공개 이미지가 없는 브랜치는 다음 명령으로 직접 빌드해 실행한다.

```sh
MOA_REVISION=$(git rev-parse HEAD) docker compose build
docker compose up -d --pull never
```

기본 Compose의 `moa-updater`가 릴리스 확인·백업·설치를 처리한다. 별도 호스트 도구 없이 설정 → 정보에서 채널을 선택하고 업데이트한다. Docker socket은 이 서비스에만 연결되며 호스트 컨테이너 관리 권한을 가진다. 기존 설치 전환과 Git 서버의 선택적 호스트 도구는 [업데이트 안내](UPDATES.md)를 참고한다. 기본 이미지 소유자는 `sidetool`이며 `MOA_IMAGE_OWNER`로 변경할 수 있다. 서명된 릴리스가 없는 개발 빌드는 자동 설치를 사용할 수 없다. 백업·운영 측정 결과를 공개 저장소에 추가하지 않는다.


## 이전 APK 기본 포함 변경의 검증 (beta.3 기록)

서버 160, extensions 17, subtitles 88, skip-markers 18, 인증·gateway·connector·worker Node 54개로 총 337개 테스트가 통과했다. workspace typecheck와 웹 build, 앱·인증·APK·connector 이미지의 로컬 build가 통과했다. `.env` 없는 기본 구성, 기존 네 overlay와 token 파일을 유지한 합성 production 구성, APK 비활성 override의 compose 검증도 통과했다.

별도 프로젝트의 기본 compose와 새 volume으로 setup → 로그인 → gateway `/api/me` → `/api/admin/apk/status`의 `available=true`를 확인했다. 앱 bridge에서 worker에 전달한 작은 로컬 fixture index의 파싱, token UID/GID/mode, worker 재시작 후 기존 token 재사용도 확인했다. 외부 저장소·APK를 다운로드하지 않았고 JVM을 시작하지 않았다. 테스트 stack은 `down -v`로 제거했다. production 설정·데이터·배포는 변경하지 않았다.

## 다중 아키텍처 이미지 빌드

CI는 계속 `linux/amd64,linux/arm64`를 발행한다. APK의 Java/Kotlin JAR와 여섯 Java smoke test는 `BUILDPLATFORM`에서 한 번 실행한다. bytecode는 두 target에서 공유하며 JRE·Node·Chromium·OS 패키지는 target 아키텍처를 사용한다. QEMU에서 Java source-file smoke를 실행하면 15초 제한에 걸릴 수 있으므로, 제한을 늘리거나 테스트를 생략하지 않고 native build stage로 분리했다.

앱의 TypeScript·웹 번들도 `BUILDPLATFORM`에서 컴파일한다. 런타임 `node_modules`는 별도 target-platform stage에서 production 의존성만 설치한다. build-platform의 `node_modules`를 복사하면 arm64 Sharp/libvips 등이 깨질 수 있으므로 컴파일된 JS·웹 파일만 공유한다. 최종 이미지 build 중 Sharp PNG 생성과 서버 모듈 import를 실행해 target의 native 의존성 및 workspace 연결을 확인한다.

컴파일 stage만 검증하려면 아래 명령을 사용한다. 이 stage들은 arm64 emulator 없이도 두 target 요청을 처리할 수 있다. 전체 런타임 검증에는 native ARM builder 또는 QEMU가 필요하며 `--target build`를 제거한다. 아래 명령은 registry에 push하지 않는다.

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly -f deploy/aniyomi/Dockerfile .
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly .
```
