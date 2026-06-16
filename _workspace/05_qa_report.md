# 05 · 통합 정합성 QA 리포트

> 작성: qa-verifier · 2026-06-16 · 방식: 경계면 교차 비교(생산자↔소비자 동시 대조) + 실검증 스크립트
> 재현 스크립트: `_workspace/qa/check-payload.mjs`, `_workspace/qa/check-upload-mapping.mjs`
> 검증 대상 커밋 시점: normalizer·scraper·upload·메시지스키마 모듈 모두 존재(아래 §5 상태표 참조)

---

## 0. 요약 (TL;DR)

| 검증 영역 | 결과 | 비고 |
|---|---|---|
| 1. 정규 페이로드 ↔ `lib/ingest.ts` 계약 | **PASS** | 정적 샘플 + 실 normalizer 산출 **239건 검사 전부 통과** |
| 1a. 금지필드(user_id/seq/resolved_name) | **PASS** | 모든 배열·모든 행에서 부재 확인 |
| 1b. daily_holdings 미리합산 금지 | **PASS** | 동일 (date,name) 2행 입력 → 2행 보존(미합산) 능동 검증 |
| 1c. schema_version / name="" / 배당분리 / 타입·포맷 | **PASS** | schema=1, name은 null 아닌 "", 배당 1:1 분리, 금액 number, 날짜 ISO, 계좌 하이픈제거 |
| 2. 메시지 스키마 단일성 | **PASS (경미 1건)** | 모든 MSG.* 상수 사용. popup의 storage 키 1곳만 리터럴(W-1) |
| 3. raw → canonical 일관성 | **PASS** | foreignAmount→foreign_amount, brokerQuantity→broker_quantity 등 매핑·부호보존 정상 |
| 4. 업로드 응답 매핑 ↔ 서버 응답코드 | **PASS** | 200/400/401/403/500 전부 정합. 세션쿠키 전용·토큰 미사용 |
| 5. 파이프라인 배선(background) | **불일치 1건(I-1)** | 모듈은 완성됐으나 background가 아직 placeholder 호출(실 import 주석 처리) |

**데이터 오염위험(P1) 없음. 검증거부(P2) 없음.** 잔존 항목은 배선 미완(I-1, 기능성)과 코드 위생(W-1, 경미)뿐.

---

## 1. [PASS] 정규 페이로드 ↔ lib/ingest.ts 계약 (최우선)

`SRHFinance/lib/ingest.ts`(`Ingest*` 인터페이스·`validateIngest`·`buildXxxRows`),
`canonical-normalizer/references/ingest-contract.md`(스냅샷), `03_normalizer_payload_samples/*.json`,
`src/normalize/index.js`를 동시에 펼쳐 한 줄씩 대조했다.

**실검증 방법**: `check-payload.mjs`가 (A) 정적 샘플 2종과 (B) `02_scraper_rawshape.md` §7 raw를
**실제 `src/normalize/index.js`에 통과**시킨 산출(dailyAsset/transaction/merged)을 `validateIngest`
동치 로직 + 금지필드/타입/포맷 assertion으로 검사. **총 239건 검사, 불일치 0건.**

- 필드명·타입: `IngestAccount/DailyAsset/DailyHolding/Transaction/Dividend` 5개 인터페이스의 모든
  필드가 샘플·normalizer 산출과 일치. snake_case 변환 정확.
- `validateIngest`: 모든 페이로드가 `ok:true`. (객체·배열·schema_version·비어있지않음 규칙 통과)
- ingest-contract.md 스냅샷이 라이브 `ingest.ts`와 일치(드리프트 없음).

### 1a. [PASS] 금지필드 검사 (오염위험 최상위)
- `user_id` / `seq` : 5개 배열 모든 행에서 **부재**.
- `resolved_name` : 거래 행에서도 **부재**(어댑터가 부여 안 함 — 서버 보강 위임). 계약상 거래의
  resolved_name은 선택적 허용이나 normalizer는 기본 비움 기대를 정확히 지킴.
- 출처: `src/normalize/index.js`가 어느 빌더에서도 이 세 필드를 쓰지 않음(grep 확인) + 산출 검사.

### 1b. [PASS] daily_holdings 미리합산 금지 (오염위험)
- 능동 검증: 같은 `(2026-06-16, 삼성전자)` 보유를 **두 계좌(두 raw 원소)** 에 흩어 입력 →
  `buildDailyAssetPayload`(+`mergePayloads`) 산출이 **2행 보존**(quantity 100·50 각각 유지, 가산 안 함).
- `mergePayloads`는 단순 concat이며 (date,name) 합산 로직 없음 확인(라인 212-236). 서버
  `buildDailyHoldingRows`(ingest.ts 168-214)만 합산. 경계 역할 정확.

### 1c. [PASS] 기타 계약
- `schema_version === 1` : 모든 페이로드. (`SCHEMA_VERSION=1` 상수, 샘플 1)
- 거래/배당 `name` : null 아닌 `""`(빈 종목명). `tx.name == null ? "" : trim` 로직 확인.
- 배당 분리 : `/배당|분배금/`(`DIVIDEND_TYPE_RE`)로 transactions의 배당 1건 ↔ dividends 1건 **1:1**.
- 금액 number, 날짜 `YYYY-MM-DD`, 계좌번호 하이픈 제거 — 전부 통과.

---

## 2. [PASS, 경미] 메시지 스키마 단일성

`src/shared/messages.js`(단일 정의) ↔ content/background/popup/options 실제 사용처 대조.

- `MSG.*`, `STAGE.*`, `SCRAPE_TARGET.*`, `SOURCE.*` 상수를 **모든 모듈이 import해서 사용**.
  메시지 타입 문자열 리터럴 직접 사용처 **없음**(grep: 리터럴은 messages.js 정의부에만 존재).
- 송신 payload 필드 ⊇ 수신 사용 필드 정합:
  - popup `SCRAPE_REQUEST{source,targets,tabId}` → background `runPipeline` 사용 필드 일치.
  - content `SCRAPE_RESULT{source,target,ok,raw,error}` → background `requestScrape` 처리 일치.
  - background `STATUS{stage,message,target}` / `UPLOAD_RESULT{ok,counts,status,error}` → popup
    `renderStatus`/`renderResult` 사용 일치(counts 키도 `COUNT_LABEL`과 정합).

### W-1 [경미/위생, 담당: extension-architect]
- **위치**: `src/popup/popup.js:175-176`
- **기대**: storage 키를 `STORAGE_KEY.PIPELINE_STATE` 상수로 참조(단일 정의 import).
- **실제**: 리터럴 `"pam:pipelineState"` 두 번 하드코딩(`chrome.storage.local.get`).
- **심각도**: 낮음(P3/위생). 값은 `STORAGE_KEY.PIPELINE_STATE`와 동일해 **현재 런타임 버그 아님**.
  단, 키 변경 시 popup만 누락될 드리프트 위험. background는 상수를 쓰므로 popup도 상수로 통일 권장.
- (참고: `client.js`의 `pam:uploadManifest`는 upload 내부 전용 키라 단일정의 대상 아님 — 정상.)

---

## 3. [PASS] raw → canonical 일관성

`02_scraper_rawshape.md`의 raw 필드 ↔ normalizer 출력 대조(유실/오매핑 검사).

- camelCase→snake_case 매핑 정상: `foreignAmount→foreign_amount`(72.34),
  `brokerQuantity→broker_quantity`(500000), `exchangeRate→exchange_rate`(1361.5),
  `unitPrice→unit_price`(144.68), `buyAmount→buy_amount`, `totalAsset→total_asset`,
  `evalAmount→eval_amount`, `profitLoss→profit_loss`, `profitRate→profit_rate`,
  `accountNo→account_no`, `accountType→account_type`, `acno→account_no`(거래).
- 손익 부호 보존: §4-1 `-`접두(`-540,000`) → `-540000` 그대로(중복부호·재보정 없음).
- `detail` 객체 패스스루(소수거래 진단값 묶음) 정상.
- 단가 보강 로직: `unitPrice` 우선, 없으면 `(foreign_amount||amount)/quantity`, 0이면 null — 계약 일치.
- 빈 계좌번호/빈 종목명 행 스킵(서버와 동일), `_skipped`/`kind` raw 부가필드는 자연 무시(산출에 미포함).
- **유실·오매핑 발견 없음.**

---

## 4. [PASS] 업로드 응답 처리 ↔ 서버 응답코드 — **검증 완료(보류 아님)**

> 주: 최초 브리핑 시점엔 `src/upload/client.js` 부재로 "보류" 예정이었으나, 검증 중 파일이
> 존재함을 확인하여 이번 패스에서 교차 검증을 수행했다.

경계: `src/upload/client.js`(소비자) ↔ `SRHFinance/app/api/ingest/portfolio/route.ts` +
`lib/apiAuth.ts`(생산자). `check-upload-mapping.mjs`로 정적 교차 검증 — **12건 검사, 불일치 0건.**

| HTTP | 서버 출처 | 클라이언트 처리 | 재시도 |
|---|---|---|---|
| 200 | route 성공 `{ok,source,counts}` | `res.ok` → `{ok:true,counts}` (counts 파싱) | – |
| 400 | route `JSON 파싱 실패`·`validateIngest` 실패 | `status===400` → `contractMismatch:true`, normalizer 통지 신호 | 안 함 ✓ |
| 401 | apiAuth `미로그인` | `status===401` → MSG_401 | 안 함 ✓ |
| 403 | apiAuth `미승인` | `status===403` → MSG_403 | 안 함 ✓ |
| 500 | route `fail()` 적재실패 | `status>=500` → transient, 1회 재시도 | 함 ✓ |

- **보안 불변식 PASS**: `credentials:"include"`(세션 쿠키 전용), 코드에 `Authorization`/`Bearer`/
  `service_role` 헤더·토큰 **없음**(주석의 "토큰 금지" 언급만 존재).
- 멱등 재시도 정책 정합: 4xx 무재시도, 5xx/네트워크만 1회 재시도(서버 복합키 upsert가 멱등 보장).
- 성공 응답 `counts` 키가 서버 `IngestCounts`(`{accounts,daily_assets,daily_holdings,transactions,dividends}`)
  와 일치 → popup `COUNT_LABEL`까지 정합.

---

## 5. [불일치 I-1] 파이프라인 배선 미완 (기능성)

- **위치**: `src/background/service-worker.js:40-41`(주석 처리된 import), `:161`(`normalizePlaceholder`
  호출), `:168`(`uploadPlaceholder` 호출), `:186-214`(placeholder 정의).
- **기대**(01_architect_interface §7): 모듈 완성 시 상단 import 2줄 활성화 +
  `normalizePlaceholder`→`buildDailyAssetPayload`/`buildTransactionPayload`/`mergePayloads`,
  `uploadPlaceholder`→`uploadPayload(payload, origin)` 로 교체.
- **실제**: `src/normalize/index.js`·`src/upload/client.js`는 **완성·계약 일치**하지만 background는
  여전히 placeholder를 호출 → 실제 파이프라인은 **빈 페이로드 + "업로드 모듈 미구현" 결과**를 반환.
- **심각도**: 중(P2급, **기능성**). 데이터 오염은 아니나 end-to-end가 아직 동작하지 않음.
  (placeholder는 안전하게 빈 결과를 내므로 오염·잘못된 업로드 위험은 없음.)
- **담당자**: extension-architect(배선 소유) 또는 integration-engineer(§7 교체 지점). 두 모듈
  export 시그니처가 background의 TODO 주석과 정확히 일치하므로 주석 해제 + 호출 치환만 하면 됨.

---

## 6. 발견 항목 종합 (심각도순)

| ID | 심각도 | 영역 | 위치 | 담당자 | 상태 |
|---|---|---|---|---|---|
| — | P1 데이터오염 | (해당 없음) | — | — | **없음** |
| — | P2 검증거부 | (해당 없음) | — | — | **없음** |
| I-1 | P2 기능성(배선) | background:40-41,161,168 | extension-architect / integration-engineer | OPEN |
| W-1 | P3 위생 | popup.js:175-176 | extension-architect | OPEN |

심각도 우선순위(데이터 오염위험 > 검증거부 > 누락/오매핑) 기준, **오염·거부급 0건**. 잔존은
배선 미완(I-1)과 상수 미사용(W-1)뿐 — 둘 다 데이터 정합성에는 영향 없음.

---

## 7. 다음 패스 트리거

- I-1 배선 교체 후 → background 통합 경로 재검증(placeholder 제거 확인).
- 실 서버 기동 가능 시 → `check-upload-mapping.mjs`를 실 fetch 통합 테스트로 승격(401/403/400/500
  실제 응답 확인). 현재는 정적 코드경로 정합까지만.
- scraper raw가 실제 DOM에서 갱신되면 → §3 raw→canonical을 실 raw 샘플로 재대조.
