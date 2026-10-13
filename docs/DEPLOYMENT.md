# Docker 셀프호스팅

최신 정식 **v0.1.2** 기준이다.

Linux는 Docker Engine과 Compose 플러그인, macOS·Windows는 Docker Desktop을 설치한다. Windows는 WSL2와 Linux 컨테이너를 사용한다.

## 새 설치

```sh
git clone --branch v0.1.2 --depth 1 https://github.com/sidetool/moa.git
cd moa
echo MOA_VERSION=v0.1.2 > .env
docker compose up -d
docker compose logs moa-auth
```

브라우저에서 `http://localhost:8796` 또는 `http://서버의-LAN-IP:8796`을 연다. 로그의 `Setup code`를 입력하고 첫 관리자 아이디·비밀번호를 만든다. 새 설치의 `.env`는 위 명령으로 이미지 버전을 Compose와 맞춘다. 호스트 Python, 로컬 빌드, 수동 권한 변경은 필요 없다. 이미 계정이 있는 설치에는 설정 화면이 나타나지 않는다.

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
| APK 실행 환경 끄기 | `compose.no-apk.yaml` | 선택 사항, `apk` profile을 활성화하지 않음 |
| Linux VAAPI | `compose.vaapi.yaml` | render 장치의 GID와 GPU 드라이버 |
| Cloudflare tunnel | `compose.tunnel.yaml` | 배포자 소유 tunnel config와 credentials |
| 기존 호스트 업데이터 연결 | `compose.updates.yaml` | 기존 호스트 도구와 상태 디렉터리 유지, [설정 안내](UPDATES.md) |

### APK와 브라우저 인증

새 설치에는 JS 확장·로컬 재생과 웹 업데이터가 기본 포함된다. APK 확장과 브라우저 인증은 설정 → 정보 → 추가 기능에서 설치한다. 사용 중지는 접힌 관리 메뉴에 있으며 데이터는 남는다. 브라우저 인증은 AMD64만 지원한다.

기존 APK 연결·volume·token은 유지한다. `compose.aniyomi.yaml`을 쓰던 설치도 기존 overlay와 token 경로를 그대로 사용한다. 웹 업데이터를 사용하지 않으면 APK는 `compose.apk.yaml`, 브라우저 인증은 `compose.source-browser.yaml`을 추가한다.

### 다운로드·쇼츠·우회

- **서버 다운로드**: 기본 `/downloads` volume이 연결된다. 설정 → 서버 관리 → 서버 다운로드에서 한도를 지정하고 켠다. 호스트 폴더를 쓰려면 최초 설치 전에 `MOA_DOWNLOAD_PATH`를 지정하고 UID 1000의 쓰기를 허용한다. 기기 오프라인 저장은 지원하지 않는다.
- **쇼츠**: TMDB 연결 후 실험 기능에서 켠다. 직접 재생 도구는 앱 이미지에 포함된다. YouTube API 키는 선택 사항이며 영상·지역에 따라 재생이 제한될 수 있다.
- **ByeDPI**: 소스 연결에서 켜면 기본 프록시로 유지된다. 끄면 이전 수동 프록시 또는 직접 연결로 돌아간다. 확장별 프록시가 우선한다.

VAAPI는 `COMPOSE_FILE`에 `:compose.vaapi.yaml`을 추가하고 `stat -c %g /dev/dri/renderD128`로 확인한 GID를 `MOA_RENDER_GID`에 넣는다. `MOA_VAAPI_DEVICE`, `MOA_DRI_PATH`, 필요하면 `LIBVA_DRIVER_NAME`을 설정한다. GPU가 없으면 기본 구성의 소프트웨어 처리를 사용한다.

터널은 `deploy/cloudflared/config.example.yml`을 `deploy/local/cloudflared/config.yml`로 복사한 뒤 자신의 tunnel ID와 hostname을 넣는다. Cloudflare가 발급한 credentials JSON은 `deploy/local/cloudflared/tunnel.json`에 둔다. JSON을 직접 작성하거나 공개하지 않는다. `TUNNEL_UID/GID`에 읽기 권한을 주고 `COMPOSE_FILE`에 `:compose.tunnel.yaml`을 추가한다. 기존 private 경로를 유지하려면 `CF_TUNNEL_CONFIG_FILE`, `CF_TUNNEL_CREDENTIALS_FILE`로 지정한다. 터널은 필수 구성요소가 아니다.

## 키, 프록시, 백업과 업그레이드

TMDB 키는 관리자 API `PATCH /api/admin/tmdb/config`로 DB에 저장할 수 있고 재시작 없이 적용된다([UI 계약](SETUP-API.md)). `MOA_TMDB_TOKEN` 또는 `MOA_TMDB_API_KEY`를 `.env`에 넣으면 DB 설정보다 우선한다. 키가 없으면 작품 정보 기능만 꺼지며 설치·로그인은 가능하다. 승인된 귀속 표시·API 이용 조건은 [TMDB FAQ](https://developer.themoviedb.org/docs/faq)를 따른다. README 문구만으로 앱 귀속 표시를 충족한다고 간주하지 않는다.

기본 outbound proxy는 앱의 설정 → 소스 연결에서 관리한다. 빈 값은 직접 연결이고 HTTP(S) CONNECT와 SOCKS5를 지원한다. 기존 proxy 설정은 앱 SQLite에 저장되므로 데이터 디렉터리를 보존한다. Gemini·OpenAI 및 호환 API의 키도 관리자 화면에서 관리하며 관련 비밀 파일은 `/data`에 저장한다. 번역은 자막과 문맥을 설정한 API로 보내며 제공자에 따라 비용이 발생할 수 있다.

업그레이드 전 앱·인증 DB, `.env`, `deploy/local`, APK named volume과 token을 비공개로 백업한다. SQLite 파일은 일관된 backup API를 쓰거나 서비스를 멈춘 상태에서 복사하고 WAL/SHM도 고려한다. 미디어는 별도로 보존한다. 기존 설치의 `MEDIA_CONTAINER_PATH`를 바꾸면 DB에 저장된 로컬 경로가 달라질 수 있다. 개발 이미지는 main의 `edge`, 정식 릴리스는 `stable`/`latest`와 버전 태그(예: `v1.0.0`)로 배포한다. 정식/베타 채널과 웹 수동 업데이트는 [업데이트 안내](UPDATES.md)를 참고한다. `.env`의 `MOA_VERSION`으로 관련 이미지의 버전을 함께 고정할 수 있다. 최초 GHCR 발행 후 각 패키지의 공개 접근 권한을 확인해야 한다. 공개 이미지가 없는 브랜치는 다음 명령으로 직접 빌드해 실행한다.

```sh
MOA_REVISION=$(git rev-parse HEAD) docker compose build
docker compose up -d --pull never
```

새 설치는 설정 → 정보에서 업데이트를 확인하고 설치한다. 확인은 주기적으로 하지만 설치는 사용자가 요청할 때만 진행한다. 업데이터 컨테이너에만 Docker socket이 연결되며 앱에는 연결하지 않는다. 기존 호스트 업데이터는 그대로 사용한다([업데이트 안내](UPDATES.md)).

## 다중 아키텍처 이미지 빌드

CI는 계속 `linux/amd64,linux/arm64`를 발행한다. APK의 Java/Kotlin JAR와 여섯 Java smoke test는 `BUILDPLATFORM`에서 한 번 실행한다. bytecode는 두 target에서 공유하며 JRE·Node·Chromium·OS 패키지는 target 아키텍처를 사용한다. QEMU에서 Java source-file smoke를 실행하면 15초 제한에 걸릴 수 있으므로, 제한을 늘리거나 테스트를 생략하지 않고 native build stage로 분리했다.

앱의 TypeScript·웹 번들도 `BUILDPLATFORM`에서 컴파일한다. 런타임 `node_modules`는 별도 target-platform stage에서 production 의존성만 설치한다. build-platform의 `node_modules`를 복사하면 arm64 Sharp/libvips 등이 깨질 수 있으므로 컴파일된 JS·웹 파일만 공유한다. 최종 이미지 build 중 Sharp PNG 생성과 서버 모듈 import를 실행해 target의 native 의존성 및 workspace 연결을 확인한다.

컴파일 stage만 검증하려면 아래 명령을 사용한다. 이 stage들은 arm64 emulator 없이도 두 target 요청을 처리할 수 있다. 전체 런타임 검증에는 native ARM builder 또는 QEMU가 필요하며 `--target build`를 제거한다. 아래 명령은 registry에 push하지 않는다.

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly -f deploy/aniyomi/Dockerfile .
docker buildx build --platform linux/amd64,linux/arm64 --target build --output type=cacheonly .
```
