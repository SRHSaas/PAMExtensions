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
 *     jQuery datepicker API)를 직접 호출할 수 없다.
 *  2) **사이트 CSP**: securities.miraeasset.com 은 `script-src 'self' 'wasm-unsafe-eval'`
 *     이라 (a) 인라인 <script> 주입 불가, (b) eval/new Function 불가. 따라서 "임의 코드 본문을
 *     페이지 월드에서 eval" 하는 방식은 못 쓴다. → 페이지 월드 접근은 별도 MAIN-world content
 *     script(page-bridge.js, manifest 주입)가 담당하고, 여기(ISOLATED)는 **고정 명령**
 *     (ping/call/get/setdate/fxrates)만 postMessage 로 보낸다. eval 코드 문자열을 보내지 않는다.
 *  3) **contentframe**: 실제 자산/거래 테이블은 동일출처 iframe[name="contentframe"] 안에 있다.
 *     이 어댑터는 top frame에만 주입되므로(all_frames 미설정) iframe.contentDocument로 DOM을
 *     직접 읽고(same-origin), 페이지 JS 전역은 그 iframe의 MAIN-world 브리지에 명령을 보내 접근한다.
 *     (page-bridge.js 는 all_frames:true 라 contentframe MAIN world 에도 설치되어 있다.)
 *
 * ── 월드 경계 요약 ───────────────────────────────────────────────────────────
 *  - DOM 읽기/클릭(테이블 파싱, #searchButton·#moreList* 클릭): **ISOLATED 직접**(getContentDoc()).
 *  - 페이지 JS 함수 트리거(openHp / subTabChange / dateOfJango / dateOfJangoDetail /
 *      accountLoaderLayer.onClickAccount): bridgeCall(fn, args).
 *  - 페이지 JS 데이터 읽기(accountLoaderLayer.list, hkd1004.list): bridgeGet(path).
 *  - jQuery datepicker 설정: bridgeSetDate(). 외화 환율 a03.json ajax: bridgeFxRates().
 *
 * 정책: 사용자 로그인 전제. 인증/비번 입력 자동화·세션 위조·keepalive 금지. 로그인 시도 코드 없음.
 */

// ⚠ content script는 manifest content_scripts로 주입되어 **클래식 스크립트**로 실행된다
// (background service_worker/popup과 달리 type:module 지정 불가). 따라서 정적 `import`를 쓰면
// 로드 즉시 "Cannot use import statement outside a module"로 스크립트 전체가 죽고 onMessage
// 리스너가 등록되지 않아 "Receiving end does not exist"가 난다. → 이 어댑터가 쓰는 소수 상수만
// 인라인으로 둔다. 값은 src/shared/messages.js(단일 정의)와 **반드시 일치**시킨다(동기화 필수).

// ── 멱등 가드(중복 주입 방어) ───────────────────────────────────────────────────
// content script가 한 문서에 두 번 주입되면(선언형 content_scripts + background의 inject 폴백
// executeScript) 최상위 `const MSG` 재선언으로 "Identifier 'MSG' has already been declared"가 나
// 스크립트가 통째로 깨지고 리스너가 망가진다(→ "message channel closed"). 전체를 IIFE+가드로 감싸
// 두 번째 주입은 즉시 return 한다. (페이지가 이동하면 새 문서의 isolated world라 플래그가 리셋돼
// 정상적으로 재주입된다.)
(function () {
  if (window.__pamMiraeContentLoaded__) return;
  window.__pamMiraeContentLoaded__ = true;

const MSG = Object.freeze({
  SCRAPE_REQUEST: "SCRAPE_REQUEST",
  SCRAPE_RESULT: "SCRAPE_RESULT",
  INJECT_BRIDGE: "INJECT_BRIDGE", // ↔ src/shared/messages.js MSG.INJECT_BRIDGE (동기화 필수)
  PROBE: "PROBE", // ↔ src/shared/messages.js MSG.PROBE (동기화 필수)
});
const SCRAPE_TARGET = Object.freeze({ DAILY_ASSET: "dailyAsset", TRANSACTION: "transaction" });
const SOURCE = Object.freeze({ MIRAEASSET: "miraeasset" });

// page-bridge.js 의 VER 과 동기화. ping 응답 ver 이 이 값과 다르면 스테일/구버전 브리지로 보고
// 핫스왑(INJECT_BRIDGE 재주입)한다. 확장 리로드 후 페이지 새로고침 없이 브리지가 갱신되도록.
const EXPECTED_BRIDGE_VER = 4; // ⚠ page-bridge.js VER 과 함께 증가.

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

/**
 * contentframe의 window를 **이름 기반**으로 찾는다. 미래에셋은 <frameset>/<frame> 구조라
 * `iframe[name=...]` 요소 질의로는 못 찾는다(실측 확인). window.frames 이름 접근은
 * <frame>·<iframe> 모두 동작한다(Playwright page.frame("contentframe")과 동일 원리).
 * @returns {Window|null}
 */
function getContentFrameWin() {
  // 1) 이름 기반 프레임 접근 — <frame>/<iframe> 무관.
  try {
    const w = window.frames["contentframe"];
    if (w) return w;
  } catch (e) {
    /* ignore */
  }
  // 2) window.frames 순회(window.name 기준).
  try {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        if (window.frames[i].name === "contentframe") return window.frames[i];
      } catch (e) {
        /* cross-origin 프레임 — 스킵 */
      }
    }
  } catch (e) {
    /* ignore */
  }
  // 3) 폴백: 요소 질의(iframe 또는 frame).
  try {
    const el = document.querySelector('iframe[name="contentframe"], frame[name="contentframe"]');
    if (el && el.contentWindow) return el.contentWindow;
  } catch (e) {
    /* ignore */
  }
  return null;
}

/** 동일출처 contentframe의 document. 없으면 top document(폴백). */
function getContentDoc() {
  const win = getContentFrameWin();
  if (win) {
    try {
      const doc = win.document;
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

// ─────────────────────────────────────────────────────────────────────────────
// 페이지 월드 브리지 클라이언트 (CSP-safe, eval 없음, **same-frame messaging**)
//   페이지 JS 전역(함수/데이터)은 MAIN-world content script(page-bridge.js)가 접근한다.
//   여기(ISOLATED)는 **고정 명령**만 postMessage 로 보내고 응답을 받는다. 코드 본문 전송 없음.
//   명령: ping / call(fn,args) / get(path) / setdate / fxrates  — 자세한 계약은 page-bridge.js.
//
//   ★ 토폴로지(중요): ISOLATED 와 MAIN 브리지는 **둘 다 top 프레임**에서 돌며, 같은 프레임의
//     window message 버스를 공유한다. 따라서 **자기 window** 에 postMessage 하고 **자기 window**
//     에서 응답을 듣는다. (iframe.contentWindow 로 cross-frame postMessage/수신 하던 패턴은 폐기
//     — 월드 경계상 신뢰 불가였다.) contentframe 전역 접근은 브리지가 내부에서 직접 한다.
// ─────────────────────────────────────────────────────────────────────────────

let rpcSeq = 0;

/**
 * 브리지에 명령 1건을 보내고 응답을 받는다(저수준, same-frame). 응답은 {__pam:"res", id, ...payload}.
 * @param {object} req  { cmd, ...명령필드 } — id 는 내부에서 부여.
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}  브리지 payload(예: {found,result} / {value} / {ok,rows} ...)
 */
function bridgeSend(req, timeoutMs = 15000) {
  const id = "pam-" + ++rpcSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(
        new Error(
          `[miraeasset] 브리지 응답 타임아웃(cmd=${req.cmd}). ` +
            `page-bridge.js(MAIN world) 미설치 또는 미응답.`
        )
      );
    }, timeoutMs);
    function onMsg(ev) {
      // same-frame 응답만 신뢰: 자기 window 가 보낸(자기 origin) __pam res.
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || m.__pam !== "res" || m.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      if (m.error) reject(new Error("[miraeasset:bridge] " + m.error));
      else resolve(m);
    }
    window.addEventListener("message", onMsg);
    // 자기 window 로 전송(same-frame). 같은 프레임 MAIN 브리지가 같은 버스에서 받는다.
    window.postMessage(Object.assign({ __pam: "req", id }, req), window.location.origin);
  });
}

/** background 에 MAIN-world 브리지 주입을 요청(선언형 주입 실패 폴백). 성공 여부 반환. */
async function requestBridgeInjection() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.INJECT_BRIDGE });
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

/** 진단용: contentframe(프레임셋 <frame> 또는 <iframe>)이 존재하는지(이름 기반). */
function hasContentFrame() {
  return !!getContentFrameWin();
}

/**
 * 준비 핸드셰이크(same-frame ping/pong). 브리지가 응답할 때까지 폴링하되, 일정 시간 무응답이면
 * background 에 programmatic 주입(INJECT_BRIDGE)을 1회 요청하고 다시 폴링한다.
 * iframe 네비게이션(openHp) 후에도 브리지는 top 프레임에 한 번 설치돼 있으면 그대로라
 * 매번 가볍게 재확인만 한다(보통 즉시 pong).
 * @param {number} [timeoutMs]  총 대기 한도
 */
async function ensureBridge(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;
  let lastErr = null;
  // 1차: 선언형 주입된 브리지가 응답하는지 짧게 폴링.
  while (Date.now() < deadline) {
    try {
      const res = await bridgeSend({ cmd: "ping" }, 1200);
      if (res && res.result === "pong") {
        if (res.ver === EXPECTED_BRIDGE_VER) return true;
        // 스테일/구버전 브리지(ver 불일치 또는 ver 없음) → 핫스왑 주입을 즉시 1회 시도.
        if (!injected) {
          injected = await requestBridgeInjection();
          await sleep(300);
        }
        // 핫스왑 후 새 버전이 응답하도록 다음 폴링으로 재확인.
      }
    } catch (e) {
      lastErr = e;
    }
    // 첫 무응답 구간(~2.5초) 후 programmatic 주입 폴백 1회 시도.
    if (!injected && Date.now() - (deadline - timeoutMs) > 2500) {
      injected = await requestBridgeInjection();
      // 주입 직후 설치/실행 여유.
      await sleep(300);
    }
    await sleep(200);
  }
  throw new Error(
    "[miraeasset] 페이지 브리지 준비 실패(same-frame ping 무응답). " +
      `경로=same-frame(top window), 주입폴백시도=${injected}, contentframe존재=${hasContentFrame()}. ` +
      "page-bridge.js(MAIN world) 주입 또는 CSP/world 지원(Chrome·Edge 111+) 확인 필요. " +
      (lastErr ? String(lastErr.message || lastErr) : "")
  );
}

/**
 * 페이지 전역 함수를 호출(점경로 허용). 함수가 없으면 found:false 를 반환받아 무시한다.
 * @param {string} fn  예: "openHp", "subTabChange", "accountLoaderLayer.onClickAccount"
 * @param {any[]} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<{found:boolean, result?:any}>}
 */
async function bridgeCall(fn, args = [], timeoutMs = 15000) {
  return bridgeSend({ cmd: "call", fn, args }, timeoutMs);
}

/**
 * 페이지 전역 데이터를 점경로로 읽는다(구조화복제 가능한 1차 데이터만; DOM/함수 제외).
 * @param {string} path  예: "accountLoaderLayer.list", "hkd1004.list"
 * @returns {Promise<any>}  값(없으면 undefined)
 */
async function bridgeGet(path, timeoutMs = 15000) {
  const res = await bridgeSend({ cmd: "get", path }, timeoutMs);
  return res ? res.value : undefined;
}

/**
 * jQuery UI datepicker 날짜 설정(페이지 월드 고정 로직).
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function bridgeSetDate(pickerId, y, m, d, timeoutMs = 15000) {
  return bridgeSend({ cmd: "setdate", pickerId, y, m, d }, timeoutMs);
}

/**
 * 외화 거래 기준환율 보강(a03.json ajax 고정 루프, 페이지 월드).
 * @param {{tr_dt:string, tr_srno:string}[]} items
 * @returns {Promise<{ok:boolean, rows?:Array, reason?:string}>}
 */
async function bridgeFxRates(items, timeoutMs = 60000) {
  return bridgeSend({ cmd: "fxrates", items }, timeoutMs);
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
  // 단독(standalone) 자산 페이지 방어: 정상 미래에셋은 프레임셋(top=securities.miraeasset.com +
  // contentframe)이라 openHp가 contentframe을 이동시키고 top의 content script는 살아남는다.
  // 그런데 자산 페이지(/hkd/...)가 top 프레임 자체이면(contentframe 없음) openHp가 top을 reload해
  // 이 content script를 종료시킨다 → "message channel closed". 명확히 안내하고 중단한다.
  if (!getContentFrameWin()) {
    throw new Error(
      "[miraeasset] 단독 자산 페이지에서는 수집할 수 없습니다 — 페이지 이동이 확장을 종료시킵니다. " +
        "주소창을 'https://securities.miraeasset.com/'(프레임셋 홈)으로 이동해 로그인 상태에서 다시 '수집'하세요. " +
        "확장이 자산 페이지로 알아서 이동합니다."
    );
  }
  // openHp 는 페이지 전역 함수 → top 프레임 브리지가 top→contentframe 자동 탐색해 호출.
  // 브리지는 top 프레임에 한 번 설치되면 iframe 네비게이션과 무관하게 유지되므로
  // 여기서 한 번만 준비 확인하면 된다(same-frame).
  await ensureBridge();
  const callRes = await bridgeCall("openHp", [pagePath, false]);
  if (callRes && callRes.found === false) {
    throw new Error(`[miraeasset:${area}] 페이지 전역 openHp 가 없습니다(로그인/페이지 상태 의심).`);
  }
  // contentframe URL이 목적지를 포함할 때까지 폴링(최대 ~12초)
  await waitFor(
    () => {
      const win = getContentFrameWin();
      let url = "";
      try {
        url = win?.location?.href || "";
      } catch (e) {
        url = "";
      }
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
 * 페이지 월드 jQuery datepicker API 호출은 브리지의 고정 setdate 명령으로 수행한다.
 * @param {string} pickerId  "datepicker1" | "datepicker2"
 * @param {string} dateStr   "YYYY.MM.DD"
 */
async function pickDate(pickerId, dateStr) {
  const [y, m, d] = dateStr.split(".").map(Number);
  const res = await bridgeSetDate(pickerId, y, m, d);
  if (!res || !res.ok) {
    throw new Error(
      `[miraeasset:date] datepicker '${pickerId}' 설정 실패(${dateStr}). ` +
        `사유: ${res?.reason || "unknown"} (jQuery UI 미로드 의심).`
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
  await bridgeCall("subTabChange", ["2"]);
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
  await bridgeCall("dateOfJango", ["first"]);
  await waitForContentChange("#reportTable01Tbody", before, 8000);
}

/**
 * "더보기" 버튼의 표시 여부는 ISOLATED 에서 DOM 으로 직접 판정하고(getContentDoc),
 * 실제 더보기 트리거(페이지 전역 함수)만 브리지로 호출한다.
 * @param {string} btnSel   더보기 버튼 셀렉터
 * @param {string} fnName   더보기 페이지 함수명(dateOfJango / dateOfJangoDetail)
 * @returns {Promise<boolean>} 클릭(트리거) 수행 여부
 */
async function clickDailyMore(btnSel, fnName) {
  const btn = getContentDoc().querySelector(btnSel);
  if (!btn || btn.style.display === "none") return false;
  const res = await bridgeCall(fnName, ["more"]);
  return !(res && res.found === false);
}

/** 전체계좌현황 더보기 모두 펼치기(dateOfJango('more')). */
async function expandDailyAccounts() {
  await expandAll("#reportTable01Tbody", () => clickDailyMore("#moreListFirst", "dateOfJango"));
}

/** 상품보유현황 더보기 모두 펼치기(dateOfJangoDetail('more')). */
async function expandDailyHoldings() {
  await expandAll("#reportTable02Tbody", () =>
    clickDailyMore("#moreList", "dateOfJangoDetail")
  );
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
  // 1순위: 페이지 전역 데이터 accountLoaderLayer.list (브리지 get — 구조화복제 가능 데이터).
  const pageList = await bridgeGet("accountLoaderLayer.list");
  let list = [];
  if (Array.isArray(pageList) && pageList.length > 0) {
    list = pageList.map((item, i) => ({
      index: i,
      acno: item.acno || "",
      name: item.ac_nnm_nm || item.ac_nm || "",
      label: ((item.acno || "") + " " + (item.ac_nnm_nm || "")).trim(),
    }));
  } else {
    // 폴백: DOM 직접 읽기(ISOLATED). #userAccountList li a > .account / .account_name
    const doc = getContentDoc();
    const anchors = doc.querySelectorAll("#userAccountList li a");
    list = Array.from(anchors).map((a) => {
      const acc = a.querySelector(".account");
      const nm = a.querySelector(".account_name");
      const acno = (acc ? acc.textContent : "").trim();
      const name = (nm ? nm.textContent : "").trim();
      return {
        index: parseInt(a.getAttribute("data-index") || "0", 10),
        acno,
        name,
        label: (acno + " " + name).trim(),
      };
    });
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      "[miraeasset:transaction] 계좌 목록을 찾을 수 없습니다 " +
        "(accountLoaderLayer.list / #userAccountList 모두 비어있음). 로그인 만료 의심."
    );
  }
  return list;
}

/** 거래내역에서 계좌를 인덱스로 선택(accountLoaderLayer.onClickAccount, 없으면 DOM 클릭). */
async function selectTransactionAccount(accountIndex) {
  const res = await bridgeCall("accountLoaderLayer.onClickAccount", [accountIndex]);
  if (res && res.found === false) {
    // 폴백: ISOLATED 에서 해당 계좌 링크 직접 클릭.
    const link = getContentDoc().querySelector(
      `#userAccountList li a[data-index="${accountIndex}"]`
    );
    if (link) link.click();
  }
  await sleep(1500);
}

/** 거래내역 조회 기간 설정(시작 datepicker1, 종료 datepicker2) + 조회 버튼 클릭. */
async function queryTransaction(startScreen, endScreen) {
  await pickDate("datepicker1", startScreen);
  await pickDate("datepicker2", endScreen);
  const before = snapshotText("#simpleTable tbody");
  // 조회 버튼 클릭은 순수 DOM → ISOLATED 직접.
  getContentDoc().querySelector("#searchButton")?.click();
  await waitForContentChange("#simpleTable tbody", before, 10000);
}

/** 거래내역 "간단히" 더보기(#moreListS) 전부 펼치기. 순수 DOM 클릭 → ISOLATED 직접. */
async function expandTransactions() {
  await expandAll("#simpleTable tbody", async () => {
    const wrap = getContentDoc().querySelector("#moreListS");
    if (wrap && wrap.style.display !== "none") {
      const btn = wrap.querySelector("a");
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
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
 * 월드 경계: 테이블 DOM 은 ISOLATED 에서 직접 읽고(getContentDoc), 페이지 원시데이터
 * hkd1004.list 는 브리지 get 으로 받아 ISOLATED 에서 조인한다(코드 본문 전송 없음).
 */
async function parseTransactionTable() {
  const doc = getContentDoc();
  const tbody = doc.querySelector("#simpleTable tbody");
  if (!tbody) {
    throw new Error("[miraeasset:transaction] 거래표(#simpleTable tbody) 없음");
  }
  // 페이지 원시데이터(거래단가/통화/소수수량/환율식별자). 없으면 null 로 진행(표 텍스트만).
  const rawList = await bridgeGet("hkd1004.list");
  const hasRaw = Array.isArray(rawList);

  const txt = (c) => (c && c.textContent ? c.textContent : "").trim();
  const out = [];
  const trs = tbody.querySelectorAll("tr");
  for (let ri = 0; ri < trs.length; ri++) {
    const cells = trs[ri].querySelectorAll("td");
    if (cells.length < 2) continue;
    if (cells[0] && cells[0].classList && cells[0].classList.contains("no_data")) continue;
    const link = cells[1] ? cells[1].querySelector("a") : null;
    const dataIndex = link ? parseInt(link.getAttribute("data-index"), 10) : -1;
    const raw = hasRaw && dataIndex >= 0 ? rawList[dataIndex] : null;
    const rec = {
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
      detail: null,
    };
    if (raw) {
      const up = parseFloat(raw.tr_upr);
      if (!isNaN(up) && up > 0) rec.unitPrice = String(up);
      if (raw.curr_cd) rec.currency = String(raw.curr_cd);
      if (/\(소수\)$/.test(rec.name)) {
        const microQty = parseFloat(raw.tr_q) || 0;
        rec.brokerQuantity = rec.quantity; // 표시 micro 수량 보존
        rec.quantity = String(microQty / 1e6); // 실수량(단위환산)
        rec.detail = {
          src: "hkd1004.list",
          tr_srno: raw.tr_srno,
          tr_q_raw: raw.tr_q,
          tr_upr: raw.tr_upr,
          curr_cd: raw.curr_cd,
        };
      }
      // FX 환율 보강용 식별자(내부 필드; 보강 후 detail로 이관, raw 출력 전 삭제).
      rec.__fx =
        raw.curr_cd && (parseFloat(raw.tr_q) || 0) > 0
          ? { tr_dt: raw.tr_dt, tr_srno: raw.tr_srno }
          : null;
    }
    out.push(rec);
  }
  return out;
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
  // a03.json POST 루프는 페이지 월드 jQuery.ajax 가 필요 → 브리지 fxrates 고정 명령.
  const fx = await bridgeFxRates(params);
  if (!fx || !fx.ok || !Array.isArray(fx.rows)) {
    return; // hkd1004.account/jQuery 없음 — 보강 생략(환율 빈 문자열 유지)
  }
  const results = fx.rows;

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
        // 범위 미지정: 화면 기본 기간으로 조회 버튼만 클릭(순수 DOM → ISOLATED).
        const before = snapshotText("#simpleTable tbody");
        getContentDoc().querySelector("#searchButton")?.click();
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

/**
 * 진단(PROBE): 콘솔(F12)이 막힌 사이트에서 현재 페이지가 실제로 무엇을 노출하는지 수집한다.
 * 브리지가 실패해도 ISOLATED가 직접 볼 수 있는 것(URL·contentframe·DOM 표)은 보고한다(graceful).
 * @returns {Promise<{ok:boolean, report:string}>}
 */
async function handleProbe() {
  const lines = [];
  const push = (s) => lines.push(s);

  push("URL(top): " + location.href);

  const cfWin = getContentFrameWin();
  if (cfWin) {
    let cf;
    try {
      cf = cfWin.location?.href || "(빈 href)";
    } catch (e) {
      cf = "접근불가(cross-origin?): " + String(e?.message || e);
    }
    push("contentframe(이름기반): 있음 → " + cf);
  } else {
    push("contentframe(이름기반): 없음");
  }

  // 프레임 트리 전수 — 브리지가 top부터 동일출처 프레임을 재귀 순회하며 URL·전역·표수를 보고.
  try {
    await ensureBridge(6000);
    const res = await bridgeSend({ cmd: "probe" }, 8000);
    const frames = (res && res.result && res.result.frames) || [];
    push(`프레임 ${frames.length}개:`);
    for (const f of frames) {
      const nm = f.name ? ` name="${f.name}"` : "";
      const tb = typeof f.tables === "number" ? ` tables=${f.tables}` : "";
      push(`• [${f.label}]${nm}${tb}`);
      push(`    url: ${f.href || ""}`);
      push("    주요전역: " + (f.hasList && f.hasList.length ? f.hasList.join(", ") : "(해당 없음)"));
      if (f.others && f.others.length) {
        push("    기타후보(앞 20개): " + f.others.slice(0, 20).join(", "));
      }
    }
  } catch (e) {
    // 브리지 실패해도 ISOLATED가 직접 보는 DOM은 보고(graceful).
    push("프레임/전역 조회 실패(브리지): " + String(e?.message || e));
    let doc = document;
    try {
      doc = getContentDoc();
    } catch (e2) {
      /* cross-origin 등 — top doc 사용 */
    }
    push(`DOM(${doc === document ? "top" : "contentframe"}, ISOLATED): table ${doc.querySelectorAll("table").length}개`);
  }

  return { ok: true, report: lines.join("\n") };
}

// content script는 manifest로 자동 주입된다(document_idle). SCRAPE_REQUEST(스크랩)와
// PROBE(진단)를 처리하고 응답(return true + sendResponse)으로 돌려준다.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.SCRAPE_REQUEST) {
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
  }
  if (message?.type === MSG.PROBE) {
    handleProbe()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, report: "진단 실패: " + String(err?.message || err) }));
    return true; // 비동기 응답.
  }
  return false;
});

})(); // ── 멱등 가드 IIFE 끝 ──
