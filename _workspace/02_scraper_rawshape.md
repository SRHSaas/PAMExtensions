# 02 · 스크래퍼 raw 출력 shape (미래에셋 어댑터)

> 작성: scraper-engineer · 2026-06-16 · 대상: `src/content/miraeasset/index.js`
> **이 문서는 normalizer-engineer의 입력 계약이자 qa-verifier의 검증 기준이다.**
> 기준 문서: `_workspace/01_architect_interface.md` §3(raw 형태), §6(export 시그니처).
> 권위 원본 플로우/셀렉터: `WebPriceTracker/miraeasset/scraper.js`.

---

## 0. 핵심 경계 (반드시 기억)

스크래퍼는 **DOM에서 값을 꺼내는 것까지**만 한다. 다음은 **하지 않는다** — normalizer 몫:

- 문자열→숫자 (`"1,234.56"` → `1234.56`)
- 하이픈 제거 (`"123-4567-8901-2"` → `"12345678901 2"`)
- 날짜 `.`→`-` (`"2026.06.16"` → `"2026-06-16"`)
- 배당 분류 (`type`이 `/배당|분배금/`이면 `dividends`로 분리)

raw 필드는 **모두 문자열**(원문 trim)이며 **camelCase**다. 빈 값은 `""`(NULL 아님).

---

## 1. SCRAPE_RESULT payload 래핑 (계약 §2.1)

content script가 `chrome.runtime.onMessage` 응답으로 반환하는 형태:

```js
{ source: "miraeasset", target: "dailyAsset" | "transaction", ok: true,
  raw: <object[]> }            // ok=true 시
{ source: "miraeasset", target, ok: false, error: "사람이 읽을 오류" }  // 실패 시
```

> **`raw`는 항상 배열이다.** background가 target별로 1건씩 요청하지만, 한 target 안에서
> 여러 날짜(dailyAsset) / 여러 계좌(transaction)를 수집하므로 배열로 반환한다(계약 §3:
> "다중 날짜/계좌면 배열" 허용). normalizer는 `raw`가 배열이라고 가정하고 각 원소를
> 순회해 `build*Payload`를 호출한 뒤 `mergePayloads`로 합치면 된다.

각 배열 원소에는 식별용 `kind` 필드가 있다(`"dailyAsset"` | `"transaction"`).

---

## 2. dailyAsset raw (`target = "dailyAsset"`)

`raw` = 날짜별 객체 배열. 원소 1개 = 한 영업일.

```js
{
  kind: "dailyAsset",
  date: "2026.06.16",          // 화면 형식 YYYY.MM.DD (normalizer가 - 치환)
  accounts: [ { ...account } ],
  holdings: [ { ...holding } ]
}
```

### 2.1 accounts[] 필드 (전체계좌현황 = `#reportTable01Tbody`)

| 필드 | 출처 셀 | 의미 | 비고 |
|---|---|---|---|
| `accountNo` | td[0] | 계좌번호 | 하이픈 포함(`123-4567-8901-2`). raw 그대로 |
| `accountType` | td[1] | 계좌 구분(위탁/연금 등) | |
| `alias` | (없음) | 계좌 별칭 | **일자별 탭엔 별칭 컬럼이 없어 항상 `""`** (§5 참조) |
| `totalAsset` | td[2] | 자산총액(원화) | 콤마 포함 문자열 |
| `evalAmount` | td[3] | 평가금액(원화) | |
| `profitLoss` | td[4] | 평가손익 | **부호 보정됨**(§4 참조) |
| `profitRate` | td[5] | 수익률 | `"3.21%"` 같은 문자열 |

### 2.2 holdings[] 필드 (상품보유현황 = `#reportTable02Tbody`)

| 필드 | 출처 셀 | 의미 | 비고 |
|---|---|---|---|
| `name` | td[0] | 종목명 | **잘릴 수 있음**(§6). 원문 그대로 |
| `category` | td[1] | 상품 구분(국내주식/해외주식/펀드 등) | |
| `quantity` | td[2] | 보유수량 | 소수 가능. 문자열 |
| `buyAmount` | td[3] | 매입금액 | |
| `evalAmount` | td[4] | 평가금액 | |
| `profitLoss` | td[5] | 평가손익 | **부호 보정됨**(§4) |
| `profitRate` | td[6] | 수익률 | |

> holdings는 (date,name)으로 **미리 합산하지 않는다**(서버가 합산). 화면에 보이는 행을 그대로 넘긴다.

---

## 3. transaction raw (`target = "transaction"`)

`raw` = 계좌별 객체 배열. 원소 1개 = 한 계좌의 기간 거래.

```js
{
  kind: "transaction",
  acno: "123-4567-8901-2",     // 계좌번호(하이픈 가능). raw 그대로
  account: "123-4567-8901-2 별칭",  // 드롭다운 라벨(번호+별칭)
  transactions: [ { ...txn } ]
}
```

### 3.1 transactions[] 필드 (`#simpleTable tbody` + 페이지 원시 `hkd1004.list` 조인)

| 필드 | 출처 | 의미 | 비고 |
|---|---|---|---|
| `date` | td[0] | 거래일자 | `YYYY.MM.DD` 화면 형식 |
| `type` | td[1] | **거래종류 텍스트** | **배당 판정 키**(§6). 예: 매수/매도/배당금입금/분배금입금 |
| `name` | td[2] | 종목명 | **잘릴 수 있음**(§6). `"(소수)"` 접미 가능 |
| `quantity` | td[3] / hkd1004 | 거래수량 | 소수거래는 **실수량으로 환산됨**(§4) |
| `amount` | td[4] | **거래금액 = 원화(KRW)** | 콤마 포함 문자열 |
| `foreignAmount` | td[5] | **외화 거래금액** | 외화거래일 때만 값. 예: `"123.45 USD"` 또는 빈 문자열 |
| `fee` | td[6] | 수수료 | |
| `balance` | td[7] | 예수금잔고 | |
| `unitPrice` | hkd1004.tr_upr | 거래단가 | 원시값 문자열. 없으면 `""` |
| `brokerQuantity` | (소수거래) | 화면 표시 micro 수량 | 소수거래만 채워짐(§4). 그 외 `""` |
| `exchangeRate` | a03.json bas_exr | 기준환율 | 외화·주식레그만. 없으면 `""` |
| `currency` | hkd1004.curr_cd / a03 | 통화코드 | 외화거래만. 예: `"USD"`. 없으면 `""` |
| `detail` | hkd1004 / a03 | 진단/정밀값 묶음 | 객체 또는 `null`(§4) |

---

## 4. 어댑터가 적용한 "약한 파싱" (정규화 아님 — 그대로 통과)

normalizer가 알아야 할, 원문에서 **벗어난** 처리는 이 4가지뿐. 나머지는 전부 원문 trim 문자열이다.

1. **손익 부호 보정** (`accounts.profitLoss`, `holdings.profitLoss`):
   미래에셋은 손실을 텍스트가 아니라 `<em title="하락">` DOM 마커로 표시한다. 텍스트만으론
   음수를 복구할 수 없으므로, **`em[title="하락"]`가 있으면 문자열 앞에 `"-"`를 붙인다**.
   (원문에 이미 `-`가 있으면 중복 부호를 막아 그대로 둠.) → normalizer는 `profitLoss`를
   숫자화할 때 이 `-`를 신뢰하면 된다.

2. **소수거래 수량 환산** (`transactions.quantity` / `brokerQuantity`):
   종목명이 `"(소수)"`로 끝나는 국내 소수거래는 화면 표시수량이 **백만분의 1주(micro)** 단위다.
   어댑터가 화면값을 `brokerQuantity`에 보존하고, `quantity`는 `hkd1004.list.tr_q / 1e6`(실수량)로
   교체한다. 이건 **단위 환산**이지 숫자 정규화가 아니다(여전히 문자열). 소수거래가 아니면
   `quantity`는 화면 td[3] 그대로, `brokerQuantity`는 `""`.

3. **원시데이터 보강** (`unitPrice`, `currency`, `exchangeRate`):
   화면 테이블엔 없는 단가/통화/환율을 페이지 JS 객체(`hkd1004.list`)와 상세 API
   (`/hkd/hkd1004/a03.json`의 `bas_exr`)에서 보강한다. 모두 **문자열 그대로** 넣는다.
   값이 없으면 `""`.

4. **`detail` 객체**: 소수거래/외화거래의 추적용 원시 식별자·정밀값(`tr_srno`, `bas_exr`,
   `frc_tr_a_precise` 등). normalizer는 이걸 `transactions[].detail`로 그대로 통과시키면 된다
   (정규 페이로드의 `detail?` 필드). 일반 거래는 `null`.

---

## 5. 계약(§3) 대비 차이 — **명시적 기록**

| 항목 | 계약 §3 | 본 어댑터 실제 | 사유 / normalizer 처리 |
|---|---|---|---|
| dailyAsset `accounts.alias` | 필드 존재 | **항상 `""`** | 일자별 탭 화면에 별칭 컬럼이 없음. 계좌 별칭은 **거래내역 raw의 `account` 라벨**과 계좌별자산 탭에만 있다. normalizer는 `alias===""`를 NULL로 처리(서버도 `""`/NULL 허용). 별칭이 꼭 필요하면 transaction raw의 `account`에서 (acno→alias) 매핑 가능. |
| raw 배열 여부 | "다중이면 배열" | **항상 배열** | dailyAsset=날짜배열, transaction=계좌배열. normalizer는 무조건 배열 순회. |
| `_skipped` 필드 | 없음 | **실패 원소에만 추가** | 방어적 파싱(스킬 원칙: 조용한 빈 배열 금지). 한 날짜/계좌 실패 시 전체를 막지 않고 `{ ...빈 데이터, _skipped: "오류메시지" }`로 남긴다. **normalizer는 `_skipped`가 있으면 그 원소를 건너뛰거나 빈 데이터로 처리**하면 된다(accounts/holdings/transactions가 빈 배열이라 자연히 무시됨). qa는 이 필드로 누락 날짜를 추적. |
| `kind` 필드 | 없음(§3 예시엔 미표기) | **각 원소에 추가** | 디스패치/검증 편의. normalizer는 무시해도 되고, `target`으로도 이미 종류를 안다. |

그 외 필드명·구조는 계약 §3 및 스킬 raw shape와 **일치**한다.

---

## 6. normalizer가 반드시 알아야 할 의미 (요약)

- **`amount` = 원화(KRW), `foreignAmount` = 외화.** 단가 계산이 필요하면 외화 우선:
  `(foreignAmount || amount) / quantity`. (어댑터는 단가를 계산하지 않고 `unitPrice` 원시값만 넘김.)
- **배당 분리는 `type` 텍스트로.** `/배당|분배금/` 매칭(배당금입금, 배당금외화입금, 배당세출금,
  배당단수주대금입금, 분배금입금 등) → `dividends`로. 어댑터는 분리하지 않고 `type` 원문만 넘긴다.
- **`name`은 잘릴 수 있다.** 화면 셀이 종목명을 truncate하는 경우가 있다. 어댑터/normalizer는
  **원문 `name`만** 넘기고 `resolved_name`을 **부여하지 않는다**(서버가 보유명 풀로 보강). 빈 이름은 `""`.
- **하이픈/날짜 정리는 normalizer.** `acno`/`accountNo`의 하이픈 제거, `date`의 `.`→`-`는 normalizer가 한다.
- **부호:** `profitLoss`의 `-` 접두는 신뢰 가능(§4). 그 외 숫자 부호는 원문 그대로.

---

## 7. 샘플 raw JSON

### 7.1 dailyAsset (1건 — `raw` 배열의 한 원소)

```json
{
  "kind": "dailyAsset",
  "date": "2026.06.16",
  "accounts": [
    {
      "accountNo": "123-4567-8901-2",
      "accountType": "위탁",
      "alias": "",
      "totalAsset": "152,340,210",
      "evalAmount": "148,920,000",
      "profitLoss": "12,450,300",
      "profitRate": "9.12%"
    },
    {
      "accountNo": "123-4567-8901-3",
      "accountType": "연금저축",
      "alias": "",
      "totalAsset": "23,100,000",
      "evalAmount": "22,800,000",
      "profitLoss": "-540,000",
      "profitRate": "-2.31%"
    }
  ],
  "holdings": [
    {
      "name": "삼성전자",
      "category": "국내주식",
      "quantity": "300",
      "buyAmount": "21,000,000",
      "evalAmount": "23,400,000",
      "profitLoss": "2,400,000",
      "profitRate": "11.43%"
    },
    {
      "name": "TIGER 미국S&P500",
      "category": "국내ETF",
      "quantity": "150",
      "buyAmount": "2,100,000",
      "evalAmount": "1,980,000",
      "profitLoss": "-120,000",
      "profitRate": "-5.71%"
    }
  ]
}
```

> 주: `accounts[1].profitLoss`의 `-`는 §4-1 부호 보정 결과(원문이 `<em title="하락">` 마커였음).

### 7.2 transaction (1건 — `raw` 배열의 한 원소)

```json
{
  "kind": "transaction",
  "acno": "123-4567-8901-2",
  "account": "123-4567-8901-2 주식계좌",
  "transactions": [
    {
      "date": "2026.05.20",
      "type": "해외주식매수",
      "name": "APPLE INC (소수)",
      "quantity": "0.5",
      "amount": "98,500",
      "foreignAmount": "72.34",
      "fee": "150",
      "balance": "1,204,330",
      "unitPrice": "144.68",
      "brokerQuantity": "500000",
      "exchangeRate": "1361.50",
      "currency": "USD",
      "detail": {
        "src": "hkd1004.list",
        "tr_srno": "00012",
        "tr_q_raw": "500000",
        "tr_upr": "144.68",
        "curr_cd": "USD",
        "bas_exr": "1361.50",
        "frc_tr_a_precise": "72.340000",
        "frc_fee_precise": "0.110000"
      }
    },
    {
      "date": "2026.05.18",
      "type": "배당금입금",
      "name": "리얼티인컴",
      "quantity": "",
      "amount": "13,420",
      "foreignAmount": "9.86",
      "fee": "0",
      "balance": "1,302,830",
      "unitPrice": "",
      "brokerQuantity": "",
      "exchangeRate": "",
      "currency": "USD",
      "detail": null
    }
  ]
}
```

> 주1: 첫 거래는 국내 소수 해외주식 매수 — `quantity`는 실수량(`0.5`), `brokerQuantity`는 화면 micro 표시(`500000`), `detail`에 원시 식별자/정밀값.
> 주2: 둘째 거래는 **배당**(`type="배당금입금"`) — 어댑터는 분리하지 않고 그대로 둔다. normalizer가 `/배당|분배금/`로 `dividends`에 넣는다. 현금성 배당이라 `quantity`/`unitPrice`/`exchangeRate`는 `""`, `detail`은 `null`.

---

## 8. 셀렉터 / 페이지 경로 참조 (DOM 변경 시 여기부터 점검)

| 영역 | 경로 / 트리거 | 핵심 셀렉터 |
|---|---|---|
| 계좌별자산 진입 | `openHp('/hkd/hkd1002/r01.do')` | `#hkd1002a01ListTbody` |
| 일자별 탭 전환 | `subTabChange('2')` | `#reportTable01Tbody`, `#reportTable02Tbody` |
| 일자별 날짜 조회 | `datepicker1` 설정 → `dateOfJango('first')` | `#date_from_view` |
| 일자별 더보기 | `dateOfJango('more')` / `dateOfJangoDetail('more')` | `#moreListFirst`, `#moreList` |
| 거래내역 진입 | `openHp('/hkd/hkd1004/r02.do')` | `#userAccountList`, `#simpleTable` |
| 거래 계좌목록 | `accountLoaderLayer.list` | `#userAccountList li a` |
| 거래 계좌선택 | `accountLoaderLayer.onClickAccount(i)` | — |
| 거래 기간/조회 | `datepicker1`/`datepicker2` → `#searchButton` | `#simpleTable tbody` |
| 거래 더보기 | `#moreListS a` 클릭 | `#simpleTable tbody` |
| 거래 환율보강 | `jQuery.ajax POST /hkd/hkd1004/a03.json` | 응답 `DLCTN[0].bas_exr` |

> **이식 메모(중요):** 위 `openHp/subTabChange/accountLoaderLayer/hkd1004/dateOfJango/jQuery`는
> **페이지 월드 전역**이다. content script(격리 월드)는 직접 못 부른다. 어댑터는 동일출처
> `iframe[name="contentframe"]`에 RPC 브리지(`<script>` 주입 + `window.postMessage`)를 심어
> 호출한다(`pageEval`/`pageCall`). DOM 읽기는 `iframe.contentDocument`로 직접 한다.
> 셀렉터가 비면 `requireEl`이 **영역/셀렉터를 담아 throw**한다(조용한 빈 배열 금지).
