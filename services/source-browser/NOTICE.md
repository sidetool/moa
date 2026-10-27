# 소스와 실행 파일 출처

MOA가 작성한 선택 기능의 게이트, 릴레이, JSONL 작업 처리 및 실행 관리 코드는 GPL-3.0-or-later를 따릅니다(저장소의 LICENSE).
브라우저 프록시·주소·정책 모듈은 `services/aniyomi-worker/browser`에서 수정 없이 가져왔습니다. [Aniyomi 작업 처리기 고지](../aniyomi-worker/NOTICE.md)를 참고해 주세요.

- Camoufox Python 0.4.11: MIT
- Playwright 1.58.0: Apache-2.0
- Camoufox 브라우저 152.0.4-beta.30, Linux amd64: Firefox 기반, MPL-2.0
- 압축 파일 SHA256: `5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672`

원본 소스와 릴리스:
https://github.com/daijro/camoufox/tree/v152.0.4-beta.30
https://github.com/daijro/camoufox/releases/tag/v152.0.4-beta.30

원본 압축 파일 전체, license.html 및 구성 요소 고지를 보존합니다. 설치된 Python wheel에는 라이선스와 dist-info 정보가 남아 있습니다.
Socks 2.8.10은 MIT이며, node_modules에도 의존성 고지를 보존합니다. 코드 라이선스는 Mozilla 상표 사용 권한을 부여하지 않습니다.

확인 화면을 기다리는 기능은 Byparr v3.0.4의 요소 위치 기반 체크박스 처리 방식(GPL-3.0)을 검토한 뒤 이 서비스용으로 작성했습니다.
https://github.com/ThePhaseless/Byparr/blob/v3.0.4/src/challenge.py

Byparr 서버, 해결 모듈 또는 playwright-captcha 코드는 포함하지 않습니다. 검토한 방식은 위젯 크기와 대기 시간 판단에 참고했습니다.
출처를 이 문서에 남기며, MOA가 적용한 코드는 GPL-3.0-or-later로 제공합니다.
