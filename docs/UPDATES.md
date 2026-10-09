# 서버 업데이트

관리자는 설정 → 정보에서 시스템 정보와 업데이트를 확인한다. 별도 연결 없이 설치 버전·이미지 저장소 또는 Git upstream 정보로 GitHub 릴리스를 확인한다. 확인 결과는 6시간, 오류는 1시간 동안 재사용하며 수동 확인 간격은 최소 1분이다. 버전을 알 수 없는 개발 빌드는 최신 버전이라고 표시하지 않는다.

실제 설치에는 호스트 업데이트 도구가 필요하다. 신규 릴리스 설치는 도구를 자동으로 연결하고, 기존 설치는 연결된 도구를 그대로 사용한다. 도구가 없는 개발 서버에서도 공개 릴리스와 변경 사항은 볼 수 있지만 앱에서 설치 파일을 교체하지 않는다. 업데이트 도구는 MOA를 설치한 호스트에서 Node.js 22 이상으로 실행한다.

## 명령행

저장소 루트에서 실행한다.

```sh
node scripts/update.mjs check
node scripts/update.mjs apply
```

`--cwd /설치/경로`, `--dir /상태/경로`, `--mode auto|git|docker`를 지정할 수 있다. 기본 상태 경로는 설치 폴더의 `data/updater`이다. `auto`는 실행 중인 MOA Compose 프로젝트가 있으면 Docker, 아니면 Git을 선택한다. Docker가 중지된 설치는 `--mode docker`로 지정한다.

Git 설치는 현재 브랜치에 설정된 추적 브랜치를 가져와 비교한다. 새 커밋이 있으면 fast-forward 병합하고 잠금 파일에 맞춰 의존성을 설치한 뒤 빌드한다. 수정한 추적 파일이 있거나 기록이 갈라졌다면 업데이트를 중단한다. 원격보다 앞선 로컬 커밋을 되돌리지 않는다.

Git 저장소에서 운영하는 Docker 설치는 같은 방식으로 소스를 갱신하고 이미지를 빌드한 다음 컨테이너를 재생성한다. 빌드에 실패하면 실행 중인 컨테이너를 교체하지 않으며 다음 실행에서 빌드를 다시 시도한다. Git 없이 Compose 이미지만 운영하면 설정된 이미지 태그를 내려받아 실행 중인 이미지 ID와 비교한다. 이 경우 **확인 단계에도 이미지 다운로드가 발생한다**. 이미지를 고정한 태그나 digest를 쓰면 지정한 버전만 사용한다.

Compose 프로젝트 이름, `.env`, `COMPOSE_FILE`과 기존 volume 설정을 유지한다. 초기 실행에 `-p`나 `-f`를 사용했다면 도구에도 같은 구성을 환경 변수로 전달한다.

```sh
COMPOSE_PROJECT_NAME=moa COMPOSE_FILE=compose.yaml:compose.vaapi.yaml node scripts/update.mjs apply --mode docker
```

일반 Git 서버는 빌드 후 `restart-required`를 표시하므로 실행 중인 MOA를 재시작한다. Linux에서 systemd로 운영한다면 호스트 도구에 `MOA_UPDATE_SERVICE=moa.service`를 설정해 자동 재시작할 수 있다. 도구 실행 계정에 해당 서비스의 재시작 권한이 있어야 한다.

수동으로 MOA를 재시작한 뒤에는 호스트 도구도 재시작해 재시작 알림을 지운다. 빌드에 실패해도 먼저 실행 중인 서비스를 중지하지 않는다. 실패한 소스 버전은 기록해 두므로 다시 확인한 뒤 설치를 재시도할 수 있다.

## 웹 설정에서 실행

호스트 도구를 `serve`로 실행하면 웹 관리자 화면의 확인·업데이트 요청을 처리한다. 브라우저에서 실행할 명령이나 파일 경로를 지정할 수 없다. 앱 컨테이너에는 상태 디렉터리만 연결하며 Docker socket이나 Git 저장소를 연결하지 않는다.

### Docker Compose

Linux 예시다. 설치 계정이 소유한 폴더에 해당 계정의 기본 그룹을 지정하고, 앱에도 같은 그룹 접근 권한을 부여한다. 다른 사용자가 이 그룹을 공유하지 않는지 확인한다.

```sh
mkdir -p data/updater
sudo chown "$(id -u):$(id -g)" data/updater
sudo chmod 2770 data/updater
id -g
```

기존 `.env`에 다음 설정을 추가한다. `MOA_UPDATER_GID`의 `1000`은 위 `id -g`의 출력값으로 바꾼다. `COMPOSE_FILE`에 기존 overlay가 있다면 그대로 두고 `compose.updates.yaml`을 마지막에 추가한다. `MOA_UPDATER_PATH`는 호스트의 절대 경로다.

```dotenv
MOA_UPDATER_PATH=/srv/moa/data/updater
MOA_UPDATER_GID=1000
COMPOSE_FILE=compose.yaml:compose.updates.yaml
```

컨테이너를 재생성하고 호스트에서 도구를 실행한다. 호스트 Node.js는 Compose의 `.env`를 자동으로 읽지 않으므로 같은 경로를 `--dir`로 지정한다. Compose 자체의 변수는 기존 `.env`에서 읽는다.

```sh
docker compose up -d --pull never
node scripts/update.mjs serve --cwd /srv/moa --dir /srv/moa/data/updater --mode docker
```

호스트의 서비스 관리자에 이 명령을 등록하면 재부팅 후에도 사용할 수 있다. 호스트 계정은 설치 폴더와 Docker Compose 프로젝트를 관리할 권한이 필요하다. 상태 디렉터리는 앱과 도구만 읽고 쓸 수 있게 유지한다.

### Git 서버

MOA 서버와 호스트 도구가 같은 상태 디렉터리에 접근하게 한다.

```sh
MOA_DEPLOYMENT=git MOA_REVISION=$(git rev-parse HEAD) MOA_UPDATER_DIR="$PWD/data/updater" corepack pnpm --filter @moa/server start
```

다른 터미널이나 서비스에서 실행한다.

```sh
node scripts/update.mjs serve --mode git
```

도구가 종료되거나 상태 갱신이 끊기면 웹의 실행 버튼이 비활성화된다. 빌드와 재시작 중에는 재생과 접속이 잠시 중단될 수 있다. 앱·인증 데이터와 기존 volume은 삭제하지 않는다.

## 이미지 소유자와 배포 정보

기본 이미지 주소는 `ghcr.io/sidetool`이며 `.env`의 `MOA_IMAGE_OWNER`로 변경할 수 있다. Git에서 빌드할 때는 커밋을 이미지에 기록한다.

```sh
MOA_REVISION=$(git rev-parse HEAD) docker compose build
docker compose up -d --pull never
```

실행 중인 Docker 이미지에 커밋 정보가 없으면 위 명령으로 처음 한 번 빌드한다. 실행 중인 이미지가 선택한 소스보다 앞서거나 다른 기록에 속하면 자동 업데이트를 중단한다. 호스트에서 배포할 브랜치를 확인하고 해당 이미지의 커밋을 포함한 소스를 사용한다.

GitHub Actions는 실행한 저장소 소유자의 GHCR에 이미지를 발행한다. 수동 실행한 개발 이미지 workflow는 `edge`와 커밋 태그를, 완성된 정식 릴리스는 `stable`/`latest`와 버전 태그를 사용하며, 포크의 작업 브랜치는 해당 브랜치에서 직접 빌드해 테스트한다. 업데이트 도구도 소스 설치에서는 현재 추적 브랜치를 그대로 유지한다.

## 웹 업데이트 흐름

관리자는 새 업데이트 알림에서 설치를 선택하거나 설정 → 정보 → 업데이트에서 직접 확인·설치할 수 있습니다. 설치 확인 후 호스트 도구가 작업을 진행하며, 웹에서 진행 상태와 결과를 확인합니다. 서버 재시작 동안 접속이 잠시 끊길 수 있습니다.

- 호스트 도구는 약 6시간마다 새 업데이트를 확인합니다. 확인 실패 시 1시간 뒤 재확인합니다. **자동 설치·예약 설치는 없습니다.**
- 알림의 닫기는 24시간 동안 다시 표시하지 않습니다. 그 사이 새 버전이 나와도 반복하지 않습니다.
- **다시 보지 않음**은 업데이트 알림을 끕니다. 설정 → 정보 → 업데이트의 알림 스위치로 다시 켤 수 있습니다.
- 알림 설정은 해당 브라우저의 서버 주소·관리자 계정별로 저장됩니다. 일반 회원과 재생 화면에는 알림을 표시하지 않습니다. OS 알림 권한은 요구하지 않습니다.
- 알림을 꺼도 설정 화면에서 확인·설치할 수 있습니다. 알림을 끄는 것은 서버의 업데이트 확인을 끄는 동작이 아닙니다.

기존 Git/Docker 설치는 연결된 호스트 도구를 그대로 사용합니다. 기존 Docker 모드의 확인은 이미지 pull을 포함하고, source/Git 모드는 추적 브랜치를 확인합니다. `source`는 기존 소스 설치를 명시적으로 선택하는 이름입니다. 현재 설치를 다른 방식으로 자동 전환하지 않습니다.

## 정식·베타 릴리스

새 release 설치는 설정에서 **정식 / 베타**만 선택합니다. 정식에는 안정판만, 베타에는 베타와 정식 중 높은 지원 버전이 표시됩니다. 채널 변경으로 설치가 시작되거나 이전 버전으로 내려가지 않습니다.

release 모드의 확인은 metadata만 받습니다. 관리자가 설치를 누르면 서명과 이미지 digest를 검증하고 필요한 이미지를 받습니다. 재생·번역·스캔이 진행 중이면 설치를 중단하고 작업 종료 뒤 다시 시도하도록 안내합니다. 적용 직전 새 작업을 잠시 막고, 쓰기 서비스를 정지한 뒤 `/data`를 백업합니다. 앱·인증 DB의 WAL도 정지 상태에서 함께 복사합니다.

호환성이 선언된 같은 스키마 epoch의 릴리스만 인앱 적용합니다. 실패하면 이전 이미지 조합 복구를 시도합니다. **사용자 DB를 과거 백업으로 자동 덮어쓰지 않습니다.** 스키마/배포 구조가 달라 수동 작업이 필요한 릴리스는 설치를 차단하고 안내합니다. 최근 두 백업과 20건의 결과를 로컬에 보관합니다. 비밀을 포함하는 백업·관리 상태는 공개 업로드하지 마세요.

### 신규 설치에서 호스트 도구 연결

Linux, Node 22 이상, Docker Compose 2.24 이상이 필요합니다. 브라우저 인증 이미지는 amd64 전용입니다. 기존 사용자에게 재설치나 이관을 요구하지 않으며 별도 이관 도구는 제공하지 않습니다.

신규 릴리스 설치 파일 `moa-install.tar.gz`와 `moa-install.tar.gz.sig`를 받고 독립적으로 확인한 프로젝트 공개키로 검증한 뒤 풉니다.

```sh
openssl pkeyutl -verify -pubin -inkey /absolute/path/trusted-key.pem \
  -rawin -in moa-install.tar.gz -sigfile moa-install.tar.gz.sig
tar -xzf moa-install.tar.gz
node moa-install/scripts/install-release.mjs install \
  --cwd /absolute/path/moa --project moa \
  --version v0.1.0-beta.1 --key /absolute/path/trusted-key.pem
```

브라우저 인증이 필요하면 `--browser true`를 추가합니다. 설치 프로그램이 생성한 `moa-updater.service`를 사용자 systemd에 자동 등록하고 실행 상태를 확인합니다. 이미 다른 설치의 같은 이름 서비스가 있으면 변경하지 않습니다. 사용자 서비스 관리자가 없거나 시작에 실패하면 설치 완료와 업데이트 도구 연결 실패를 구분해 표시합니다. 이 경우 릴리스 확인은 가능하지만 앱에서 설치할 수 없습니다.

이후 설치는 웹에서 요청합니다. 앱에 Docker socket을 주지 않으며 호스트 Node·Docker는 자동 갱신하지 않습니다. 로그아웃 뒤 계속 실행하려면 호스트 관리자가 systemd lingering을 설정해야 합니다. Docker rootless/user namespace 환경은 공유 디렉터리 그룹 권한 조정이 필요할 수 있습니다.

`.moa-release/`에 버전별 실행 파일·digest 고정 Compose·로컬 백업을, `data/updater/`에 앱과 도구의 상태 전달 파일을 보관합니다. 사용자 환경은 설치 당시 해석한 Compose에 보존합니다. 이후 `.env` 수정만으로 관리 Compose가 바뀌지는 않습니다.

### 복구

호스트가 적용 도중 재시작되면 journal을 확인하고 이전 호환 이미지 조합 복구를 시도합니다. 자동 복구 실패 시 추가 설치를 막습니다. 관리자는 `.moa-release/journal.json`의 `previous.compose`로 이전 조합을 실행하고 상태를 확인할 수 있습니다.

```sh
docker compose --project-name YOUR_PROJECT --project-directory /absolute/path/moa \
  -f /absolute/path/to/previous/compose.json up -d --no-build --pull never --wait
```

백업 DB를 수동 복원할 때는 모든 쓰기 서비스를 정지하고 업데이트 후 저장된 데이터가 있는지 먼저 확인해야 합니다. 정상 복구 확인 후 journal을 별도 보관·정리하고 도구를 재시작합니다. 원문 journal에는 환경과 로컬 경로가 있을 수 있어 공개 이슈에 붙이지 마세요.

## Maintainer: 릴리스 발행

개발용 edge/sha 이미지는 `Container images` workflow를 수동 실행하여 만듭니다. main 병합만으로 중복 빌드하지 않으며, 버전 태그는 정식 또는 베타 Release를 만듭니다. 발행 환경 `releases`의 Ed25519 개인키 Secret `RELEASE_PRIVATE_KEY`와 공개키 variable `RELEASE_PUBLIC_KEY`를 사용합니다. 공개키는 `deploy/release-trust.json`과 일치해야 합니다. 개인키를 저장소에 넣지 않습니다.

태그는 `vX.Y.Z` 또는 `vX.Y.Z-beta.N`입니다. `deploy/release-policy.json`에 해당 version, minimumVersion, schemaEpoch, rollbackSafe를 검토하고 같은 버전의 `docs/releases/` 노트를 작성합니다. 구버전 실행 호환성을 확인하지 않았으면 rollbackSafe를 true로 선언하지 않습니다.

필수 검사·이미지 빌드 후 고정 공개 파일 목록으로 설치 묶음을 만들고 서명합니다. 모든 산출물이 준비된 draft만 공개합니다. 공개한 버전을 덮어쓰지 않습니다. stable/latest/beta 별칭을 사용하되 인앱 설치는 manifest의 digest를 사용합니다. 베타 최초 발행 전 실제 registry 빌드 결과를 확인해야 합니다.

빌드 캐시는 각 이미지의 GHCR `buildcache` 태그에 저장해 릴리스 태그 사이에서도 공유합니다. 캐시가 없으면 정상 빌드하고, 캐시 저장 실패만으로 완성된 릴리스를 중단하지 않습니다. 배포 버전은 서명된 manifest의 digest를 사용하며 `buildcache` 태그를 실행하지 않습니다. 의존성·베이스 이미지의 보안 업데이트가 필요하면 관리자가 해당 빌드 입력을 갱신해 릴리스를 발행합니다.
