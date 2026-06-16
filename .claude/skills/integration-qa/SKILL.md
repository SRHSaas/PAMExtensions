---
name: integration-qa
description: "PAMExtensions 통합 정합성 검증 가이드. 정규 페이로드 ↔ SRHFinance lib/ingest.ts 계약 교차 비교, 금지필드(user_id/seq/resolved_name) 검사, 메시지 스키마 단일성, raw→canonical 일관성, 업로드 응답 처리 검증. 각 모듈 완성 직후 점진적 QA. 검증·정합성·QA·경계점검 작업 시 반드시 사용. qa-verifier 전용."
---

# 통합 정합성 검증 가이드

PAMExtensions의 모듈 경계 정합성을 검증하는 절차. qa-verifier(general-purpose) 전용.
핵심은 "파일이 있나"가 아니라 **"경계의 양쪽이 같은 계약을 말하나"**를 교차 비교하는 것이다.

## 왜 경계면인가

이 시스템의 버그는 대부분 한 모듈 안이 아니라 **경계**에서 난다: 스크래퍼 raw shape ↔ normalizer 입력, normalizer 출력 ↔ `lib/ingest.ts` 계약, 메시지 송신부 ↔ 수신부. 각 모듈만 보면 멀쩡한데 합치면 깨진다. 그래서 항상 **양쪽을 함께 읽고 한 줄씩 대조**한다.

## 점진적 QA (모듈 완성마다)

전체 완성 후 1회가 아니라 각 모듈 완료 직후 검증한다. 늦게 잡힌 경계 버그일수록 비싸다.
- 스크래퍼 완료 → raw shape ↔ `_workspace/02_*` ↔ normalizer 기대입력 대조
- 정규화 완료 → 정규 페이로드 ↔ `lib/ingest.ts` 계약 교차 비교(최우선)
- 업로드 완료 → 에러 매핑 ↔ 서버 응답코드(401/403/400/500) 대조

## 검증 1: 정규 페이로드 ↔ lib/ingest.ts (최우선)

`D:/Github/SRHSaaS/SRHFinance/lib/ingest.ts`와 `canonical-normalizer/references/ingest-contract.md`, 그리고 normalizer 산출 샘플(`_workspace/03_normalizer_payload_samples/`)을 **동시에** 펼치고:

1. 각 배열의 모든 필드명·타입이 `Ingest*` 인터페이스와 일치하는가.
2. **금지 필드 검사**: 샘플에 `user_id`, `seq`, `resolved_name`이 들어있지 않은가(서버 권위 침범 = 충돌/오염 위험, 심각도 최상).
3. daily_holdings가 (date,name)으로 **미리 합산되지 않았는가**(같은 종목 여러 행 허용 — 서버가 합산).
4. `schema_version === 1`인가. 거래 `name`이 null이 아닌 빈 문자열인가.
5. 배당이 `/배당|분배금/` 거래에서 dividends로 분리됐는가.

### 실검증 스크립트

`lib/ingest.ts`의 `validateIngest`/`buildXxxRows`를 직접 호출하거나(동일 로직 Node 재현) 샘플을 통과시켜본다:

```js
// _workspace/qa/check-payload.mjs (개요)
import { readFileSync } from "node:fs";
const FORBIDDEN = ["user_id","seq","resolved_name"];
for (const sample of samples) {
  const p = JSON.parse(readFileSync(sample));
  // schema_version
  assert(p.schema_version === 1, `${sample}: schema_version != 1`);
  // 금지필드
  for (const arr of ["accounts","daily_assets","daily_holdings","transactions","dividends"])
    for (const row of p[arr] ?? [])
      for (const f of FORBIDDEN)
        assert(!(f in row) || (arr==="transactions" && f==="resolved_name"),
               `${sample}.${arr}: 금지필드 ${f}`);
  // 비어있지 않음
  assert(["accounts","daily_assets","daily_holdings","transactions","dividends"]
         .reduce((n,k)=>n+(p[k]?.length??0),0) > 0, `${sample}: 빈 페이로드`);
}
```

가능하면 `lib/ingest.ts`를 ts로 import해 실제 `validateIngest`로 검사한다(동치 재현보다 정확).

## 검증 2: 메시지 스키마 단일성

architect의 `src/shared/messages.js` 정의와 각 모듈의 실제 메시지 송수신부를 대조한다. 같은 메시지 타입을 두 곳에서 다른 shape로 쓰면 드리프트다. 송신 payload 필드 ⊇ 수신 사용 필드인지 확인한다.

## 검증 3: raw → canonical 일관성

scraper 샘플 raw(`_workspace/02_*`)와 normalizer 출력 샘플을 대조해, raw에 있던 의미 있는 필드가 정규 페이로드에서 유실되거나 오매핑되지 않았는지 본다(예: foreignAmount → foreign_amount, brokerQuantity → broker_quantity).

## 보고

`_workspace/05_qa_report.md`에 불일치를 기록한다. 각 항목에 **위치 / 기대값 / 실제값 / 심각도 / 담당자**. 심각도 우선순위: 데이터 오염 위험(금지필드·미리합산) > 검증 거부(schema_version·필수필드) > 단순 누락/오매핑. **직접 고치지 말고** 담당 에이전트에 SendMessage로 정확히 통지한다(역할 경계 존중).

## 체크리스트

- [ ] 정규 페이로드 ↔ lib/ingest.ts 필드 교차 비교 완료
- [ ] 금지필드(user_id/seq/resolved_name)·미리합산 검사 통과
- [ ] 메시지 스키마 단일성 확인
- [ ] raw→canonical 유실/오매핑 없음
- [ ] 불일치를 심각도·담당자와 함께 05_qa_report.md에 기록
