# 미래에셋증권 어댑터 참조

미래에셋증권(`securities.miraeasset.com`) 스크래핑 세부. 원본 Playwright 구현 전문은
`D:/Github/SRHSaaS/WebPriceTracker/miraeasset/scraper.js`(셀렉터·대기·파싱)와 `index.js`(플로우)에 있다.
이식 시 그 셀렉터를 그대로 가져오되 content script로 변환한다.

## 페이지 경로 (config.json)

| 영역 | path |
|------|------|
| 로그인 | `/` (`loginUrl: https://securities.miraeasset.com`) |
| My자산 | `/hkd/hkd1001/r01.do` |
| 계좌별자산 | `/hkd/hkd1002/r01.do` |
| 상품별자산 | `/hkd/hkd1003/r01.do` |
| 거래내역 | `/hkd/hkd1004/r01.do` |
| 거래내역 상세 | `/hkd/hkd1004/r02.do` |

## 스크랩 영역과 플로우

원본 `index.js` 메뉴 흐름을 content script 액션으로 매핑:

1. **계좌별자산**(`scrapeAccountAsset`) — 전체계좌현황(계좌별 totalAsset/accountType/alias) + 선택계좌 보유종목.
2. **일자별자산**(`switchToDailyTab` → `scrapeDailyForDate(date)`) — 계좌별자산 페이지에서 일자별 탭 전환 후 영업일별 순회. 영업일 계산은 `getBusinessDays(start,end)`(주말 제외). 날짜 형식은 화면이 `YYYY.MM.DD`.
3. **거래내역**(`navigateToTransaction` → `getTransactionAccounts` → `scrapeTransaction(accountIndex, start, end)`) — 계좌 목록을 읽고 계좌·날짜범위별 거래를 추출. 상세조회(`r02.do`)에서 소수점 거래의 단가(`unitPrice`)·중개수량(`brokerQuantity`)·환율(`exchangeRate`)을 보강.

## 거래 raw 필드 (normalizer가 소비)

`scrapeTransaction`이 내놓는 거래 객체(원문 문자열 허용):
`date, type, name, quantity, amount, foreignAmount, fee, balance, unitPrice, brokerQuantity, exchangeRate, currency, detail`

- `type`: 거래 유형 텍스트. 배당성 유형은 `/배당|분배금/` 매칭(예: 배당금입금, 배당금외화입금, 배당세출금, 배당단수주대금입금, 분배금입금). normalizer가 이 정규식으로 dividends를 분리한다.
- `amount`는 원화, `foreignAmount`는 외화. 단가 계산은 외화 우선((foreignAmount||amount)/quantity).
- `name`이 잘리는 경우가 있어 서버가 보유명 풀로 `resolved_name`을 보강한다 — 어댑터/normalizer는 원문 `name`만 넘긴다.

## 일자별 raw 필드

- accounts: `accountNo, accountType, alias, totalAsset, evalAmount, profitLoss, profitRate`
- holdings: `name, category, quantity, buyAmount, evalAmount, profitLoss, profitRate`

## 프레임 구조 (실측 — 중요)

미래에셋은 **`<frameset>`/`<frame>` 구조의 SPA**다. URL은 항상 `https://securities.miraeasset.com/`로 고정되고, 내부 JS 함수(`openHp(path, secure)`)가 **contentframe**을 다른 페이지로 이동시킨다(주소창 안 바뀜). 진단(PROBE)으로 확인한 프레임 트리:

```
top  (securities.miraeasset.com/)
├─ topframe          (blank.html)
├─ contentframe      ← 데이터·페이지 전역이 여기 산다
│    예: /hkd/hkd1002/r01.do, tables=3, openHp/subTabChange/jQuery/accountLoader
├─ sessionCheckFrame (session_update.jsp)
└─ refreshframe      (wtsform.jsp)
```

- **`openHp`·`hkd1004`·`accountLoader`·jQuery 등 페이지 전역은 top이 아니라 `contentframe` 안에 산다.** contentframe이 자산 페이지(hkd1002/hkd1004 등)로 이동한 뒤에야 그 페이지 고유 전역(`hkd1004`, `accountLoaderLayer`/`accountLoader`)과 데이터 표가 생긴다.
- **`<frame>`이므로 `document.querySelector('iframe[name="contentframe"]')`로는 못 찾는다.** 반드시 **이름 기반**(`window.frames["contentframe"]`, 또는 `window.frames` 순회 후 `.name === "contentframe"`)으로 접근한다 — Playwright `page.frame("contentframe")`과 동일 원리. `<frame>`/`<iframe>` 모두 동작. (이 함정으로 "openHp 없음" 오류가 났었다.)
- 스크래퍼는 openHp로 contentframe을 자산 페이지로 이동시키므로, 사용자는 자산 화면에 미리 들어가 있지 않아도 된다(로그인만 돼 있으면 됨).

## 주의

- 계좌번호는 화면상 하이픈 포함. raw에는 그대로 두고 normalizer가 하이픈 제거.
- 날짜는 화면 `YYYY.MM.DD`. raw에 그대로 두고 normalizer가 `-`로 치환.
- 일자별 순회는 건수가 많아 느리다 — 이미 수집한 날짜 스킵(증분) 로직을 chrome.storage manifest로 둔다.
- headless가 아닌 사용자 실탭에서 도는 content script이므로 보안지문 문제는 없다(원본의 headless 회피 주석은 무시).
