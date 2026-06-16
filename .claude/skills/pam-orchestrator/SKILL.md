---
name: pam-orchestrator
description: "PAMExtensions(증권사 스크래핑 → 정규화 → SRHFinance 세션 업로드 Chrome 확장) 빌드/유지보수를 에이전트 팀으로 조율하는 오케스트레이터. 확장 구축, 증권사 어댑터 추가(미래에셋 등), 매니페스트/메시지규약, canonical 정규화, 업로드 연동, 정합성 검증 작업에 사용. 후속 작업: 다시 실행, 재실행, 업데이트, 수정, 보완, '스크래퍼만/정규화만/업로드만 다시', 이전 결과 개선, 증권사 추가, 계약 동기화 요청 시에도 반드시 이 스킬을 사용."
---

# PAMExtensions Orchestrator

증권사 데이터를 스크래핑하여 정규화하고, 사용자가 로그인한 SRHFinance 세션으로 자동 업로드하는 Chrome MV3 확장을 **빌드·유지보수**하기 위해 에이전트 팀을 조율하는 통합 스킬.

## 실행 모드: 에이전트 팀

파이프라인(스크랩→정규화→업로드) + 생성-검증(QA) 복합 패턴. 팀원 간 계약(메시지 스키마, raw shape, 정규 페이로드)이 긴밀히 맞물려 SendMessage 교차 검증이 품질을 좌우하므로 에이전트 팀으로 운영한다.

## 에이전트 구성

| 팀원 | 타입 | 역할 | 스킬 | 주요 출력 |
|------|------|------|------|----------|
| extension-architect | extension-architect | MV3 골격·매니페스트·메시지규약·UI셸 | chrome-extension-mv3 | manifest.json, src/shared, src/background, popup, `_workspace/01_*` |
| scraper-engineer | scraper-engineer | 증권사 content script 어댑터 | brokerage-scraper | src/content/{broker}, `_workspace/02_*` |
| normalizer-engineer | normalizer-engineer | raw→정규 IngestPayload 변환 | canonical-normalizer | src/normalize, `_workspace/03_*` |
| integration-engineer | integration-engineer | SRHFinance 세션 업로드 | srhfinance-upload | src/upload, `_workspace/04_*` |
| qa-verifier | general-purpose | 경계면 정합성 검증 | integration-qa | `_workspace/05_qa_report.md`, `_workspace/qa/` |

모든 팀원은 `model: "opus"`. 작업 디렉토리: `D:/Github/SRHSaaS/PAMExtensions`.

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 지원)

1. `_workspace/` 존재 여부 확인.
2. 모드 결정:
   - **미존재** → 초기 빌드. Phase 1.
   - **존재 + 부분 수정 요청**(예: "스크래퍼만 다시", "미래에셋 셀렉터 고쳐", "계약 동기화") → 부분 재실행. 해당 팀원만 스폰하고 관련 산출물만 갱신. 의존 팀원(예: raw shape 변경 시 normalizer·qa)도 함께 깨운다.
   - **존재 + 새 증권사/새 입력** → 확장 실행. 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 Phase 1.

### Phase 1: 준비
1. 사용자 요청에서 범위 파악 — 신규 빌드 / 증권사 추가 / 특정 모듈 수정 / 계약 동기화 중 무엇인가.
2. `_workspace/` 생성(초기). 대상 증권사·SRHFinance origin(dev/배포)을 `_workspace/00_input/context.md`에 기록.
3. SRHFinance 계약 원본 경로를 팀에 전달: `lib/ingest.ts`, `app/api/ingest/portfolio/route.ts`, `lib/apiAuth.ts`. 참조 스크래퍼: `WebPriceTracker/miraeasset/`.

### Phase 2: 팀 구성

```
TeamCreate(
  team_name: "pam-team",
  members: [
    { name:"extension-architect",  agent_type:"extension-architect",  model:"opus", prompt:"chrome-extension-mv3 스킬로 MV3 골격·매니페스트·src/shared/messages·서비스워커·popup/options 셸을 만들고 메시지 스키마를 확정해 전원에 통지. 최소권한·쿠키자동유지금지 준수." },
    { name:"scraper-engineer",     agent_type:"scraper-engineer",     model:"opus", prompt:"brokerage-scraper 스킬로 src/content/{대상증권사} 어댑터를 작성. WebPriceTracker/miraeasset/scraper.js 로직 이식. raw shape 확정 후 normalizer에 통지. raw까지만(정규화 금지)." },
    { name:"normalizer-engineer",  agent_type:"normalizer-engineer",  model:"opus", prompt:"canonical-normalizer 스킬로 raw→정규 IngestPayload 변환기를 작성. lib/ingest.ts 계약과 정확히 일치. user_id/seq/resolved_name 미포함·holdings 미합산. 샘플 페이로드 생성." },
    { name:"integration-engineer", agent_type:"integration-engineer", model:"opus", prompt:"srhfinance-upload 스킬로 세션 쿠키 기반 POST /api/ingest/portfolio 클라이언트를 작성. 401/403/400/500 매핑, 멱등 재시도, manifest. service_role/토큰 금지." },
    { name:"qa-verifier",          agent_type:"general-purpose",      model:"opus", prompt:"integration-qa 스킬로 각 모듈 완성 직후 경계면 정합성을 교차 검증. 정규 페이로드↔lib/ingest.ts, 금지필드, 메시지 스키마 단일성. 직접 수정 말고 담당자에 통지." }
  ]
)
```

작업 등록(의존성 명시):
```
TaskCreate(tasks: [
  { title:"MV3 골격+메시지규약 확정", assignee:"extension-architect" },
  { title:"{증권사} content script 어댑터", assignee:"scraper-engineer", depends_on:["MV3 골격+메시지규약 확정"] },
  { title:"raw→정규 변환기", assignee:"normalizer-engineer", depends_on:["{증권사} content script 어댑터"] },
  { title:"정규화 정합성 검증", assignee:"qa-verifier", depends_on:["raw→정규 변환기"] },
  { title:"세션 업로드 클라이언트", assignee:"integration-engineer", depends_on:["raw→정규 변환기"] },
  { title:"업로드 응답/에러 매핑 검증", assignee:"qa-verifier", depends_on:["세션 업로드 클라이언트"] },
  { title:"배선(background 파이프라인)+popup 흐름", assignee:"extension-architect", depends_on:["raw→정규 변환기","세션 업로드 클라이언트"] }
])
```

### Phase 3: 빌드 (팀원 자체 조율)

팀원들이 공유 작업 목록에서 작업을 claim하고 수행한다. 통신 규칙:
- architect가 메시지 스키마/디렉토리 계약을 **가장 먼저** 확정해 전원에 SendMessage(다른 작업의 선행 조건).
- scraper가 raw shape 확정 시 normalizer·qa에 통지. normalizer가 정규 페이로드 확정 시 integration·qa에 통지.
- 각 모듈 완료 시 qa-verifier에게 "검증 요청" SendMessage → **점진적 QA**.
- qa가 불일치 발견 시 담당자에게 위치·기대·실제값을 통지(직접 수정 금지).

리더(오케스트레이터) 모니터링: 팀원 유휴 알림 수신, TaskGet으로 진행률 확인, 막힌 팀원에 개입.

### Phase 4: 통합 검증
1. 모든 작업 완료 대기(TaskGet).
2. qa-verifier의 `_workspace/05_qa_report.md` 수집 — 잔존 불일치가 있으면 담당자 재호출로 해소(최대 2회).
3. architect가 background 파이프라인으로 스크랩→정규화→업로드 배선을 완료했는지 확인.
4. 빌드 산출물 점검: `manifest.json` 로드 가능 여부, 메시지 스키마 단일성, 금지필드 부재.

### Phase 5: 정리
1. 팀원 종료(SendMessage) 후 팀 정리.
2. `_workspace/` 보존(감사 추적).
3. 사용자에게 요약 보고: 생성/수정 파일, 잔존 이슈, 다음 단계(확장 로드·실증권사 스모크 테스트 안내).

## 데이터 흐름

```
[architect] 메시지규약 ──SendMessage──→ 전원
     │
[scraper] raw ──→ _workspace/02 ──SendMessage──→ [normalizer]
                                          │
                          정규 페이로드 ──→ _workspace/03
                                  ├──SendMessage──→ [integration] → POST /api/ingest/portfolio
                                  └──SendMessage──→ [qa] ↔ lib/ingest.ts 교차검증 → 05_qa_report
                                          │
                          [architect] background 배선 → popup 표시
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 팀원 1명 실패/중지 | 리더 감지 → 상태 확인 → 재시작 또는 작업 재할당 |
| qa 불일치 반복(2회 초과) | 사용자에게 계약 모호성 보고, lib/ingest.ts 변경 필요 여부 확인 |
| raw shape 변경 파급 | scraper 변경 시 normalizer·qa 자동 재검증(의존 작업 재오픈) |
| 400 업로드 거부 | integration→normalizer 통지, qa가 계약 대조로 원인 격리 |
| lib/ingest.ts 외부 변경 감지 | normalizer가 ingest-contract.md·변환기 동기화, qa 재검증 |
| 타임아웃 | 부분 결과 보존, 미완 영역 보고서에 명시 |

상충 데이터는 삭제하지 않고 출처 병기. 업로드는 멱등이라 재시도 안전.

## 테스트 시나리오

### 정상 흐름 (초기 빌드)
1. 사용자가 "PAMExtensions 확장 빌드" 요청.
2. Phase 1에서 대상=미래에셋, origin=localhost 파악.
3. Phase 2에서 5명 팀 + 7개 작업 구성.
4. architect가 골격·메시지규약 확정 → scraper 어댑터 → normalizer 변환기 → (qa 검증) → integration 업로드 → (qa 검증) → architect 배선.
5. Phase 4에서 qa 리포트 클린, manifest 로드 가능 확인.
6. 결과: 로드 가능한 MV3 확장(미래에셋 스크랩→정규화→세션 업로드).

### 에러 흐름 (계약 불일치)
1. normalizer가 daily_holdings를 미리 합산해 페이로드 생성.
2. qa-verifier가 "클라이언트 미리합산(금지)" 불일치를 심각도 최상으로 05_qa_report에 기록, normalizer에 통지.
3. normalizer가 합산 제거 후 샘플 재생성, qa 재검증 통과.
4. 최종 보고서에 수정 이력 명시.
