---
name: canonical-normalizer
description: "스크랩 raw를 SRHFinance 정규(canonical) IngestPayload로 변환하는 가이드. accounts/daily_assets/daily_holdings/transactions/dividends 빌드, schema_version·source, 금액 문자열→숫자, 하이픈/날짜 정규화, 배당 추출, 거래단가 계산. user_id/seq/resolved_name은 서버 몫이라 넣지 않음. lib/ingest.ts 계약과 동기화. 정규화·페이로드·스키마 작업 시 반드시 사용. normalizer-engineer 전용."
---

# 정규(canonical) 변환 가이드

raw 스크랩 데이터를 SRHFinance가 수신하는 정규 페이로드로 변환하는 절차. normalizer-engineer 전용. 참조 구현은 `D:/Github/SRHSaaS/WebPriceTracker/miraeasset/canonical.js`, 수신 계약은 `D:/Github/SRHSaaS/SRHFinance/lib/ingest.ts`.

## 정규 페이로드 형태

영역별로 두 종류를 만든다(둘 다 `source`, `schema_version` 포함):

```js
// 일자별 자산 페이로드
{ source, schema_version, accounts:[IngestAccount], daily_assets:[IngestDailyAsset], daily_holdings:[IngestDailyHolding] }

// 거래 페이로드
{ source, schema_version, accounts:[IngestAccount], transactions:[IngestTransaction], dividends:[IngestDividend] }
```

필드명·타입의 **권위는 `lib/ingest.ts`의 `Ingest*` 인터페이스**다. 전체 필드 표·검증 규칙은 `references/ingest-contract.md`에 고정해 두었으니 변환기를 만들기 전 반드시 읽는다. `lib/ingest.ts`가 바뀌면 그 표와 변환기를 함께 갱신한다.

## 역할 경계 — 클라이언트가 하는 것 / 안 하는 것

**한다(소스별 파싱):**
- 금액 문자열 → 숫자: `Number(String(s).replace(/[^\d.-]/g,"")) || 0`. 소수 수량은 `parseFloat` 동치.
- 하이픈 제거: 계좌번호 `replace(/-/g,"")`.
- 날짜 정규화: `YYYY.MM.DD` → `YYYY-MM-DD` (`replace(/\./g,"-")`).
- 배당 추출: 거래 중 `type`이 `/배당|분배금/` 매칭이면 dividends에도 넣는다.
- 거래단가(`unit_price`): 상세값 우선, 없으면 `(foreign_amount>0?foreign_amount:amount)/quantity`. 0이면 null.
- `name` null 금지 → 빈 문자열(서버 unique 키 매칭 때문).

**안 한다(서버 권위):**
- `user_id` 부여 금지 — 서버가 세션 사용자로 stamp.
- `seq` 부여 금지 — 서버가 중복 키에 1부터 부여.
- `resolved_name` 부여 금지(원칙) — 서버가 보유명 풀로 보강. 어댑터가 확실히 알면 줄 수 있으나 기본은 비운다.
- daily_holdings (date,name) 합산 금지 — 서버가 합산·수익률 재계산. 클라이언트는 행 단위로 그대로 보낸다.

이 경계를 어기면(예: user_id를 넣거나 미리 합산) 데이터 오염·충돌이 난다. **빈 결과보다 위험한 게 잘못된 정규화다.**

## schema_version

`schema_version`은 반드시 `INGEST_SCHEMA_VERSION`(현재 **1**)과 같게 한다. 다르면 서버 `validateIngest`가 즉시 400으로 거부한다. `references/ingest-contract.md`에서 현재 값을 확인한다.

## 변환 함수 골격

```js
const SCHEMA_VERSION = 1;
const DIVIDEND_RE = /배당|분배금/;

export function buildDailyAssetPayload(raw, source) {
  const date = toDate(raw.date);
  return {
    source, schema_version: SCHEMA_VERSION,
    accounts: raw.accounts.map(a => ({ account_no: stripHyphen(a.accountNo), account_type: a.accountType||null, alias: a.alias||a.accountType||null })),
    daily_assets: raw.accounts.map(a => ({ date, account_no: stripHyphen(a.accountNo), total_asset:num(a.totalAsset), eval_amount:num(a.evalAmount), profit_loss:num(a.profitLoss), profit_rate:a.profitRate||null })),
    daily_holdings: raw.holdings.filter(h=>h.name?.trim()).map(h => ({ date, name:h.name.trim(), category:h.category||null, quantity:num(h.quantity), buy_amount:num(h.buyAmount), eval_amount:num(h.evalAmount), profit_loss:num(h.profitLoss), profit_rate:h.profitRate||null })),
  };
}
```

거래 페이로드는 `references/ingest-contract.md`의 거래/배당 필드 표를 그대로 따른다(`canonical.js`의 `buildTransactionPayload` 이식).

## 산출물

- `src/normalize/index.js` — `buildDailyAssetPayload`, `buildTransactionPayload` + 헬퍼(`stripHyphen`, `toDate`, `num`).
- `_workspace/03_normalizer_payload_samples/` — 영역별 샘플 정규 JSON(integration 업로드 테스트·qa 검증용).

## 체크리스트

- [ ] 필드명/타입이 `references/ingest-contract.md`와 100% 일치
- [ ] `user_id`/`seq`/`resolved_name` 미포함, holdings 미합산
- [ ] `schema_version === 1`
- [ ] 거래 `name` null 대신 빈 문자열
- [ ] 배당이 `/배당|분배금/`로 dividends에 분리됨
