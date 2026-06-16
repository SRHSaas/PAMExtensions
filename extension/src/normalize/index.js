/**
 * raw(미래에셋 어댑터 고유, camelCase, 파싱 전) → SRHFinance 정규(canonical) `IngestPayload`.
 *
 * 권위 계약: `SRHFinance/lib/ingest.ts`(`Ingest*` 인터페이스) + 스냅샷
 *   `.claude/skills/canonical-normalizer/references/ingest-contract.md`.
 * 입력 계약: `_workspace/02_scraper_rawshape.md`(raw shape, 약한 파싱, 계약 차이).
 * 참조 구현: `WebPriceTracker/miraeasset/canonical.js`(동명 함수의 변환 규칙 이식).
 *
 * 역할 경계(위반 시 데이터 오염 — 서버 권위):
 *   - `user_id` / `seq` / `resolved_name` 부여 금지. resolved_name은 비운다(서버가 보유명 풀로 보강).
 *   - `daily_holdings`를 (date,name)으로 미리 합산하지 않는다 — 행 단위로 그대로 보낸다(서버가 합산·수익률 재계산).
 *   - `schema_version === 1`. 거래/배당 `name`은 null 대신 `""`(서버 unique 키 매칭).
 *
 * 입력 raw는 **항상 배열**이다(02 §5: dailyAsset=날짜 배열, transaction=계좌 배열).
 * build 함수는 배열을 순회해 행을 누적한다. 실패 원소(`_skipped`)·빈 배열은 자연히 무시된다.
 */

import { SOURCE } from "../shared/messages.js";

/** 권위: ingest-contract.md / lib/ingest.ts 의 INGEST_SCHEMA_VERSION. */
const SCHEMA_VERSION = 1;
/** 배당 판정 키 — 거래 type 텍스트가 이 패턴이면 dividends로도 분리(02 §6). */
const DIVIDEND_TYPE_RE = /배당|분배금/;

// ───────────────────────────────────────────────────────────────────────────
// 헬퍼 — 소스별 파싱(클라이언트 몫). 02 §0/§4의 약한 파싱 산출은 그대로 존중한다.
// ───────────────────────────────────────────────────────────────────────────

/** 계좌번호 하이픈 제거(`"123-4567-8901-2"` → `"12345678901"`). 02 §6. */
function stripHyphen(s) {
  return String(s == null ? "" : s).replace(/-/g, "");
}

/** 날짜 `"YYYY.MM.DD"` → `"YYYY-MM-DD"`. 이미 ISO면 그대로(02 §0). */
function toDate(dateStr) {
  return String(dateStr == null ? "" : dateStr).replace(/\./g, "-").trim();
}

/**
 * 금액 문자열 → 숫자. 콤마/통화기호/공백 등 숫자·부호·소수점 외 문자를 제거한다.
 * `"152,340,210"` → 152340210, `"-540,000"` → -540000, `"144.68"` → 144.68, `""` → 0.
 * 02 §4-1의 손익 부호(`-` 접두)는 보존된다 — 다시 건드리지 않는다.
 */
function num(str) {
  if (str == null || str === "") return 0;
  if (typeof str === "number") return Number.isFinite(str) ? str : 0;
  return Number(String(str).replace(/[^\d.-]/g, "")) || 0;
}

/** 빈/공백 문자열을 null로(서버는 null/`""` 모두 허용). category/profit_rate 등 선택 문자열용. */
function strOrNull(s) {
  const v = s == null ? "" : String(s).trim();
  return v === "" ? null : v;
}

/** raw 배열로 정규화. 단일 객체가 와도 배열로 감싸 방어한다(02 §5: 항상 배열 가정). */
function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  return raw == null ? [] : [raw];
}

// ───────────────────────────────────────────────────────────────────────────
// 빌더
// ───────────────────────────────────────────────────────────────────────────

/**
 * dailyAsset raw(배열) → IngestPayload(accounts/daily_assets/daily_holdings).
 *
 * raw 각 원소 = 한 영업일 `{ kind, date, accounts[], holdings[] }`(02 §2).
 * 실패 원소(`_skipped`)는 accounts/holdings가 비어 자연히 무시된다.
 * daily_holdings는 행 단위 그대로 — (date,name) 합산 금지(서버 몫).
 *
 * @param {object|object[]} raw  §2 dailyAsset raw(항상 배열, 방어적으로 단일도 허용)
 * @param {string} [source]      SOURCE.* (기본 miraeasset)
 * @returns {import("../shared/messages.js").UploadRequestPayload["payload"]}
 */
export function buildDailyAssetPayload(raw, source = SOURCE.MIRAEASSET) {
  const accounts = [];
  const daily_assets = [];
  const daily_holdings = [];

  for (const day of asArray(raw)) {
    if (!day || typeof day !== "object") continue;
    const date = toDate(day.date);

    for (const a of day.accounts || []) {
      const account_no = stripHyphen(a.accountNo);
      if (!account_no) continue; // 빈 계좌번호 행은 서버가 스킵 — 미리 거른다.
      const account_type = strOrNull(a.accountType);
      // 02 §5: 일자별 탭 alias는 항상 "". alias→account_type→null 순으로 보강(canonical.js 동치).
      accounts.push({
        account_no,
        account_type,
        alias: strOrNull(a.alias) || account_type || null,
      });
      daily_assets.push({
        date,
        account_no,
        total_asset: num(a.totalAsset),
        eval_amount: num(a.evalAmount),
        profit_loss: num(a.profitLoss), // 02 §4-1: `-` 부호 보정 결과를 그대로 신뢰.
        profit_rate: strOrNull(a.profitRate),
      });
    }

    for (const h of day.holdings || []) {
      const name = h.name == null ? "" : String(h.name).trim();
      if (!name) continue; // 빈 종목명 행은 스킵(서버도 스킵).
      daily_holdings.push({
        date,
        name,
        category: strOrNull(h.category),
        quantity: num(h.quantity),
        buy_amount: num(h.buyAmount),
        eval_amount: num(h.evalAmount),
        profit_loss: num(h.profitLoss), // 02 §4-1: 부호 보정 신뢰.
        profit_rate: strOrNull(h.profitRate),
      });
    }
  }

  return { source, schema_version: SCHEMA_VERSION, accounts, daily_assets, daily_holdings };
}

/**
 * transaction raw(배열) → IngestPayload(accounts/transactions/dividends).
 *
 * raw 각 원소 = 한 계좌의 기간 거래 `{ kind, acno, account, transactions[] }`(02 §3).
 * 배당(`type ~ /배당|분배금/`)은 transactions에도 두고 dividends로도 분리한다(02 §6).
 * seq/resolved_name/user_id 부여 금지 — 서버 권위.
 *
 * @param {object|object[]} raw  §3 transaction raw(항상 배열, 방어적으로 단일도 허용)
 * @param {string} [source]      SOURCE.*
 * @returns {import("../shared/messages.js").UploadRequestPayload["payload"]}
 */
export function buildTransactionPayload(raw, source = SOURCE.MIRAEASSET) {
  const accounts = [];
  const transactions = [];
  const dividends = [];

  for (const acct of asArray(raw)) {
    if (!acct || typeof acct !== "object") continue;
    const account_no = stripHyphen(acct.acno);
    if (!account_no) continue; // 실패/빈 계좌 원소 스킵.

    // 거래 계좌의 alias는 드롭다운 라벨(`account` = 번호+별칭)에서만 알 수 있다(02 §5).
    accounts.push({
      account_no,
      account_type: null,
      alias: strOrNull(acct.account),
    });

    for (const tx of acct.transactions || []) {
      if (!tx || !tx.date || !tx.type) continue; // 필수(date,type) 없는 행 스킵.
      const date = toDate(tx.date);
      const name = tx.name == null ? "" : String(tx.name).trim(); // null 금지 → "".
      // 02 §4-2: quantity는 소수거래 실수량으로 이미 환산됨 — 그대로 숫자화만 한다.
      const quantity = num(tx.quantity);
      const amount = num(tx.amount); // 원화(KRW).
      const foreign_amount = num(tx.foreignAmount); // 외화.

      // 거래단가: 상세값(unitPrice) 우선, 없으면 (외화우선)금액/수량. 0이면 null.
      let unit_price = num(tx.unitPrice);
      if (!unit_price && quantity > 0) {
        unit_price = (foreign_amount > 0 ? foreign_amount : amount) / quantity;
      }

      transactions.push({
        date,
        account_no,
        type: tx.type,
        name,
        quantity,
        amount,
        foreign_amount,
        fee: num(tx.fee),
        balance: num(tx.balance),
        unit_price: unit_price || null,
        // 02 §4-2: brokerQuantity는 어댑터가 보존한 화면 micro 표시값. 그대로 매핑.
        broker_quantity: tx.brokerQuantity ? num(tx.brokerQuantity) : null,
        exchange_rate: tx.exchangeRate ? num(tx.exchangeRate) : null,
        currency: strOrNull(tx.currency),
        detail: tx.detail || null, // 02 §4-4: 진단/정밀값 묶음 그대로 통과.
      });

      if (DIVIDEND_TYPE_RE.test(tx.type)) {
        dividends.push({
          date,
          account_no,
          type: tx.type,
          name,
          amount,
          foreign_amount,
          fee: num(tx.fee),
        });
      }
    }
  }

  return { source, schema_version: SCHEMA_VERSION, accounts, transactions, dividends };
}

/**
 * 여러 IngestPayload를 하나로 병합한다. 영역 배열을 단순 concat한다 —
 * daily_holdings를 (date,name)으로 미리 합산하지 않는다(서버 몫). 계좌 중복은 서버 upsert가 흡수.
 *
 * 빈/누락 배열은 무시되고, 비어 있지 않은 첫 payload의 source/schema_version을 채택한다.
 *
 * @param {Array<import("../shared/messages.js").UploadRequestPayload["payload"]>} payloads
 * @returns {import("../shared/messages.js").UploadRequestPayload["payload"]}
 */
export function mergePayloads(payloads) {
  const merged = {
    source: SOURCE.MIRAEASSET,
    schema_version: SCHEMA_VERSION,
    accounts: [],
    daily_assets: [],
    daily_holdings: [],
    transactions: [],
    dividends: [],
  };
  let sourceSet = false;

  for (const p of payloads || []) {
    if (!p || typeof p !== "object") continue;
    if (!sourceSet && p.source) {
      merged.source = p.source;
      sourceSet = true;
    }
    for (const key of ["accounts", "daily_assets", "daily_holdings", "transactions", "dividends"]) {
      if (Array.isArray(p[key]) && p[key].length) merged[key].push(...p[key]);
    }
  }

  return merged;
}
