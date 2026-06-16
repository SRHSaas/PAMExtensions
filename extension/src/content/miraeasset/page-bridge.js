/**
 * 미래에셋 MAIN-world 페이지 브리지 (CSP-safe).
 *
 * ── 왜 별도 파일/별도 월드인가 ───────────────────────────────────────────────
 * securities.miraeasset.com 의 CSP는 `script-src 'self' 'wasm-unsafe-eval' ...` 로,
 *   (1) 인라인 <script> 주입 불가(unsafe-inline 없음),
 *   (2) eval / new Function / new AsyncFunction 불가(unsafe-eval 없음, wasm만 허용).
 * 따라서 "임의 코드 본문을 페이지 월드에서 eval" 하던 방식은 원천 차단된다.
 *
 * 해법: 이 파일을 manifest content_scripts 의 `"world":"MAIN"` 스크립트로 주입한다(빠른 경로).
 * 확장이 주입하는 MAIN-world 스크립트는 **페이지 CSP의 script-src 제약을 받지 않고** 실행된다
 * (Chrome/Edge 111+). 선언형 주입이 안 된 탭(확장 로드 전부터 열려 있던 탭 등)에는 background 가
 * chrome.scripting.executeScript({world:"MAIN"}) 로 같은 파일을 주입한다(폴백). 어느 경로든 멱등하다.
 *
 * ── 메시징 토폴로지: **same-frame only** (cross-frame 신뢰불가 해결) ──────────
 * 이 브리지는 **top 프레임의 MAIN world** 에서 돈다. ISOLATED(index.js)도 top 프레임에서 돌며,
 * 둘은 **같은 프레임의 window message 버스를 공유**한다(ISOLATED↔MAIN same-frame postMessage 는
 * 신뢰성 있음). 따라서:
 *   - 요청 수신: window 자신의 'message' 이벤트(같은 프레임 ISOLATED 가 window.postMessage 로 보냄).
 *   - 응답 송신: window.postMessage 로 자신에게(같은 프레임 ISOLATED 가 같은 버스에서 받음).
 * iframe(contentframe) MAIN world 에 별도 브리지를 두고 cross-frame 으로 주고받던 패턴은 **폐기**한다.
 *
 * ── contentframe 전역은 브리지가 직접 해석 ───────────────────────────────────
 * 페이지 전역(openHp 등 함수, accountLoaderLayer/hkd1004 등 데이터)은 top window 에 있을 수도,
 * 동일출처 iframe[name="contentframe"] 에 있을 수도 있다. call/get 은 대상 window 를
 * **top → contentframe 순으로 자동 탐색**해 점경로를 해석한다. contentframe 접근은
 * iframe.contentWindow 로 **직접**(같은출처 MAIN world 는 cross-frame window 속성/함수 호출 가능,
 * postMessage 불필요). 어느 프레임에서 찾았는지 응답 frame 필드로 표시(진단용). 선택적 frame 힌트
 * ("top"|"content")도 받되 기본은 자동 탐색.
 *
 * ── eval 완전 제거: 고정 명령 프로토콜 ──────────────────────────────────────
 * 본문 코드 문자열을 주고받지 않는다. 허용 명령은 6종으로 **고정**이며 로직은 이 파일에
 * 하드코딩(eval/Function 일절 없음):
 *
 *   { __pam:"req", id, cmd:"ping" }              → { result:"pong", frames:{top,content} }
 *   { __pam:"req", id, cmd:"call", fn, args[], frame? }  → { found, frame?, result? }
 *   { __pam:"req", id, cmd:"get",  path, frame? }        → { found, frame?, value? }
 *   { __pam:"req", id, cmd:"setdate", pickerId, y, m, d, frame? } → { ok, frame?, reason? }
 *   { __pam:"req", id, cmd:"fxrates", items[], acno?, frame? }    → { ok, frame?, rows[]? }
 *
 * 이 브리지는 DOM 조작/클릭/테이블 파싱을 하지 않는다 — 그건 ISOLATED(index.js)가 동일출처
 * iframe.contentDocument 로 직접 한다. 브리지는 **페이지 JS 전역(함수/데이터)** 접근만 담당.
 *
 * 정책: 인증 자동화·세션 위조·keepalive 없음. 읽기/페이지함수 트리거만. raw 정규화 없음.
 */
(function () {
  "use strict";

  // 같은 프레임에 중복 설치 방지(선언형 + 폴백 주입이 겹쳐도 멱등).
  if (window.__pamMiraeBridgeMain__) return;
  window.__pamMiraeBridgeMain__ = true;

  // ── 대상 window 탐색 (top + contentframe) ────────────────────────────────────

  /** 동일출처 contentframe 의 window. 없거나 접근 불가면 null. */
  function getContentWin() {
    try {
      const iframe = document.querySelector('iframe[name="contentframe"]');
      if (iframe && iframe.contentWindow) return iframe.contentWindow;
    } catch (e) {
      /* cross-origin 등 — null 로 처리 */
    }
    return null;
  }

  /**
   * frame 힌트("top"|"content")에 따른 후보 window 목록(순서 = 탐색 우선순위).
   * 기본(미지정): top 먼저, 그다음 contentframe.
   */
  function candidateWindows(frameHint) {
    const contentWin = getContentWin();
    if (frameHint === "content") return contentWin ? [["content", contentWin]] : [];
    if (frameHint === "top") return [["top", window]];
    const out = [["top", window]];
    if (contentWin) out.push(["content", contentWin]);
    return out;
  }

  /**
   * 한 window 에서 점경로(예: "a.b.c")를 해석한다. eval 없이 안전 해석.
   * @returns {{ ok:boolean, parent:any, key:string, value:any }}
   */
  function resolvePathIn(win, path) {
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, parent: null, key: "", value: undefined };
    }
    const parts = path.split(".");
    let parent = null;
    let cur = win;
    let key = "";
    for (let i = 0; i < parts.length; i++) {
      key = parts[i];
      if (i > 0 && (cur == null || (typeof cur !== "object" && typeof cur !== "function"))) {
        return { ok: false, parent: null, key, value: undefined };
      }
      parent = cur;
      cur = cur != null ? cur[key] : undefined;
    }
    return { ok: true, parent, key, value: cur };
  }

  /**
   * 구조화복제(postMessage) 가능한 형태로 깊은 정제. 함수/DOM/심볼/순환참조 제거.
   * 데이터(배열/평범한 객체/원시값)만 통과. 깊이 제한으로 폭주 방지.
   * @param {Window} ownerWin  value 가 속한 window(그 window 의 Node 로 DOM 판정).
   */
  function toPlain(value, depth, seen, ownerWin) {
    if (depth > 6) return undefined;
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
      return undefined;
    }
    // DOM 노드/Window 제외(소유 window 기준으로 판정).
    try {
      if (ownerWin && ownerWin.Node && value instanceof ownerWin.Node) return undefined;
    } catch (e) {
      /* ignore */
    }
    if (value === window || value === ownerWin) return undefined;
    if (seen.indexOf(value) !== -1) return undefined; // 순환 차단
    seen.push(value);
    let out;
    if (Array.isArray(value)) {
      out = [];
      for (let i = 0; i < value.length; i++) {
        out.push(toPlain(value[i], depth + 1, seen, ownerWin));
      }
    } else if (t === "object") {
      out = {};
      for (const k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        const v = toPlain(value[k], depth + 1, seen, ownerWin);
        if (v !== undefined) out[k] = v;
      }
    } else {
      out = undefined;
    }
    seen.pop();
    return out;
  }

  // ── 명령 핸들러 (전부 고정 로직, eval 없음) ──────────────────────────────────

  function cmdCall(msg) {
    const cands = candidateWindows(msg.frame);
    for (let i = 0; i < cands.length; i++) {
      const [frameName, win] = cands[i];
      const r = resolvePathIn(win, msg.fn);
      if (r.ok && typeof r.value === "function") {
        const args = Array.isArray(msg.args) ? msg.args : [];
        try {
          const ret = r.value.apply(r.parent, args);
          return { found: true, frame: frameName, result: toPlain(ret, 0, [], win) };
        } catch (e) {
          return { found: true, frame: frameName, error: String((e && e.message) || e) };
        }
      }
    }
    return { found: false, searched: cands.map((c) => c[0]) };
  }

  function cmdGet(msg) {
    const cands = candidateWindows(msg.frame);
    for (let i = 0; i < cands.length; i++) {
      const [frameName, win] = cands[i];
      const r = resolvePathIn(win, msg.path);
      if (r.ok && typeof r.value !== "undefined") {
        return { found: true, frame: frameName, value: toPlain(r.value, 0, [], win) };
      }
    }
    return { found: false, searched: cands.map((c) => c[0]) };
  }

  function cmdSetDate(msg) {
    const cands = candidateWindows(msg.frame);
    let lastReason = "no-jquery-ui";
    for (let i = 0; i < cands.length; i++) {
      const [frameName, win] = cands[i];
      try {
        const $ = win.jQuery || win.$;
        if (!$ || !$.fn || !$.fn.datepicker) {
          lastReason = "no-jquery-ui";
          continue;
        }
        const $el = $("#" + msg.pickerId);
        if ($el.length === 0) {
          lastReason = "no-picker";
          continue;
        }
        const target = new (win.Date || Date)(msg.y, msg.m - 1, msg.d);
        $el.datepicker("setDate", target);
        const onSelect = $el.datepicker("option", "onSelect");
        if (typeof onSelect === "function") {
          const fmt = $el.datepicker("option", "dateFormat") || "yy.mm.dd";
          const dateText = $.datepicker.formatDate(fmt, target);
          onSelect.call($el[0], dateText, $el.data("datepicker"));
        }
        return { ok: true, frame: frameName };
      } catch (e) {
        lastReason = String((e && e.message) || e);
      }
    }
    return { ok: false, reason: lastReason };
  }

  async function cmdFxRates(msg) {
    const cands = candidateWindows(msg.frame);
    for (let i = 0; i < cands.length; i++) {
      const [frameName, win] = cands[i];
      const hkd1004 = win.hkd1004;
      const jQuery = win.jQuery;
      if (typeof hkd1004 === "undefined" || !hkd1004.account || typeof jQuery === "undefined") {
        continue;
      }
      const acno = msg.acno || hkd1004.account.acno;
      const items = Array.isArray(msg.items) ? msg.items : [];
      const rows = [];
      for (let j = 0; j < items.length; j++) {
        const it = items[j];
        try {
          const data = await new Promise((resolve) => {
            jQuery.ajax({
              type: "POST",
              url: "/hkd/hkd1004/a03.json",
              data: { acno: acno, header_account: acno, tr_dt: it.tr_dt, tr_srno: it.tr_srno },
              success: (d) => resolve(d),
              error: () => resolve(null),
            });
          });
          const r = data && data.DLCTN && data.DLCTN[0];
          rows.push(
            r
              ? {
                  bas_exr: r.bas_exr,
                  curr_cd: r.curr_cd,
                  frc_tr_a: r.frc_tr_a,
                  tr_upr: r.tr_upr,
                  frc_fee: r.frc_fee,
                }
              : null
          );
        } catch (e) {
          rows.push(null);
        }
      }
      return { ok: true, frame: frameName, rows: rows };
    }
    return { ok: false, reason: "no-hkd1004-or-jquery" };
  }

  // ── 메시지 라우터 (same-frame) ───────────────────────────────────────────────

  window.addEventListener("message", async (ev) => {
    // same-frame 전제: 요청은 같은 프레임 ISOLATED 가 window.postMessage 로 보낸다.
    //   따라서 ev.source 는 이 window 자신이어야 한다. 동시에 origin 도 같은 출처여야 한다.
    //   (다른 프레임/창에서 온 메시지는 무시 — same-frame 신뢰 모델.)
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin || ev.origin === "null") return;
    const msg = ev.data;
    if (!msg || msg.__pam !== "req" || typeof msg.id === "undefined") return;

    let payload;
    try {
      switch (msg.cmd) {
        case "ping":
          payload = {
            result: "pong",
            frames: { top: true, content: !!getContentWin() },
          };
          break;
        case "call":
          payload = cmdCall(msg);
          break;
        case "get":
          payload = cmdGet(msg);
          break;
        case "setdate":
          payload = cmdSetDate(msg);
          break;
        case "fxrates":
          payload = await cmdFxRates(msg);
          break;
        default:
          payload = { error: "unknown cmd: " + String(msg.cmd) };
      }
    } catch (e) {
      payload = { error: String((e && e.message) || e) };
    }
    // 응답도 same-frame: 자기 window 로 postMessage → 같은 프레임 ISOLATED 가 받는다.
    window.postMessage(Object.assign({ __pam: "res", id: msg.id }, payload), window.location.origin);
  });
})();
