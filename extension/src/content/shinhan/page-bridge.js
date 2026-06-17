/**
 * 신한투자증권 MAIN-world 페이지 브리지 (CSP-safe) — **1단계: 정찰(PROBE) 중심**.
 *
 * 미래에셋 브리지(src/content/miraeasset/page-bridge.js)와 같은 설계 원칙을 따른다:
 *   - MAIN world content script 로 주입(페이지 CSP script-src 제약 우회, Chrome/Edge 111+).
 *   - **same-frame messaging**: top 프레임 ISOLATED(index.js)와 같은 window 버스를 공유한다.
 *   - eval/Function 없음: 고정 명령(ping/call/get/probe)만.
 *
 * ── 왜 신한 전용 브리지가 따로 필요한가 ──────────────────────────────────────
 * 신한투자증권 '나의자산분석' 잔고/거래내역 화면의 **실제 렌더 방식과 프레임 구조를 아직 모른다**.
 * 국내 증권사 잔고 화면은 보통 RealGrid/AUIGrid 같은 그리드 컴포넌트(때로 canvas)로 그리고,
 * 거래 PIN 입력은 보안 키보드(TouchEn/nProtect/raonsecure 등)로 막혀 있을 수 있다. 이 둘이
 * 스크래핑 가능 여부를 가르므로, 우선 **확장 PROBE로 실측**한다(콘솔 F12 차단 대비).
 *
 * 따라서 이 1단계 브리지의 핵심은 cmdProbe 다 — 프레임 트리를 순회하며 프레임별로:
 *   (1) URL·이름,
 *   (2) 그리드 라이브러리 전역(RealGrid/AUIGrid/agGrid 등) 존재,
 *   (3) 보안 키보드 전역(TouchEn/nProtect/raonsecure 등) 존재,
 *   (4) <table>·<canvas> 개수(그리드 canvas 렌더 신호),
 *   (5) input[type=password] 목록(id/name/readonly)과 보안키패드 추정 오버레이 요소
 * 를 수집해 사람이 읽을 보고서로 돌려준다. call/get/ping 은 향후 실제 스크래핑용으로 둔다.
 *
 * 정책: 인증 자동화·세션 위조·keepalive 없음. 읽기/페이지함수 트리거만. raw 정규화 없음.
 *       (거래 PIN 자동입력은 향후 단계에서, 사용자가 런 단위로 입력한 값만 메모리로 받아 처리한다.)
 */
(function () {
  "use strict";

  // 버전 핫스왑(미래에셋 브리지와 동일 메커니즘). 신한 브리지는 독립 표식을 쓴다.
  var VER = 3; // ⚠ 변경 시마다 +1. index.js 의 EXPECTED_BRIDGE_VER 와 동기화.
  if (window.__pamShinhanBridgeMainVer__ === VER) return; // 같은 버전 중복 방지
  window.__pamShinhanBridgeMainVer__ = VER;

  // ── 탐색 대상 전역 목록 ──────────────────────────────────────────────────────

  // 그리드 라이브러리 전역(잔고/거래표가 DOM table 이 아닌 그리드 컴포넌트로 그려지는지 판정).
  var GRID_GLOBALS = [
    "RealGrid", "RealGridJS", "GridView", "LocalDataProvider", // RealGrid 계열
    "AUIGrid", "AUIGridApi", // AUIGrid
    "agGrid", "Tabulator", "Handsontable", "Slick", "jspreadsheet", "luckysheet",
    "Grid", "ibsheet", "IBSheet", // 기타 국내 그리드(ibsheet 등)
  ];

  // 보안 키보드/보안모듈 전역(거래 PIN 입력칸이 보안키보드로 막혀 자동입력 불가인지 판정).
  var SECKBD_GLOBALS = [
    "nppfs", "nProtect", "nProtectKeyCrypt", // nProtect Online Security
    "TouchEnKey", "touchenkey", "nxKey", "nos", "TKAppManager", "crosswebex", "crosskeyweb", // TouchEn nxKey
    "raon", "raonsecure", "TouchEn", // raonsecure 계열
    "ASTx", "ASTx2", // AhnLab Safe Transaction
    "veraport", "wizvera", "INISAFE", "INILite", "supzio", "ksign", "KSesb", // 기타 보안모듈
    "delfino", "Initech",
  ];

  // 보안 키패드 추정 DOM 셀렉터(오버레이 키패드/난수배열 컨테이너 흔적).
  var KEYPAD_SEL = [
    '[id*="keypad" i]', '[class*="keypad" i]',
    '[id*="nppfs" i]', '[class*="nppfs" i]',
    '[id*="touchen" i]', '[class*="touchen" i]',
    '[id*="raon" i]', '[class*="raon" i]',
    '[id*="mtk" i]', '[id*="vkey" i]', '[class*="vkey" i]',
    '[class*="secu" i][class*="key" i]',
  ].join(",");

  // ── 대상 window 탐색(top + 동일출처 자손 프레임 전수) ─────────────────────────
  // 신한의 contentframe 이름을 아직 모르므로, top 부터 접근 가능한 모든 동일출처 프레임을 후보로.

  function collectWindows() {
    var out = [];
    function walk(win, label, depth) {
      if (depth > 5 || out.length > 25) return;
      out.push([label, win]);
      var n = 0;
      try { n = win.frames.length; } catch (e) { return; }
      for (var i = 0; i < n; i++) {
        var child;
        try { child = win.frames[i]; } catch (e2) { continue; }
        var nm = "";
        try { nm = child.name || ""; } catch (e3) { /* ignore */ }
        walk(child, label + " > " + (nm || "[" + i + "]"), depth + 1);
      }
    }
    walk(window, "top", 0);
    return out;
  }

  /** 한 window 에서 점경로(예: "a.b.c")를 eval 없이 안전 해석. */
  function resolvePathIn(win, path) {
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, parent: null, key: "", value: undefined };
    }
    var parts = path.split(".");
    var parent = null, cur = win, key = "";
    for (var i = 0; i < parts.length; i++) {
      key = parts[i];
      if (i > 0 && (cur == null || (typeof cur !== "object" && typeof cur !== "function"))) {
        return { ok: false, parent: null, key: key, value: undefined };
      }
      parent = cur;
      cur = cur != null ? cur[key] : undefined;
    }
    return { ok: true, parent: parent, key: key, value: cur };
  }

  /** 구조화복제 가능 형태로 깊은 정제(함수/DOM/순환 제거, 깊이 제한). */
  function toPlain(value, depth, seen, ownerWin) {
    if (depth > 6) return undefined;
    if (value === null) return null;
    var t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") return undefined;
    try { if (ownerWin && ownerWin.Node && value instanceof ownerWin.Node) return undefined; } catch (e) { /* ignore */ }
    if (value === window || value === ownerWin) return undefined;
    if (seen.indexOf(value) !== -1) return undefined;
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      out = [];
      for (var i = 0; i < value.length; i++) out.push(toPlain(value[i], depth + 1, seen, ownerWin));
    } else if (t === "object") {
      out = {};
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        var v = toPlain(value[k], depth + 1, seen, ownerWin);
        if (v !== undefined) out[k] = v;
      }
    } else { out = undefined; }
    seen.pop();
    return out;
  }

  // ── 명령 핸들러 ──────────────────────────────────────────────────────────────

  function cmdCall(msg) {
    var cands = collectWindows();
    for (var i = 0; i < cands.length; i++) {
      var frameName = cands[i][0], win = cands[i][1];
      var r = resolvePathIn(win, msg.fn);
      if (r.ok && typeof r.value === "function") {
        var args = Array.isArray(msg.args) ? msg.args : [];
        try {
          var ret = r.value.apply(r.parent, args);
          return { found: true, frame: frameName, result: toPlain(ret, 0, [], win) };
        } catch (e) {
          return { found: true, frame: frameName, error: String((e && e.message) || e) };
        }
      }
    }
    return { found: false };
  }

  function cmdGet(msg) {
    var cands = collectWindows();
    for (var i = 0; i < cands.length; i++) {
      var frameName = cands[i][0], win = cands[i][1];
      var r = resolvePathIn(win, msg.path);
      if (r.ok && typeof r.value !== "undefined") {
        return { found: true, frame: frameName, value: toPlain(r.value, 0, [], win) };
      }
    }
    return { found: false };
  }

  /** 한 window 의 전역 목록에서 후보군에 해당하는 것들(typeof 포함)을 추린다. */
  function detectGlobals(win, names) {
    var hits = [];
    for (var i = 0; i < names.length; i++) {
      var n = names[i], t;
      try { t = typeof win[n]; } catch (e) { t = "?"; }
      if (t !== "undefined" && t !== "?") hits.push(n + ":" + t);
    }
    return hits;
  }

  /** 한 문서의 password 입력칸 정보(자동입력 가능성 판정용). */
  function scanPwInputs(doc) {
    var pws;
    try { pws = doc.querySelectorAll('input[type="password"]'); } catch (e) { return []; }
    var out = [];
    for (var i = 0; i < pws.length && i < 20; i++) {
      var p = pws[i];
      out.push({
        id: p.id || "",
        name: p.name || "",
        readonly: !!p.readOnly,
        disabled: !!p.disabled,
        maxlen: p.maxLength,
        cls: (p.className || "").slice(0, 60),
        // 화면에 실제 보이는지(보안키보드는 진짜 input 을 숨기고 가짜를 띄우기도 함).
        visible: !!(p.offsetParent !== null || (p.offsetWidth + p.offsetHeight) > 0),
      });
    }
    return out;
  }

  /** 보안 키패드 추정 오버레이 요소 개수. */
  function countKeypadEls(doc) {
    try { return doc.querySelectorAll(KEYPAD_SEL).length; } catch (e) { return -1; }
  }

  /**
   * 한 문서의 자식 <iframe>/<frame> 요소의 src·name 을 읽는다. **요소의 src 속성은
   * 프레임 내용이 cross-origin이어도 부모(동일출처) 문서에서 읽을 수 있다** — cross-origin
   * 프레임의 URL(=권한/주입 대상 origin)을 알아내는 유일한 길.
   */
  function scanChildFrames(doc) {
    var els;
    try { els = doc.querySelectorAll("iframe, frame"); } catch (e) { return []; }
    var out = [];
    for (var i = 0; i < els.length && i < 20; i++) {
      var f = els[i];
      out.push({
        tag: f.tagName.toLowerCase(),
        name: f.getAttribute("name") || "",
        id: f.id || "",
        src: f.getAttribute("src") || f.src || "(src 없음/동적)",
      });
    }
    return out;
  }

  /** 텍스트 압축(공백 정리 + 길이 제한). */
  function squish(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > (max || 40) ? t.slice(0, max || 40) + "…" : t;
  }

  /**
   * 심화 덤프(셀렉터 수확용) — 자산 프레임(또는 #inq_pw 보유 프레임)에서:
   *   tables  : 표별 caption/직전제목 + 헤더 + 행수 + 첫 데이터행 셀(셀렉터 추정용),
   *   buttons : 조회/한화면/검색/펀드/신탁 관련 버튼·링크(id/onclick/텍스트),
   *   pinForm : #inq_pw 가 속한 form 의 모든 input(name/type/id, hidden 포함 — 암호화필드 식별),
   *   keypad  : 현재 보안키패드 추정요소 개수(포커스 후 재진단 비교용).
   * 출력 크기 제한(표 6개·행 일부·버튼 40개)을 둔다.
   */
  function dumpFrame(doc) {
    var dump = { tables: [], buttons: [], pinForm: null, keypad: countKeypadEls(doc) };

    // ── tables ──
    var tbls = doc.querySelectorAll("table");
    for (var i = 0; i < tbls.length && i < 6; i++) {
      var tb = tbls[i];
      var label = "";
      var cap = tb.querySelector("caption");
      if (cap) label = squish(cap.textContent, 40);
      if (!label) {
        // 직전 제목 후보(h*, .tit, th 등).
        var prev = tb.previousElementSibling;
        for (var g = 0; prev && g < 3; g++) {
          var tx = squish(prev.textContent, 40);
          if (tx) { label = tx; break; }
          prev = prev.previousElementSibling;
        }
      }
      var headRow = tb.querySelector("thead tr") || tb.querySelector("tr");
      var headers = [];
      if (headRow) {
        var hcells = headRow.querySelectorAll("th, td");
        for (var h = 0; h < hcells.length && h < 12; h++) headers.push(squish(hcells[h].textContent, 16));
      }
      var bodyRows = tb.querySelectorAll("tbody tr");
      if (!bodyRows.length) bodyRows = tb.querySelectorAll("tr");
      var firstRow = [];
      // 헤더가 아닌 첫 데이터행 추정(2번째 tr부터).
      var dataTr = bodyRows.length > 1 ? bodyRows[1] : null;
      if (dataTr) {
        var dcells = dataTr.querySelectorAll("td, th");
        for (var d = 0; d < dcells.length && d < 12; d++) firstRow.push(squish(dcells[d].textContent, 16));
      }
      dump.tables.push({
        idx: i,
        id: tb.id || "",
        cls: squish(tb.className, 30),
        label: label,
        rows: bodyRows.length,
        headers: headers,
        firstRow: firstRow,
      });
    }

    // ── buttons/links(조회 관련) ──
    var RE_BTN = /조회|한화면|검색|펀드|신탁|퇴직|예수금|cma|외화|해외|국내|주식/i;
    var clickable = doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], [onclick]');
    for (var b = 0; b < clickable.length && dump.buttons.length < 40; b++) {
      var el = clickable[b];
      var txt = squish(el.value || el.textContent || el.getAttribute("title") || "", 24);
      if (!txt || !RE_BTN.test(txt)) continue;
      dump.buttons.push({
        tag: el.tagName.toLowerCase(),
        text: txt,
        id: el.id || "",
        onclick: squish(el.getAttribute("onclick") || "", 60),
      });
    }

    // ── selects(계좌 드롭다운 등) ──
    var sels = doc.querySelectorAll("select");
    dump.selects = [];
    for (var s = 0; s < sels.length && s < 12; s++) {
      var sel = sels[s];
      var opts = [];
      for (var o = 0; o < sel.options.length && o < 5; o++) opts.push(squish(sel.options[o].textContent, 24));
      dump.selects.push({
        id: sel.id || "",
        name: sel.name || "",
        cls: squish(sel.className, 30),
        optionCount: sel.options.length,
        sampleOptions: opts,
      });
    }

    // ── 계좌 선택 추정 컨트롤(custom dropdown — select 가 아닌 div/button/a) ──
    var RE_ACCT = /acct|account|계좌|gaccount|accnt|accno/i;
    var acctEls = doc.querySelectorAll('[id*="acct" i],[id*="account" i],[class*="acct" i],[class*="account" i],[id*="accnt" i]');
    dump.accountEls = [];
    for (var a2 = 0; a2 < acctEls.length && dump.accountEls.length < 15; a2++) {
      var ae = acctEls[a2];
      var tag2 = ae.tagName.toLowerCase();
      if (tag2 === "input") continue; // input 은 pinForm 에서 이미 보고
      var t2 = squish(ae.textContent, 30);
      dump.accountEls.push({
        tag: tag2,
        id: ae.id || "",
        cls: squish(ae.className, 36),
        role: ae.getAttribute("role") || "",
        text: t2,
      });
    }

    // ── pinForm(#inq_pw 주변) ──
    var pin = doc.querySelector("#inq_pw") || doc.querySelector('input[type="password"]');
    if (pin) {
      var form = pin.closest ? pin.closest("form") : null;
      var scope = form || doc;
      var ins = scope.querySelectorAll("input");
      var fields = [];
      for (var k = 0; k < ins.length && k < 30; k++) {
        var inp = ins[k];
        fields.push({ name: inp.name || "", id: inp.id || "", type: inp.type || "", readonly: !!inp.readOnly });
      }
      dump.pinForm = { hasForm: !!form, formId: form ? (form.id || form.name || "") : "", fields: fields };
    }
    return dump;
  }

  /**
   * 정찰: top + 모든 동일출처 프레임을 순회하며 그리드/보안키보드/표·canvas/PIN입력칸을 수집.
   * 콘솔 차단 사이트에서 "잔고가 table 인지 그리드(canvas)인지", "PIN 입력칸이 일반인지
   * 보안키보드인지"를 한 번에 확인하기 위함. eval 없음.
   */
  function cmdProbe() {
    function frameInfo(label, win) {
      var info = { label: label };
      try { info.name = win.name || ""; } catch (e) { info.name = "?"; }
      try { info.href = win.location.href; } catch (e2) { info.href = "(접근불가:cross-origin?)"; info.crossOrigin = true; }
      info.grids = detectGlobals(win, GRID_GLOBALS);
      info.secKbd = detectGlobals(win, SECKBD_GLOBALS);
      try { info.tables = win.document.querySelectorAll("table").length; } catch (e3) { info.tables = -1; }
      try { info.canvas = win.document.querySelectorAll("canvas").length; } catch (e4) { info.canvas = -1; }
      // RealGrid 컨테이너 흔적(div[id*=grid] 등) — canvas 와 함께 그리드 렌더 신호.
      try { info.gridDivs = win.document.querySelectorAll('[id*="grid" i],[id*="Grid"],[class*="grid" i]').length; } catch (e5) { info.gridDivs = -1; }
      try { info.pwInputs = scanPwInputs(win.document); } catch (e6) { info.pwInputs = []; }
      info.keypadEls = (function () { try { return countKeypadEls(win.document); } catch (e7) { return -1; } })();
      // 자식 프레임 src(cross-origin 프레임 URL 식별용) — 부모가 동일출처일 때만 읽힘.
      try { info.childFrames = scanChildFrames(win.document); } catch (e8) { info.childFrames = []; }
      // 심화 덤프: 자산표(table>=1) 또는 PIN칸이 있는 동일출처 프레임만(셀렉터 수확).
      try {
        var d = win.document;
        if (d && (d.querySelector("#inq_pw") || d.querySelector('input[type="password"]') || (info.tables > 0))) {
          info.dump = dumpFrame(d);
        }
      } catch (e9) { /* cross-origin 등 — 덤프 생략 */ }
      return info;
    }
    var frames = [];
    var cands = collectWindows();
    for (var i = 0; i < cands.length; i++) {
      frames.push(frameInfo(cands[i][0], cands[i][1]));
    }
    return { frames: frames };
  }

  // ── 메시지 라우터(same-frame) ────────────────────────────────────────────────

  window.addEventListener("message", function (ev) {
    if (window.__pamShinhanBridgeMainVer__ !== VER) return; // 핫스왑: 더 새 버전이 오면 무력화
    if (ev.source !== window) return; // same-frame 전제
    if (ev.origin !== window.location.origin || ev.origin === "null") return;
    var msg = ev.data;
    if (!msg || msg.__pam !== "req" || typeof msg.id === "undefined") return;

    var payload;
    try {
      switch (msg.cmd) {
        case "ping":
          payload = { result: "pong", ver: VER };
          break;
        case "call":
          payload = cmdCall(msg);
          break;
        case "get":
          payload = cmdGet(msg);
          break;
        case "probe":
          payload = { result: cmdProbe() };
          break;
        default:
          payload = { error: "unknown cmd: " + String(msg.cmd) };
      }
    } catch (e) {
      payload = { error: String((e && e.message) || e) };
    }
    window.postMessage(Object.assign({ __pam: "res", id: msg.id }, payload), window.location.origin);
  });
})();
