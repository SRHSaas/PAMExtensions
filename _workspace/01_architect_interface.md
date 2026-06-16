# 01 · 인터페이스 계약 (Extension Architect)

> PAMExtensions MV3 골격의 **인터페이스 계약**. scraper / normalizer / integration 전원의 기준 문서.
> 메시지 스키마·payload·모듈 경계·export 시그니처가 여기서 단일 정의된다.
> 작성: extension-architect · 2026-06-16 · 외부 계약 동기화 대상: `SRHFinance/lib/ingest.ts`

---

## 1. 파이프라인 흐름

```
popup ──SCRAPE_REQUEST──▶ background ──tabs.sendMessage──▶ content(미래에셋 탭)
content ──SCRAPE_RESULT(raw)──▶ background        (SCRAPE_REQUEST의 응답으로 반환)
background ──normalize(raw)──▶ IngestPayload      (src/normalize/index.js)
background ──uploadPayload(payload, origin)──▶ SRHFinance  (src/upload/client.js)
background ──STATUS──▶ popup                       (진행 단계 브로드캐스트)
background ──UPLOAD_RESULT──▶ popup                ({ ok, counts, status, error })
```

서비스워커는 **무상태**다. 진행상태(`PipelineState`)는 `chrome.storage.local["pam:pipelineState"]`에 저장한다.
업로드는 **사용자 세션 쿠키**(`fetch(origin, { credentials: "include" })`)로만 한다. keepalive/세션위조/service_role 금지.

---

## 2. 메시지 타입 (단일 정의: `src/shared/messages.js`)

| 상수 `MSG.*` | 방향 | payload typedef | 비고 |
|---|---|---|---|
| `SCRAPE_REQUEST` | popup → background → content | `ScrapeRequestPayload` | content는 응답으로 `SCRAPE_RESULT`를 반환 |
| `SCRAPE_RESULT` | content → background | `ScrapeResultPayload` | **raw(소스 고유) 형태** — 정규화 안 함 |
| `UPLOAD_REQUEST` | background → upload(내부 호출) | `UploadRequestPayload` | 논리적 경계. 실제로는 `uploadPayload()` 직접 호출 |
| `UPLOAD_RESULT` | background → popup | `UploadResultPayload` | 서버 응답 그대로 전달 |
| `STATUS` | background → popup | `StatusPayload` | 단계 알림 + storage 저장 |

보조 enum(같은 파일):
`STAGE`(idle/scraping/normalizing/uploading/done/error), `SCRAPE_TARGET`(dailyAsset/transaction), `SOURCE`(miraeasset), `STORAGE_KEY`.

### 2.1 payload 필드 표

**`ScrapeRequestPayload`** (popup→background→content)

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `source` | string | ✓ | `SOURCE.*` (예: `"miraeasset"`) |
| `targets` | string[] | ✓ | `SCRAPE_TARGET.*` 배열. background가 target별로 1건씩 content에 보냄 |
| `tabId` | number | – | 대상 탭. 없으면 background가 활성 탭으로 채움 |
| `range.startDate` / `range.endDate` | string | – | `"YYYY-MM-DD"`. content 어댑터가 해석 |

**`ScrapeResultPayload`** (content→background) — **raw, 파싱 전**

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `source` | string | ✓ | 요청과 동일 |
| `target` | string | ✓ | 이 raw가 어느 종류인지(`SCRAPE_TARGET.*`) |
| `ok` | boolean | ✓ | 스크랩 성공 여부 |
| `raw` | object \| object[] | ok=true 시 | raw 데이터(아래 §3 형태). 다중 날짜/계좌면 배열 |
| `error` | string | ok=false 시 | 사람이 읽을 오류 |

**`UploadRequestPayload`** (background→upload)

| 필드 | 타입 | 설명 |
|---|---|---|
| `origin` | string | options에서 설정한 SRHFinance origin |
| `payload` | `IngestPayload` | normalize 산출(아래 §4, lib/ingest.ts와 동일) |

**`UploadResultPayload`** (background→popup)

| 필드 | 타입 | 설명 |
|---|---|---|
| `ok` | boolean | HTTP 2xx + 응답 `ok:true` |
| `counts` | object | `{ accounts, daily_assets, daily_holdings, transactions, dividends }` (서버 `IngestCounts`) |
| `status` | number | HTTP 상태코드(401/403/400/500 등) |
| `error` | string | 실패 시 사람이 읽을 오류 |

**`StatusPayload`** (background→popup)

| 필드 | 타입 | 설명 |
|---|---|---|
| `stage` | string | `STAGE.*` |
| `message` | string | 선택 보조 메시지 |
| `target` | string | 선택. 진행 중인 `SCRAPE_TARGET.*` |

---

## 3. raw 형태 (content 스크래퍼 → SCRAPE_RESULT.raw)

> 권위 출처: 참조 구현 `WebPriceTracker/miraeasset/`의 output 형태.
> **camelCase**(raw, 미래에셋 어댑터 고유). 정규화(snake_case 변환)는 normalize가 한다.

**`target = "dailyAsset"`** 의 `raw`:
```js
{
  date: "2026.06.16",                      // 또는 "YYYY-MM-DD" (normalize가 정리)
  accounts: [{
    accountNo, accountType, alias,
    totalAsset, evalAmount, profitLoss, profitRate
  }],
  holdings: [{
    name, category,
    quantity, buyAmount, evalAmount, profitLoss, profitRate
  }]
}
```

**`target = "transaction"`** 의 `raw`:
```js
{
  acno, account,                           // 계좌번호(하이픈 가능), 계좌 별칭
  transactions: [{
    date, type, name,
    quantity, amount, foreignAmount, fee, balance,
    unitPrice, brokerQuantity, exchangeRate, currency, detail
  }]
}
```

> 금액은 문자열("1,234.56 USD" 등)일 수 있다 — **문자열→숫자 파싱은 normalize 책임**.
> 배당(`type`이 `배당|분배금`)은 raw에서 분리하지 않는다 — normalize가 `dividends`로 추출.

---

## 4. 정규 페이로드 `IngestPayload` (normalize 산출 = upload 입력)

> **권위 원본: `SRHFinance/lib/ingest.ts` (수정 금지, 일치 대상).** `schema_version = 1`.
> 클라이언트는 `user_id` / `seq` / `resolved_name`을 **넣지 않는다**. `daily_holdings`를 (date,name)으로 **미리 합산하지 않는다**(서버가 합산·부여).

```ts
IngestPayload {
  source?: string;            // "miraeasset"
  schema_version?: number;    // 1
  accounts?:       { account_no, account_type?, alias? }[]
  daily_assets?:   { date, account_no, total_asset?, eval_amount?, profit_loss?, profit_rate? }[]
  daily_holdings?: { date, name, category?, quantity?, buy_amount?, eval_amount?, profit_loss?, profit_rate? }[]
  transactions?:   { date, account_no, type, name?, quantity?, amount?, foreign_amount?, fee?,
                     balance?, unit_price?, broker_quantity?, exchange_rate?, currency?, detail? }[]
  dividends?:      { date, account_no, type, name?, amount?, foreign_amount?, fee? }[]
}
```
- 날짜: `"YYYY-MM-DD"`(서버도 `.`→`-` 정리하지만 어댑터가 맞추는 게 표준).
- account_no: 하이픈 제거 권장(서버도 제거).
- `transactions.name` / `dividends.name`: 없으면 `""`(NULL 금지 — unique 키 매칭).
- 응답 `counts`(`IngestCounts`): `{ accounts, daily_assets, daily_holdings, transactions, dividends }`.

---

## 5. 디렉토리 / 모듈 경계 (= 팀원 경계)

| 경로 | 담당 | 상태 |
|---|---|---|
| `manifest.json` | extension-architect | ✅ 생성 |
| `src/shared/messages.js` | extension-architect | ✅ 단일 정의(전원 import) |
| `src/background/service-worker.js` | extension-architect | ✅ 라우터+오케스트레이션 스캐폴드(placeholder 포함) |
| `src/popup/{popup.html, popup.js}` | extension-architect | ✅ 상태머신 UI 셸 |
| `src/options/{options.html, options.js}` | extension-architect | ✅ origin 설정 |
| `src/content/miraeasset/index.js` | **scraper-engineer** | ⬜ DOM 스크랩 → SCRAPE_RESULT(raw) |
| `src/normalize/index.js` | **normalizer-engineer** | ⬜ raw → IngestPayload |
| `src/upload/client.js` | **integration-engineer** | ⬜ 세션 쿠키 업로드 |

신규 증권사 추가 = `host_permissions` + `content_scripts` 항목 + `src/content/{broker}/` 추가 + `SOURCE`/`BROKER_HOSTS` 상수 추가. **매니페스트가 확장 지점**이다.

---

## 6. 각 팀원이 채울 export 시그니처 (계약)

### scraper-engineer → `src/content/miraeasset/index.js`
content script는 manifest로 자동 주입된다(document_idle). `chrome.runtime.onMessage`로 `SCRAPE_REQUEST`를 받아 **`SCRAPE_RESULT` payload를 응답(sendResponse 또는 return Promise)으로 반환**한다.

```js
import { MSG, SCRAPE_TARGET } from "../../shared/messages.js";

// 메시지 핸들러(필수): SCRAPE_REQUEST → ScrapeResultPayload 반환.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG.SCRAPE_REQUEST) return false;
  handleScrape(message.payload).then(sendResponse);
  return true; // 비동기 응답.
});

// target별 raw 추출 함수(권장 분해 — 내부 구현 자유):
/** @returns {Promise<object>} §3 dailyAsset raw */
export async function scrapeDailyAsset(range) { /* DOM 추출 */ }
/** @returns {Promise<object>} §3 transaction raw */
export async function scrapeTransaction(range) { /* DOM 추출 */ }
```
- 반드시 **raw(camelCase, 파싱 전)** 로 반환. 정규화/숫자파싱 금지(normalize 담당).
- 이미 로그인된 탭에서만 동작. 로그인 시도/쿠키 조작 금지.

### normalizer-engineer → `src/normalize/index.js`
```js
import { SOURCE } from "../shared/messages.js";

/**
 * §3 dailyAsset raw → IngestPayload(accounts/daily_assets/daily_holdings).
 * @param {object} raw  { date, accounts[], holdings[] }
 * @param {string} source  SOURCE.*
 * @returns {import("../shared/messages.js").UploadRequestPayload["payload"]}
 */
export function buildDailyAssetPayload(raw, source) {}

/**
 * §3 transaction raw → IngestPayload(accounts/transactions/dividends).
 * 배당(type ~ 배당|분배금)을 dividends로 분리. seq/resolved_name/user_id 부여 금지.
 * @param {object} raw  { acno, account, transactions[] }
 * @param {string} source  SOURCE.*
 */
export function buildTransactionPayload(raw, source) {}

/** 여러 IngestPayload를 배열 concat으로 병합(daily_holdings 미리합산 금지). */
export function mergePayloads(payloads) {}
```
일치 대상: `SRHFinance/lib/ingest.ts`. 참조 구현: `WebPriceTracker/miraeasset/canonical.js`의 동명 함수(거기엔 source 인자가 없으나 본 계약은 다증권사 대비 `source`를 인자로 받는다).

### integration-engineer → `src/upload/client.js`
```js
/**
 * 정규 페이로드를 사용자 세션 쿠키로 SRHFinance에 업로드.
 *   POST {origin}/api/ingest/portfolio  (credentials:"include", JSON body=payload)
 * 401/403/400/500을 분기해 사람이 읽을 메시지로 변환.
 * @param {import("../shared/messages.js").UploadRequestPayload["payload"]} payload
 * @param {string} origin
 * @returns {Promise<import("../shared/messages.js").UploadResultPayload>}
 *          { ok, counts?, status?, error? }
 */
export async function uploadPayload(payload, origin) {}
```
- 토큰/service_role 금지. 오직 세션 쿠키. host_permissions에 origin이 있어야 쿠키 전송됨.
- 401=로그인 필요, 403=미승인, 400=페이로드 오류, 500=서버 적재 실패(서버 `{error}` 메시지 활용).

---

## 7. background placeholder 교체 지점

`src/background/service-worker.js`에 다음 TODO가 있다(모듈 생기면 교체):
- `normalizePlaceholder(...)` → `buildDailyAssetPayload`/`buildTransactionPayload`/`mergePayloads`
- `uploadPlaceholder(...)` → `uploadPayload(payload, origin)`
- 상단 주석 처리된 `import` 두 줄을 활성화.

배선(SCRAPE_REQUEST 수신 → content 호출 → STATUS/UPLOAD_RESULT)은 이미 동작하므로, 각 모듈은 **자기 함수만** 채우면 파이프라인이 연결된다.

---

## 8. 체크리스트 (architect 산출 검증)

- [x] host_permissions가 대상 origin으로 한정(`<all_urls>` 없음)
- [x] 메시지 스키마가 `src/shared/messages.js` 단일 정의
- [x] keepalive/쿠키자동유지/세션위조 코드 없음
- [x] 서비스워커 상태가 chrome.storage.local에 저장
- [x] SRHFinance origin이 options(chrome.storage.sync)에서 설정 가능
- [x] 클라이언트가 user_id/seq/resolved_name 부여하지 않음(빈 골격만)
