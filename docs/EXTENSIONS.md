# 사용자 선택 확장

MOA는 확장이나 확장 저장소를 기본 등록·번들·추천하지 않는다. 영상 소스 화면에서 **자신이 신뢰하는 저장소 URL**을 직접 입력하고 형식(Mangayomi JS / Aniyomi APK)을 선택한다. 목록을 갱신한 뒤 원하는 확장만 설치한다. 저장소 URL을 모른다면 해당 운영자의 설명과 라이선스를 직접 확인한다.

인기·최신·검색·필터·상세·회차·영상 목록은 확장이 제공하는 범위에서 동작한다. 호환 실행기는 원래 앱 전체를 구현하지 않는다. 사이트별 호환 목록이나 재생 성공을 보장하지 않는다. 소스의 분류·LIVE 여부·preference는 설정에서 바꾼다.

업데이트는 사용자가 명시적으로 적용한다. 검사를 통과한 설치만 교체하고 실패하면 기존 설치를 유지한다. 직전 설치는 이전 버전 복원으로 되돌릴 수 있다. 저장소 등록 해제와 설치한 소스 삭제는 별개다. 삭제 전 기록에 미치는 영향을 확인한다.

JS는 제한된 QuickJS 프로세스에서 실행한다. 공개 IP 검사, 요청 크기·시간 제한, preference 저장과 캐시를 사용한다. APK는 선택 설치한 worker의 JVM에서 실행되며 임의 코드를 실행할 수 있다. 컨테이너와 자원 제한은 완전한 보안 sandbox를 보장하지 않는다. 신뢰하지 않는 APK를 설치하지 않는다.

APK worker는 API14/API16의 일부 source/filter/preference ABI와 WebView 동작을 제공한다. WebView는 필요할 때 Chromium을 시작하며 쿠키·저장소·네트워크 정책을 연결한다. Android emulator나 원래 앱 UI는 제공하지 않는다. [worker 설명](../services/aniyomi-worker/README.md)을 참고한다.

원격 영상·이미지·확장 자막은 서버에서 중계·캐시할 수 있다. proxy 설정을 바꾸면 새 재생 세션에 적용한다. 세션 URL과 설정·쿠키는 사적으로 보관한다. 확장·저장소·콘텐츠의 권리와 서비스 약관은 사용자가 확인한다. [이용 책임](../DISCLAIMER.md), [출처 고지](../THIRD_PARTY_NOTICES.md)를 참고한다.


## APK 실행 환경

v0.1.2부터 새 설치의 APK 실행 환경은 선택 사항이다. 웹 업데이터가 연결돼 있으면 설정 → 정보 → 추가 기능에서 설치한다. 수동 구성은 `compose.apk.yaml`을 추가한다. 공유 인증 token은 자동 생성된다. 저장소나 APK 자체를 자동 설치하지는 않는다. 관리자 진단 `GET /api/admin/apk/status`는 `{ available, state, workers }`를 반환한다. `state`는 `ready`, `disabled`, `unreachable`이며 token이나 내부 오류는 반환하지 않는다.

JVM과 WebView Chromium은 필요할 때만 시작한다. JVM은 비활성 상태에서 기본 10분 뒤 종료되며 재생 중인 worker는 유지된다. worker 컨테이너의 기본 한도는 메모리 1 GiB, CPU 2개, PID 192개다. 저메모리 환경의 중지 override와 기존 token 파일 호환 설정은 [배포 문서](DEPLOYMENT.md#apk와-브라우저-인증)를 참고한다.
