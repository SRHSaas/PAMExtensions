# 신한투자증권 어댑터 — 1단계: 정찰(PROBE)

대상: `www.shinhansec.com` / `*.shinhansec.com` (나의자산분석 > 잔고/거래내역).
목표(이 단계): **실측 진단**으로 가능/난이도를 확정. 실제 스크래핑 구현은 다음 단계.

## 왜 정찰부터인가 (판정해야 할 2가지)

1. **잔고표 렌더 방식** — DOM `<table>` 인가, RealGrid/AUIGrid 등 **그리드 컴포넌트(canvas/가상 DOM)** 인가.
   - table → DOM 스크래핑(미래에셋과 동일 난이도).
   - 그리드 → 그리드 JS 데이터 API 후킹 필요(가능하나 손이 더 감). 사용자가 말한 "한화면 조회" 버튼이 그리드 전체표시 기능 패턴.
2. **거래내역 계좌 PIN 입력칸** — 일반 `<input type=password>` 인가, **보안 키보드**(TouchEn/nProtect/raonsecure 등)인가.
   - 일반 input(readonly=false) → `.value` 설정으로 자동입력 가능.
   - 보안 키보드(readonly=true 또는 보안모듈 전역/오버레이 키패드 존재) → 자동입력 사실상 불가.

## 추가한 것 (구현됨)

| 파일 | 내용 |
|------|------|
| `extension/manifest.json` | host_permissions에 `https://*.shinhansec.com/*` 추가. content_scripts에 신한 page-bridge(MAIN, document_start, all_frames) + index(document_idle) 추가 |
| `extension/src/content/shinhan/page-bridge.js` | MAIN-world 브리지. **cmdProbe 중심** — 프레임 트리 순회하며 프레임별 그리드전역/보안키보드전역/table·canvas수/grid컨테이너수/password입력칸(id·name·readonly·visible)/보안키패드추정요소 수집. call/get/ping은 향후 스크래핑용 |
| `extension/src/content/shinhan/index.js` | ISOLATED. PROBE → 사람이 읽을 진단 보고서(판정 힌트 포함). SCRAPE는 "미구현 — 먼저 진단" 안내 스텁. `payload.pin`은 향후 사용(메모리만) |
| `extension/src/shared/messages.js` | `SOURCE.SHINHAN="shinhan"`. ScrapeRequest/CollectRequest에 `pin`(무저장) typedef 추가 |
| `extension/src/background/service-worker.js` | `CONTENT_SCRIPTS` 맵 + `adapterFor(source)`/`sourceFromUrl(url)`. probeTab/injectPageBridge/requestScrape를 source별 파일선택으로. PROBE에 source 전달, INJECT_BRIDGE는 sender URL로 역추정. COLLECT의 `pin`을 SCRAPE_REQUEST로 패스스루(저장 경로엔 미포함) |
| `extension/src/popup/{popup.html,popup.js}` | BROKER_HOSTS/LABEL에 신한 추가. 신한 탭이면 **거래 PIN 입력칸 표시**(PIN_SOURCES). 가이드 문구 source별. COLLECT에 pin 동봉(입력 시), PROBE에 source 동봉 |

## PIN 정책 (확정)

- 신한 거래내역 PIN = **로그인 PW 아님**, 거래내역 조회용 2차 비밀번호.
- 사용자가 **수집 시작 시 팝업에서 입력** → COLLECT→SCRAPE 메시지의 `pin` 인자로만 흐름.
- **chrome.storage(pendingPayload/PipelineState) 어디에도 저장 안 함.** 팝업 닫히면 DOM 값도 소멸. 로그인 자동화 없음.
- 보안 키보드면 자동입력 불가할 수 있음 → PROBE로 먼저 판정.

## 전체 조회 페이지 리스트 (확장 계획, 2026-06-18)

canonical: 평가금액=daily_assets, 보유종목=daily_holdings, 거래=transactions.

| # | 영역 | 메뉴 경로 | 매핑 | PIN | 상태 |
|---|------|----------|------|-----|------|
| 1 | 총 자산평가(전계좌+예수금) | 잔고 > 총 자산평가 | daily_assets | 필요 | 미구현 |
| 2 | 국내주식 | 잔고 > 주식/선물옵션 > 주식 탭 > 한화면 조회 | daily_holdings | 분석필요(미언급) | 미구현 |
| 3 | KRX금 | 잔고 > 주식/선물옵션 > KRX금 탭 | daily_holdings | 필요 | 미구현 |
| 4 | 해외주식 | 잔고 > 주식/선물옵션 > 해외주식 탭 > 한화면 조회 | daily_holdings | 필요 | 미구현 |
| 5 | 펀드 | 잔고 > 금융상품 > 한화면 조회 | daily_holdings | 필요 | 미구현 |
| 6 | 신탁/퇴직연금 | 잔고 > 금융상품 > 한화면 조회 | daily_holdings | 필요 | 미구현 |
| 7 | CMA잔고 | 잔고 > CMA잔고 | daily_assets | 분석필요(미언급) | 미구현 |
| 8 | 외화자산잔고(외화예수금) | 잔고 > 외화자산잔고 | daily_assets(외화) | 필요 | 미구현 |
| 9 | 주식거래내역 | 주식거래내역 | transactions | 필요 | ✅ 완료 |

구현 방식: 페이지마다 (1)진단(PROBE)으로 표 헤더/셀렉터·PIN·"한화면 조회" 버튼 확인 → (2)어댑터 함수 추가 → (3)확장 테스트. 2~6은 같은 "주식/선물옵션"·"금융상품" 화면의 탭 전환이라 셀렉터 공유 가능성 높음. PIN 자동입력(완료)·세션 유지(완료) 재사용.

## 구현 진행 (2026-06-18)

- **총 자산평가(1번) → daily_assets 구현.** 페이지 `/myasset/balance/540401`, **PIN 불필요**(확인). 표는 **tblV(세로형 label-value)**. `parseTblVMap`로 라벨→값(순자산평가/총자산평가/예수금합/인출가능금액합). 계좌(#acct-no-combo) 순회 → 계좌별 daily_assets(totalAsset=총자산평가, evalAmount=순자산평가), 예수금합은 daily_holdings name="예수금" 행으로 보존(canonical에 예수금 칼럼 없음). date=오늘(잔고는 현재 스냅샷, 이력 날짜 없음). 팝업 신한 DAILY_ASSET 활성화.
- **자동 순회 진단(handleWalkProbe) 추가.** 팝업 "전체 자동 진단" 버튼 → 메뉴/서브탭 링크를 자동 클릭하며 각 페이지 구조(표 tblH/tblV·헤더·PIN칸·조회버튼·계좌·탭후보)를 한 번에 덤프. 순회 계획: 주식/선물옵션(주식·해외주식·KRX금) / 금융상품(펀드·신탁·퇴직연금) / CMA잔고 / 외화자산잔고 / 주식거래내역 / 총자산평가. PROBE payload.walk=true로 분기(background probeTab 전달). 페이지마다 수동 진단 반복 제거용.
- 페이지 구분: 거래표=tblH(가로형), 잔고요약=tblV(세로형). 계좌 위젯·조회버튼(#search-btn)·PIN(#inq_pw)·fireClick은 공유.

## 페이지 직접 URL (사용자 제공, 2026-06-18) — PAGES 상수

링크 클릭이 새 탭을 열어서, **mainFrame 직접 이동**으로 전환(navUrl). 경로(mainFrame):
| 영역 | path |
|------|------|
| 총자산평가 | /siw/myasset/balance/540401/view.do |
| 주식/선물옵션(국내·해외·KRX금 탭) | /siw/myasset/balance/540101/view.do |
| 금융상품(펀드·신탁·퇴직연금) | /siw/myasset/balance/580001/view.do |
| CMA잔고 | /siw/myasset/balance/540801/view.do |
| 외화자산잔고 | /siw/myasset/balance/foreign_asset/view.do |
| 입출금내역 | /siw/myasset/details/551201/view.do |
| 주식거래내역 | /siw/myasset/details/550501/view.do |
| 금융상품거래내역 | /siw/myasset/details/580801/view.do |
| 종합거래내역 | /siw/myasset/details/551001/view.do |

자동 순회 진단(handleWalkProbe)을 navUrl(직접 이동)로 교체 — 새 탭 안 열림. 잔고형 페이지는 착지 후 서브탭(주식/해외주식/KRX금, 펀드/신탁/퇴직연금) 클릭 덤프.

## 전체 페이지 구조 실측 (자동 순회 진단 결과, 2026-06-18)

| 페이지 | 표 | PIN(id) | 매핑 | 비고 |
|--------|-----|--------|------|------|
| 총자산평가(540401) | tblV 순자산/총자산/예수금합 | 無 | daily_assets | ✅구현 |
| 주식/선물옵션(540101) | tblH 보유: 종목명·수량·평균단가·현재가·평가금액·미실현손익·수익률 / [0]요약(예수금·주식평가금액) | 無 | daily_holdings(국내·해외·KRX금 탭) | ✅구현 |
| 금융상품(580001) | tblV(데이터 PIN後) | `#inq_pw` | daily_holdings(펀드/신탁/퇴직연금) | 미구현 |
| CMA잔고(540801) | tblV 요약 + tblH RP: 매수일자·상품명·원금·이자·세후금액 | 無 | daily_holdings | 미구현 |
| 외화자산(foreign_asset) | tblH: 구분·외화자산·외화예수금·기준환율 + 통화·상품명·매입금액 | **`#acct-pwd`** | daily_assets(외화) | 미구현·PIN id 다름 |
| 입출금내역(551201) | tblH: 거래일시·거래구분·입금·잔액·적요 | 無 | transactions(현금) | 미구현 |
| 주식거래내역(550501) | tblH | `#inq_pw` | transactions | ✅구현 |
| 금융상품거래내역(580801) | tblH: 거래일·코드·상품명·구분·기준가·주문금액·정산금액 | 無 | transactions | 미구현 |
| 종합거래내역(551001) | tblH: 일자·구분·종목번호·수량·거래대금·수수료 | 無 | transactions | 미구현 |

구현(daily_asset 확장): scrapeDailyAsset 이 navUrl 로 총자산평가→주식/선물옵션 자동 이동. 계좌 순회×탭(주식/해외/KRX금) 보유종목 parseHoldingsTable(헤더 종목명·평가금액·수익률, [조회내역]/[한화면] dedupe, buyAmount=평균단가×수량 도출).

금융상품 보유표 구조(PIN 조회 후 실측): tblH "연금저축 조회내역" = 상품명·입금액·평가금액·과세제외금액 (주식과 달리 종목명X·수익률X). 표 제목=상품유형(연금저축/펀드 등).

추가 구현(daily_asset): no-data 행 필터(NO_DATA_RE, 보유·거래 공통). 자동 순회 진단이 세션 PIN으로 PIN 페이지도 조회. 금융상품(parseFundHoldings: 상품명+평가금액, category=표제목, 탭 펀드/신탁/퇴직연금 누적·계좌내 dedupe, PIN #inq_pw 탭마다 재설정) + CMA(parseCmaHoldings: 상품명+원금/세후금액) 수집 추가. scrapeDailyAsset(opts.pin) 받음.

버그수정/개선(실측 피드백):
- 단독 페이지(주소창 직접입력)면 navUrl이 mainFrameWinOrNull()로 mainFrame 엄격 탐색 → 없으면 top 안 건드리고 명확히 throw(이전엔 top 이동→content 종료→"message channel closed"). 수집/진단은 **frameset(정상 로그인→메뉴)** 에서만.
- 탭 전환: `ul.tabType li a`(data-bind moveTab) 정확 클릭 clickTabByText (LNB 동명 링크 오클릭 방지). 주식 보유표 단가 헤더 동적(평균단가/제비용단가) → "단가" 매칭.
- 플로우 page-outer 재구성: 총자산평가(전계좌)→주식/선물옵션(전계좌×탭)→금융상품(전계좌×탭,PIN)→CMA(전계좌). 계좌선택은 페이지 이동에도 유지되지만 페이지 내 계좌별 재선택+조회. 주식 보유표는 div.tableScroll table.tblH(foreach:subResultList).

다음: 외화(#acct-pwd) + 거래내역 계열(입출금/금융상품거래/종합거래).

## 다음 단계 (사용자 실측 후)

1. Edge에서 확장 리로드(`chrome://extensions` 또는 `edge://extensions` → 새로고침).
2. 신한 로그인 탭에서 **나의자산분석 > 잔고**(또는 거래내역 PIN 화면)를 연 상태로 팝업 → **진단(페이지 구조 확인)** 클릭.
3. 보고서를 붙여주면:
   - 잔고표 table/canvas/그리드 → 스크래핑 방식·난이도 확정.
   - PIN 입력칸 readonly/보안모듈 유무 → 자동입력 가능 여부 확정.
4. 확정 후 scraper-engineer로 scrapeDailyAsset/scrapeTransaction + (가능 시)PIN 자동입력 구현.

> 주의: 자산/거래 화면이 **cross-origin 별도 프레임/팝업창**이면 top 브리지가 그 프레임 전역을 못 읽을 수 있음 — 그 경우 해당 창에서 다시 진단하거나, 그 origin을 host_permissions/content_scripts matches에 추가해야 함(보고서의 `crossOrigin`/`(접근불가)` 표기로 식별).

## 실측 결과 (2026-06-17, 1차 PROBE)

프레임 구조(`www.shinhansec.com` `<frameset>` SPA — 미래에셋과 유사):
```
top  index.html (frameset, 표 0)
├─ frame name="mainFrame"  → /siw/myasset/details/550501/view.do  (나의자산분석 잔고)
│    · table 3 · canvas 0 · grid 라이브러리 없음 · same-origin(읽기 가능)
│    · PIN: <input id="inq_pw" name="inq_pw" maxlen=4 readonly=true visible>
│    · 자식 iframe: insider-worker(useinsider.com, 분석툴=무관) + yettie_library_iframe(same-origin)
│    └─ [0] cross-origin = insider-worker (데이터 아님)
└─ frame name="socketFrame" → /util/chat.html (무관)
```

판정:
- **잔고표 = DOM `<table>` (그리드/canvas 아님) → DOM 스크래핑 가능, 난이도 낮음.** mainFrame이 top과 동일출처라 content script가 직접 읽음. 메뉴 네비게이션은 frameset SPA(mainFrame 교체) — 미래에셋 openHp 패턴과 유사, 네비 함수/"한화면 조회" 셀렉터를 덤프로 확인 필요.
- **cross-origin 프레임은 Insider 분석툴**이라 무관 → 추가 origin 권한 불필요.
- **PIN(inq_pw) readonly=true, 단 외부 보안키보드 모듈/키패드요소 미감지** → 신한 자체 가상키패드 또는 단순 readonly 추정. 자동입력 가능 여부는 (a)클릭 시 가상키패드 출현 (b)암호화 hidden 필드 존재로 갈림 → 2차 덤프로 확인.

2차 PROBE 강화(bridge VER2): mainFrame 심화 덤프 추가 — 표 헤더/첫행, 조회·"한화면" 버튼 onclick, inq_pw 폼의 전체 input(hidden 포함), 키패드요소 개수(PIN칸 클릭 전후 비교).

## 실측 결과 (2026-06-17, 2~3차 PROBE + 사용자 확인)

확정 셀렉터(mainFrame, www.shinhansec.com, top과 동일출처 — content script 직접 접근):
| 요소 | 셀렉터 |
|------|--------|
| 거래내역 표 | `table.tblH` (헤더: 일자·종목코드·종목명·구분·수량·가격·금액·수수료·세금·정산금액) |
| 요약표(제외) | `table.tblH` 중 헤더 '구분·건수·수량·매매대금합…' |
| 계좌 선택 | `#acct-no` (사용자 확인: id=acct-no) |
| PIN | `#inq_pw` (readonly=true, **보안키보드 없음** — 클릭 시 키패드 미출현 확인 → JS 주입 가능) |
| 조회 | `#search-btn` |
| 기간 | `#inq_dateFrom` / `#inq_dateTo` (+ hidden `#sdate`/`#edate`) + 라디오 `termSelect`(term01~05) |
| 국내/해외·구분 | `inq_radio1`(2) / `inq_radio2`(3) (의미 미확정 — 테스트로 매핑) |
| 조회 파라미터(hidden) | acctNo, acctNoTxt, sdate, edate, buySell, qryGbn, goodsCode, stockCode, sort, gubun |
| 탭 네비 | `<a>` 텍스트 클릭("주식거래내역" 등; onclick 비어있음=JS 바인딩) |

PIN 확정: 클릭 시 가상키패드 안 뜸 + 외부 보안모듈 없음 + 동반 암호화 hidden 없음 → **JS `.value` 주입(+input/change/keyup 디스패치, readonly 임시해제)으로 자동입력**. setNativeValue로 프레임워크(_e2e_) value 추적 우회.

## 구현 (1차 — 주식거래내역, TRANSACTION)

`extension/src/content/shinhan/index.js` 에 거래내역 스크래퍼 구현:
- `getMainDoc()` mainFrame(동일출처) 직접 접근.
- `getAccounts()`: `#acct-no` 가 `<select>`면 옵션 순회(전계좌), 아니면 현재 hidden(acctNoTxt) 1계좌.
- `queryAccountTxns()`: 계좌선택 → `#inq_pw` PIN 주입 → 기간(표시형+hidden) → `#search-btn` → 표 변화 대기 → 파싱.
- `parseAllTxnTables()`: 거래 헤더(일자·종목명·구분·수량) 가진 `table.tblH`만 파싱(요약표 제외). raw 는 normalizer가 소비하는 camelCase 형태({date,type,name,quantity,amount,fee,unitPrice,...}); 신한 고유값(종목코드/세금/정산금액)은 `detail`에 보존.
- normalizer `buildTransactionPayload`는 소스 무관이라 **수정 불필요**. dividends 자동분리(type ~ /배당|분배금/).
- 팝업: 신한은 '일자별 자산' 비활성(거래내역만), PIN 입력칸 노출.

## 1차 실측 피드백 → 보강 (2026-06-17)

- 계좌 드롭다운은 **커스텀 selectbox 위젯**(`#acct-no`=`<div class="selectbox">`). 내부에 숨은 진짜 `<select id="acct-no-combo">`(옵션 value=하이픈없는 계좌번호) + 클릭용 `<ul class="con"><li><a>`. → 목록은 `#acct-no-combo` 옵션에서 읽고, 선택은 `#acct-no-combobox` 열고 `li a` 텍스트 매칭 클릭(폴백: 숨은 select value 설정). **계좌 2개 순회 성공 확인.**
- 날짜·PIN 입력 성공 확인(setNativeValue + change 디스패치). **PIN 자동입력 동작 확인.**
- `조회`(`#search-btn`, `data-bind="click:on.goRetrieve"` = Knockout식 MVVM) 가 단순 `.click()`으로 안 눌림 → **fireClick**(mousedown/mouseup/click 시퀀스 + native click) + **보이는 버튼 우선** 선택으로 보강.
- **조회 기간 최대 1년 제약** → `splitRangeByYear`로 ≤1년 구간 분할 후 구간별 조회·누적(계좌는 1회 선택, 구간마다 PIN·날짜 재설정).

미검증(2차 실측 필요): 날짜 입력 형식(표시형 YYYY.MM.DD vs hidden YYYYMMDD 중 무엇이 먹히는지), `#acct-no`가 진짜 `<select>`인지(아니면 단일계좌만), 조회 후 행 로딩 방식, 국내/해외 라디오 매핑, 페이지네이션 유무.
