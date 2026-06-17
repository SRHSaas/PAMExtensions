# Changelog

이 프로젝트의 모든 주요 변경사항을 기록합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르며,
버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따릅니다.

## [Unreleased]

### Changed
- **자동(증분) 시작일을 `마지막 수집일 + 1` → `마지막 수집일 자체`(그날 포함)로** 변경. 이유: (1) 마지막
  업로드 이후에도 **같은 날짜의 거래내역이 더 발생**할 수 있어 그날을 다시 받아야 하고, (2) **일자별 자산은
  그날 종가** 기준이어야 하는데 직전 수집이 장중(미확정) 값일 수 있어 다시 받아 덮어써야 한다. 같은 날 재수집의
  중복은 SRHFinance ingest의 upsert로 정리된다. (`computeRanges`의 `nextDay(last)` → `last`)

### Fixed
- **content script 중복 주입 `Identifier 'MSG' has already been declared`**: 선언형 content_scripts
  주입과 background의 inject 폴백(executeScript)이 같은 문서에 두 번 실행돼 최상위 `const MSG`
  재선언으로 스크립트가 깨지고 리스너가 망가지던 문제(→ "message channel closed") → content script
  전체를 **멱등 가드(IIFE)**로 감싸 두 번째 주입은 즉시 return.
- **단독 자산 페이지에서 "message channel closed"**: 자산 페이지(/hkd/…)가 contentframe이 아니라
  top 프레임 자체일 때 `openHp`가 top을 reload해 content script가 종료되던 문제 → contentframe이
  없으면 "프레임셋 홈(securities.miraeasset.com)으로 이동해 수집하라"는 명확한 에러로 중단.

## [0.2.0] - 2026-06-17

수집 옵션 시스템 + 업로드 전 미리보기(2단계 파이프라인).

### Added
- **스크랩 대상 선택**(팝업): 일자별 자산 / 거래내역 체크박스.
- **기간 모드**: 자동(증분) / 지정(시작·종료일). 자동은 SRHFinance의 마지막 수집일 다음날~오늘을
  수집한다(증분).
- **2단계 파이프라인**: 수집(스크랩+정규화, `chrome.storage.local`에 저장) → **미리보기**(영역별
  건수 + canonical **JSON 다운로드**) → 업로드. 업로드 전에 데이터를 확인/저장할 수 있다.
- **SRHFinance 조회 API**(별도 레포): `GET /api/ingest/last-dates`(requireApprovedUser, 읽기 전용)가
  로그인 사용자의 `daily_last`/`tx_last`를 반환. 자동 증분 모드가 이를 사용. *pam.srhsol.com 반영은
  SRHFinance 배포 필요.*

### Fixed
- **업로드 500 (`ON CONFLICT ... cannot affect row a second time`)**: 일자별 raw가 날짜마다 같은
  계좌를 반복해 `accounts`의 `account_no`가 대량 중복 → 서버 upsert 실패. `mergePayloads`에서
  accounts(account_no 유일)·daily_assets((date,account_no) 유일) dedup.
- **"message channel closed before a response was received"**: 장시간 수집을 팝업이 `sendMessage`
  응답으로 기다리다 팝업이 닫히면 채널이 끊겨 발생 → COLLECT/UPLOAD를 **fire-and-ack**로 전환
  (즉시 ack, 결과는 `COLLECT_RESULT`/`UPLOAD_RESULT` 브로드캐스트 + `chrome.storage` 복원).

## [0.1.0] - 2026-06-17

증권사 데이터를 스크래핑 → 정규화 → 사용자가 로그인한 SRHFinance 세션으로 업로드하는
Chrome/Edge MV3 확장의 첫 동작 버전(미래에셋). 쿠키 자동유지 방식을 폐지하고, 사용자가 직접
로그인한 탭에서 이후 작업만 자동화한다.

### Added
- **하네스(개발 자동화 체계)**: 5개 전문 에이전트(extension-architect, scraper-engineer,
  normalizer-engineer, integration-engineer, qa-verifier) + 6개 스킬(pam-orchestrator 외).
  빌드·유지보수를 에이전트 팀으로 조율. (`.claude/`, `CLAUDE.md`)
- **MV3 골격**: `manifest.json`(최소 권한 + `optional_host_permissions`), 메시지 패싱 단일
  계약(`src/shared/messages.js`), background 서비스워커 파이프라인 라우터, popup 상태머신 UI,
  options(SRHFinance origin 설정).
- **미래에셋 스크래핑 어댑터**(`src/content/miraeasset/`): 로그인된 탭의 DOM에서 일자별 자산·
  보유종목·거래내역·배당을 추출. 격리 월드 제약을 page-world RPC 브리지로 우회.
- **정규(canonical) 변환**(`src/normalize/`): raw → SRHFinance `IngestPayload`. `user_id`/`seq`/
  `resolved_name` 미부여·`daily_holdings` 미리합산 금지(서버 권위) 준수.
- **SRHFinance 업로드 클라이언트**(`src/upload/`): 사용자 세션 쿠키(`credentials:"include"`)로
  `POST /api/ingest/portfolio`. 401/403/400/500 에러 매핑, 멱등 재시도, 중복방지 manifest.
- **경계면 QA 회귀 스크립트**(`_workspace/qa/`): 정규 페이로드 ↔ `lib/ingest.ts` 계약 검증
  (`check-payload.mjs`), 업로드 응답코드 매핑 검증(`check-upload-mapping.mjs`).
- **진단 버튼**(팝업): 콘솔(F12)이 막힌 사이트에서도 현재 페이지의 프레임(top/contentframe) URL,
  페이지 전역(`openHp` 등) 존재 여부, DOM 표 구조를 읽어 복사 가능한 보고서로 표시. 실제 페이지에
  스크래퍼를 맞추기 위한 진단용(`MSG.PROBE` + 브리지 `probe` 명령, 브리지 실패 시에도 graceful).

### Changed
- 확장 런타임 파일을 **`extension/` 하위로 분리**. Chrome/Edge가 확장 로드 루트의 `_workspace`
  (예약 `_` 접두) 디렉토리를 거부하므로, 로드 디렉토리를 프로젝트 루트와 분리하고 하네스/개발
  파일(`.claude/`, `_workspace/`)은 루트에 둔다. → 로드 경로: `…/PAMExtensions/extension`.

### Fixed
- **"Could not establish connection. Receiving end does not exist."** 해소: content script는
  manifest로 주입 시 클래식 스크립트로 실행되어 ESM 구문(`import` 및 함수 `export`)이 스크립트를
  죽이고 메시지 리스너가 등록되지 않았다(증상: `import` → "outside a module", `export` →
  "Unexpected token 'export'"). → 정적 import/export 제거, 사용 상수를 인라인 미러로 선언.
- background에 **content script 자동 주입 폴백** 추가: 메시지 전송 실패 시
  `chrome.scripting.executeScript`로 주입 후 1회 재시도. 확장 로드 전부터 열려 있던 탭도 수동
  새로고침 없이 동작.
- 정규 변환에서 일자별 자산 금액을 숫자로 정규화. 참조 구현(`canonical.js`)이 콤마 포함 문자열을
  그대로 통과시켜 서버 `num()`에서 `NaN→0`으로 손실되던 버그를 보정.
- **미래에셋 CSP에서 스크래핑 동작**: 페이지 CSP(`script-src 'self' 'wasm-unsafe-eval'`)가 인라인
  `<script>` 주입과 `eval`/`new Function`을 모두 차단해, 페이지 전역(`openHp`·`hkd1004.list` 등)에
  접근하던 RPC 브리지가 동작하지 못했다. → 브리지를 **MAIN-world content script**(`page-bridge.js`,
  `world:"MAIN"`, `all_frames`)로 분리(확장 주입 MAIN 스크립트는 페이지 CSP의 script-src 제약을
  받지 않음)하고, eval 기반 임의코드 실행을 **고정 명령 프로토콜**(ping/call/get/setdate/fxrates)로
  대체. 순수 DOM 조작·테이블 파싱은 ISOLATED 월드로 이동. 브리지 메시징은 **same-frame(top
  window)**으로 신뢰성을 확보(cross-frame 수신은 월드 경계상 무응답)하고, 페이지 전역이 top·
  contentframe 어디에 있든 브리지가 자동 탐색하며, declarative MAIN 미주입 탭은 background의
  `chrome.scripting.executeScript({world:"MAIN"})`(INJECT_BRIDGE) 폴백으로 복구한다.
- **계좌별자산 페이지에서 "openHp 없음"**: 미래에셋은 `<frameset>`/`<frame>` 구조라
  `document.querySelector('iframe[name="contentframe"]')`가 contentframe(`<frame>`)을 못 찾아
  그 안의 페이지 전역(`openHp` 등)에 도달하지 못했다. → contentframe을 **이름 기반**
  (`window.frames["contentframe"]`, Playwright `page.frame()` 원리, `<frame>`/`<iframe>` 모두 동작)으로
  찾도록 브리지·ISOLATED 양쪽 수정. 진단도 동일 수정.
- **브리지 버전 핫스왑**: MAIN-world 브리지가 "이미 설치됨" 가드로 페이지에 고착돼 확장만
  리로드하면 옛 코드가 계속 응답하던 문제 → `VER` + ping `ver` + 구버전 리스너 자가 무력화 +
  ISOLATED의 ver 불일치 감지 재주입으로, 이후 변경은 페이지 새로고침 없이 자동 갱신.

[Unreleased]: https://example.invalid/PAMExtensions/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/PAMExtensions/releases/tag/v0.1.0
