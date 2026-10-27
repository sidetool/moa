# 소스와 빌드 출처

MOA가 작성한 최소 Aniyomi API14/API16 실행 환경, Android 호환 클래스, Inspect, Filters/Preferences, 실행 관리, 빌드 절차 및 브라우저 연결 코드는 GPL-3.0-or-later를 따릅니다.
브라우저 프록시, 공개 주소 제한, 실행·세션 관리, 비공개 JVM-to-Node RPC도 포함됩니다. 외부 소스와 의존성에는 아래의 별도 라이선스가 적용됩니다.
Patchright와 Chromium 버전은 브라우저 패키지 잠금 파일로 고정하며 각자의 라이선스를 유지합니다.

Android 에뮬레이터, Aniyomi 앱 배포본, AnymeX 연결 모듈은 포함하지 않습니다.

## 빌드에 사용하는 소스

소스 압축 파일은 내려받을 때 **SHA-256 검증을 반드시 거칩니다**.

- Suwayomi Server `v2.3.2243`
  - SHA-256: `e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2`
  - 네트워크/Rx 도우미, Android 설정 선언, URI/UriCodec, LruCache만 사용합니다.
  - URI/UriCodec과 LruCache의 Android Open Source Project Apache-2.0 고지를 보존합니다.
  - 서버의 URI 정규화에서는 Android 가상 저장소 경로 변환을 제외합니다.
  - 빌드 결과에 원본 라이선스와 사용한 소스 경로를 포함합니다.
- Aniyomi `97414446b8a95994c72dd33c41c971a89d4d25b8` (`v0.18.2.1`)
  - SHA-256: `e9bae19c0387b0aa7f977e61ffc35712f0711c7ec877d606bd1bce2ff2193521`
  - 영상 소스 API만 사용하고 Compose 전용 어노테이션은 제외합니다. HttpServer는 미지원 오류를 반환합니다.
  - 코루틴 import와 다중 플랫폼 PreferenceScreen 선언은 `build.py`에서 조정합니다.
  - Apache-2.0 라이선스를 `build-inventory.json`과 함께 제공합니다.

`dependencies.lock.json`으로 모든 실행 의존성 JAR의 해시를 검증합니다. Maven과 Kotlin 컴파일러는 빌드에만 사용합니다.
MPL 적용 도우미의 수정 사항을 포함해 생성된 소스와 정확한 수정 절차를 이 저장소의 빌드에서 제공합니다. 원본 소스 고지도 보존합니다.

APK 확장에는 제작자의 라이선스가 적용됩니다. 사용자가 설치한 APK와 변환된 JAR는 데이터 볼륨에 저장하며 실행 이미지나 Git 저장소에는 포함하지 않습니다.

## 호환성을 위한 변환

OkHttp `Headers.Builder.set/add` 호출은 MOA의 `UrlHeaders`를 거칩니다. Referer/Origin의 유니코드 URL만 ASCII로 변환하며, 다른 헤더와 제어 문자 거부는 OkHttp 검증을 유지합니다.
서명된 원본 APK는 변경하지 않습니다. 변환 결과는 실행 환경 식별값으로 구분하며, 호환 처리 방식이 바뀌면 한 번 다시 생성합니다.

DEX 변환은 JVM 스택 맵 프레임을 계산합니다(`-cf`). JVM 검증도 계속 활성화합니다.
RequestsKt는 같은 네트워크 클라이언트와 취소 가능한 awaitSuccess 경로를 사용하는 suspending get/post 도우미를 제공합니다.

프레임 정보 보정은 dex2jar 2.4.37이 공통 상위 클래스로 잘못 생성하는 `java/util/Object`를 `java/lang/Object`로 수정합니다.
확장 클래스 이름과 메서드 명령은 바꾸지 않습니다.

## 라이선스 적용 범위와 미확인 사항

MOA 작성 코드의 GPL-3.0-or-later는 복사하거나 빌드에 사용한 외부 파일의 원래 라이선스를 대체하지 않습니다.

Suwayomi의 `androidx/preference/*.java`, `MemoryCookieJar.kt`, `RxCoroutineBridge.kt`는 **MPL-2.0**입니다.
`JsonObject.kt`에는 개별 헤더가 없어 보수적으로 MPL-2.0으로 취급합니다. 빌드 과정에서 수정하는 Preference/ListPreference/TwoStatePreference에도 MPL이 계속 적용됩니다.

AOSP의 NonNull/Nullable, Uri, LruCache, UriCodec은 Apache-2.0 헤더를 보존합니다.
Tachiyomi에서 가져온 네트워크/Jsoup 도우미에는 Apache 고지와 Copyright 2015 Javier Tomás가 있습니다.
전체 고지는 루트의 `LICENSES/Tachiyomi-Apache-2.0.txt`에 보존합니다. 개별 파일 적용 범위와 UriCodec의 ASF NOTICE는 추가 확인이 필요합니다.
Aniyomi에서 가져온 소스 API는 Apache-2.0입니다.

`mihon/core/common`의 Json/RequestsCompat/HttpServer 호환 코드 작성자와 복사 출처는 **UNKNOWN**입니다.
Maven의 구형·통합 JAR 라이선스, 정확한 브라우저·네이티브 구성 요소, 실행 파일에 대응하는 전체 소스 자료는 릴리스 담당자가 확인해야 합니다.
[외부 구성 요소 고지](../../THIRD_PARTY_NOTICES.md)와 [외부 소스 배포 안내](../../docs/THIRD-PARTY-SOURCES.md)를 참고해 주세요.

실행 이미지의 Dockerfile은 생성·수정된 소스를 `/app/build/src`에 보존하며 프로젝트와 의존성 고지 전체도 포함합니다.
재배포 시 원본 고지와 JAR 내부 고지를 유지해야 합니다. 빌드 절차 링크만으로 모든 소스 제공·출처 표시 요건이 충족되지는 않습니다.
