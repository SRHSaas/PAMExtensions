/**
 * 미래에셋 MAIN-world 페이지 브리지 (CSP-safe).
 *
 * ── 왜 별도 파일/별도 월드인가 ───────────────────────────────────────────────
 * securities.miraeasset.com 의 CSP는 `script-src 'self' 'wasm-unsafe-eval' ...` 로,
 *   (1) 인라인 <script> 주입 불가(unsafe-inline 없음),
 *   (2) eval / new Function / new AsyncFunction 불가(unsafe-eval 없음, wasm만 허용).
 * 따라서 "임의 코드 본문을 페이지 월드에서 eval" 하던 기존 브리지는 원천 차단된다.
 *
 * 해법: 이 파일을 manifest content_scripts 의 `"world":"MAIN"` 스크립트로 주입한다.
 * 확장이 주입하는 MAIN-world 스크립트는 **페이지 CSP의 script-src 제약을 받지 않고**
 * 실행된다(Chrome/Edge 111+). all_frames:true 로 top + contentframe(iframe) 양쪽 월드에
 * document_start 에 설치된다. iframe 이 새 문서로 네비게이트되면(openHp 후) 그 새 문서에도
 * document_start 로 자동 재주입된다.
 *
 * ── eval 완전 제거: 고정 명령 프로토콜 ──────────────────────────────────────
 * ISOLATED 월드(index.js)와는 window.postMessage 로만 통신한다. 본문 코드 문자열을
 * 주고받지 않는다. 허용 명령은 아래 5종으로 **고정**이며, 각 명령의 로직은 이 파일에
 * 하드코딩되어 있다(eval/Function 일절 없음):
 *
 *   { __pam:"req", id, cmd:"ping" }
 *       → { __pam:"res", id, result:"pong" }                 (준비 핸드셰이크)
 *
 *   { __pam:"req", id, cmd:"call", fn:"openHp", args:[p,false] }
 *       → window.openHp(p,false) 호출. fn 은 점경로 허용(예: "accountLoaderLayer.onClickAccount").
 *         반환값은 구조화복제 가능하면 그대로, 아니면 무시(undefined). 함수 없으면 found:false.
 *
 *   { __pam:"req", id, cmd:"get", path:"hkd1004.list" }
 *       → 페이지 전역을 점경로로 읽어 **구조화복제 가능한 1차 데이터**만 반환(deep-plain 정제).
 *         DOM 노드/함수/순환참조는 제거된다. 데이터 객체(hkd1004.list, accountLoaderLayer.list 등)용.
 *
 *   { __pam:"req", id, cmd:"setdate", pickerId, y, m, d }
 *       → jQuery UI datepicker 에 날짜 설정(원본 pickDateByCalendar fast-path 고정 이식).
 *         { ok:boolean }.
 *
 *   { __pam:"req", id, cmd:"fxrates", acno?, items:[{tr_dt,tr_srno}] }
 *       → 외화 거래 기준환율 보강(/hkd/hkd1004/a03.json 고정 POST 루프). jQuery.ajax 사용.
 *         { ok, rows:[{bas_exr,curr_cd,frc_tr_a,tr_upr,frc_fee}|null] } 또는 { ok:false }.
 *
 * 이 브리지는 DOM 조작/클릭/테이블 파싱을 하지 않는다 — 그건 동일출처 iframe.contentDocument
 * 로 ISOLATED 월드(index.js)가 직접 한다. 브리지는 **페이지 JS 전역(함수/데이터)** 접근만 담당.
 *
 * 정책: 인증 자동화·세션 위조·keepalive 없음. 읽기/페이지함수 트리거만. raw 정규화 없음.
 */
(function () {
  "use strict";

  // 동일 문서/월드 중복 설치 방지(같은 프레임에 두 번 주입될 일은 없으나 방어).
  if (window.__pamMiraeBridgeMain__) return;
  window.__pamMiraeBridgeMain__ = true;

  /**
   * 점경로(예: "a.b.c")를 window 기준으로 해석한다. eval 없이 안전 해석.
   * @returns {{ ok:boolean, parent:any, key:string, value:any }}
   */
  function resolvePath(path) {
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, parent: null, key: "", value: undefined };
    }
    const parts = path.split(".");
    let parent = null;
    let cur = window;
    let key = "";
    for (let i = 0; i < parts.length; i++) {
      key = parts[i];
      if (cur == null || typeof cur !== "object") {
        // window 자체는 object지만, 첫 단계는 window의 속성 접근
        if (i === 0 && cur === window) {
          // ok — window에서 첫 키 접근
        } else {
          return { ok: false, parent: null, key, value: undefined };
        }
      }
      parent = cur;
      cur = cur != null ? cur[key] : undefined;
    }
    return { ok: true, parent, key, value: cur };
  }

  /**
   * 구조화복제(postMessage) 가능한 형태로 깊은 정제. 함수/DOM/심볼/순환참조 제거.
   * 데이터 객체(배열/평범한 객체/원시값)만 통과시킨다. 깊이 제한으로 폭주 방지.
   */
  function toPlain(value, depth, seen) {
    if (depth > 6) return undefined;
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
      return undefined;
    }
    // DOM 노드/Window 등은 제외
    if (typeof Node !== "undefined" && value instanceof Node) return undefined;
    if (value === window) return undefined;
    if (seen.indexOf(value) !== -1) return undefined; // 순환 차단
    seen.push(value);
    let out;
    if (Array.isArray(value)) {
      out = [];
      for (let i = 0; i < value.length; i++) {
        out.push(toPlain(value[i], depth + 1, seen));
      }
    } else if (t === "object") {
      out = {};
      for (const k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        const v = toPlain(value[k], depth + 1, seen);
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
    const r = resolvePath(msg.fn);
    if (!r.ok || typeof r.value !== "function") {
      return { found: false };
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    let ret;
    try {
      ret = r.value.apply(r.parent, args);
    } catch (e) {
      return { found: true, error: String((e && e.message) || e) };
    }
    return { found: true, result: toPlain(ret, 0, []) };
  }

  function cmdGet(msg) {
    const r = resolvePath(msg.path);
    if (!r.ok) return { found: false };
    return { found: true, value: toPlain(r.value, 0, []) };
  }

  function cmdSetDate(msg) {
    try {
      const $ = window.jQuery || window.$;
      if (!$ || !$.fn || !$.fn.datepicker) return { ok: false, reason: "no-jquery-ui" };
      const $el = $("#" + msg.pickerId);
      if ($el.length === 0) return { ok: false, reason: "no-picker" };
      const target = new Date(msg.y, msg.m - 1, msg.d);
      $el.datepicker("setDate", target);
      const onSelect = $el.datepicker("option", "onSelect");
      if (typeof onSelect === "function") {
        const fmt = $el.datepicker("option", "dateFormat") || "yy.mm.dd";
        const dateText = $.datepicker.formatDate(fmt, target);
        onSelect.call($el[0], dateText, $el.data("datepicker"));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  async function cmdFxRates(msg) {
    if (typeof window.hkd1004 === "undefined" || !window.hkd1004.account || typeof window.jQuery === "undefined") {
      return { ok: false, reason: "no-hkd1004-or-jquery" };
    }
    const jQuery = window.jQuery;
    const acno = msg.acno || window.hkd1004.account.acno;
    const items = Array.isArray(msg.items) ? msg.items : [];
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
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
    return { ok: true, rows: rows };
  }

  // ── 메시지 라우터 ────────────────────────────────────────────────────────────

  window.addEventListener("message", async (ev) => {
    // 출처 게이팅: 같은 origin(프레임 트리 내부)만 신뢰한다.
    //   ISOLATED index.js 는 top 프레임에서 동일출처 iframe(contentframe)의 window 로
    //   postMessage 하므로, 브리지(iframe MAIN world)가 받을 때 ev.source 는 top window 다
    //   (자기 window 가 아님). 따라서 ev.source===window 엄격 비교는 못 쓴다.
    //   securities.miraeasset.com 단일 출처이므로 origin 일치 + __pam 태그로 충분히 게이팅된다.
    //   (file:// 등 origin 이 'null' 인 경우는 신뢰하지 않음)
    if (ev.origin !== window.location.origin || ev.origin === "null") return;
    const msg = ev.data;
    if (!msg || msg.__pam !== "req" || typeof msg.id === "undefined") return;

    let payload;
    try {
      switch (msg.cmd) {
        case "ping":
          payload = { result: "pong" };
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
    window.postMessage(Object.assign({ __pam: "res", id: msg.id }, payload), "*");
  });

  // 설치 즉시 ping 가능. (ISOLATED 의 ensureBridge 가 ping/pong 으로 준비 확인)
})();
