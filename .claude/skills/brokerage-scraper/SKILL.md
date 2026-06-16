---
name: brokerage-scraper
description: "증권사 페이지에서 계좌/일자별자산/보유종목/거래내역/배당을 추출하는 content script 어댑터 작성 가이드. 사용자 로그인 세션 위에서 DOM 스크래핑, 셀렉터·페이지 네비게이션·날짜순회·계좌선택, Playwright scraper.js 로직의 content script 이식. 미래에셋(miraeasset) 등 증권사 어댑터를 만들거나 셀렉터를 고칠 때 반드시 사용. scraper-engineer 전용."
---

# 증권사 스크래핑 어댑터 가이드

사용자가 로그인한 증권사 페이지에서 데이터를 추출하는 content script 어댑터 작성법. scraper-engineer 전용.

## 원칙: 어댑터당 한 증권사 (전문가 풀)

증권사마다 URL·DOM·플로우가 완전히 다르다. 공통 추상화를 억지로 만들기보다 `src/content/{broker}/`에 어댑터를 분리하고, 각 어댑터가 **동일한 raw 출력 shape**를 반환하게 한다. 공통은 출력 계약(shape)뿐, 추출 방법은 어댑터 자유다.

## 역할 경계: raw까지만

스크래퍼는 **DOM에서 값을 꺼내는 것까지**가 책임이다. 문자열을 숫자로 바꾸거나(`"1,234"`→`1234`), 하이픈 제거, 배당 분류 같은 **정규화는 normalizer가** 한다. 스크래퍼는 약한 파싱(텍스트 trim, 셀 단위 분리)만 하고 원문에 가까운 raw를 넘긴다. 이 경계를 지켜야 증권사가 늘어도 normalizer 한 곳에서 규칙을 관리할 수 있다.

## 사용자 로그인 전제

스크래핑은 사용자가 **직접 로그인을 마친 탭**에서만 한다. 인증서/비밀번호 입력 자동화, 세션 위조, 백그라운드 세션 연장은 하지 않는다(정책). content script는 이미 인증된 페이지의 DOM·동일 출처 요청을 그대로 활용한다.

## Playwright → content script 이식

참조 구현은 `D:/Github/SRHSaaS/WebPriceTracker/miraeasset/scraper.js`(Playwright)다. 이식 시 치환 규칙:

| Playwright | content script |
|-----------|----------------|
| `page.goto(url)` | `location.href = url` 또는 SPA 내 네비게이션 클릭 후 대기 |
| `page.$eval/$$eval` | `document.querySelector/All` + 직접 파싱 |
| `page.waitForSelector` | MutationObserver 또는 폴링 대기 헬퍼 |
| `page.click` | `el.click()` + 변화 대기 |
| 파일 저장 | `SCRAPE_RESULT` 메시지로 background에 반환 |

증권사별 페이지 경로·셀렉터·플로우는 references/에 분리한다. 미래에셋은 `references/miraeasset.md` 참조.

### ⚠ content script에서 정적 import 금지

manifest `content_scripts`로 주입되는 스크립트는 **클래식 스크립트**로 실행되어 `import`·`export` 둘 다 못 쓴다. 최상단 `import {...}`은 `Cannot use import statement outside a module`로, 내부 함수의 `export`(예: `export async function scrapeDailyAsset`)는 `Unexpected token 'export'`로 로드 즉시 죽는다 → `onMessage` 리스너 미등록 → background가 "Receiving end does not exist"로 실패. 따라서 (1) 어댑터가 쓰는 메시지 상수(MSG/SCRAPE_TARGET/SOURCE 등 소수)는 **인라인 미러**로 선언해 `src/shared/messages.js` 값과 동기화하고, (2) 내부 scrape 함수에 `export`를 붙이지 않는다(같은 파일에서 호출). JSDoc의 `@param {import("...").Type}`은 주석이라 무방. 작성 후 `node --check`로 파싱 확인. 상세는 `chrome-extension-mv3` 스킬 참조.

## raw 출력 shape (normalizer 입력 계약)

어댑터는 영역별로 다음 raw를 반환한다. 필드는 **원문 문자열 허용**(normalizer가 숫자화):

```js
// 일자별 자산
{ kind: "dailyAsset", date, accounts: [{ accountNo, accountType, alias, totalAsset, evalAmount, profitLoss, profitRate }],
  holdings: [{ name, category, quantity, buyAmount, evalAmount, profitLoss, profitRate }] }

// 거래내역
{ kind: "transaction", acno, account,
  transactions: [{ date, type, name, quantity, amount, foreignAmount, fee, balance,
                   unitPrice, brokerQuantity, exchangeRate, currency, detail }] }
```

이 shape를 바꾸면 normalizer·qa가 깨진다 — 변경 시 반드시 SendMessage로 통지하고 `_workspace/02_scraper_rawshape.md`를 갱신한다.

## 방어적 파싱

증권사 DOM은 예고 없이 바뀐다.
- 셀렉터가 비면 throw하고 **어떤 영역/셀렉터**가 깨졌는지 메시지에 담는다. 조용한 빈 배열 반환 금지.
- 실패 시 현재 DOM 스냅샷(`document.body.innerHTML` 일부)을 `_workspace/`에 덤프해 진단을 돕는다.
- 명시적 대기(요소 등장까지) 후 1회 재시도, 재실패 시 해당 날짜/계좌만 스킵하고 누락을 기록한다.

## 산출물

- `src/content/{broker}/index.js` — `scrape{영역}()` 순수 함수 집합 + content script 진입점
- `_workspace/02_scraper_rawshape.md` — 영역별 raw 필드 표 + 샘플 JSON(normalizer·qa용)

## 체크리스트

- [ ] raw shape가 위 계약과 일치, `_workspace/02_*`에 문서화
- [ ] 숫자 정규화/배당 분류를 하지 않음(normalizer 경계 존중)
- [ ] 셀렉터 실패가 throw + 영역/셀렉터 명시
- [ ] 인증 자동화/세션 위조 코드 없음
