# Aniyomi APK 작업 서버

설치한 APK의 영상 소스 기능을 별도 JVM에서 실행합니다. API14/API16 검사, DEX 변환, 소스·필터·환경설정 RPC, 자산·쿠키 저장, 선택적 Chromium WebView 연결을 제공합니다. Android 에뮬레이터나 원래 앱 화면은 포함하지 않습니다.

## 설치와 보관

[Docker 배포](../../docs/DEPLOYMENT.md)에 작업 서버와 공유 토큰 생성이 포함됩니다. `compose.aniyomi.yaml`은 기존 토큰 파일을 사용하는 호환 설정입니다. RPC는 내부 8797 포트만 사용하며 APK·변환 JAR·환경설정은 Docker 볼륨에 저장합니다. 업데이트할 때 볼륨과 토큰을 유지해 주세요.

APK는 일반 JVM 코드이므로 신뢰하는 확장만 설치하고 작업 서버를 외부에 노출하지 않습니다. 읽기 전용 루트·권한·자원 제한은 완전한 격리를 보장하지 않습니다. WebView에는 공개 IP 검사, 연결·페이지·시간 제한, 확장별 저장 영역이 적용됩니다.

## 빌드와 검사

`build.py`, `pom.xml`, `dependencies.lock.json`으로 소스와 JAR 해시를 고정합니다. Java 21·Maven·Python과 브라우저 의존성이 필요하며, 브라우저 잠금 파일은 pnpm 작업 공간과 별개입니다.

```sh
npm ci --prefix services/aniyomi-worker/browser --ignore-scripts
node --test services/aniyomi-worker/*.test.mjs
```

프로세스 잠금·중계 테스트는 Linux에서 합성 응답으로 실행하며 실제 Chromium을 실행하지 않습니다. [출처 고지](NOTICE.md)와 [대응 소스](../../docs/THIRD-PARTY-SOURCES.md)를 참고해 주세요.
