# 하락군협전 세이브 에디터 v1.0

`Ho Tu Lo Shu: The Books of Dragon` (Steam AppID `952860`) 전용 오프라인 세이브 편집기입니다.

## 주요 실행 방식 (3종 표면)

- **단독 오프라인 HTML**: `dist/HoTuLoShuSaveEditor-v1.0.html` (CSP 엄격 적용, 외부 요청 0건, 라이트/다크 테마, 키보드 탭 접근성)
- **Python 3 CLI 및 로컬 웹 서버**: `htls_editor.py` (`demo`, `inspect`, `validate`, `presets`, `edit`, `serve`)
- **Windows x64 WebView2 단독 실행 파일**: `src/SaveStore.cs` + `src/SaveEditor.cs` (`.NET Framework 4.8`)

## 지원 세이브 형식

- `HELUO_1_0` / `HELUO_1_1` 9바이트 ASCII 머리글 + LZ4/MessagePack 2블록 프레임
- 미편집 NPC 슬라이스 및 월드 데이터 무손실 보존
- 모드(`SSTS` 등) 사용자 정의 ID 호환

## 편집 기능

- 주인공·동료·NPC 능력치, 레벨·경험치·칭호·내공·경공 편집
- 감오 포인트 및 감오 노드 개방
- 일반 물품·장비 인벤토리 편집 및 `inventoryNoList` 일련번호 자동 동기화
- 보유 무공 경험치·숙련 개방
- 전송 거점·경과 일수·난이도 설정 및 원클릭 프리셋 6종

## 안전 장치

- `J2.exe` 실행 중 저장 차단 (`HTLS_SIMULATE_GAME_RUNNING=1` 시뮬레이션 지원)
- 덮어쓰기 전 원본 SHA-256 검증 `.bak` 백업 생성 및 원자적 파일 교체
- 심볼릭 링크·디렉터리 정션·하드링크·NTFS ADS(`:` 스트림)·예약 장치명(`CON`, `NUL` 등)·UNC 경로 차단
- 로컬 웹 서버 `Host` / `Origin` / `Sec-Fetch-Site` 검증 및 `X-HTLS-Token` CSRF 방어

## 빠른 실행 및 검증 명령

```text
python3 tools/extract_catalog.py --check-only
python3 build.py
python3 htls_editor.py presets
node tests/test_editor.cjs
python3 -W error -B -m unittest discover -s tests -v
```
