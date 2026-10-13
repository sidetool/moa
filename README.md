<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.png">
  <img src=".github/assets/logo-light.png" alt="MOA" width="220">
</picture>

### 흩어진 영상을, 내 서버 한 곳에서

MOA는 직접 운영하는 영상 스트리밍 앱입니다. 여러 확장 소스와 내 서버의 영상 파일을<br>
한 화면에 모으고, 작품 정보와 시즌을 정리해 줍니다. 한국어 자막이 없으면 AI가 번역해 줍니다.

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-7b61ff)](LICENSE)
![Node 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![React 19](https://img.shields.io/badge/react-19-61dafb?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/docker-compose-2496ed?logo=docker&logoColor=white)

[기능](#기능) · [빠른 시작](#빠른-시작) · [확장 소스](#확장-소스) · [문서](#문서) · [면책](#면책-disclaimer)

<br>

<img src=".github/assets/home.webp" alt="MOA 홈 화면" width="100%">

</div>

<br>

## 기능

**찾기**

- **통합 검색** — 설치한 모든 소스와 내 라이브러리를 한 번에 검색합니다. 여러 소스에 있는 같은 작품은 카드 하나로 묶고, 결과는 소스별로 도착하는 대로 보여 줍니다.
- **시즌 전환** — 시즌마다 다른 소스에 있어도 작품 페이지의 `시즌 1 · 26화 ▾`에서 바로 넘어갑니다.
- **작품 정보** — TMDB에서 포스터, 타이틀 로고, 줄거리, 평점, 출연진을 가져옵니다.

**보기**

- **자막 자동 번역** — Gemini, OpenAI와 호환 API로 다른 언어 자막을 번역합니다. 지금 보고 있는 장면부터 먼저 번역하고, 끝난 번역은 저장하거나 내보낼 수 있습니다. 사용할 API와 키는 관리자 설정에서 관리합니다.
- **자막 찾기** — 공개 자막 서비스에서 자막을 찾아 붙입니다. ASS 자막은 원래 스타일 그대로 보여 줍니다.
- **자막 파일** — SRT, VTT, ASS, SMI와 ZIP·7z·RAR 파일을 불러와 서버에 저장합니다. 소스를 바꾸거나 다시 재생해도 선택한 자막을 유지합니다.
- **플레이어** — 이어 보기, 다음 화 자동 재생, 오프닝·엔딩 건너뛰기를 지원합니다. 브라우저가 바로 재생할 수 없는 내 영상 파일은 서버에서 변환하며, VAAPI 하드웨어 가속을 쓸 수 있습니다.
- **TV 전송** — Chromecast와 AirPlay로 영상과 선택한 자막을 전송합니다. 필요한 브라우저와 연결 조건은 [TV 전송 안내](docs/CASTING.md)를 보세요.
- **내 영상 파일** — 서버 폴더를 스캔해서 확장 소스와 같은 화면에서 재생합니다.

**함께 쓰기**

- **프로필** — 가족마다 시청 기록과 내 목록을 따로 두고 PIN을 설정할 수 있습니다. 키즈 프로필은 TMDB 관람 등급을 기준으로 작품을 거릅니다.
- **어느 화면에서나** — PC, 모바일, TV에 맞춰 화면이 바뀝니다. TV에서는 리모컨 방향키만으로 모든 화면을 조작할 수 있고, 휴대폰에서는 홈 화면에 앱처럼 설치할 수 있습니다(PWA).
- **확장 실행** — Mangayomi(JS)와 Aniyomi(APK) 확장 형식을 지원합니다. 저장소는 사용자가 직접 추가합니다.
- **웹사이트 플러그인** — ZIP이나 폴더로 설치한 JavaScript 플러그인으로 자막 가져오기, 재생 제어, 페이지 도구를 추가합니다. [개발 템플릿](plugins/template/README.md)과 [API 문서](docs/PLUGINS.md)를 제공합니다.
- **서버 업데이트** — 호스트 업데이트 도구를 연결하면 관리자가 정식·베타 릴리스를 확인하고 데이터와 설정을 유지하며 업데이트할 수 있습니다.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/title.webp" alt="작품 페이지"></td>
    <td width="50%"><img src=".github/assets/season.webp" alt="시즌 메뉴"></td>
  </tr>
  <tr>
    <td align="center"><sub>작품 페이지</sub></td>
    <td align="center"><sub>다른 소스에 있는 시즌도 같은 메뉴에서</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/search.webp" alt="통합 검색"></td>
    <td width="50%"><img src=".github/assets/mobile.webp" alt="모바일"></td>
  </tr>
  <tr>
    <td align="center"><sub>통합 검색</sub></td>
    <td align="center"><sub>모바일</sub></td>
  </tr>
</table>

## 빠른 시작

최신 정식 **v0.1.1** 기준입니다.

Linux는 Docker Engine과 Compose 플러그인, macOS·Windows는 Docker Desktop이 필요합니다. Windows에서는 WSL2를 켜고 Linux 컨테이너를 사용합니다.

1. 저장소를 받고 공개 이미지로 실행합니다.

   ```sh
   git clone --branch v0.1.1 --depth 1 https://github.com/sidetool/moa.git
   cd moa
   echo MOA_VERSION=v0.1.1 > .env
   docker compose up -d
   docker compose logs moa-auth
   ```

2. 로그의 `Setup code`를 확인합니다. 브라우저에서 `http://localhost:8796`(다른 기기는 `http://서버의-LAN-IP:8796`)을 열고 코드를 입력한 뒤 관리자 계정을 만듭니다.
APK 실행 환경도 기본 포함되며 토큰 파일이나 추가 compose 설정은 필요 없습니다.

3. 설정에서 사용할 소스와 로컬 라이브러리를 추가합니다. 기본 확장 저장소는 없습니다. 내 영상 폴더 연결, TMDB 키, APK 확장, HTTPS와 업그레이드는 [배포 문서](docs/DEPLOYMENT.md)를 보세요.

설정 코드는 `docker compose exec moa-auth moa-setup-code`로 다시 확인할 수 있습니다. 데이터와 계정은 Docker volume에 보관합니다. gateway 포트 `8796`은 LAN에 열리고, 앱 포트 `8795`는 호스트에 열리지 않으며 모든 접속은 로그인 gateway를 거칩니다. 설정 → 원격 접속에서 Cloudflare 또는 Tailscale 주소와 QR을 만들 수 있습니다([원격 접속 안내](docs/REMOTE-ACCESS.md)).

## 확장 소스

MOA에는 **기본 확장 저장소가 없습니다.** 설정 → 소스에서 신뢰하는 저장소의 주소를 직접 추가해서 씁니다.

| 형식 | 저장소 파일 | 실행 방식 |
|---|---|---|
| Mangayomi JS | `index.min.json` / `anime_index.json` | 서버 안의 격리된 JS 런타임 |
| Aniyomi APK | `index.min.json` | 정식 기본 구성에 포함된 별도 APK 브리지 |

지원하는 형식과 동작 방식은 [확장 문서](docs/EXTENSIONS.md)에 있습니다. 특정 사이트나 확장 저장소를 추가하는 PR은 받지 않습니다.

확장 옵션의 **연결**에서 개별 프록시를 지정할 수 있습니다. 비워 두면 서버 기본값을 사용합니다. **브라우저 인증 사용**은 브라우저 인증 서비스를 설치한 경우 지원하는 JS 확장에 적용되며 기본값은 꺼짐입니다. [설정 안내](docs/SOURCE-BROWSER.md)를 참고하세요.

## 문서

- [배포](docs/DEPLOYMENT.md) — Docker로 설치하기, 로그인, 외부 접속
- [업데이트](docs/UPDATES.md) — Git·Docker 버전 확인과 관리자 업데이트
- [TV 전송](docs/CASTING.md) — Chromecast·AirPlay 재생
- [구조](docs/ARCHITECTURE.md) — 서버, 웹, 확장 런타임, APK 브리지
- [개발](docs/DEVELOPMENT.md) — 로컬 실행과 테스트
- [웹사이트 플러그인](docs/PLUGINS.md) — JavaScript 기능 확장, 자막·재생 API와 [개발 템플릿](plugins/template/README.md)
- [기여 안내](CONTRIBUTING.md) · [보안 제보](SECURITY.md)

## 기술 스택

React 19 · Vite · TanStack Query · Fastify · SQLite (`node:sqlite`) · QuickJS · Docker · nginx

## 면책 (Disclaimer)

**한국어**

- MOA는 사용자가 직접 추가한 확장을 실행하는 **프로그램**입니다. 이 프로젝트는 어떤 확장, 확장 저장소, 영상 콘텐츠도 제공·호스팅·포함·추천하지 않으며, 기본으로 설정된 저장소도 없습니다.
- 어떤 저장소와 확장을 추가하고 무엇을 재생할지는 전적으로 사용자의 선택입니다. 이로 인해 생기는 저작권 등 모든 법적 책임은 사용자에게 있으며, 사용자는 자신이 사는 곳의 법을 지켜야 합니다.
- MOA는 어떤 영상 사이트, 확장 개발자, TMDB와도 관계가 없습니다.
- 이 소프트웨어는 어떠한 보증 없이 "있는 그대로" 제공되며, 개발자는 사용으로 생기는 어떤 손해에도 책임지지 않습니다.

**English**

- MOA is a **program** that runs extensions added by its users. This project does not provide, host, bundle or endorse any extension, extension repository or media content, and ships with no repository configured.
- Which repositories and extensions you add, and what you play, is entirely your choice. You are solely responsible for any legal consequences, including copyright, and for complying with the laws that apply to you.
- MOA is not affiliated with any streaming site, extension developer or TMDB.
- This software is provided "as is", without warranty of any kind. The authors are not liable for any damages arising from its use.

자세한 내용은 [DISCLAIMER.md](DISCLAIMER.md)를 보세요.

## 라이선스

[GPL-3.0](LICENSE). 포함된 서드파티 코드의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.

<sub>This product uses the TMDB API but is not endorsed or certified by TMDB.</sub>
