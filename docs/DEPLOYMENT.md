# Docker 서버 설치

정식 설치 예시는 **v0.1.2**를 기준으로 합니다.

Linux는 Docker Engine과 Compose 플러그인, macOS·Windows는 Docker Desktop을 설치합니다. Windows는 WSL2와 Linux 컨테이너를 사용합니다.

## 새 설치

```sh
git clone --branch v0.1.2 --depth 1 https://github.com/sidetool/moa.git
cd moa
echo MOA_VERSION=v0.1.2 > .env
docker compose up -d
docker compose logs moa-auth
```

브라우저에서 `http://localhost:8796` 또는 `http://서버의-LAN-IP:8796`을 엽니다. 로그의 `Setup code`를 입력하고 첫 관리자 아이디·비밀번호를 만듭니다. 새 설치의 `.env`는 위 명령으로 이미지 버전을 Compose와 맞춥니다. 호스트 Python, 로컬 빌드, 수동 권한 변경은 필요 없습니다. 이미 계정이 있는 설치에는 설정 화면이 나타나지 않습니다.

설정 코드는 재시작해도 유지되며 첫 계정 생성과 함께 삭제됩니다. 인증 DB는 0600 권한으로 보관합니다. 코드는 컨테이너 로그에도 남으므로 로그를 비공개로 관리합니다.

```sh
docker compose exec moa-auth moa-setup-code
docker compose exec moa-auth moa-setup-code --regenerate
```

기본 게이트웨이는 `0.0.0.0:8796`에 열리고 앱 포트 `8795`는 호스트에 열리지 않습니다. 앱은 게이트웨이의 계정 헤더를 신뢰하므로 외부에 직접 노출하지 않습니다. 게이트웨이를 통한 접속은 LAN IP·localhost·원격 접속 Host를 허용하고, 폼은 같은 Origin과 CSRF 쿠키를 확인합니다. 외부 접속에는 아래 HTTPS 구성을 사용합니다.

## 데이터와 호스트 폴더 연결

기본 데이터는 Compose 프로젝트별 Docker가 관리하는 이름 있는 저장소(volume)에 저장합니다. 컨테이너를 재생성해도 유지됩니다. `docker compose down -v`는 데이터를 삭제하므로 일반 중지·업그레이드에 사용하지 않습니다. 기본 미디어 volume은 비어 있습니다. 호스트 영상 폴더를 연결하려면 `.env`에 `MEDIA_PATH=/내/영상/폴더`를 넣고 재생성한 뒤 설정 → 로컬 라이브러리에서 `/media/library`를 등록합니다.

기존 `./data` 설치는 **업데이트 전에** `.env`에 다음을 추가합니다. 같은 프로젝트 이름과 기존 미디어 경로, 주소, 추가 Compose 파일, 비밀 파일 설정을 유지합니다.

```dotenv
MOA_DATA_PATH=./data
MOA_AUTH_DATA_PATH=./data/auth/sessions
MOA_AUTH_CONFIG_PATH=./data/auth/config
```

각 변수는 이름 있는 Docker 저장소(volume) 대신 호스트 경로를 선택합니다. 기존 `credentials.json`의 계정은 이전과 같은 일회성 이관을 거치며, 이미 인증 DB에 있는 계정은 유지됩니다. 기존 호스트 폴더 권한은 바꾸지 않습니다. 새 호스트 폴더를 직접 쓸 때만 앱·인증 UID 1000이 쓸 수 있게 준비합니다. 이름 있는 Docker 저장소(volume) 기본 설치에는 이 단계가 없습니다.

```sh
mkdir -p data/auth/config data/auth/sessions
sudo chown -R 1000:1000 data
sudo chmod 700 data/auth/config data/auth/sessions
```

`.env.example`은 선택 설정의 예시입니다. 실제 키·DB·비밀 파일은 Git과 이미지 빌드 입력에서 제외합니다.

커넥터도 기본 Docker가 관리하는 이름 있는 저장소(volume)를 사용합니다. 호스트 경로를 쓰려면 `MOA_CONNECTOR_DATA_PATH=./data/connector`, `MOA_CONNECTOR_SECRET_PATH=./data/connector-secret`를 설정하고 **새 두 디렉터리만** UID/GID 1000, mode 0700으로 준비합니다. RPC 토큰은 자동 생성되어 앱·인증에 읽기 전용으로 공유됩니다. 기존 운영 설치의 전체 변경·보존 절차는 [기존 설치 이관](DEPLOYMENT.md#기존-설치-이관)을 따릅니다.

설정 → 원격 접속은 Cloudflare Quick Tunnel, dashboard token tunnel, Tailscale Serve/Funnel을 지원합니다([계약과 제한](REMOTE-ACCESS.md)). `compose.tunnel.yaml`을 쓰는 설치는 외부 관리 상태로 표시하며 기존 정적 터널을 유지합니다. 커넥터는 별도 네트워크에서 게이트웨이만 볼 수 있습니다.

## 관리자 비밀번호 복구

컨테이너 안의 CLI가 비밀번호를 화면에 표시하지 않고 묻습니다. 해당 관리자의 세션만 만료시키며 재시작은 필요 없습니다. 비활성화된 관리자는 다시 활성화합니다.

```sh
docker compose exec moa-auth moa-admin reset-password
```

기존 호스트 폴더 설치에서는 Python 복구 도구도 유지합니다. `python3 deploy/auth/set-password.py`를 실행하거나 `--database`와 `--credentials`로 경로를 지정합니다. 새 설치는 웹 설정을 사용합니다.

## 도메인과 HTTPS

HTTPS 리버스 프록시를 게이트웨이 앞에 둡니다. `.env`의 `PUBLIC_HOST`는 호스트 이름(포트 제외), `PUBLIC_ORIGIN`은 브라우저에서 쓰는 전체 주소(origin), `PUBLIC_SCHEME`은 `https`로 맞춥니다. 예: `media.example.com`, `https://media.example.com`, `https`. 프록시는 같은 Host와 정확한 `X-Forwarded-Proto: https` 헤더를 전달해야 합니다. 쿠키 보안은 요청에 전달된 접속 방식을 따르며 `PUBLIC_SCHEME`만으로 결정하지 않습니다. 별도 포트라면 origin과 Host 헤더에 그 포트가 포함되어야 합니다. nginx의 입력 템플릿은 읽기 전용이며 공식 시작 스크립트가 `/etc/nginx/conf.d`에 렌더링합니다. nginx 런타임 변수는 envsubst 필터로 보존합니다.

기본 게이트웨이는 연결 상대의 IP를 사용합니다. 신뢰하는 앞단 프록시 뒤에서만 `GATEWAY_CLIENT_IP`를 해당 프록시의 클라이언트 IP 변수로 바꿉니다. 예를 들어 Cloudflare 전용 경로는 `GATEWAY_CLIENT_IP='$http_cf_connecting_ip'`입니다. HTTPS에는 `__Host-moa_session; Secure`, HTTP에는 `moa_session` 쿠키를 사용하며 전환 중 두 이름을 읽습니다. 기존 HTTPS 세션은 인증 DB와 계정을 보존하면 계속 유효합니다. 원격 접속에는 HTTPS를 사용합니다.

## 선택 구성

Linux에서 `.env`의 `COMPOSE_FILE`에 콜론으로 추가 Compose 파일을 연결합니다. 다른 플랫폼은 Compose의 파일 구분자 또는 명시적인 `-f` 인자를 사용합니다.

| 구성 | 추가 Compose 파일 | 준비 |
| --- | --- | --- |
| 기존 APK 토큰 파일 호환 | `compose.aniyomi.yaml` | 이미 사용 중인 토큰 파일을 그대로 유지 |
| APK 실행 환경 끄기 | `compose.no-apk.yaml` | 선택 사항, `apk` profile을 활성화하지 않음 |
| Linux VAAPI | `compose.vaapi.yaml` | render 장치의 GID와 GPU 드라이버 |
| Cloudflare tunnel | `compose.tunnel.yaml` | 배포자 소유 tunnel config와 credentials |
| 기존 호스트 업데이터 연결 | `compose.updates.yaml` | 기존 호스트 도구와 상태 디렉터리 유지, [설정 안내](UPDATES.md) |

### APK와 브라우저 인증

새 설치에는 JS 확장·로컬 재생과 웹 업데이터가 기본 포함됩니다. APK 확장과 브라우저 인증은 설정 → 정보 → 추가 기능에서 설치합니다. 사용 중지는 접힌 관리 메뉴에 있으며 데이터는 남습니다. 브라우저 인증은 AMD64만 지원합니다.

기존 APK 연결·volume·토큰은 유지합니다. `compose.aniyomi.yaml`을 쓰던 설치도 기존 추가 Compose 파일과 토큰 경로를 그대로 사용합니다. 웹 업데이터를 사용하지 않으면 APK는 `compose.apk.yaml`, 브라우저 인증은 `compose.source-browser.yaml`을 추가합니다.

### 다운로드·쇼츠·우회

- **서버 다운로드**: 기본 `/downloads` volume이 연결됩니다. 설정 → 서버 관리 → 서버 다운로드에서 한도를 지정하고 켭니다. 호스트 폴더를 쓰려면 최초 설치 전에 `MOA_DOWNLOAD_PATH`를 지정하고 UID 1000의 쓰기를 허용합니다. 기기 오프라인 저장은 지원하지 않습니다.
- **쇼츠**: TMDB 연결 후 실험 기능에서 켭니다. 직접 재생 도구는 앱 이미지에 포함됩니다. YouTube API 키는 선택 사항이며 영상·지역에 따라 재생이 제한될 수 있습니다.
- **ByeDPI**: 소스 연결에서 켜면 기본 프록시로 유지됩니다. 끄면 이전 수동 프록시 또는 직접 연결로 돌아갑니다. 확장별 프록시가 우선합니다.

VAAPI는 `COMPOSE_FILE`에 `:compose.vaapi.yaml`을 추가하고 `stat -c %g /dev/dri/renderD128`로 확인한 GID를 `MOA_RENDER_GID`에 넣습니다. `MOA_VAAPI_DEVICE`, `MOA_DRI_PATH`, 필요하면 `LIBVA_DRIVER_NAME`을 설정합니다. GPU가 없으면 기본 구성의 소프트웨어 처리를 사용합니다.

터널은 `deploy/cloudflared/config.example.yml`을 `deploy/local/cloudflared/config.yml`로 복사한 뒤 자신의 tunnel ID와 hostname을 넣습니다. Cloudflare가 발급한 credentials JSON은 `deploy/local/cloudflared/tunnel.json`에 둡니다. JSON을 직접 작성하거나 공개하지 않습니다. `TUNNEL_UID/GID`에 읽기 권한을 주고 `COMPOSE_FILE`에 `:compose.tunnel.yaml`을 추가합니다. 기존 비공개 경로를 유지하려면 `CF_TUNNEL_CONFIG_FILE`, `CF_TUNNEL_CREDENTIALS_FILE`로 지정합니다. 터널은 필수 구성요소가 아닙니다.

## 키, 프록시, 백업과 업그레이드

TMDB 키는 관리자 API `PATCH /api/admin/tmdb/config`로 DB에 저장할 수 있고 재시작 없이 적용됩니다([UI 계약](DEVELOPMENT.md#설치-ui-계약)). `MOA_TMDB_TOKEN` 또는 `MOA_TMDB_API_KEY`를 `.env`에 넣으면 DB 설정보다 우선합니다. 키가 없으면 작품 정보 기능만 꺼지며 설치·로그인은 가능합니다. 승인된 귀속 표시·API 이용 조건은 [TMDB FAQ](https://developer.themoviedb.org/docs/faq)를 따릅니다. README 문구만으로 앱 귀속 표시를 충족한다고 간주하지 않습니다.

기본 외부 연결 프록시는 앱의 설정 → 소스 연결에서 관리합니다. 빈 값은 직접 연결이고 HTTP(S) CONNECT와 SOCKS5를 지원합니다. 기존 프록시 설정은 앱 SQLite에 저장되므로 데이터 디렉터리를 보존합니다. Gemini·OpenAI 및 호환 API의 키도 관리자 화면에서 관리하며 관련 비밀 파일은 `/data`에 저장합니다. 번역은 자막과 문맥을 설정한 API로 보내며 제공자에 따라 비용이 발생할 수 있습니다.

업그레이드 전 앱·인증 DB, `.env`, `deploy/local`, APK 이름 있는 Docker 저장소(volume)과 token을 비공개로 백업합니다. SQLite 파일은 일관성을 유지하는 백업 API를 쓰거나 서비스를 멈춘 상태에서 복사하고 WAL/SHM도 고려합니다. 미디어는 별도로 보존합니다. 기존 설치의 `MEDIA_CONTAINER_PATH`를 바꾸면 DB에 저장된 로컬 경로가 달라질 수 있습니다. 개발 이미지는 main의 `edge`, 정식 릴리스는 `stable`/`latest`와 버전 태그(예: `v1.0.0`)로 배포합니다. 정식/베타 채널과 웹 수동 업데이트는 [업데이트 안내](UPDATES.md)를 참고합니다. `.env`의 `MOA_VERSION`으로 관련 이미지의 버전을 함께 고정할 수 있습니다. 최초 GHCR 발행 후 각 패키지의 공개 접근 권한을 확인해야 합니다. 공개 이미지가 없는 브랜치는 다음 명령으로 직접 빌드해 실행합니다.

```sh
MOA_REVISION=$(git rev-parse HEAD) docker compose build
docker compose up -d --pull never
```

새 설치는 설정 → 정보에서 업데이트를 확인하고 설치합니다. 확인은 주기적으로 하지만 설치는 사용자가 요청할 때만 진행합니다. 업데이터 컨테이너에만 Docker socket이 연결되며 앱에는 연결하지 않습니다. 기존 호스트 업데이터는 그대로 사용합니다([업데이트 안내](UPDATES.md)).

## 다중 아키텍처 이미지 빌드

CI는 계속 `linux/amd64,linux/arm64`를 발행합니다. APK의 Java/Kotlin JAR와 Java 기본 실행 검사 6개는 `BUILDPLATFORM`에서 한 번 실행합니다. 바이트코드는 두 대상 아키텍처가 공유하며 JRE·Node·Chromium·OS 패키지는 대상 아키텍처를 사용합니다. QEMU에서 Java 소스 실행 검사를 수행하면 15초 제한에 걸릴 수 있으므로, 제한을 늘리거나 테스트를 생략하지 않고 실제 빌드 호스트에서 실행하는 단계로 분리합니다.

앱의 TypeScript·웹 번들도 `BUILDPLATFORM`에서 컴파일합니다. 런타임 `node_modules`는 별도 대상 아키텍처용 단계에서 실행에 필요한 의존성만 설치합니다. 빌드 호스트의 `node_modules`를 복사하면 arm64 Sharp/libvips 등이 깨질 수 있으므로 컴파일된 JS·웹 파일만 공유합니다. 최종 이미지 빌드 중 Sharp PNG 생성과 서버 모듈 불러오기를 실행해 대상 아키텍처의 네이티브 의존성과 워크스페이스 연결을 확인합니다.

컴파일 단계만 검증하려면 아래 명령을 사용합니다. 이 단계는 arm64 에뮬레이터 없이 두 대상의 코드를 컴파일할 수 있습니다. 전체 런타임 검증에는 ARM 빌드 호스트 또는 QEMU가 필요하며 `--target build`를 제거합니다. 아래 명령은 이미지 저장소에 업로드하지 않습니다.

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly -f deploy/aniyomi/Dockerfile .
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly .
```

## 기존 설치 이관

기존 데이터·계정·세션을 유지하려면 Compose 이름과 저장 경로를 먼저 확인하세요. 테스트용 인증 정보를 운영 설치에 복사하지 마세요.

기존 설치가 `./data` 폴더를 사용한다면 `.env`에 다음 연결을 유지합니다.

```dotenv
MOA_DATA_PATH=./data
MOA_AUTH_DATA_PATH=./data/auth/sessions
MOA_AUTH_CONFIG_PATH=./data/auth/config
```

이 값을 생략하면 새 기본 이름 있는 Docker 저장소(volume)이 비어 있어 데이터가 사라진 것처럼 보일 수 있습니다. 기존 앱 DB, 인증 `sessions.sqlite`와 WAL/SHM, `credentials.json`을 옮기거나 이름을 바꾸지 마세요.

커넥터는 기본 전용 volume을 쓰거나 아래 호스트 폴더를 선택할 수 있습니다.

```dotenv
MOA_CONNECTOR_DATA_PATH=./data/connector
MOA_CONNECTOR_SECRET_PATH=./data/connector-secret
```

호스트 폴더를 선택했다면 새 폴더만 준비합니다.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 data/connector data/connector-secret
```

RPC 토큰은 자동 생성합니다. APK 토큰을 복사하거나 기존 데이터 전체의 소유자를 바꾸지 마세요. 앱·인증·커넥터는 UID 1000이며 APK worker의 기존 UID·토큰 권한은 유지합니다.

### 유지할 설정

기존 `COMPOSE_FILE`, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, `PUBLIC_SCHEME`, `GATEWAY_CLIENT_IP`, 미디어 경로·게이트웨이 주소/포트·변환 설정을 유지합니다. VAAPI 장치·그룹, 터널 UID/GID·설정·인증 파일, APK token·volume, TMDB 환경 키도 보존합니다. `-p` 또는 `COMPOSE_PROJECT_NAME`도 같아야 같은 데이터에 연결됩니다.

`MOA_VERSION`은 앱·인증·APK·커넥터에 같은 태그를 지정하므로 고정 배포에는 공개된 버전 태그를 사용하세요. 사용하지 않는 `MOA_PORT`는 제거할 수 있습니다.

`MOA_CONNECTOR_URL=http://moa-gateway:8798`, `MOA_CONNECTOR_SECRET_FILE=/run/moa-connector/token`, 인증의 `MOA_TRUST_GATEWAY=1`은 Compose가 연결합니다. 공개 호스트 주소로 노출하지 마세요. 기존 정적 터널은 해당 추가 파일과 `MOA_REMOTE_EXTERNALLY_MANAGED=1`을 유지합니다.

### 갱신 후 차이

- 호스트 앱 포트 8795 대신 기존 게이트웨이 8796 또는 HTTPS 주소를 사용합니다. 직접 API를 호출하던 검사·스크립트는 게이트웨이로 바꾸고, 컨테이너 내부 검사는 8795를 유지합니다.
- 커넥터와 두 저장소가 추가됩니다. 정적 터널 사용 시 커넥터는 대기하며 기존 터널 설정·도메인은 그대로입니다.
- 커넥터는 앱·인증 네트워크에 직접 접근하지 않고 비공개 게이트웨이 8798을 통해 인증된 RPC만 사용합니다. 호스트에는 게이트웨이의 HTTP 포트 8080만 연결합니다(기본 접속 포트 8796).
- 고정 컨테이너 이름 대신 `docker compose exec moa …`를 사용합니다.
- 기존 계정 DB가 있으면 첫 설정 화면이나 새 관리자를 만들지 않습니다. accounts-v1 이후 설치의 계정·비밀번호 해시·세션과 유효한 HTTPS `__Host-moa_session` 쿠키를 유지합니다. 만료·계정 중지·비밀번호 초기화 시 기존 규칙대로 취소합니다. 더 오래된 설치는 기존 일회성 세션 초기화 규칙을 따릅니다.
- 쿠키는 실제 HTTPS/HTTP 요청에 맞춰 Secure 여부를 정하며 전환 중 두 이름을 읽습니다. Host와 정확한 `X-Forwarded-Proto`를 전달하세요. `PUBLIC_SCHEME`만으로 보안을 결정하지 않습니다.
- TMDB 환경 키는 웹에 저장한 키보다 우선합니다. 앱 데이터·소스·프록시·계정은 원래 저장소를 사용합니다.

### 작업 순서와 복구

1. 앱·인증 DB·비공개 설정·APK volume과 토큰을 일관된 상태로 백업합니다. SQLite 백업 기능을 쓰거나 쓰기 서비스를 멈춘 뒤 WAL까지 복사합니다. 운영 환경에서 `down -v`를 실행하지 마세요.
2. 기존 저장 경로·추가 Compose 파일·프로젝트 이름을 유지하고 새 커넥터 폴더만 필요할 때 준비합니다.
3. 검토한 소스와 같은 버전 이미지로 `docker compose config --quiet`를 실행합니다. 해석된 설정 전체에는 비밀 값이 있을 수 있으므로 공개 출력하지 마세요.
4. 점검 시간에 이미지 설치는 `docker compose pull` 뒤 `docker compose up -d`, 로컬 빌드는 `docker compose build` 뒤 `docker compose up -d --pull never`를 실행합니다. 변경된 컨테이너가 다시 시작되어 잠시 끊길 수 있습니다.
5. 기존 HTTPS 로그인·세션·라이브러리·소스·재생·VAAPI·APK·관리 설정을 확인합니다. 정적 터널은 외부 관리 상태여야 하며 앱 8795·RPC 8798의 호스트 공개가 없어야 합니다.

되돌릴 때는 이전 Compose·소스·이미지와 같은 저장 경로·프로젝트 이름을 사용합니다. volume을 지우지 마세요. 추가된 `auth_state` 테이블은 기존 계정·세션 스키마를 대체하지 않습니다.
