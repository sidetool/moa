# 원격 접속

커넥터는 기본 Compose에 포함되며 관리자가 시작하기 전에는 대기합니다. **모든 터널은 로그인 게이트웨이를 통과해야 합니다.** 앱 API의 8795 포트를 직접 공개하거나 `moa:8795`로 터널을 연결하지 마세요.

## 관리자 API

타입은 `packages/shared/src/remote-access.ts`에서 정의하고 `@moa/shared`로 제공합니다.

| 메서드 | 경로 | JSON 본문 | 응답 |
| --- | --- | --- | --- |
| GET | `/api/admin/remote-access` | 없음 | `RemoteAccessStatus` |
| POST | `/api/admin/remote-access/configure` | `RemoteAccessConfigure` | `RemoteAccessStatus` |
| POST | `/api/admin/remote-access/start` | `{}` | `RemoteAccessStatus` |
| POST | `/api/admin/remote-access/stop` | `{}` | `RemoteAccessStatus` |

관리자 계정이 필요하며 프로필 헤더는 필요하지 않습니다. 변경 요청은 JSON만 받고 Origin이 현재 호스트·전달 프로토콜과 일치해야 합니다. 응답은 `private, no-store`, 오류는 `{ "error": "code" }`입니다.

필수 `mode`는 `off | cloudflare-quick | cloudflare-token | tailscale`입니다. 선택값은 `publicHostname`(프로토콜·경로·포트 없는 호스트명), `funnel`(불리언), `cloudflareToken`, `tailscaleAuthKey`입니다. 생략한 값은 유지하고 비밀 값의 `null`은 삭제를 뜻합니다. 응답의 `********` 가림값을 다시 보내지 마세요.

설정 변경은 실행 중인 연결에도 적용합니다. 시작은 저장된 방식을 켜고, 중지는 비밀 값을 남긴 채 끕니다. `off`도 중지합니다. 방식 변경 시 이전 프로세스를 먼저 종료하며 최대 2초가 걸릴 수 있습니다.

응답에는 `mode`, `state`, `url`, `urls`, `loginUrl`, `funnel`, `lastError`, `externallyManaged`, `available`, `desiredEnabled`, `gatewayServiceUrl`, `warning`, `config`가 있습니다. `config`는 위 설정값을 반환하되 비밀 값을 숨깁니다.

- `state`: `off | starting | needs-login | connected | error`
- `url`: 접속 주소 또는 null, `urls`: 현재 빈 배열 또는 `[url]`
- `loginUrl`: Tailscale 승인 주소이며 MOA 접속 주소가 아닙니다. QR은 실제 접속 주소가 있을 때만 표시합니다.
- `available=false`: 커넥터 미설정 또는 외부 관리 상태입니다.
- `warning`: 공개 접속 경고이며 UI에서 번역할 수 있습니다.

화면이 보이는 동안 2~5초마다 확인합니다. 내부 상태 갱신은 15초 주기라 승인·네트워크 변경 직후에는 기다려야 합니다. 시작·설정 응답이 곧바로 연결 완료를 뜻하지는 않습니다. Quick Tunnel 주소는 재시작하면 바뀝니다. 토큰 터널의 `connected`는 연결 등록이며 DNS·대시보드 경로 검증은 아닙니다. `funnel`은 요청한 설정이고 Serve 적용은 `connected`로 확인합니다.

오류는 503 `connector-unavailable`, 409 `remote-access-externally-managed`·`login-gate-and-admin-required`, 400 `invalid-public-hostname`·`invalid-secret`·`cloudflare-token-and-hostname-required`입니다. 실행 오류 `lastError`는 `connector-unavailable`, `connector-operation-failed`, `connector-process-failed`, `connector-process-exited`, `login-gate-and-admin-required` 중 하나입니다. 원본 프로세스 로그·비밀 값은 반환하지 않습니다.

## 배포와 보호

- 커넥터는 cloudflared·Tailscale과 인증된 내부 RPC 8798을 제공합니다. 외부 포트·Docker socket·추가 capability·TUN 장치 없이 UID/GID 1000으로 실행합니다. 별도 네트워크에는 커넥터와 게이트웨이만 두고, 앱은 공개되지 않은 게이트웨이 8798 중계로 RPC를 호출합니다.
- Tailscale 신원은 `moa-connector-data`(`MOA_CONNECTOR_DATA_PATH`), RPC 토큰은 `moa-connector-secret`(`MOA_CONNECTOR_SECRET_PATH`)에 저장합니다. 토큰은 앱·인증 서버에 읽기 전용으로 연결합니다.
- 설정과 비밀 값은 `/data/remote-access.json`에 원자적으로 기록하며 권한은 0600입니다. 파일 권한으로 보호하는 평문이므로 백업도 비공개로 관리하세요. 커넥터 비밀 파일은 0600이며 중지 시 삭제하고, RPC 토큰은 0640입니다. 명령 인수·응답에 토큰을 넣지 않습니다.
- Compose는 `MOA_CONNECTOR_URL=http://moa-gateway:8798`, `MOA_CONNECTOR_SECRET_FILE=/run/moa-connector/token`, 인증 서버의 `MOA_TRUST_GATEWAY=1`을 설정합니다. 직접 배포에서 기능을 끄려면 URL과 커넥터 서비스를 생략합니다. 인증·RPC 포트는 비공개로 유지하세요.
- 정적 터널은 `MOA_REMOTE_EXTERNALLY_MANAGED=1`을 사용합니다. 기존 cloudflared 설정은 유지하며 호스트 폴더를 쓰는 설치는 [이관 안내](DEPLOYMENT.md#기존-설치-이관)를 따릅니다.
- 시작·갱신마다 `MOA_REQUIRE_ACCOUNT=1`, 활성 관리자 존재, 로그인하지 않은 게이트웨이 `/api/me`의 401 응답을 확인합니다. 실패하거나 서버가 45초 동안 사용 기간을 갱신하지 않으면 중지합니다. Tailscale 내부 접속에도 같습니다.
- 전달 프로토콜은 `http`·`https`로 제한하고 실제 Host를 전달합니다. HTTPS는 `__Host-moa_*; Secure`, HTTP는 `moa_*` 쿠키를 씁니다. 전환 중 두 이름을 읽으며 같은 출처 CSRF 검증과 내부 상대 경로 이동을 유지합니다. `PUBLIC_HOST`·`PUBLIC_ORIGIN`은 기본값으로 남지만 `PUBLIC_SCHEME`은 쿠키 보안을 결정하지 않습니다.
- `GATEWAY_CLIENT_IP` 기본값은 `$remote_addr`입니다. 모든 접속이 신뢰하는 Cloudflare를 통과할 때만 `$http_cf_connecting_ip`를 사용하세요. LAN·Tailscale을 함께 쓰면 기본값 또는 별도 검증한 설정을 유지합니다. 로그인 실패는 IP별 15분당 8회, 동시 비밀번호 검사는 4개로 제한하며 로그인 성공 시 실패 수를 지웁니다. 프록시 IP를 공유하면 제한도 공유할 수 있습니다.

## 연결 방식

Cloudflare Quick Tunnel은 계정 없이 임시 주소를 만듭니다. 토큰 터널은 대시보드 공개 호스트 경로를 **HTTP `moa-gateway:8080`**으로 지정하고 MOA에 토큰·호스트명을 입력합니다. MOA는 대시보드 경로를 수정·검증하지 못하므로 앱 API나 다른 내부 서비스로 연결하지 마세요.

Tailscale은 userspace 모드로 실행합니다. 승인 링크를 열거나 선택적으로 인증키를 제공합니다. Serve에는 tailnet HTTPS·MagicDNS·클라이언트 접근 권한이, Funnel에는 추가 정책 권한과 제공자 포트 조건이 필요합니다. 중지해도 기기 신원은 남으므로 완전히 해제하려면 Tailscale에서 기기를 제거하세요. 키는 재시작을 위해 저장되므로 무인 등록이 필요하지 않다면 대화형 승인 후 넣지 마세요.

공식 안내: [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [토큰 파일](https://developers.cloudflare.com/tunnel/reference/run-parameters/), [Tailscale userspace](https://tailscale.com/docs/concepts/userspace-networking), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel).

## 검증

```sh
node --test deploy/auth/server.test.mjs deploy/gateway/config.test.mjs services/connector/server.test.mjs
corepack pnpm --filter @moa/server exec tsx --test test/remote-access.test.ts test/accounts.test.ts test/api.test.ts
docker build -t moa-connector:remote-access services/connector
```

연결 검사는 별도 Compose 프로젝트·테스트 데이터로 수행하고 끝나면 해당 테스트 자원만 정리합니다. 앱·RPC 포트를 공개하지 마세요. 로컬 상태 검사만으로 외부 접속 성공을 판단하지 않습니다.
