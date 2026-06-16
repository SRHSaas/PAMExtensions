/**
 * 미래에셋증권 content script 어댑터 (securities.miraeasset.com).
 *
 * 역할: **사용자가 이미 로그인한 탭**의 DOM을 긁어 raw(소스 고유, camelCase, 파싱 전)를
 * 반환한다. 숫자 정규화(문자열→숫자), 하이픈 제거, 날짜 `.`→`-`, 배당 분류는 **하지 않는다**
 * — 그건 normalizer(src/normalize/index.js) 몫이다. 여기서는 trim/셀 분리 같은 약한 파싱만 한다.
 *
 * 원본: Playwright 스크래퍼 D:/Github/SRHSaaS/WebPriceTracker/miraeasset/scraper.js 의
 * 셀렉터·페이지 경로(config.json)·플로우를 content script로 이식했다.
 *
 * ── content script 이식의 핵심 난점 (Playwright → 브라우저 확장) ────────────────
 *  1) **격리 월드(isolated world)**: content script는 페이지와 분리된 JS 월드에서 돈다.
 *     페이지 전역 함수/객체(openHp, subTabChange, accountLoaderLayer, hkd1004, dateOfJango,
 *     jQuery datepicker API)를 직접 호출할 수 없다. → 페이지 월드에 RPC 브리지(<script> 주입)를
 *     심어 window.postMessage로 호출/조회한다. (pageCall/pageEval)
 *  2) **contentframe**: 실제 자산/거래 테이블은 동일출처 iframe[name="contentframe"] 안에 있다.
 *     매니페스트가 top frame에만 주입하므로(all_frames 미설정), iframe.contentDocument로 직접
 *     접근한다(same-origin). 페이지 전역도 contentframe.window 쪽에 산다 → 브리지를 그 프레임에 심는다.
 *
 * 정책: 사용자 로그인 전제. 인증/비번 입력 자동화·세션 위조·keepalive 금지. 로그인 시도 코드 없음.
 */

// ⚠ content script는 manifest content_scripts로 주입되어 **클래식 스크립트**로 실행된다
// (background service_worker/popup과 달리 type:module 지정 불가). 따라서 정적 `import`를 쓰면
// 로드 즉시 "Cannot use import statement outside a module"로 스크립트 전체가 죽고 onMessage
// 리스너가 등록되지 않아 "Receiving end does not exist"가 난다. → 이 어댑터가 쓰는 소수 상수만
// 인라인으로 둔다. 값은 src/shared/messages.js(단일 정의)와 **반드시 일치**시킨다(동기화 필수).
const MSG = Object.freeze({ SCRAPE_REQUEST: "SCRAPE_REQUEST", SCRAPE_RESULT: "SCRAPE_RESULT" });
const SCRAPE_TARGET = Object.freeze({ DAILY_ASSET: "dailyAsset", TRANSACTION: "transaction" });
const SOURCE = Object.freeze({ MIRAEASSET: "miraeasset" });

// ─────────────────────────────────────────────────────────────────────────────
// 페이지 경로 (원본 config.json) — openHp(path, secure)로 contentframe을 이동시킨다.
// ─────────────────────────────────────────────────────────────────────────────
const PATHS = {
  login: "/",
  accountAsset: "/hkd/hkd1002/r01.do", // 계좌별자산(일자별 탭 포함)
  transaction: "/hkd/hkd1004/r02.do", // 거래내역(r02 = "거래내역" 탭)
};

// ─────────────────────────────────────────────────────────────────────────────
// 작은 유틸
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** DOM 셀의 텍스트를 trim해 원문에 가까운 문자열로 반환(숫자화 금지). */
function cellText(cell) {
  return (cell?.textContent || "").trim();
}

/**
 * 손익 셀 부호 보정: 원본 Playwright는 em[title="하락"] 존재로 음수를 판정했다.
 * 이 signedness는 텍스트만으로 복구 불가능한 DOM 유래 정보라 raw 단계에서 보존한다.
 * 정규화(콤마 제거·숫자화)는 normalizer가 한다 — 여기서는 음수면 "-"만 접두한다.
 * 원문에 이미 "-"가 있으면 그대로 둔다(중복 부호 방지).
 */
function signedCellText(cell) {
  const text = cellText(cell);
  const isLoss = !!cell?.querySelector('em[title="하락"]');
  if (isLoss && text && !text.startsWith("-")) return "-" + text;
  return text;
}

/**
 * 방어적 파싱 보조: 필수 컨테이너가 없으면 어느 영역/셀렉터가 깨졌는지 담아 throw.
 * 조용한 빈 배열 반환 금지(스킬 원칙).
 */
function requireEl(root, selector, area) {
  const el = root.querySelector(selector);
  if (!el) {
    throw new Error(
      `[miraeasset:${area}] 셀렉터 실패: '${selector}' 를 찾을 수 없습니다. ` +
        `(로그인 만료 또는 DOM 변경 의심)`
    );
  }
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────
// contentframe 접근
// ─────────────────────────────────────────────────────────────────────────────

/** 동일출처 contentframe의 document. 없으면 top document(폴백). */
function getContentDoc() {
  const iframe = document.querySelector('iframe[name="contentframe"]');
  if (iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) return doc;
    } catch (e) {
      throw new Error(
        "[miraeasset] contentframe 접근 실패(cross-origin?). 로그인 탭이 맞는지 확인하세요: " +
          String(e?.message || e)
      );
    }
  }
  return document;
}

/** contentframe의 window(페이지 전역이 사는 곳). 없으면 top window. */
function getContentWin() {
  const iframe = document.querySelector('iframe[name="contentframe"]');
  return (iframe && iframe.contentWindow) || window;
}

// ─────────────────────────────────────────────────────────────────────────────
// 페이지 월드 RPC 브리지
//   격리 월드는 페이지 전역(openHp/subTabChange/accountLoaderLayer/hkd1004/jQuery 등)에
//   접근 못 한다. 페이지 월드에 리스너 <script>를 1회 주입하고 window.postMessage로
//   "이 함수를 호출/이 식을 평가" 요청을 보낸다. 응답도 postMessage로 받는다.
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_TAG = "__pamMiraeBridge__";
let bridgeReady = false;

/** contentframe 월드에 RPC 리스너를 주입(중복 주입 방지). */
function ensureBridge() {
  if (bridgeReady) return;
  const win = getContentWin();
  const doc = win.document;
  if (win[BRIDGE_TAG]) {
    bridgeReady = true;
    return;
  }
  const script = doc.createElement("script");
  // 페이지 월드에서 실행될 코드. 격리 월드의 함수 직렬화가 아니라 "문자열 본문(fn body)"을
  // new Function으로 만들어 실행한다(async 지원). 결과는 postMessage로 회신.
  script.textContent =
    "(" +
    function () {
      const TAG = "__pamMiraeBridge__";
      if (window[TAG]) return;
      window[TAG] = true;
      window.addEventListener("message", async (ev) => {
        const msg = ev.data;
        if (!msg || msg.__pam !== "req") return;
        const { id, body, args } = msg;
        let result = null;
        let error = null;
        try {
          // body: "return ..." 형태의 함수 본문. args를 1개 객체로 받는다.
          // async 본문 지원을 위해 AsyncFunction 사용.
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction("$args", body);
          result = await fn(args);
        } catch (e) {
          error = String((e && e.message) || e);
        }
        window.postMessage({ __pam: "res", id, result, error }, "*");
      });
    }.toString() +
    ")()";
  (doc.head || doc.documentElement).appendChild(script);
  script.remove(); // 실행 후 태그 제거(리스너는 남는다)
  win[BRIDGE_TAG] = true; // 격리 월드 측 캐시 플래그
  bridgeReady = true;
}

let rpcSeq = 0;

/**
 * 페이지 월드에서 함수 본문(body)을 실행하고 결과를 받는다.
 * @param {string} body  "return expr;" 형태의 함수 본문. 인자는 $args(객체)로 접근.
 * @param {object} [args] 직렬화 가능한 인자.
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function pageEval(body, args = {}, timeoutMs = 15000) {
  ensureBridge();
  const win = getContentWin();
  const id = "pam-" + ++rpcSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      win.removeEventListener("message", onMsg);
      reject(new Error("[miraeasset] pageEval 타임아웃: " + body.slice(0, 60)));
    }, timeoutMs);
    function onMsg(ev) {
      const m = ev.data;
      if (!m || m.__pam !== "res" || m.id !== id) return;
      clearTimeout(timer);
      win.removeEventListener("message", onMsg);
      if (m.error) reject(new Error("[miraeasset:pageEval] " + m.error));
      else resolve(m.result);
    }
    win.addEventListener("message", onMsg);
    win.postMessage({ __pam: "req", id, body, args }, "*");
  });
}

/** 페이지 전역 함수를 이름으로 호출(없으면 무시). 예: pageCall("subTabChange", ["2"]). */
function pageCall(fnName, callArgs = []) {
  return pageEval(
    "if (typeof " +
      fnName +
      " === 'function') { return " +
      fnName +
      "(...$args.a); } return '__nofn__';",
    { a: callArgs }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 네비게이션 / 대기 헬퍼 (Playwright page.waitFor* → 폴링 치환)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * contentframe을 pagePath로 이동(openHp 호출) 후 URL 도달 + 대상 셀렉터 등장까지 대기.
 * @param {string} pagePath  PATHS.*
 * @param {string} readySel  도착 후 존재해야 할 셀렉터(영역 진단용)
 * @param {string} area      진단 메시지용 영역명
 */
async function navigateTo(pagePath, readySel, area) {
  await pageCall("openHp", [pagePath, false]);
  // contentframe URL이 목적지를 포함할 때까지 폴링(최대 ~12초)
  await waitFor(
    () => {
      const iframe = document.querySelector('iframe[name="contentframe"]');
      const url = iframe?.contentWindow?.location?.href || "";
      return url.includes(pagePath);
    },
    12000,
    `${area} 페이지(${pagePath}) 로드`
  );
  // 페이지 내 스크립트(계좌목록 ajax 등) 초기화 여유 + 대상 셀렉터 등장 대기
  await sleep(800);
  await waitForSelector(readySel, 12000, area);
}

/** 조건 함수가 true가 될 때까지 폴링. 실패 시 영역/조건을 담아 throw. */
async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    await sleep(250);
  }
  throw new Error(`[miraeasset] 대기 타임아웃: ${what}`);
}

/** contentDoc에 셀렉터가 등장할 때까지 대기(page.waitForSelector 치환). */
async function waitForSelector(selector, timeoutMs, area) {
  await waitFor(
    () => !!getContentDoc().querySelector(selector),
    timeoutMs,
    `[${area}] 셀렉터 '${selector}'`
  );
}

/**
 * 특정 컨테이너의 innerText가 before와 달라질 때까지 대기(ajax 결과 변화 감지).
 * 변화가 없으면(같은/빈 결과) 타임아웃 후 조용히 진행한다(원본 동작과 동일).
 */
async function waitForContentChange(selector, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = getContentDoc().querySelector(selector);
    if (el && el.innerText !== before) break;
    await sleep(200);
  }
  await sleep(300); // 렌더 안정화
}

function snapshotText(selector) {
  const el = getContentDoc().querySelector(selector);
  return el ? el.innerText : "";
}

/**
 * "더보기" 버튼을 행 수가 더 늘지 않을 때까지 반복 클릭(페이지네이션 전부 펼치기).
 * @param {string} tbodySel   행 수를 감시할 tbody
 * @param {() => Promise<boolean>} clickMore  더보기 1회 클릭(클릭했으면 true)
 */
async function expandAll(tbodySel, clickMore) {
  for (let guard = 0; guard < 2000; guard++) {
    const before = getContentDoc().querySelectorAll(tbodySel + " tr").length;
    const clicked = await clickMore();
    if (!clicked) break;
    // 행 수 증가를 최대 6초 대기. 안 늘면 종료.
    let grew = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (getContentDoc().querySelectorAll(tbodySel + " tr").length > before) {
        grew = true;
        break;
      }
      await sleep(150);
    }
    if (!grew) break;
  }
}

/** 날짜 범위의 영업일(평일)을 "YYYY.MM.DD"로 생성(주말 제외). */
function getBusinessDays(startDate, endDate) {
  const days = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, "0");
      const d = String(current.getDate()).padStart(2, "0");
      days.push(`${y}.${m}.${d}`);
    }
    current.setDate(current.getDate() + 1);
  }
  return days;
}

/** "YYYY-MM-DD" → "YYYY.MM.DD" (화면 datepicker 형식). 없으면 null. */
function toScreenDate(isoDate) {
  if (!isoDate) return null;
  return isoDate.replace(/-/g, ".");
}

/**
 * jQuery UI datepicker에 날짜를 설정(원본 pickDateByCalendar의 fast path 이식).
 * 페이지 월드에서 jQuery datepicker API를 직접 호출한다.
 * @param {string} pickerId  "datepicker1" | "datepicker2"
 * @param {string} dateStr   "YYYY.MM.DD"
 */
async function pickDate(pickerId, dateStr) {
  const [y, m, d] = dateStr.split(".").map(Number);
  const ok = await pageEval(
    `
    try {
      var $ = window.jQuery || window.$;
      if (!$ || !$.fn || !$.fn.datepicker) return false;
      var $el = $('#' + $args.pid);
      if ($el.length === 0) return false;
      var target = new Date($args.y, $args.m - 1, $args.d);
      $el.datepicker('setDate', target);
      var onSelect = $el.datepicker('option', 'onSelect');
      if (typeof onSelect === 'function') {
        var fmt = $el.datepicker('option', 'dateFormat') || 'yy.mm.dd';
        var dateText = $.datepicker.formatDate(fmt, target);
        onSelect.call($el[0], dateText, $el.data('datepicker'));
      }
      return true;
    } catch (e) { return false; }
    `,
    { pid: pickerId, y, m, d }
  );
  if (!ok) {
    throw new Error(
      `[miraeasset:date] datepicker '${pickerId}' 설정 실패(${dateStr}). jQuery UI 미로드 의심.`
    );
  }
  await sleep(150);
}

// ─────────────────────────────────────────────────────────────────────────────
// 영역 1: 일자별 자산 (계좌별자산 페이지 → 일자별 탭)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 계좌별자산 페이지로 이동 후 일자별 탭(subTabChange '2')으로 전환.
 * 일자별 테이블(#reportTable01Tbody)이 등장할 때까지 대기.
 */
async function openDailyTab() {
  // 계좌별자산 페이지 진입 — 전체계좌현황 테이블 컨테이너 등장 대기.
  await navigateTo(PATHS.accountAsset, "#hkd1002a01ListTbody, #reportTable01Tbody", "dailyAsset");
  // 일자별 탭 전환(페이지 전역 subTabChange).
  await pageCall("subTabChange", ["2"]);
  await waitForSelector("#reportTable01Tbody", 10000, "dailyAsset");
  await sleep(500);
}

/**
 * 특정 기준일로 일자별자산을 조회(datepicker 설정 → dateOfJango('first') → 변화 대기).
 * @param {string} dateStr "YYYY.MM.DD"
 */
async function queryDailyByDate(dateStr) {
  await pickDate("datepicker1", dateStr);
  const before = snapshotText("#reportTable01Tbody");
  await pageCall("dateOfJango", ["first"]);
  await waitForContentChange("#reportTable01Tbody", before, 8000);
}

/** 전체계좌현황 더보기 모두 펼치기(dateOfJango('more')). */
async function expandDailyAccounts() {
  await expandAll("#reportTable01Tbody", async () => {
    const r = await pageEval(`
      var btn = document.querySelector('#moreListFirst');
      if (btn && btn.style.display !== 'none') {
        if (typeof dateOfJango === 'function') { dateOfJango('more'); return true; }
      }
      return false;
    `);
    return !!r;
  });
}

/** 상품보유현황 더보기 모두 펼치기(dateOfJangoDetail('more')). */
async function expandDailyHoldings() {
  await expandAll("#reportTable02Tbody", async () => {
    const r = await pageEval(`
      var btn = document.querySelector('#moreList');
      if (btn && btn.style.display !== 'none') {
        if (typeof dateOfJangoDetail === 'function') { dateOfJangoDetail('more'); return true; }
      }
      return false;
    `);
    return !!r;
  });
}

/**
 * 현재 일자별자산 페이지의 전체계좌현황(accounts) + 상품보유현황(holdings)을 DOM 파싱.
 * 원본 parseDailyAssetPage의 셀 인덱스를 그대로 이식하되 **문자열 그대로**(숫자화 금지)로 둔다.
 *   accounts cells: [0]계좌번호 [1]구분 [2]자산총액 [3]평가금액 [4]평가손익 [5]수익률
 *   holdings cells: [0]종목명 [1]구분 [2]수량 [3]매입금액 [4]평가금액 [5]평가손익 [6]수익률
 * 일자별 화면에는 alias 컬럼이 없으므로 accounts.alias는 빈 문자열로 둔다(계좌별자산 탭에만 존재).
 */
function parseDailyAssetPage(doc) {
  const acctTbody = requireEl(doc, "#reportTable01Tbody", "dailyAsset.accounts");
  const accounts = Array.from(acctTbody.querySelectorAll("tr"))
    .map((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 6) return null; // "내역 없음" 행 방어
      return {
        accountNo: cellText(cells[0]),
        accountType: cellText(cells[1]),
        alias: "", // 일자별 탭에는 별칭 컬럼이 없음(normalizer는 ""을 NULL 취급)
        totalAsset: cellText(cells[2]),
        evalAmount: cellText(cells[3]),
        profitLoss: signedCellText(cells[4]),
        profitRate: cellText(cells[5]),
      };
    })
    .filter(Boolean);

  const holdTbody = requireEl(doc, "#reportTable02Tbody", "dailyAsset.holdings");
  const holdings = Array.from(holdTbody.querySelectorAll("tr"))
    .map((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 7) return null;
      return {
        name: cellText(cells[0]),
        category: cellText(cells[1]),
        quantity: cellText(cells[2]),
        buyAmount: cellText(cells[3]),
        evalAmount: cellText(cells[4]),
        profitLoss: signedCellText(cells[5]),
        profitRate: cellText(cells[6]),
      };
    })
    .filter(Boolean);

  return { accounts, holdings };
}

/**
 * 일자별 자산 raw 수집. range(YYYY-MM-DD) 영업일을 순회하며 날짜별 raw를 모은다.
 * range 미지정 시 오늘 하루만 수집(어댑터는 범위만 받아 수집 — 증분 상태는 background 책임).
 *
 * @param {{startDate?:string, endDate?:string}} [range]
 * @returns {Promise<object[]>}  §3 dailyAsset raw 배열: [{ kind, date, accounts[], holdings[] }, ...]
 */
async function scrapeDailyAsset(range = {}) {
  await openDailyTab();

  const start = toScreenDate(range.startDate);
  const end = toScreenDate(range.endDate);
  let dates;
  if (start && end) {
    dates = getBusinessDays(range.startDate, range.endDate);
  } else if (start) {
    dates = [start];
  } else {
    // 기본: 오늘 하루(화면 기본 기준일). 영업일 아니면 그대로 조회(빈 결과일 수 있음).
    const t = new Date();
    dates = [
      `${t.getFullYear()}.${String(t.getMonth() + 1).padStart(2, "0")}.${String(
        t.getDate()
      ).padStart(2, "0")}`,
    ];
  }

  const out = [];
  for (const dateStr of dates) {
    try {
      await queryDailyByDate(dateStr);
      await expandDailyAccounts();
      await expandDailyHoldings();
      const { accounts, holdings } = parseDailyAssetPage(getContentDoc());
      out.push({ kind: "dailyAsset", date: dateStr, accounts, holdings });
    } catch (err) {
      // 한 날짜 실패는 전체를 막지 않는다(원본 동작) — 누락을 raw에 기록.
      out.push({
        kind: "dailyAsset",
        date: dateStr,
        accounts: [],
        holdings: [],
        _skipped: String(err?.message || err),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 영역 2: 거래내역
// ─────────────────────────────────────────────────────────────────────────────

/** 거래내역 페이지(r02)로 이동. 계좌 드롭다운(#userAccountList) 또는 조회표 컨테이너 등장 대기. */
async function openTransactionPage() {
  await navigateTo(PATHS.transaction, "#userAccountList, #simpleTable", "transaction");
  await sleep(800);
}

/**
 * 거래내역 계좌 목록 조회(페이지 전역 accountLoaderLayer.list 우선, 폴백 DOM).
 * raw로 acno/name/index/label만 반환(하이픈은 acno에 그대로 둘 수 있음).
 * @returns {Promise<{index:number, acno:string, name:string, label:string}[]>}
 */
async function getTransactionAccounts() {
  const list = await pageEval(`
    if (typeof accountLoaderLayer !== 'undefined' && accountLoaderLayer.list) {
      return accountLoaderLayer.list.map(function (item, i) {
        return {
          index: i,
          acno: item.acno || '',
          name: item.ac_nnm_nm || item.ac_nm || '',
          label: (item.acno || '') + ' ' + (item.ac_nnm_nm || '')
        };
      });
    }
    var items = document.querySelectorAll('#userAccountList li a');
    return Array.prototype.map.call(items, function (a) {
      var acc = a.querySelector('.account');
      var nm = a.querySelector('.account_name');
      return {
        index: parseInt(a.getAttribute('data-index') || '0', 10),
        acno: (acc ? acc.textContent : '').trim(),
        name: (nm ? nm.textContent : '').trim(),
        label: ((acc ? acc.textContent : '').trim() + ' ' + (nm ? nm.textContent : '').trim()).trim()
      };
    });
  `);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      "[miraeasset:transaction] 계좌 목록을 찾을 수 없습니다 " +
        "(accountLoaderLayer.list / #userAccountList 모두 비어있음). 로그인 만료 의심."
    );
  }
  return list;
}

/** 거래내역에서 계좌를 인덱스로 선택(accountLoaderLayer.onClickAccount). */
async function selectTransactionAccount(accountIndex) {
  await pageEval(
    `
    if (typeof accountLoaderLayer !== 'undefined' && accountLoaderLayer.onClickAccount) {
      accountLoaderLayer.onClickAccount($args.idx);
    } else {
      var link = document.querySelector('#userAccountList li a[data-index="' + $args.idx + '"]');
      if (link) link.click();
    }
    return true;
  `,
    { idx: accountIndex }
  );
  await sleep(1500);
}

/** 거래내역 조회 기간 설정(시작 datepicker1, 종료 datepicker2) + 조회 버튼 클릭. */
async function queryTransaction(startScreen, endScreen) {
  await pickDate("datepicker1", startScreen);
  await pickDate("datepicker2", endScreen);
  const before = snapshotText("#simpleTable tbody");
  await pageEval(`
    var btn = document.querySelector('#searchButton');
    if (btn) btn.click();
    return true;
  `);
  await waitForContentChange("#simpleTable tbody", before, 10000);
}

/** 거래내역 "간단히" 더보기(#moreListS) 전부 펼치기. */
async function expandTransactions() {
  await expandAll("#simpleTable tbody", async () => {
    const r = await pageEval(`
      var wrap = document.querySelector('#moreListS');
      if (wrap && wrap.style.display !== 'none') {
        var btn = wrap.querySelector('a');
        if (btn) { btn.click(); return true; }
      }
      return false;
    `);
    return !!r;
  });
}

/**
 * #simpleTable 거래 테이블 + 페이지 원시데이터(hkd1004.list)를 조인해 raw 거래 배열을 만든다.
 * 헤더: [0]거래일자 [1]거래종류 [2]종목명 [3]거래수량 [4]거래금액(원화) [5]외화거래금액 [6]수수료 [7]예수금잔고
 *
 * 보강(원본 parseTransactionTable 이식 — **문자열 그대로** 유지):
 *  - unitPrice: hkd1004.list[i].tr_upr (거래단가)
 *  - currency : curr_cd (외화 통화코드)
 *  - 국내 소수거래("(소수)" 접미)는 표시수량이 백만분의1주(micro) 단위 → 표시수량을 brokerQuantity로
 *    보존하고 quantity는 실수량 문자열(microQty/1e6)로 둔다. (이 1e6 보정은 단위환산이지 정규화가 아님)
 *  - detail: 진단/추적용 원시 식별자(tr_srno 등) 보관(키 안정성).
 * 환율(exchangeRate)은 별도 a03.json 보강에서 채운다(enrichFxRates).
 *
 * 이 함수는 페이지 월드에서 한 번에 실행(테이블+hkd1004.list 접근). 반환은 직렬화 가능한 배열.
 */
async function parseTransactionTable() {
  const rows = await pageEval(`
    var tbody = document.querySelector('#simpleTable tbody');
    if (!tbody) return { __err: "거래표(#simpleTable tbody) 없음" };
    var rawList = (typeof hkd1004 !== 'undefined' && hkd1004.list && hkd1004.list.length >= 0)
      ? hkd1004.list : null;
    var trs = tbody.querySelectorAll('tr');
    var out = [];
    for (var ri = 0; ri < trs.length; ri++) {
      var cells = trs[ri].querySelectorAll('td');
      if (cells.length < 2) continue;
      if (cells[0] && cells[0].classList && cells[0].classList.contains('no_data')) continue;
      var link = cells[1] ? cells[1].querySelector('a') : null;
      var dataIndex = link ? parseInt(link.getAttribute('data-index'), 10) : -1;
      var raw = (rawList && dataIndex >= 0) ? rawList[dataIndex] : null;
      var txt = function (c) { return (c && c.textContent ? c.textContent : '').trim(); };
      var rec = {
        date: txt(cells[0]),
        type: txt(cells[1]),
        name: txt(cells[2]),
        quantity: txt(cells[3]),
        amount: txt(cells[4]),
        foreignAmount: txt(cells[5]),
        fee: txt(cells[6]),
        balance: txt(cells[7]),
        unitPrice: "",
        brokerQuantity: "",
        exchangeRate: "",
        currency: "",
        detail: null
      };
      if (raw) {
        var up = parseFloat(raw.tr_upr);
        if (!isNaN(up) && up > 0) rec.unitPrice = String(up);
        if (raw.curr_cd) rec.currency = String(raw.curr_cd);
        if (/\\(소수\\)$/.test(rec.name)) {
          var microQty = parseFloat(raw.tr_q) || 0;
          rec.brokerQuantity = rec.quantity;          // 표시 micro 수량 보존
          rec.quantity = String(microQty / 1e6);      // 실수량(단위환산)
          rec.detail = {
            src: 'hkd1004.list',
            tr_srno: raw.tr_srno,
            tr_q_raw: raw.tr_q,
            tr_upr: raw.tr_upr,
            curr_cd: raw.curr_cd
          };
        }
        // FX 환율 보강용 식별자(스크립트 내부 사용 후 응답에 포함; 보강 후 detail로 이관)
        rec.__fx = (raw.curr_cd && (parseFloat(raw.tr_q) || 0) > 0)
          ? { tr_dt: raw.tr_dt, tr_srno: raw.tr_srno } : null;
      }
      out.push(rec);
    }
    return { rows: out };
  `);

  if (rows && rows.__err) {
    throw new Error("[miraeasset:transaction] " + rows.__err);
  }
  return (rows && rows.rows) || [];
}

/**
 * 외화 거래의 기준환율(bas_exr)을 거래내역상세 API(a03.json)로 보강.
 * 팝업 없이 페이지 내 jQuery.ajax 직접 호출(원본 enrichFxRates 이식).
 * exchangeRate는 raw 문자열 그대로 둔다(숫자화는 normalizer).
 * @param {object[]} transactions  parseTransactionTable 결과(각 rec.__fx 보유 가능)
 */
async function enrichFxRates(transactions) {
  const targets = transactions.filter((t) => t.__fx);
  if (targets.length === 0) return;

  const params = targets.map((t) => t.__fx);
  const results = await pageEval(
    `
    if (typeof hkd1004 === 'undefined' || !hkd1004.account || typeof jQuery === 'undefined') {
      return null;
    }
    var acno = hkd1004.account.acno;
    var items = $args.items;
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      try {
        var data = await new Promise(function (resolve) {
          jQuery.ajax({
            type: 'POST',
            url: '/hkd/hkd1004/a03.json',
            data: { acno: acno, header_account: acno, tr_dt: it.tr_dt, tr_srno: it.tr_srno },
            success: function (d) { resolve(d); },
            error: function () { resolve(null); }
          });
        });
        var r = data && data.DLCTN && data.DLCTN[0];
        out.push(r ? {
          bas_exr: r.bas_exr, curr_cd: r.curr_cd, frc_tr_a: r.frc_tr_a,
          tr_upr: r.tr_upr, frc_fee: r.frc_fee
        } : null);
      } catch (e) { out.push(null); }
    }
    return out;
  `,
    { items: params },
    60000
  );

  if (!results) return; // hkd1004.account/jQuery 없음 — 보강 생략(환율 빈 문자열 유지)

  for (let i = 0; i < targets.length; i++) {
    const tx = targets[i];
    const rec = results[i];
    if (!rec) continue;
    if (rec.bas_exr != null && String(rec.bas_exr) !== "0") {
      tx.exchangeRate = String(rec.bas_exr); // 문자열 그대로(normalizer가 숫자화)
    }
    if (rec.curr_cd) tx.currency = String(rec.curr_cd);
    tx.detail = {
      ...(tx.detail || {}),
      bas_exr: rec.bas_exr,
      frc_tr_a_precise: rec.frc_tr_a,
      frc_fee_precise: rec.frc_fee,
    };
  }
}

/**
 * 거래내역 raw 수집. range(YYYY-MM-DD) 기간으로 **모든 계좌**를 순회해 계좌별 raw를 모은다.
 * range 미지정 시 화면 기본 기간(보통 최근 N개월)을 그대로 조회한다.
 *
 * @param {{startDate?:string, endDate?:string}} [range]
 * @returns {Promise<object[]>}  §3 transaction raw 배열: [{ kind, acno, account, transactions[] }, ...]
 */
async function scrapeTransaction(range = {}) {
  await openTransactionPage();
  const accounts = await getTransactionAccounts();

  const startScreen = toScreenDate(range.startDate);
  const endScreen = toScreenDate(range.endDate);
  const haveRange = !!(startScreen && endScreen);

  const out = [];
  for (let ai = 0; ai < accounts.length; ai++) {
    const acc = accounts[ai];
    try {
      // 계좌 변경 시 페이지 상태 초기화를 위해 두 번째 계좌부터 재이동(원본 흐름과 동일).
      if (ai > 0) {
        await openTransactionPage();
      }
      await selectTransactionAccount(acc.index);
      if (haveRange) {
        await queryTransaction(startScreen, endScreen);
      } else {
        // 범위 미지정: 화면 기본 기간으로 조회 버튼만 클릭.
        const before = snapshotText("#simpleTable tbody");
        await pageEval(`var b=document.querySelector('#searchButton'); if(b)b.click(); return true;`);
        await waitForContentChange("#simpleTable tbody", before, 10000);
      }
      await expandTransactions();

      const txns = await parseTransactionTable();
      await enrichFxRates(txns);

      // 내부 식별 필드(__fx) 제거 — raw 출력에서 빠진다.
      for (const t of txns) delete t.__fx;

      out.push({
        kind: "transaction",
        acno: acc.acno, // 하이픈 포함 가능(raw 그대로; normalizer가 제거)
        account: acc.label,
        transactions: txns,
      });
    } catch (err) {
      out.push({
        kind: "transaction",
        acno: acc.acno,
        account: acc.label,
        transactions: [],
        _skipped: String(err?.message || err),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 메시지 핸들러 (계약 §6) — SCRAPE_REQUEST → ScrapeResultPayload 반환
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SCRAPE_REQUEST 처리. background는 target별로 1건씩 보내므로 payload.targets[0]로 디스패치.
 * @param {import("../../shared/messages.js").ScrapeRequestPayload} payload
 * @returns {Promise<import("../../shared/messages.js").ScrapeResultPayload>}
 */
async function handleScrape(payload) {
  const source = payload?.source || SOURCE.MIRAEASSET;
  const target = (payload?.targets && payload.targets[0]) || SCRAPE_TARGET.DAILY_ASSET;
  const range = payload?.range || {};

  try {
    let raw;
    if (target === SCRAPE_TARGET.DAILY_ASSET) {
      raw = await scrapeDailyAsset(range);
    } else if (target === SCRAPE_TARGET.TRANSACTION) {
      raw = await scrapeTransaction(range);
    } else {
      throw new Error(`[miraeasset] 알 수 없는 target: ${target}`);
    }
    return { source, target, ok: true, raw };
  } catch (err) {
    return {
      source,
      target,
      ok: false,
      error: String(err?.message || err),
    };
  }
}

// content script는 manifest로 자동 주입된다(document_idle). SCRAPE_REQUEST만 처리하고
// SCRAPE_RESULT payload를 응답(return true + sendResponse)으로 돌려준다.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG.SCRAPE_REQUEST) return false;
  handleScrape(message.payload || {})
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        source: message.payload?.source || SOURCE.MIRAEASSET,
        target: (message.payload?.targets && message.payload.targets[0]) || null,
        ok: false,
        error: String(err?.message || err),
      })
    );
  return true; // 비동기 응답.
});
