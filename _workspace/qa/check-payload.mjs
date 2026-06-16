/**
 * QA 검증 스크립트 — 정규 페이로드 ↔ lib/ingest.ts 계약 교차 검증.
 *
 * 두 경로로 페이로드를 만들어 검증한다:
 *  (A) 정적 샘플: _workspace/03_normalizer_payload_samples/*.json
 *  (B) 동적: 02_scraper_rawshape.md §7 raw 샘플을 실제 normalizer(src/normalize/index.js)에 통과
 *
 * 검증 항목:
 *  1) validateIngest 동치 로직(ingest.ts 라인 99-134 재현) 통과 여부
 *  2) 금지필드 user_id/seq/resolved_name 부재(거래 resolved_name은 선택적 허용·기본 비움)
 *  3) daily_holdings 미리합산 안 됨((date,name) 중복 행 허용)
 *  4) schema_version===1, 거래/배당 name이 null 아닌 ""
 *  5) 배당이 /배당|분배금/ 으로 dividends에 분리
 *  6) 금액 number, 날짜 YYYY-MM-DD, 계좌 하이픈 제거
 *
 * 실행: node _workspace/qa/check-payload.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // PAMExtensions/
const SAMPLES = join(ROOT, "_workspace", "03_normalizer_payload_samples");

// ── 결과 누적 ────────────────────────────────────────────────────────────────
const findings = [];
let checks = 0;
function check(cond, location, expected, actual, severity = "P3") {
  checks++;
  if (!cond) findings.push({ location, expected, actual, severity });
  return cond;
}

const INGEST_SCHEMA_VERSION = 1;
const ARRAYS = ["accounts", "daily_assets", "daily_holdings", "transactions", "dividends"];
const FORBIDDEN = ["user_id", "seq", "resolved_name"];
const DIVIDEND_RE = /배당|분배금/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── ingest.ts validateIngest 동치 재현 (라인 99-134) ──────────────────────────
function validateIngest(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "JSON 객체가 아닙니다." };
  const p = payload;
  if (p.schema_version != null && p.schema_version !== INGEST_SCHEMA_VERSION)
    return { ok: false, error: `지원하지 않는 schema_version(${p.schema_version}).` };
  for (const key of ARRAYS) {
    const val = p[key];
    if (val != null && !Array.isArray(val)) return { ok: false, error: `${key}는 배열이어야 합니다.` };
  }
  const total = ARRAYS.reduce((n, k) => n + (p[k]?.length ?? 0), 0);
  if (total === 0) return { ok: false, error: "업로드할 데이터가 없습니다." };
  return { ok: true, payload: p };
}

// ── 페이로드 1건 정밀 검증 ────────────────────────────────────────────────────
function inspectPayload(label, p) {
  // 1) validateIngest
  const v = validateIngest(p);
  check(v.ok, `${label}: validateIngest`, "ok:true", v.ok ? "ok" : v.error, "P2");

  // 4) schema_version
  check(p.schema_version === 1, `${label}.schema_version`, "1", String(p.schema_version), "P2");

  // 2) 금지필드 — 모든 배열의 모든 행
  for (const arr of ARRAYS) {
    for (const [i, row] of (p[arr] ?? []).entries()) {
      for (const f of FORBIDDEN) {
        // 거래의 resolved_name은 선택적 허용(있으면 경고)이나 기본 비움 기대.
        if (arr === "transactions" && f === "resolved_name") {
          if (f in row)
            findings.push({
              location: `${label}.${arr}[${i}].resolved_name`,
              expected: "비움(서버 보강)",
              actual: `존재: ${JSON.stringify(row[f])}`,
              severity: "P2-soft",
            });
          continue;
        }
        check(!(f in row), `${label}.${arr}[${i}]`, `금지필드 ${f} 부재`, `${f} 존재`, "P1");
      }
    }
  }

  // 3) daily_holdings 미리합산 검사 — (date,name) 중복이 "허용"되는지 확인.
  // 합산되지 않았음을 직접 증명하긴 어렵지만, 정규화 로직이 합산하지 않음을 코드 경로로 확인하고
  // 여기선 행들이 개별 보존됐는지(중복 키가 단일로 뭉치지 않았는지)를 정보성으로 본다.
  const holdKeys = (p.daily_holdings ?? []).map((h) => `${h.date}|${h.name}`);
  const dupCount = holdKeys.length - new Set(holdKeys).size;
  // 정보성: 중복이 있으면 미리합산 안 한 명확한 증거. 없으면 (이 샘플엔 중복 종목이 없을 뿐) 통과.

  // 6) daily_holdings 필드 타입/포맷
  for (const [i, h] of (p.daily_holdings ?? []).entries()) {
    check(DATE_RE.test(h.date), `${label}.daily_holdings[${i}].date`, "YYYY-MM-DD", h.date, "P3");
    check(typeof h.name === "string" && h.name !== "", `${label}.daily_holdings[${i}].name`, "비지않은 string", JSON.stringify(h.name), "P2");
    for (const numf of ["quantity", "buy_amount", "eval_amount", "profit_loss"])
      if (numf in h) check(typeof h[numf] === "number", `${label}.daily_holdings[${i}].${numf}`, "number", typeof h[numf], "P3");
  }

  // 6) daily_assets 포맷
  for (const [i, a] of (p.daily_assets ?? []).entries()) {
    check(DATE_RE.test(a.date), `${label}.daily_assets[${i}].date`, "YYYY-MM-DD", a.date, "P3");
    check(!/-/.test(a.account_no), `${label}.daily_assets[${i}].account_no`, "하이픈 없음", a.account_no, "P3");
    for (const numf of ["total_asset", "eval_amount", "profit_loss"])
      if (numf in a) check(typeof a[numf] === "number", `${label}.daily_assets[${i}].${numf}`, "number", typeof a[numf], "P3");
  }

  // 6) accounts 하이픈
  for (const [i, a] of (p.accounts ?? []).entries())
    check(!/-/.test(a.account_no), `${label}.accounts[${i}].account_no`, "하이픈 없음", a.account_no, "P3");

  // 4) 거래 name == "" not null + 5) 배당 분리 + 6) 포맷
  for (const [i, t] of (p.transactions ?? []).entries()) {
    check(t.name !== null && t.name !== undefined, `${label}.transactions[${i}].name`, '"" (null 아님)', JSON.stringify(t.name), "P2");
    check(DATE_RE.test(t.date), `${label}.transactions[${i}].date`, "YYYY-MM-DD", t.date, "P3");
    check(!/-/.test(t.account_no), `${label}.transactions[${i}].account_no`, "하이픈 없음", t.account_no, "P3");
    for (const numf of ["quantity", "amount", "foreign_amount", "fee", "balance"])
      if (numf in t) check(typeof t[numf] === "number", `${label}.transactions[${i}].${numf}`, "number", typeof t[numf], "P3");
  }

  // 5) 배당 분리 정합성: transactions 중 /배당|분배금/ 인 행 수 == dividends 행 수(같은 페이로드 내)
  const divTx = (p.transactions ?? []).filter((t) => DIVIDEND_RE.test(t.type || ""));
  const divs = p.dividends ?? [];
  if (divTx.length > 0 || divs.length > 0) {
    check(divTx.length === divs.length, `${label}: 배당 분리 카운트`, `transactions의 배당 ${divTx.length}건 == dividends ${divTx.length}건`, `dividends ${divs.length}건`, "P3");
  }
  for (const [i, d] of divs.entries()) {
    check(DIVIDEND_RE.test(d.type || ""), `${label}.dividends[${i}].type`, "/배당|분배금/ 매칭", d.type, "P3");
    check(d.name !== null && d.name !== undefined, `${label}.dividends[${i}].name`, '"" (null 아님)', JSON.stringify(d.name), "P3");
    check(typeof d.amount === "number", `${label}.dividends[${i}].amount`, "number", typeof d.amount, "P3");
  }

  return { dupCount, divTx: divTx.length, divs: divs.length };
}

// ── (A) 정적 샘플 검증 ────────────────────────────────────────────────────────
console.log("=== (A) 정적 샘플 (_workspace/03_normalizer_payload_samples) ===");
for (const f of ["dailyAsset.sample.json", "transaction.sample.json"]) {
  const p = JSON.parse(readFileSync(join(SAMPLES, f), "utf8"));
  const r = inspectPayload(`sample:${f}`, p);
  console.log(`  ${f}: holdings중복=${r.dupCount}, 배당tx=${r.divTx}, dividends=${r.divs}`);
}

// ── (B) raw → normalizer → 검증 (실 정규화기 호출) ────────────────────────────
console.log("\n=== (B) raw → 실 normalizer(src/normalize/index.js) → 검증 ===");
// 02 §7 raw 샘플(스크래퍼 출력 형태). raw는 항상 배열.
const rawDailyAsset = [
  {
    kind: "dailyAsset",
    date: "2026.06.16",
    accounts: [
      { accountNo: "123-4567-8901-2", accountType: "위탁", alias: "", totalAsset: "152,340,210", evalAmount: "148,920,000", profitLoss: "12,450,300", profitRate: "9.12%" },
      { accountNo: "123-4567-8901-3", accountType: "연금저축", alias: "", totalAsset: "23,100,000", evalAmount: "22,800,000", profitLoss: "-540,000", profitRate: "-2.31%" },
    ],
    holdings: [
      { name: "삼성전자", category: "국내주식", quantity: "300", buyAmount: "21,000,000", evalAmount: "23,400,000", profitLoss: "2,400,000", profitRate: "11.43%" },
      { name: "TIGER 미국S&P500", category: "국내ETF", quantity: "150", buyAmount: "2,100,000", evalAmount: "1,980,000", profitLoss: "-120,000", profitRate: "-5.71%" },
    ],
  },
];
const rawTransaction = [
  {
    kind: "transaction",
    acno: "123-4567-8901-2",
    account: "123-4567-8901-2 주식계좌",
    transactions: [
      { date: "2026.05.20", type: "해외주식매수", name: "APPLE INC (소수)", quantity: "0.5", amount: "98,500", foreignAmount: "72.34", fee: "150", balance: "1,204,330", unitPrice: "144.68", brokerQuantity: "500000", exchangeRate: "1361.50", currency: "USD",
        detail: { src: "hkd1004.list", tr_srno: "00012", tr_q_raw: "500000", tr_upr: "144.68", curr_cd: "USD", bas_exr: "1361.50", frc_tr_a_precise: "72.340000", frc_fee_precise: "0.110000" } },
      { date: "2026.05.18", type: "배당금입금", name: "리얼티인컴", quantity: "", amount: "13,420", foreignAmount: "9.86", fee: "0", balance: "1,302,830", unitPrice: "", brokerQuantity: "", exchangeRate: "", currency: "USD", detail: null },
    ],
  },
];

let buildDailyAssetPayload, buildTransactionPayload, mergePayloads;
try {
  ({ buildDailyAssetPayload, buildTransactionPayload, mergePayloads } = await import(
    pathToFileURL(join(ROOT, "extension", "src", "normalize", "index.js")).href
  ));
} catch (e) {
  console.error("  normalizer import 실패:", e.message);
  findings.push({ location: "src/normalize/index.js import", expected: "Node import 성공", actual: e.message, severity: "ENV" });
}

if (buildDailyAssetPayload) {
  const da = buildDailyAssetPayload(rawDailyAsset);
  const tx = buildTransactionPayload(rawTransaction);
  const merged = mergePayloads([da, tx]);
  inspectPayload("norm:dailyAsset", da);
  inspectPayload("norm:transaction", tx);
  inspectPayload("norm:merged", merged);

  // raw→canonical 매핑 스팟체크(유실/오매핑)
  const t0 = tx.transactions[0];
  check(t0.foreign_amount === 72.34, "norm:transaction[0].foreign_amount", "72.34 (foreignAmount 매핑)", t0.foreign_amount, "P3");
  check(t0.broker_quantity === 500000, "norm:transaction[0].broker_quantity", "500000 (brokerQuantity 매핑)", t0.broker_quantity, "P3");
  check(t0.exchange_rate === 1361.5, "norm:transaction[0].exchange_rate", "1361.5", t0.exchange_rate, "P3");
  check(t0.unit_price === 144.68, "norm:transaction[0].unit_price", "144.68", t0.unit_price, "P3");
  check(t0.detail && typeof t0.detail === "object", "norm:transaction[0].detail", "객체 통과", typeof t0.detail, "P3");
  check(da.accounts[0].account_no === "123456789012", "norm:account_no 하이픈제거", "123456789012", da.accounts[0].account_no, "P3");
  check(da.daily_assets[1].profit_loss === -540000, "norm:profit_loss 부호보존", "-540000", da.daily_assets[1].profit_loss, "P3");
  check(tx.dividends.length === 1 && tx.dividends[0].type === "배당금입금", "norm:배당분리", "dividends 1건(배당금입금)", `${tx.dividends.length}건`, "P3");
  console.log(`  normalizer 출력: dailyAsset(acc=${da.accounts.length},assets=${da.daily_assets.length},hold=${da.daily_holdings.length}) transaction(tx=${tx.transactions.length},div=${tx.dividends.length})`);

  // ── 미리합산 금지 적극 검증: 같은 (date,name) 보유를 두 계좌에 흩어 입력 →
  //    normalizer가 합치지 않고 2행으로 보존해야 한다(서버가 합산).
  const rawDup = [
    { kind: "dailyAsset", date: "2026.06.16",
      accounts: [{ accountNo: "111-1", accountType: "위탁", alias: "", totalAsset: "1", evalAmount: "1", profitLoss: "0", profitRate: "" }],
      holdings: [{ name: "삼성전자", category: "국내주식", quantity: "100", buyAmount: "1,000", evalAmount: "1,100", profitLoss: "100", profitRate: "" }] },
    { kind: "dailyAsset", date: "2026.06.16",
      accounts: [{ accountNo: "222-2", accountType: "연금", alias: "", totalAsset: "1", evalAmount: "1", profitLoss: "0", profitRate: "" }],
      holdings: [{ name: "삼성전자", category: "국내주식", quantity: "50", buyAmount: "500", evalAmount: "560", profitLoss: "60", profitRate: "" }] },
  ];
  const dup = buildDailyAssetPayload(rawDup);
  const samsung = dup.daily_holdings.filter((h) => h.name === "삼성전자" && h.date === "2026-06-16");
  check(samsung.length === 2, "norm:미리합산 금지(daily_holdings)", "동일(date,name) 2행 보존(미합산)", `${samsung.length}행`, "P1");
  const totalQty = samsung.reduce((s, h) => s + h.quantity, 0);
  check(samsung.length === 2 && samsung.every((h) => h.quantity === 100 || h.quantity === 50),
    "norm:미리합산 금지(수량 미가산)", "각 행 quantity 원본 보존(100,50)", `quantity합=${totalQty}`, "P1");
}

// ── 리포트 ────────────────────────────────────────────────────────────────────
console.log(`\n=== 결과: ${checks}건 검사, 불일치 ${findings.length}건 ===`);
const order = { P1: 0, P2: 1, "P2-soft": 2, P3: 3, ENV: 4 };
findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
for (const f of findings) console.log(`  [${f.severity}] ${f.location}\n      기대: ${f.expected}\n      실제: ${f.actual}`);
if (findings.length === 0) console.log("  PASS — 모든 경계 검사 통과.");
process.exit(findings.filter((f) => f.severity === "P1" || f.severity === "P2").length ? 1 : 0);
