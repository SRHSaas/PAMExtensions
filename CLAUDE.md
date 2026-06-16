# PAMExtensions

여러 증권사로부터 계좌·거래 정보를 스크래핑 → 정규화 → 사용자가 로그인한 SRHFinance 세션으로 자동 업로드하는 Chrome MV3 확장 프로그램.

**정책:** 증권사 인증을 쿠키 방식으로 백그라운드 유지하던 방식은 **폐지**. 사용자가 직접 증권사에 로그인한 뒤, 그 로그인된 탭에서 이후 작업만 자동화한다. keepalive/세션위조/service_role 키를 사용하지 않는다.

## 관련 프로젝트 (외부 계약)

| 경로 | 역할 |
|------|------|
| `D:/Github/SRHSaaS/SRHFinance/lib/ingest.ts` | 정규(canonical) 페이로드 **권위 계약**. 변환기는 여기에 맞춘다 |
| `D:/Github/SRHSaaS/SRHFinance/app/api/ingest/portfolio/route.ts` | 업로드 수신 엔드포인트(`POST /api/ingest/portfolio`) |
| `D:/Github/SRHSaaS/SRHFinance/lib/apiAuth.ts` | `requireApprovedUser` — 로그인+승인 세션만 통과(401/403) |
| `D:/Github/SRHSaaS/WebPriceTracker/miraeasset/` | 참조 구현(Playwright 스크래퍼 + canonical.js). 확장으로 이식 |

## 하네스: PAMExtensions 빌드/유지보수

**목표:** 증권사 스크래핑 → canonical 정규화 → SRHFinance 세션 업로드 Chrome 확장을 에이전트 팀으로 빌드·진화한다.

**실행 모드:** 에이전트 팀 (파이프라인 + 생성-검증 복합)

**에이전트 팀:**
| 에이전트 | 역할 |
|---------|------|
| extension-architect | MV3 골격·매니페스트·메시지 패싱 규약·서비스워커·popup/options UI 셸 |
| scraper-engineer | 증권사별 content script 스크래핑 어댑터(미래에셋 시작), raw 추출 |
| normalizer-engineer | raw → 정규 IngestPayload 변환, lib/ingest.ts 계약 동기화 |
| integration-engineer | 사용자 세션 쿠키로 SRHFinance 업로드, 401/403/400/500 처리 |
| qa-verifier | 경계면 정합성 교차 검증(정규 페이로드↔lib/ingest.ts), 점진적 QA |

**스킬:**
| 스킬 | 용도 | 사용 에이전트 |
|------|------|-------------|
| pam-orchestrator | 팀 조율 오케스트레이터(빌드/유지보수 워크플로우) | (리더) |
| chrome-extension-mv3 | MV3 매니페스트·메시지규약·서비스워커·빌드 | extension-architect |
| brokerage-scraper | content script 스크래핑 어댑터(+references/miraeasset.md) | scraper-engineer |
| canonical-normalizer | 정규 변환(+references/ingest-contract.md) | normalizer-engineer |
| srhfinance-upload | 세션 기반 업로드 연동 | integration-engineer |
| integration-qa | 경계면 정합성 검증 방법론 | qa-verifier |

**실행 규칙:**
- 확장 빌드/수정, 증권사 어댑터 추가, 정규화·업로드·정합성 작업 요청 시 `pam-orchestrator` 스킬로 에이전트 팀을 통해 처리한다.
- 단순 질문/확인은 팀 없이 직접 응답해도 무방.
- 모든 에이전트는 `model: "opus"` 사용.
- 중간 산출물은 `_workspace/`에 보존(감사 추적). 최종 소스는 `src/` + `manifest.json`.
- **금지**: 클라이언트가 `user_id`/`seq`/`resolved_name` 부여·daily_holdings 미리합산(서버 권위), 쿠키 자동유지/세션위조, service_role 키.

**디렉토리 구조:**
```
.claude/
├── agents/
│   ├── extension-architect.md
│   ├── scraper-engineer.md
│   ├── normalizer-engineer.md
│   ├── integration-engineer.md
│   └── qa-verifier.md
└── skills/
    ├── pam-orchestrator/SKILL.md
    ├── chrome-extension-mv3/SKILL.md
    ├── brokerage-scraper/{SKILL.md, references/miraeasset.md}
    ├── canonical-normalizer/{SKILL.md, references/ingest-contract.md}
    ├── srhfinance-upload/SKILL.md
    └── integration-qa/SKILL.md
```

빌드 산출물(구현됨): **`extension/`** 하위에 `manifest.json` + `src/{shared,content/miraeasset,normalize,upload,background,popup,options}/`. 중간 산출물·QA 스크립트: `_workspace/`.

**확장 로드 경로:** `chrome://extensions`에서 **`D:\Github\SRHSaaS\PAMExtensions\extension`**(프로젝트 루트가 아님)을 "압축해제된 확장 프로그램 로드"로 지정한다. 확장 런타임 파일은 `extension/`에 격리하고, 하네스/개발 파일(`.claude/`, `_workspace/`, `CLAUDE.md`)은 루트에 둔다 — Chrome이 확장 루트의 `_` 접두 디렉토리(`_workspace`)를 예약 충돌로 거부하기 때문이며, 배포 패키지에 개발 파일이 섞이지 않는 이점도 있다.

**빌드 메모(미래에셋 v0.1):**
- 파이프라인: popup→background→content(SCRAPE) → normalize → upload(세션 쿠키). 메시지 스키마 단일 정의 `src/shared/messages.js`.
- content script는 격리 월드 한계로 `iframe[name="contentframe"]`에 page-world RPC 브리지를 주입해 미래에셋 페이지 전역 함수를 호출한다(상세 `_workspace/02_scraper_rawshape.md`).
- 배포 origin은 `optional_host_permissions`(`https://*/*`) + options에서 런타임 `chrome.permissions.request`로 처리(매니페스트에 광역 정적 권한 미사용).
- QA 회귀 스크립트: `_workspace/qa/check-payload.mjs`, `check-upload-mapping.mjs`(계약 변경 시 재실행).

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-16 | 초기 하네스 구성(에이전트 5 + 스킬 6) | 전체 | 쿠키 자동유지 폐지 → 사용자 로그인 후 자동화 확장 빌드 체계 구축 |
| 2026-06-16 | 초기 빌드 실행(미래에셋 v0.1) | manifest.json, src/* | 하네스 첫 구동 — 스크랩→정규화→세션 업로드 파이프라인 배선 완료, QA 전 항목 PASS |
| 2026-06-16 | 확장 파일을 `extension/` 하위로 이전 | extension/*, _workspace/qa/* | Chrome이 확장 루트의 `_workspace`(예약 `_` 접두) 거부 → 로드 디렉토리를 프로젝트 루트와 분리 |
| 2026-06-17 | content script ESM 구문(import/export) 제거(인라인 상수) + background 자동주입 폴백 | content/miraeasset, background, chrome-extension-mv3·brokerage-scraper 스킬 | 실행 시 "Receiving end does not exist" — content_scripts는 클래식 스크립트라 import/export 시 파싱 실패로 리스너 미등록. 스킬에 함정 반영 |
| 2026-06-17 | 버전 관리 시작 + CHANGELOG 작성 | 전체(.gitignore, CHANGELOG.md, 8개 커밋) | 의미 있는 구성요소 단위로 초기 이력 확립 |
| 2026-06-17 | CSP-safe 페이지 월드 브리지 재설계 | content/miraeasset(+page-bridge.js), manifest, chrome-extension-mv3·brokerage-scraper 스킬 | 미래에셋 CSP가 인라인 script·eval 차단 → MAIN-world content script + 고정 명령 프로토콜(eval 제거). 스킬에 함정 반영 |
| 2026-06-17 | 브리지 same-frame 토폴로지 + 주입 폴백 | content/miraeasset, background, messages(INJECT_BRIDGE) | cross-frame(iframe) 메시징이 월드 경계상 ping 무응답 → same-frame(top) 송수신 + 브리지의 top→contentframe 자동탐색 + declarative MAIN 미주입 시 executeScript 폴백 |
| 2026-06-17 | 팝업 진단(PROBE) 버튼 추가 | popup, content/miraeasset, page-bridge, background, messages(PROBE) | 미래에셋 콘솔(F12) 차단으로 페이지 구조 확인 불가 → 확장 내 진단으로 프레임·전역·DOM 보고. 실제 페이지에 스크래퍼 맞추기용 |
