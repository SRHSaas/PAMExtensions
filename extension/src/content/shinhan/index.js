/**
 * 신한투자증권 content script 어댑터 (www.shinhansec.com) — **1단계: 정찰(PROBE) 중심**.
 *
 * 현 단계 목표: 실제 스크래핑 구현이 아니라 **실측 진단**이다. 신한 '나의자산분석' 잔고/거래내역
 * 화면의 프레임 구조, 잔고표의 렌더 방식(DOM table vs RealGrid/AUIGrid 등 그리드 컴포넌트),
 * 거래내역 계좌 PIN 입력칸의 종류(일반 input vs 보안키보드)를 PROBE로 수집한다. 이 결과로
 * 가능/난이도를 확정한 뒤 다음 단계에서 scrapeDailyAsset/scrapeTransaction 을 구현한다.
 *
 * 설계는 미래에셋 어댑터와 동일 원칙:
 *   - content_scripts 는 **클래식 스크립트**라 import/export 금지 → 상수 인라인(messages.js와 동기화).
 *   - 중복 주입(선언형 + executeScript 폴백) 대비 IIFE 멱등 가드.
 *   - 페이지 JS 전역 접근은 MAIN-world 브리지(page-bridge.js)에 same-frame postMessage.
 *
 * PIN 정책(중요): 거래 PIN 은 **로그인 비밀번호가 아니라** 거래내역 조회용 2차 비밀번호다.
 *   - 사용자가 **수집 시작 시 팝업에서 입력**한 값만 메시지(payload.pin)로 받는다.
 *   - chrome.storage 등 **어디에도 저장하지 않는다**(런 단위 메모리). 로그인 자동화도 하지 않는다.
 *   - 입력칸이 보안키보드면 자동입력이 불가할 수 있다(PROBE로 먼저 판정).
 */
(function () {
  if (window.__pamShinhanContentLoaded__) return;
  window.__pamShinhanContentLoaded__ = true;

  // ── 메시지 상수(인라인) — src/shared/messages.js 와 동기화 필수 ────────────────
  const MSG = Object.freeze({
    SCRAPE_REQUEST: "SCRAPE_REQUEST",
    INJECT_BRIDGE: "INJECT_BRIDGE",
    PROBE: "PROBE",
  });
  const SOURCE = Object.freeze({ SHINHAN: "shinhan" });
  const SCRAPE_TARGET = Object.freeze({ DAILY_ASSET: "dailyAsset", TRANSACTION: "transaction" });

  // 신한 나의자산분석 각 조회 페이지의 mainFrame 직접 경로(사용자 제공).
  // 링크 클릭(새 탭 열림 위험)이 아니라 mainFrame.location 직접 이동에 쓴다 — 안정적·정확.
  const PAGES = Object.freeze({
    총자산평가: "/siw/myasset/balance/540401/view.do",
    주식선물옵션: "/siw/myasset/balance/540101/view.do", // 국내주식/해외주식/KRX금 탭
    금융상품: "/siw/myasset/balance/580001/view.do", // 펀드/신탁/퇴직연금
    CMA잔고: "/siw/myasset/balance/540801/view.do",
    외화자산잔고: "/siw/myasset/balance/foreign_asset/view.do",
    입출금내역: "/siw/myasset/details/551201/view.do",
    주식거래내역: "/siw/myasset/details/550501/view.do",
    금융상품거래내역: "/siw/myasset/details/580801/view.do",
    종합거래내역: "/siw/myasset/details/551001/view.do",
  });

  // page-bridge.js 의 VER 과 동기화. ping 응답 ver 이 다르면 핫스왑(재주입) 요청.
  const EXPECTED_BRIDGE_VER = 3; // ⚠ shinhan/page-bridge.js VER 과 함께 증가.

  // 수집 중단 플래그 키 — ↔ src/shared/messages.js STORAGE_KEY.CANCEL (동기화 필수).
  const STORAGE_CANCEL = "pam:cancelRequested";
  const CANCELLED = "__PAM_CANCELLED__";
  async function isCancelRequested() {
    try {
      const o = await chrome.storage.local.get(STORAGE_CANCEL);
      return !!o[STORAGE_CANCEL];
    } catch (e) {
      return false;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 브리지 클라이언트(same-frame, eval 없음) — 미래에셋과 동일 토폴로지 ─────────
  let rpcSeq = 0;

  function bridgeSend(req, timeoutMs = 12000) {
    const id = "pam-" + ++rpcSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error(`[shinhan] 브리지 응답 타임아웃(cmd=${req.cmd}). page-bridge.js(MAIN) 미설치/미응답.`));
      }, timeoutMs);
      function onMsg(ev) {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.__pam !== "res" || m.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        if (m.error) reject(new Error("[shinhan:bridge] " + m.error));
        else resolve(m);
      }
      window.addEventListener("message", onMsg);
      window.postMessage(Object.assign({ __pam: "req", id }, req), window.location.origin);
    });
  }

  /** background 에 MAIN-world 브리지 주입 요청(선언형 주입 실패 폴백). */
  async function requestBridgeInjection() {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.INJECT_BRIDGE });
      return !!(res && res.ok);
    } catch (e) {
      return false;
    }
  }

  /** 브리지 준비(ping/pong + ver 확인, 무응답 시 주입 폴백 1회). */
  async function ensureBridge(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let injected = false;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const res = await bridgeSend({ cmd: "ping" }, 1200);
        if (res && res.result === "pong") {
          if (res.ver === EXPECTED_BRIDGE_VER) return true;
          if (!injected) {
            injected = await requestBridgeInjection();
            await sleep(300);
          }
        }
      } catch (e) {
        lastErr = e;
      }
      if (!injected && Date.now() - (deadline - timeoutMs) > 2500) {
        injected = await requestBridgeInjection();
        await sleep(300);
      }
      await sleep(200);
    }
    throw new Error(
      "[shinhan] 페이지 브리지 준비 실패(same-frame ping 무응답). " +
        `주입폴백시도=${injected}. page-bridge.js(MAIN world) 주입 또는 CSP/world 지원(Chrome·Edge 111+) 확인 필요. ` +
        (lastErr ? String(lastErr.message || lastErr) : "")
    );
  }

  // ── 진단(PROBE) ──────────────────────────────────────────────────────────────

  /**
   * 신한 페이지 구조 진단 보고서. 프레임별 그리드/보안키보드/표·canvas/PIN입력칸을 사람이
   * 읽을 형태로 정리한다. 브리지가 실패해도 ISOLATED 가 직접 보는 top DOM 은 보고한다(graceful).
   * @returns {Promise<{ok:boolean, report:string}>}
   */
  async function handleProbe() {
    const lines = [];
    const push = (s) => lines.push(s);

    push("=== 신한투자증권 페이지 진단 ===");
    push("URL(top): " + location.href);
    push("");

    try {
      await ensureBridge(8000);
      const res = await bridgeSend({ cmd: "probe" }, 10000);
      const frames = (res && res.result && res.result.frames) || [];
      push(`프레임 ${frames.length}개:`);
      for (const f of frames) {
        const nm = f.name ? ` name="${f.name}"` : "";
        push("");
        push(`▶ [${f.label}]${nm}`);
        push(`   url: ${f.href || ""}`);
        push(`   표(table): ${f.tables}개 · canvas: ${f.canvas}개 · grid컨테이너(div): ${f.gridDivs}개`);
        push("   그리드 라이브러리: " + (f.grids && f.grids.length ? f.grids.join(", ") : "(없음)"));
        push("   보안키보드/보안모듈: " + (f.secKbd && f.secKbd.length ? f.secKbd.join(", ") : "(없음)"));
        push("   보안키패드 추정요소: " + (typeof f.keypadEls === "number" ? f.keypadEls + "개" : "?"));
        if (f.pwInputs && f.pwInputs.length) {
          push(`   비밀번호 입력칸 ${f.pwInputs.length}개:`);
          for (const p of f.pwInputs) {
            push(
              `     • id="${p.id}" name="${p.name}" readonly=${p.readonly} disabled=${p.disabled}` +
                ` maxlen=${p.maxlen} visible=${p.visible} class="${p.cls}"`
            );
          }
        } else {
          push("   비밀번호 입력칸: (없음 — 현재 화면에 PIN 입력칸 미표시일 수 있음)");
        }
        if (f.childFrames && f.childFrames.length) {
          push(`   자식 프레임 ${f.childFrames.length}개(src):`);
          for (const c of f.childFrames) {
            push(`     • <${c.tag}> name="${c.name}" id="${c.id}" src=${c.src}`);
          }
        }
        if (f.dump) {
          const dmp = f.dump;
          push("   ── 심화 덤프(셀렉터 수확) ──");
          push(`   표 ${dmp.tables.length}개:`);
          for (const t of dmp.tables) {
            push(`     [${t.idx}] id="${t.id}" class="${t.cls}" 행=${t.rows} 제목="${t.label}"`);
            if (t.headers && t.headers.length) push(`         헤더: ${t.headers.join(" | ")}`);
            if (t.firstRow && t.firstRow.length) push(`         첫행: ${t.firstRow.join(" | ")}`);
          }
          if (dmp.buttons && dmp.buttons.length) {
            push(`   조회/탭 버튼 ${dmp.buttons.length}개:`);
            for (const b of dmp.buttons) {
              push(`     • <${b.tag}> "${b.text}" id="${b.id}" onclick=${b.onclick}`);
            }
          }
          if (dmp.selects && dmp.selects.length) {
            push(`   <select> ${dmp.selects.length}개(계좌 드롭다운 후보):`);
            for (const s of dmp.selects) {
              push(`     • id="${s.id}" name="${s.name}" class="${s.cls}" 옵션${s.optionCount}개 [${(s.sampleOptions || []).join(" / ")}]`);
            }
          }
          if (dmp.accountEls && dmp.accountEls.length) {
            push(`   계좌 추정 컨트롤 ${dmp.accountEls.length}개:`);
            for (const a of dmp.accountEls) {
              push(`     • <${a.tag}> id="${a.id}" class="${a.cls}" role="${a.role}" text="${a.text}"`);
            }
          }
          if (dmp.pinForm) {
            push(`   PIN 폼: form=${dmp.pinForm.hasForm}(id="${dmp.pinForm.formId}") 입력칸 ${dmp.pinForm.fields.length}개:`);
            for (const fd of dmp.pinForm.fields) {
              push(`     • name="${fd.name}" id="${fd.id}" type=${fd.type} readonly=${fd.readonly}`);
            }
          }
          push(`   (현재 보안키패드 추정요소: ${dmp.keypad}개 — PIN칸 클릭 후 재진단 시 증가하면 가상키패드)`);
        }
      }
      push("");
      push("─ 판정 힌트 ─");
      push("• 잔고표: table 多 → DOM 스크래핑 쉬움 / canvas·grid 라이브러리 → 그리드 데이터 API 후킹 필요");
      push("• PIN: readonly=true 또는 보안키보드/보안키패드요소 존재 → 자동입력 어려움(보안키보드)");
      push("       readonly=false 인 일반 input → 자동입력 가능");
    } catch (e) {
      // 브리지 실패 — ISOLATED 가 직접 보는 top 문서만이라도 보고.
      push("프레임/전역 조회 실패(브리지): " + String(e?.message || e));
      push("");
      push("[top 문서 직접 관찰(ISOLATED)]");
      push(`표(table): ${document.querySelectorAll("table").length}개 · canvas: ${document.querySelectorAll("canvas").length}개`);
      const pws = document.querySelectorAll('input[type="password"]');
      push(`비밀번호 입력칸: ${pws.length}개`);
      pws.forEach((p) => push(`  • id="${p.id}" name="${p.name}" readonly=${p.readOnly}`));
      push("");
      push("※ 자산/거래 화면이 별도 프레임/팝업이면 그 창에서 다시 진단하세요.");
    }

    return { ok: true, report: lines.join("\n") };
  }

  // ── 자동 순회 진단(여러 페이지 구조를 한 번에 덤프) ───────────────────────────
  // 메뉴/탭 링크를 자동 클릭하며 각 페이지(잔고 하위 등) 구조를 한 번에 덤프한다.
  // 페이지마다 수동으로 진단 뜨는 반복을 없애기 위함. 구조 분석용이라 PIN 없이 진행
  // (데이터는 안 나와도 표·셀렉터·PIN칸 유무는 보인다). 끝나면 화면이 마지막 방문 페이지에 머문다.

  const sq = (s, m) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > (m || 40) ? t.slice(0, m || 40) + "…" : t;
  };

  /** 텍스트로 클릭 대상(a/li/button/span)을 찾는다. 정확 일치 우선, 없으면 부분 일치. */
  function findClickableByText(doc, text) {
    const key = text.replace(/\s+/g, "");
    const els = Array.from(doc.querySelectorAll("a, li, button, span"));
    // 1) 정확 일치 + 보이는 것.
    for (const el of els) {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if (t === key && isVisible(el)) return el;
    }
    // 2) 부분 일치 + 보이는 것.
    for (const el of els) {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if (t && t.includes(key) && isVisible(el)) return el;
    }
    // 3) 숨김 포함 부분 일치(폴백).
    for (const el of els) {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if (t && t.includes(key)) return el;
    }
    return null;
  }

  /** 현재 mainFrame 페이지 구조를 report 라인에 덤프(표/PIN/조회버튼/계좌/탭후보). */
  function dumpCurrentPage(title, lines) {
    let doc;
    try {
      doc = getMainDoc();
    } catch (e) {
      lines.push(`▶▶ ${title}: mainFrame 접근 실패 — ${String(e?.message || e)}`);
      return;
    }
    let url = "";
    try {
      url = getMainWin().location.href;
    } catch (e) {
      /* ignore */
    }
    lines.push("");
    lines.push("════════════════════════════════════════");
    lines.push(`▶▶ ${title}`);
    lines.push("   url: " + url);

    const pw = Array.from(doc.querySelectorAll('input[type="password"]'));
    lines.push(
      `   PIN 입력칸: ${pw.length}개` +
        (pw.length ? " (" + pw.map((p) => `#${p.id || "?"} readonly=${p.readOnly}`).join(", ") + ")" : "")
    );
    const combo = doc.querySelector("#acct-no-combo");
    lines.push(`   계좌 select(#acct-no-combo): ${combo ? combo.options.length + "개" : "없음"}`);
    const btns = Array.from(doc.querySelectorAll("#search-btn, button.btnInq")).filter(isVisible);
    lines.push(`   조회버튼(visible): ${btns.length}개`);

    const tabWords = ["주식", "해외주식", "KRX금", "선물옵션", "펀드", "신탁", "퇴직연금", "채권", "CMA", "외화", "한화면"];
    const foundTabs = tabWords.filter((w) => findClickableByText(doc, w));
    lines.push("   탭/버튼 후보: " + (foundTabs.join(", ") || "(없음)"));

    const tables = Array.from(doc.querySelectorAll("table.tblH, table.tblV"));
    lines.push(`   표(tblH/tblV) ${tables.length}개:`);
    tables.slice(0, 10).forEach((t, i) => {
      const cls = /tblV/.test(t.className) ? "tblV" : /tblH/.test(t.className) ? "tblH" : t.className;
      let label = "";
      const cap = t.querySelector("caption");
      if (cap) label = sq(cap.textContent, 30);
      if (!label) {
        let p = t.previousElementSibling;
        for (let g = 0; p && g < 3; g++) {
          const tx = sq(p.textContent, 30);
          if (tx) {
            label = tx;
            break;
          }
          p = p.previousElementSibling;
        }
      }
      const headRow = t.querySelector("thead tr") || t.querySelector("tr");
      const headers = Array.from(headRow ? headRow.querySelectorAll("th,td") : [])
        .slice(0, 12)
        .map((c) => sq(c.textContent, 14));
      let rows = t.querySelectorAll("tbody tr");
      if (!rows.length) rows = t.querySelectorAll("tr");
      lines.push(`     [${i}] ${cls} 행=${rows.length} 제목="${label}"`);
      if (headers.length) lines.push(`         셀: ${headers.join(" | ")}`);
    });
  }

  /**
   * mainFrame window 를 **엄격히**(top 폴백 없이) 찾는다. 없으면 null.
   * navUrl 은 반드시 mainFrame 만 이동해야 한다 — top 폴백으로 top 을 이동시키면 content script 가
   * 죽어 "message channel closed" 가 난다(단독 페이지 상태에서 발생했던 버그).
   */
  function mainFrameWinOrNull() {
    try {
      const w = window.frames["mainFrame"];
      if (w) return w;
    } catch (e) {
      /* ignore */
    }
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].name === "mainFrame") return window.frames[i];
        } catch (e2) {
          /* cross-origin 스킵 */
        }
      }
    } catch (e3) {
      /* ignore */
    }
    return null;
  }

  /**
   * mainFrame 을 path 로 **직접 이동**(링크 클릭 X → 새 탭 안 열림). URL 도달 + 문서 로드 대기.
   * mainFrame(프레임셋)이 없으면(주소창 직접입력 등 단독 페이지) **top 을 건드리지 않고** 명확히 throw.
   */
  async function navUrl(path) {
    const pathKey = path.replace(/#.*$/, "");
    const win = mainFrameWinOrNull();
    if (!win) {
      throw new Error(
        "[shinhan] 프레임(mainFrame) 화면이 아닙니다 — 주소창에 페이지 URL을 직접 입력한 '단독 페이지' 상태로 보입니다. " +
          "자동 페이지 이동을 할 수 없습니다(top 이동 시 확장이 종료됨). " +
          "신한 홈 https://www.shinhansec.com 로그인 후 '나의자산분석' 메뉴로 들어간(프레임) 화면에서 다시 수집하세요."
      );
    }
    try {
      win.location.href = path; // mainFrame 만 이동(top content script 생존).
    } catch (e) {
      throw new Error("[shinhan] 페이지 이동 실패(" + path + "): " + String(e?.message || e));
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        const w = mainFrameWinOrNull();
        if (w && w.location.href.includes(pathKey) && w.document.readyState === "complete") break;
      } catch (e) {
        /* 네비게이션 중 일시적 접근 예외 — 재시도 */
      }
    }
    await sleep(1200); // 페이지 내 스크립트(표 렌더) 안정화.
    return true;
  }

  /** 같은 화면에서 서브탭(주식/해외주식/KRX금 등)을 텍스트로 클릭(in-page, 새 탭 아님). */
  async function clickTab(doc, tab, lines, prefix) {
    const tabEl = findClickableByText(doc, tab);
    if (!tabEl) {
      lines.push(`   · 서브탭 [${tab}] 없음`);
      return;
    }
    fireClick(tabEl);
    await sleep(1300);
    dumpCurrentPage(prefix + " > " + tab, lines);
  }

  /**
   * 자동 순회 진단: 사용자 제공 직접 URL로 mainFrame을 이동하며 각 페이지 구조를 한 번에 덤프.
   * 링크 클릭이 아니라 직접 이동이라 **새 탭이 열리지 않는다**.
   * @returns {Promise<{ok:boolean, report:string}>}
   */
  async function handleWalkProbe(pin) {
    const lines = [];
    lines.push("=== 신한 자동 순회 진단(직접 URL 이동, 여러 페이지 한 번에 덤프) ===");
    lines.push(
      pin
        ? "※ 세션 PIN으로 PIN 페이지도 조회해 데이터까지 덤프합니다."
        : "※ PIN 미입력 — PIN 페이지는 데이터 없이 구조만 보입니다(팝업에 PIN 입력 후 다시 누르면 데이터까지)."
    );
    lines.push("※ 끝나면 화면이 마지막 방문 페이지에 머뭅니다(정상).");

    // 순회 계획: 직접 경로(PAGES) + 잔고형 페이지의 서브탭.
    const plan = [
      { title: "총자산평가", path: PAGES.총자산평가, tabs: [] },
      { title: "주식/선물옵션", path: PAGES.주식선물옵션, tabs: ["주식", "해외주식", "KRX금"] },
      { title: "금융상품", path: PAGES.금융상품, tabs: ["펀드", "신탁", "퇴직연금"] },
      { title: "CMA잔고", path: PAGES.CMA잔고, tabs: [] },
      { title: "외화자산잔고", path: PAGES.외화자산잔고, tabs: [] },
      { title: "입출금내역", path: PAGES.입출금내역, tabs: [] },
      { title: "주식거래내역", path: PAGES.주식거래내역, tabs: [] },
      { title: "금융상품거래내역", path: PAGES.금융상품거래내역, tabs: [] },
      { title: "종합거래내역", path: PAGES.종합거래내역, tabs: [] },
    ];

    for (const step of plan) {
      if (await isCancelRequested()) {
        lines.push("\n(중단됨)");
        break;
      }
      try {
        await navUrl(step.path);
      } catch (e) {
        lines.push("\n" + String(e?.message || e));
        break; // 단독 페이지 등 — 이후 페이지도 동일하게 실패하므로 중단.
      }
      let doc;
      try {
        doc = getMainDoc();
      } catch (e) {
        continue;
      }
      // PIN 페이지면 세션 PIN 입력 + 조회해 데이터까지 보이게 한 뒤 덤프.
      const pinEl = doc.querySelector("#inq_pw") || doc.querySelector("#acct-pwd");
      if (pinEl && pin) {
        setNativeValue(pinEl, pin);
        clickSearchButton(doc, "walk");
        await sleep(1800);
        doc = getMainDoc();
      } else if (pinEl) {
        lines.push(`   (PIN 필요 페이지 — PIN 미입력으로 데이터 없음)`);
      }
      dumpCurrentPage(step.title, lines);
      for (const tab of step.tabs) {
        await clickTab(doc, tab, lines, step.title);
        try {
          doc = getMainDoc();
        } catch (e) {
          /* keep */
        }
      }
    }

    return { ok: true, report: lines.join("\n") };
  }

  // ── mainFrame(같은 출처) DOM 접근 ────────────────────────────────────────────
  // 신한은 <frameset> SPA. 데이터·폼은 frame[name="mainFrame"] (www.shinhansec.com, top과
  // 동일출처) 안에 산다. content script는 top(ISOLATED)에서 돌지만 same-origin이라
  // mainFrame.document 를 직접 읽고 클릭/입력할 수 있다(미래에셋 contentframe 접근과 동일 원리).

  /** mainFrame 의 window(이름 기반). 없으면 top window(폴백). */
  function getMainWin() {
    try {
      const w = window.frames["mainFrame"];
      if (w) return w;
    } catch (e) {
      /* ignore */
    }
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].name === "mainFrame") return window.frames[i];
        } catch (e2) {
          /* cross-origin 스킵 */
        }
      }
    } catch (e3) {
      /* ignore */
    }
    return window;
  }

  /** mainFrame 의 document(같은 출처). 접근 불가 시 진단 메시지로 throw. */
  function getMainDoc() {
    const win = getMainWin();
    try {
      const doc = win.document;
      if (doc) return doc;
    } catch (e) {
      throw new Error(
        "[shinhan] mainFrame 접근 실패(cross-origin?). 신한 로그인 탭(www.shinhansec.com)이 맞는지 확인하세요: " +
          String(e?.message || e)
      );
    }
    return document;
  }

  /** doc.querySelector 실패 시 어느 셀렉터/영역이 깨졌는지 담아 throw(조용한 빈 반환 금지). */
  function requireEl(doc, selector, area) {
    const el = doc.querySelector(selector);
    if (!el) {
      throw new Error(
        `[shinhan:${area}] 셀렉터 실패: '${selector}' 없음. (로그인 만료 / 화면 미진입 / DOM 변경 의심) ` +
          "주식거래내역 화면에 들어간 상태에서 수집하세요."
      );
    }
    return el;
  }

  /**
   * 프레임워크(_e2e_…)가 value 변경을 자체 추적할 수 있어, **네이티브 setter로 값을 넣고**
   * input/change 이벤트를 발생시켜 프레임워크가 인지하도록 한다(React 등에서 쓰는 표준 우회).
   * readonly 입력은 잠시 해제 후 설정한다(보안키보드 아님이 확인됨 — PIN 칸 포함 안전).
   */
  function setNativeValue(el, value) {
    if (!el) return;
    const hadReadonly = el.readOnly;
    if (hadReadonly) el.readOnly = false;
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("keyup", { bubbles: true }));
    if (hadReadonly) el.readOnly = true; // 원복(가시 상태 유지).
  }

  /** 요소가 화면에 보이는지(숨은 탭의 중복 버튼 회피용). */
  function isVisible(el) {
    return !!(el && (el.offsetParent !== null || el.offsetWidth + el.offsetHeight > 0));
  }

  /**
   * 클릭 트리거(강화). data-bind(Knockout 등) 핸들러·jQuery 위임 등 다양한 바인딩에 닿도록
   * mousedown→mouseup→click 시퀀스를 디스패치하고 native click()도 호출한다.
   */
  function fireClick(el) {
    if (!el) return;
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    for (const type of ["mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view }));
      } catch (e) {
        /* ignore — native click 으로 폴백 */
      }
    }
    try {
      el.click();
    } catch (e) {
      /* ignore */
    }
  }

  /** 조건이 true 될 때까지 폴링. 실패 시 영역/조건 담아 throw. */
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
      await sleep(200);
    }
    throw new Error(`[shinhan] 대기 타임아웃: ${what}`);
  }

  /** "YYYY-MM-DD" → "YYYY.MM.DD"(화면 표시형). */
  function toDot(iso) {
    return iso ? iso.replace(/-/g, ".") : "";
  }
  /** "YYYY-MM-DD" → "YYYYMMDD"(hidden 파라미터형). */
  function toCompact(iso) {
    return iso ? iso.replace(/-/g, "") : "";
  }

  // ── 거래내역 표 파싱 ──────────────────────────────────────────────────────────
  // 신한 주식거래내역 표 헤더(실측): 일자|종목코드|종목명|구분|수량|가격|금액|수수료|세금|정산금액.
  // raw 는 normalizer(buildTransactionPayload)가 소비하는 camelCase 형태로 맞춘다(소스 무관 계약):
  //   {date,type,name,quantity,amount,foreignAmount,fee,balance,unitPrice,brokerQuantity,
  //    exchangeRate,currency,detail}. 신한 고유값(종목코드/세금/정산금액)은 detail 에 보존.

  const TXN_HEADER_KEYS = ["일자", "종목명", "구분", "수량"]; // 거래 표 식별용(요약표 7컬럼 제외).
  const cellText = (c) => (c && c.textContent ? c.textContent : "").trim();
  // "조회된 데이터가 없습니다" 등 빈 결과 안내행 — 종목/거래로 오인하지 않도록 거른다.
  const NO_DATA_RE = /조회.*없|데이터가?\s*없|내역이?\s*없|자료가?\s*없|결과가?\s*없|없습니다/;

  /** 한 거래표(table.tblH)에서 데이터행을 raw 거래 객체로 파싱. 헤더/빈/합계행은 거른다. */
  function parseTxnTable(table) {
    // 헤더 인덱스 매핑(컬럼 순서가 바뀌어도 헤더 텍스트로 찾는다).
    const headRow = table.querySelector("thead tr") || table.querySelector("tr");
    const headers = Array.from(headRow ? headRow.querySelectorAll("th,td") : []).map((c) =>
      cellText(c).replace(/\s+/g, "")
    );
    const idx = (label) => headers.findIndex((h) => h.includes(label));
    const iDate = idx("일자"),
      iCode = idx("종목코드"),
      iName = idx("종목명"),
      iType = idx("구분"),
      iQty = idx("수량"),
      iPrice = idx("가격"),
      iAmt = idx("금액"),
      iFee = idx("수수료"),
      iTax = idx("세금"),
      iSettle = idx("정산금액");

    let bodyRows = table.querySelectorAll("tbody tr");
    if (!bodyRows.length) bodyRows = table.querySelectorAll("tr");

    const out = [];
    bodyRows.forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      if (!cells.length) return; // 헤더행(th) 스킵.
      if (NO_DATA_RE.test(tr.textContent || "")) return; // "조회된 내역이 없습니다" 안내행 스킵.
      const date = iDate >= 0 ? cellText(cells[iDate]) : "";
      const type = iType >= 0 ? cellText(cells[iType]) : "";
      // 필수(일자·구분) 없는 행(합계/안내) 스킵.
      if (!date || !type) return;
      if (/^합계|소계|총계/.test(type)) return;
      out.push({
        date, // "YYYY.MM.DD" 또는 사이트형식 — normalizer가 '-'로 정규화.
        type,
        name: iName >= 0 ? cellText(cells[iName]) : "",
        quantity: iQty >= 0 ? cellText(cells[iQty]) : "",
        amount: iAmt >= 0 ? cellText(cells[iAmt]) : "",
        foreignAmount: "",
        fee: iFee >= 0 ? cellText(cells[iFee]) : "",
        balance: "", // 신한 거래표엔 예수금잔고 컬럼 없음.
        unitPrice: iPrice >= 0 ? cellText(cells[iPrice]) : "",
        brokerQuantity: "",
        exchangeRate: "",
        currency: "",
        // 신한 고유값 보존(서버 정밀/추적용).
        detail: {
          src: "shinhan.주식거래내역",
          code: iCode >= 0 ? cellText(cells[iCode]) : "",
          tax: iTax >= 0 ? cellText(cells[iTax]) : "",
          settlement: iSettle >= 0 ? cellText(cells[iSettle]) : "",
        },
      });
    });
    return out;
  }

  /** 현재 화면의 거래표(거래 헤더를 가진 table.tblH)들에서 거래행을 모두 모은다. */
  function parseAllTxnTables(doc) {
    const tables = Array.from(doc.querySelectorAll("table.tblH"));
    const txns = [];
    let matched = 0;
    for (const t of tables) {
      const headRow = t.querySelector("thead tr") || t.querySelector("tr");
      const hdr = Array.from(headRow ? headRow.querySelectorAll("th,td") : [])
        .map((c) => cellText(c))
        .join("");
      // 거래 표만(요약표 '구분|건수|수량…' 제외): 헤더에 일자·종목명·구분·수량이 모두 있어야.
      if (!TXN_HEADER_KEYS.every((k) => hdr.includes(k))) continue;
      matched++;
      txns.push(...parseTxnTable(t));
    }
    if (matched === 0) {
      throw new Error(
        "[shinhan:transaction] 거래표(table.tblH, 헤더 일자/종목명/구분/수량)를 찾지 못했습니다. " +
          "주식거래내역 화면에 진입했는지, 조회가 실행됐는지 확인하세요."
      );
    }
    return txns;
  }

  // ── 계좌 목록 / 선택 ──────────────────────────────────────────────────────────

  /**
   * 계좌 목록 조회. 신한 계좌 드롭다운은 **커스텀 selectbox 위젯**이다(실측):
   *   <div class="selectbox" id="acct-no">           ← 위젯 컨테이너(<select> 아님)
   *     <div class="select"><a class="tit" id="acct-no-combobox">현재계좌</a>
   *       <div class="maskDiv_wddo"><ul class="con"><li><a><span>270-83-… 별칭</span></a></li>…</ul></div>
   *     </div>
   *     <select id="acct-no-combo" style="display:none">   ← 숨은 진짜 <select>(옵션=계좌)
   *       <option value="27083661382">270-83-661382 방유석(IRP)</option>…
   * 따라서 **목록은 숨은 `#acct-no-combo` 옵션**에서 읽는다. 폴백은 hidden acctNoTxt/acctNo 1건.
   * @returns {{accounts:{value:string, label:string, acno:string}[]}}
   */
  function getAccounts(doc) {
    const sel = doc.querySelector("#acct-no-combo");
    if (sel && sel.tagName === "SELECT" && sel.options.length) {
      const accounts = Array.from(sel.options)
        .map((o) => {
          const label = (o.textContent || "").trim();
          // 라벨의 하이픈 포함 계좌번호 우선(없으면 option.value). normalizer가 하이픈 제거.
          const acno = ((label.match(/[\d-]{6,}/) || [o.value])[0] || "").trim();
          return { value: o.value, label, acno };
        })
        .filter((o) => o.acno);
      if (accounts.length) return { accounts };
    }
    // 폴백: hidden 현재 선택값 1건.
    const acno =
      (doc.querySelector("#acctNoTxt")?.value || doc.querySelector("#acctNo")?.value || "").trim();
    return { accounts: acno ? [{ value: acno, label: acno, acno }] : [] };
  }

  /**
   * 커스텀 selectbox 위젯에서 계좌 선택. 위젯 핸들러가 hidden <select>·표시텍스트·계좌변경
   * 로직을 모두 처리하도록 **목록 <li> 링크를 클릭**(사용자 동작 모사)한다.
   * 못 찾으면 숨은 `#acct-no-combo` value 설정 + change 로 폴백.
   */
  async function selectAccount(doc, acc) {
    const key = acc.acno.replace(/\s+/g, "");
    // 1) 드롭다운 열기(목록 링크가 활성화되도록).
    const opener = doc.querySelector("#acct-no-combobox");
    if (opener) {
      opener.click();
      await sleep(200);
    }
    // 2) 목록에서 해당 계좌 링크 클릭.
    const links = doc.querySelectorAll("#acct-no ul.con li a, #acct-no .con li a");
    let clicked = false;
    for (const a of links) {
      const t = (a.textContent || "").replace(/\s+/g, "");
      if (t.includes(key)) {
        a.click();
        clicked = true;
        break;
      }
    }
    // 3) 폴백: 숨은 <select> 직접 설정.
    if (!clicked) {
      const combo = doc.querySelector("#acct-no-combo");
      if (combo && combo.tagName === "SELECT") setNativeValue(combo, acc.value);
    }
    await sleep(900); // 계좌 변경 화면 갱신 여유.
  }

  // ── 조회 기간 분할(최대 1년) ──────────────────────────────────────────────────
  // 신한 주식거래내역은 **한 번에 최대 1년 구간**만 조회 가능. 범위가 1년을 넘으면 1년 단위로
  // 잘라 여러 번 조회해 누적한다(auto 증분도 마지막 수집일이 오래면 1년 초과 가능 → 필수).

  /** Date → "YYYY-MM-DD"(로컬). */
  function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  /** [startIso,endIso]를 최대 1년(시작+1년-1일) 구간들로 분할. 범위 없으면 [{}] 1건(화면 기본). */
  function splitRangeByYear(startIso, endIso) {
    if (!startIso || !endIso) return [{ startDate: startIso, endDate: endIso }];
    const chunks = [];
    let s = new Date(startIso);
    const end = new Date(endIso);
    let guard = 0;
    while (s <= end && guard++ < 100) {
      const e = new Date(s);
      e.setFullYear(e.getFullYear() + 1);
      e.setDate(e.getDate() - 1); // 시작+1년-1일 = 최대 1년 구간.
      const chunkEnd = e <= end ? e : end;
      chunks.push({ startDate: ymd(s), endDate: ymd(chunkEnd) });
      s = new Date(chunkEnd);
      s.setDate(s.getDate() + 1); // 다음 구간 시작 = 직전 끝 +1일.
    }
    return chunks;
  }

  // ── 거래내역 조회(1계좌, 1구간) ──────────────────────────────────────────────

  /**
   * 현재 선택된 계좌에 대해 **한 구간**(≤1년)을 조회·파싱한다.
   * PIN 입력(#inq_pw) → 기간설정 → #search-btn 클릭 → 표 변화 대기 → 파싱.
   * @param {Document} doc  mainFrame document
   * @param {{startDate?:string,endDate?:string}} range  단일 구간(≤1년)
   * @param {string} pin
   */
  async function runOneQuery(doc, range, pin) {
    // PIN 입력(키패드 없음 확인됨 — JS 주입). 구간마다 재설정(쿼리/계좌 변경 후 비워질 수 있음).
    const pinEl = requireEl(doc, "#inq_pw", "transaction");
    setNativeValue(pinEl, pin);

    // 기간 설정(범위 있을 때만). 표시형(YYYY.MM.DD)·hidden 파라미터형(YYYYMMDD) 모두 설정(방어).
    if (range && range.startDate && range.endDate) {
      const from = doc.querySelector("#inq_dateFrom");
      const to = doc.querySelector("#inq_dateTo");
      if (from) setNativeValue(from, toDot(range.startDate));
      if (to) setNativeValue(to, toDot(range.endDate));
      const sdate = doc.querySelector("#sdate");
      const edate = doc.querySelector("#edate");
      if (sdate) setNativeValue(sdate, toCompact(range.startDate));
      if (edate) setNativeValue(edate, toCompact(range.endDate));
    }

    // PIN/날짜 observable 반영 여유(MVVM 바인딩이 change를 처리할 시간).
    await sleep(250);

    // 조회 전 표 스냅샷(변화 감지용).
    const beforeText = (doc.querySelector("table.tblH tbody")?.innerText || "").trim();

    // 조회 버튼: **보이는 것 우선**(숨은 탭의 중복 #search-btn/.btnInq 회피) + mouse 시퀀스 트리거.
    const candidates = Array.from(doc.querySelectorAll("#search-btn, button.btnInq"));
    let searchBtn = candidates.find(isVisible) || candidates[0];
    if (!searchBtn) searchBtn = requireEl(doc, "#search-btn", "transaction");
    fireClick(searchBtn);

    // 조회 완료 대기 — 다음 중 **하나라도** 충족하면 즉시 종료(빈 구간에서 풀타임아웃 방지):
    //   (a) 거래표 tbody에 날짜 행 등장(데이터 있음),
    //   (b) "내역/자료/데이터 없음" 메시지 등장(데이터 없음 — 빠르게 종료),
    //   (c) 표 텍스트가 조회 전과 달라짐(빈→메시지 등 변화).
    // 어느 신호도 없으면 최대 6초 후 진행.
    const NO_DATA_RE = /(내역|자료|데이터|결과)\s*가?\s*없|없습니다/;
    const DATE_RE = /\d{4}[.\-/]\d{2}[.\-/]\d{2}/;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(200);
      const tb = doc.querySelector("table.tblH tbody");
      const now = (tb?.innerText || "").trim();
      if (tb && DATE_RE.test(now)) break; // (a) 데이터 행.
      if (NO_DATA_RE.test(now)) break; // (b) 없음 메시지.
      if (now && now !== beforeText) break; // (c) 변화.
    }
    await sleep(300); // 렌더 안정화.

    return parseAllTxnTables(doc);
  }

  /**
   * 한 계좌의 주식거래내역을 조회·파싱한다. 계좌를 1회 선택한 뒤, 기간을 ≤1년 구간으로
   * 분할해 구간마다 조회·누적한다.
   * @param {Document} doc  mainFrame document
   * @param {{value:string,label:string,acno:string}} acc
   * @param {{startDate?:string,endDate?:string}} range
   * @param {string} pin
   */
  async function queryAccountTxns(doc, acc, range, pin) {
    // PIN 미입력 방어(키패드 없음 — JS 주입 가능하나 값 자체가 있어야 함).
    if (!pin) {
      throw new Error(
        "[shinhan:transaction] 거래 PIN이 비어 있습니다. 팝업 'PIN' 칸에 거래(2차) 비밀번호를 입력하고 다시 수집하세요."
      );
    }

    await selectAccount(doc, acc);

    const chunks = splitRangeByYear(range?.startDate, range?.endDate);
    const all = [];
    for (const chunk of chunks) {
      if (await isCancelRequested()) throw new Error(CANCELLED);
      const txns = await runOneQuery(doc, chunk, pin);
      all.push(...txns);
    }
    return all;
  }

  /**
   * 주식거래내역 raw 수집. #acct-no 계좌를 순회(전계좌)하며 계좌별 raw를 모은다.
   * range 미지정 시 화면 기본 기간으로 조회.
   * @param {{range?:{startDate?:string,endDate?:string}, pin?:string}} opts
   * @returns {Promise<object[]>}  transaction raw 배열(normalizer 입력)
   */
  async function scrapeTransaction(opts = {}) {
    // 주식거래내역 페이지로 자동 이동(현재 화면·수집 순서 무관하게 견고).
    await navUrl(PAGES.주식거래내역);
    const doc = getMainDoc();

    // 진입 확인(조회 버튼 + 계좌 드롭다운). PIN 칸은 조회 시 확인.
    if (!doc.querySelector("#search-btn") || !doc.querySelector("#acct-no-combo")) {
      throw new Error(
        "[shinhan:transaction] 주식거래내역 화면 진입 실패. 신한 로그인 상태를 확인하세요."
      );
    }

    const { accounts } = getAccounts(doc);
    if (!accounts.length) {
      throw new Error(
        "[shinhan:transaction] 계좌 목록을 찾지 못했습니다(#acct-no 비어있음). 로그인/계좌 표시 상태를 확인하세요."
      );
    }

    const out = [];
    for (let i = 0; i < accounts.length; i++) {
      if (await isCancelRequested()) throw new Error(CANCELLED);
      const acc = accounts[i];
      try {
        const transactions = await queryAccountTxns(doc, acc, opts.range || {}, opts.pin || "");
        out.push({
          kind: "transaction",
          acno: acc.acno, // 하이픈 포함 가능(normalizer가 제거).
          account: acc.label,
          transactions,
        });
      } catch (err) {
        if (String(err?.message || err) === CANCELLED) throw err;
        // 한 계좌 실패가 전체를 막지 않게 — 누락을 raw에 기록.
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

  // ── 영역: 총 자산평가(잔고) → daily_assets ──────────────────────────────────────
  // 페이지: 잔고 > 총 자산평가 (/siw/myasset/balance/540401/view.do). PIN 불필요(확인됨).
  // 표는 **tblV(세로형 label-value)**: 한 행에 [라벨|값|라벨|값] 식. 계좌별 스냅샷(현재 시점)이라
  // date = 오늘. 계좌(#acct-no-combo) 순회하며 계좌별 총자산/순자산을 daily_assets 로,
  // 예수금합은 daily_holdings 의 현금성 행(name="예수금")으로 보존(canonical엔 예수금 칼럼 없음).

  /** 오늘 "YYYY-MM-DD". */
  function todayYmd() {
    return ymd(new Date());
  }

  /** tblV 라벨 정리("예수금합 상세보기" → "예수금합"). */
  function cleanLabel(s) {
    return String(s || "").replace(/상세보기|더보기/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * 현재 화면의 모든 table.tblV 를 라벨→값 맵으로. 한 행의 셀을 (라벨,값) 쌍으로 짝지어 읽는다.
   * 먼저 등장한 라벨 우선(중복 라벨 보호).
   */
  function parseTblVMap(doc) {
    const map = {};
    for (const t of doc.querySelectorAll("table.tblV")) {
      for (const tr of t.querySelectorAll("tr")) {
        const cells = Array.from(tr.querySelectorAll("th, td"));
        for (let k = 0; k + 1 < cells.length; k += 2) {
          const label = cleanLabel(cellText(cells[k]));
          const value = cellText(cells[k + 1]);
          if (label && !(label in map)) map[label] = value;
        }
      }
    }
    return map;
  }

  /** 조회 버튼(보이는 것 우선) 클릭. */
  function clickSearchButton(doc, area) {
    const candidates = Array.from(doc.querySelectorAll("#search-btn, button.btnInq"));
    let btn = candidates.find(isVisible) || candidates[0];
    if (!btn) btn = requireEl(doc, "#search-btn", area);
    fireClick(btn);
  }

  /** selector 의 innerText 가 before 와 달라질 때까지(또는 maxMs) 대기. */
  async function waitChange(doc, selector, before, maxMs) {
    const deadline = Date.now() + (maxMs || 5000);
    while (Date.now() < deadline) {
      await sleep(200);
      const now = (doc.querySelector(selector)?.innerText || "").trim();
      if (now && now !== before) break;
    }
    await sleep(300);
  }

  /**
   * 화면의 **모든 보이는 password 입력칸**에 PIN을 채운다(id 무관 — 해외주식/KRX금/금융상품/외화 등
   * PIN 칸 id가 달라도 커버). setNativeValue 로 MVVM(Knockout) observable 갱신.
   * @returns {number} 채운 칸 수.
   */
  function fillAllPins(doc, pin) {
    if (!pin) return 0;
    let n = 0;
    for (const p of doc.querySelectorAll('input[type="password"]')) {
      const visible = p.offsetParent !== null || p.offsetWidth + p.offsetHeight > 0;
      if (visible) {
        setNativeValue(p, pin);
        n++;
      }
    }
    return n;
  }

  /**
   * PIN 채우고 조회. PIN observable 반영 텀을 두고, 조회 후에도 빈 PIN 칸이 보이면(=조회 시점에
   * PIN 입력을 요구하는 페이지) 한 번 더 채우고 재조회한다. 두 가지 순서(PIN→조회 / 조회→PIN)를 커버.
   */
  async function pinSearch(doc, pin, waitSel) {
    if (pin) {
      fillAllPins(doc, pin);
      await sleep(350); // observable 반영 텀(거래내역에서 PIN이 먹힌 패턴과 동일).
    }
    let before = (doc.querySelector(waitSel)?.innerText || "").trim();
    clickSearchButton(doc, "dailyAsset");
    await waitChange(doc, waitSel, before, 7000);
    if (pin) {
      const emptyPw = Array.from(doc.querySelectorAll('input[type="password"]')).find(
        (p) => (p.offsetParent !== null || p.offsetWidth + p.offsetHeight > 0) && !p.value
      );
      if (emptyPw) {
        fillAllPins(doc, pin);
        await sleep(350);
        before = (doc.querySelector(waitSel)?.innerText || "").trim();
        clickSearchButton(doc, "dailyAsset");
        await waitChange(doc, waitSel, before, 7000);
      }
    }
  }

  /** 숫자 추정(콤마/기호 제거) — 0 판정·계산용(정규화는 normalizer). */
  function num0(s) {
    return Number(String(s == null ? "" : s).replace(/[^\d.-]/g, "")) || 0;
  }

  /**
   * 보유종목 표(tblH, 헤더 종목명·평가금액·수익률) 파싱 → daily_holdings raw 행.
   * 주식/선물옵션(540101)의 국내주식·해외주식·KRX금 탭 표가 동일 헤더를 쓴다:
   *   종목명 | 수량 | 평균단가 | 현재가 | 평가금액 | 미실현손익 | 수익률
   * 화면에 같은 헤더 표가 둘([조회내역],[조회내역 한화면])일 수 있어 (category+종목명+수량) 으로 dedupe.
   * buyAmount 는 화면에 없어 평균단가×수량으로 도출(정규화는 normalizer).
   */
  function parseHoldingsTable(doc, category) {
    const out = [];
    const seen = new Set();
    for (const t of doc.querySelectorAll("table.tblH")) {
      const headRow = t.querySelector("thead tr") || t.querySelector("tr");
      const headers = Array.from(headRow ? headRow.querySelectorAll("th,td") : []).map((c) =>
        cellText(c).replace(/\s+/g, "")
      );
      const hdr = headers.join("");
      if (!(hdr.includes("종목명") && hdr.includes("평가금액") && hdr.includes("수익률"))) continue;
      const ix = (l) => headers.findIndex((h) => h.includes(l));
      const iName = ix("종목명"),
        iQty = ix("수량"),
        iAvg = ix("단가"), // 평균단가/제비용단가(헤더 동적) 모두 매칭.
        iEval = ix("평가금액"),
        iPL = ix("미실현손익"),
        iRate = ix("수익률");
      let rows = t.querySelectorAll("tbody tr");
      if (!rows.length) rows = t.querySelectorAll("tr");
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll("td");
        if (!cells.length) return; // 헤더행 스킵.
        if (NO_DATA_RE.test(tr.textContent || "")) return; // "조회된 데이터가 없습니다" 안내행 스킵.
        const name = iName >= 0 ? cellText(cells[iName]) : "";
        if (!name || NO_DATA_RE.test(name)) return;
        const qty = iQty >= 0 ? cellText(cells[iQty]) : "";
        const key = category + "|" + name + "|" + qty;
        if (seen.has(key)) return; // [조회내역]/[한화면] 중복 제거.
        seen.add(key);
        const avg = iAvg >= 0 ? cellText(cells[iAvg]) : "";
        const buyAmount = num0(avg) && num0(qty) ? String(num0(avg) * num0(qty)) : "";
        out.push({
          name,
          category,
          quantity: qty,
          buyAmount,
          evalAmount: iEval >= 0 ? cellText(cells[iEval]) : "",
          profitLoss: iPL >= 0 ? cellText(cells[iPL]) : "",
          profitRate: iRate >= 0 ? cellText(cells[iRate]) : "",
        });
      });
    }
    return out;
  }

  /** 표의 제목(caption 또는 직전 형제 텍스트). */
  function tableLabel(t) {
    const cap = t.querySelector("caption");
    if (cap) {
      const x = cellText(cap);
      if (x) return x;
    }
    let p = t.previousElementSibling;
    for (let g = 0; p && g < 3; g++) {
      const x = (p.textContent || "").replace(/\s+/g, " ").trim();
      if (x) return x;
      p = p.previousElementSibling;
    }
    return "";
  }

  /** 헤더 라벨 목록에서 첫 매칭 인덱스(여러 후보 중). */
  function headerIndex(headers, ...labels) {
    for (const l of labels) {
      const i = headers.findIndex((h) => h.includes(l));
      if (i >= 0) return i;
    }
    return -1;
  }

  /**
   * 금융상품 보유표(tblH, 헤더 상품명+평가금액) 파싱 → daily_holdings raw.
   * 상품유형별 표(연금저축/펀드/신탁/퇴직연금)가 따로 있고 컬럼이 조금씩 달라 헤더 텍스트로 매핑:
   *   상품명 / (입금액|매입금액|원금) / 평가금액 / (좌수|수량) / (수익률) / (평가손익|손익).
   * category 는 표 제목에서(예: "연금저축 조회내역" → "연금저축"). 주식표(종목명)는 제외된다.
   */
  function parseFundHoldings(doc) {
    const out = [];
    const seen = new Set();
    for (const t of doc.querySelectorAll("table.tblH")) {
      const headRow = t.querySelector("thead tr") || t.querySelector("tr");
      const headers = Array.from(headRow ? headRow.querySelectorAll("th,td") : []).map((c) =>
        cellText(c).replace(/\s+/g, "")
      );
      const hdr = headers.join("");
      if (!(hdr.includes("상품명") && hdr.includes("평가금액"))) continue;
      const cat = tableLabel(t).replace(/조회내역|내역|보유|현황/g, "").replace(/\s+/g, " ").trim() || "금융상품";
      const iName = headerIndex(headers, "상품명");
      const iEval = headerIndex(headers, "평가금액");
      const iBuy = headerIndex(headers, "매입금액", "입금액", "원금");
      const iQty = headerIndex(headers, "좌수", "수량");
      const iRate = headerIndex(headers, "수익률");
      const iPL = headerIndex(headers, "평가손익", "미실현손익", "손익");
      let rows = t.querySelectorAll("tbody tr");
      if (!rows.length) rows = t.querySelectorAll("tr");
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll("td");
        if (!cells.length) return;
        if (NO_DATA_RE.test(tr.textContent || "")) return;
        const name = iName >= 0 ? cellText(cells[iName]) : "";
        if (!name || NO_DATA_RE.test(name)) return;
        const key = cat + "|" + name;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          name,
          category: cat,
          quantity: iQty >= 0 ? cellText(cells[iQty]) : "",
          buyAmount: iBuy >= 0 ? cellText(cells[iBuy]) : "",
          evalAmount: iEval >= 0 ? cellText(cells[iEval]) : "",
          profitLoss: iPL >= 0 ? cellText(cells[iPL]) : "",
          profitRate: iRate >= 0 ? cellText(cells[iRate]) : "",
        });
      });
    }
    return out;
  }

  /**
   * CMA잔고의 RP/증금예금 표(tblH, 헤더 상품명 + 원금/세후금액) 파싱 → daily_holdings raw.
   *   매수일자 | 상품명 | 금리구분 | 만기일 | 원금 | 예탁일수 | 적용이율 | 이자(세전) | 세금 | 세후금액
   */
  function parseCmaHoldings(doc) {
    const out = [];
    const seen = new Set();
    for (const t of doc.querySelectorAll("table.tblH")) {
      const headRow = t.querySelector("thead tr") || t.querySelector("tr");
      const headers = Array.from(headRow ? headRow.querySelectorAll("th,td") : []).map((c) =>
        cellText(c).replace(/\s+/g, "")
      );
      const hdr = headers.join("");
      if (!(hdr.includes("상품명") && (hdr.includes("원금") || hdr.includes("세후금액")))) continue;
      const iName = headerIndex(headers, "상품명");
      const iPrin = headerIndex(headers, "원금");
      const iAfter = headerIndex(headers, "세후금액");
      rows: {
        let rows = t.querySelectorAll("tbody tr");
        if (!rows.length) rows = t.querySelectorAll("tr");
        rows.forEach((tr) => {
          const cells = tr.querySelectorAll("td");
          if (!cells.length) return;
          if (NO_DATA_RE.test(tr.textContent || "")) return;
          const name = iName >= 0 ? cellText(cells[iName]) : "";
          if (!name || NO_DATA_RE.test(name)) return;
          const key = name + "|" + (iPrin >= 0 ? cellText(cells[iPrin]) : "");
          if (seen.has(key)) return;
          seen.add(key);
          out.push({
            name,
            category: "CMA",
            quantity: "",
            buyAmount: iPrin >= 0 ? cellText(cells[iPrin]) : "",
            evalAmount: iAfter >= 0 ? cellText(cells[iAfter]) : iPrin >= 0 ? cellText(cells[iPrin]) : "",
            profitLoss: "",
            profitRate: "",
          });
        });
      }
    }
    return out;
  }

  /**
   * 탭 전환 — 신한 탭은 `<ul class="tabType"><li><a data-bind="click:on.moveTab.bind($data,N)">…</a></li>`.
   * 정확히 `ul.tabType li a` 텍스트로 클릭한다(LNB 등 동명 링크 오클릭 방지). 없으면 일반 폴백.
   * @returns {boolean} 클릭 수행 여부.
   */
  function clickTabByText(doc, text) {
    const key = text.replace(/\s+/g, "");
    // **ul.tabType 안에서만** 클릭한다. 폴백으로 LNB 등 동명 링크를 누르면 페이지가 이탈하므로 금지.
    for (const a of doc.querySelectorAll("ul.tabType li a")) {
      if ((a.textContent || "").replace(/\s+/g, "") === key) {
        fireClick(a);
        return true;
      }
    }
    return false;
  }

  /** 계좌 선택 + 조회 + 표 변화 대기(현재 페이지). 반환: 갱신된 mainFrame doc. */
  async function selectAndQuery(doc, acc, waitSel) {
    await selectAccount(doc, acc);
    const before = (doc.querySelector(waitSel)?.innerText || "").trim();
    clickSearchButton(doc, "dailyAsset");
    await waitChange(doc, waitSel, before, 6000);
    return getMainDoc();
  }

  /**
   * 총 자산평가 + 주식/선물옵션/금융상품/CMA 보유 수집 → daily_assets/daily_holdings raw 1건(오늘).
   *
   * 플로우(개선): **페이지 바깥 / 계좌 안쪽** — 각 페이지를 한 번만 방문하고 그 안에서 계좌를
   * 순회한다(계좌 선택은 페이지 이동 후에도 유지되지만, 페이지 내에서 계좌별로 다시 선택해
   * 표를 갱신). 페이지 왕복을 최소화한다.
   *   1) 총자산평가(540401, PIN無): 계좌별 총자산/순자산 → daily_assets, 예수금합 → 예수금 holding.
   *   2) 주식/선물옵션(540101, PIN無): 주식·해외주식·KRX금 탭 보유 → daily_holdings.
   *   3) 금융상품(580001, PIN `#inq_pw`): 펀드/신탁/퇴직연금/연금저축 보유 → daily_holdings.
   *   4) CMA잔고(540801, PIN無): RP/증금예금 → daily_holdings.
   * (외화자산은 다음 단계 — PIN `#acct-pwd`·컬럼 상이.)
   * @param {{pin?:string}} [opts]  거래(2차) PIN(금융상품 등 PIN 페이지 조회용, 메모리만).
   * @returns {Promise<object[]>}  [{ kind:"dailyAsset", date, accounts[], holdings[] }]
   */
  async function scrapeDailyAsset(opts = {}) {
    const pin = opts.pin || "";
    const date = todayYmd();
    const accOut = [];
    const holdOut = [];

    // 계좌 목록 확보(총자산평가 페이지로 이동해 #acct-no-combo 읽기).
    await navUrl(PAGES.총자산평가);
    let doc = getMainDoc();
    if (!doc.querySelector("#acct-no-combo")) {
      throw new Error(
        "[shinhan:dailyAsset] 잔고 화면 진입 실패(#acct-no-combo 없음). 신한 로그인 상태를 확인하세요."
      );
    }
    const { accounts } = getAccounts(doc);
    if (!accounts.length) {
      throw new Error("[shinhan:dailyAsset] 계좌 목록을 찾지 못했습니다(#acct-no-combo 비어있음).");
    }

    const cancelCheck = async () => {
      if (await isCancelRequested()) throw new Error(CANCELLED);
    };

    // ── 1) 총자산평가 — 계좌별 totals + 예수금 ──
    for (const acc of accounts) {
      await cancelCheck();
      try {
        doc = await selectAndQuery(getMainDoc(), acc, "table.tblV");
        const map = parseTblVMap(doc);
        accOut.push({
          accountNo: acc.acno,
          accountType: "",
          alias: acc.label,
          totalAsset: map["총자산평가"] || map["총자산"] || "",
          evalAmount: map["순자산평가"] || map["순자산"] || map["총자산평가"] || "",
          profitLoss: "",
          profitRate: "",
        });
        const deposit = map["예수금합"] || map["예수금"] || "";
        if (deposit && num0(deposit) !== 0) {
          holdOut.push({ name: "예수금", category: "예수금", quantity: "", buyAmount: "", evalAmount: deposit, profitLoss: "", profitRate: "" });
        }
      } catch (err) {
        if (String(err?.message || err) === CANCELLED) throw err;
        accOut.push({ accountNo: acc.acno, accountType: "", alias: acc.label, totalAsset: "", evalAmount: "", profitLoss: "", profitRate: "", _skipped: String(err?.message || err) });
      }
    }

    // ── 2) 주식/선물옵션 — 주식·해외주식·KRX금 탭 보유 ──
    try {
      await navUrl(PAGES.주식선물옵션);
      for (const acc of accounts) {
        await cancelCheck();
        doc = getMainDoc();
        await selectAccount(doc, acc);
        for (const [tab, category] of [["주식", "국내주식"], ["해외주식", "해외주식"], ["KRX금", "KRX금"]]) {
          await cancelCheck();
          clickTabByText(doc, tab);
          await sleep(700);
          // 해외주식·KRX금 탭은 전환 시 PIN 칸이 나타난다(국내주식은 없음). pinSearch가 채우고 조회.
          await pinSearch(getMainDoc(), pin, ".tableScroll table.tblH, table.tblH");
          holdOut.push(...parseHoldingsTable(getMainDoc(), category));
          doc = getMainDoc();
        }
      }
    } catch (err) {
      if (String(err?.message || err) === CANCELLED) throw err;
    }

    // ── 3) 금융상품 — 펀드/신탁/퇴직연금/연금저축 보유(PIN 필요) ──
    // 이 페이지는 in-page 탭이 없다(LNB 링크만). 계좌 선택 → PIN → 조회 → 표시되는 상품표 전부 파싱.
    try {
      await navUrl(PAGES.금융상품);
      for (const acc of accounts) {
        await cancelCheck();
        doc = getMainDoc();
        await selectAccount(doc, acc);
        await pinSearch(getMainDoc(), pin, "table.tblH");
        holdOut.push(...parseFundHoldings(getMainDoc()));
      }
    } catch (err) {
      if (String(err?.message || err) === CANCELLED) throw err;
    }

    // ── 4) CMA잔고 — RP/증금예금(PIN無) ──
    try {
      await navUrl(PAGES.CMA잔고);
      for (const acc of accounts) {
        await cancelCheck();
        doc = getMainDoc();
        const d2 = await selectAndQuery(doc, acc, "table.tblH");
        holdOut.push(...parseCmaHoldings(d2));
      }
    } catch (err) {
      if (String(err?.message || err) === CANCELLED) throw err;
    }

    return [{ kind: "dailyAsset", date, accounts: accOut, holdings: holdOut }];
  }

  // ── 스크랩 디스패치 ───────────────────────────────────────────────────────────

  /**
   * SCRAPE_REQUEST 처리. 현재 구현: TRANSACTION(주식거래내역). DAILY_ASSET(잔고)은 추후.
   * payload.pin 은 사용자가 런 단위로 입력한 거래 PIN(메모리만, 저장 안 함).
   */
  async function handleScrape(payload) {
    const source = payload?.source || SOURCE.SHINHAN;
    const target = (payload?.targets && payload.targets[0]) || SCRAPE_TARGET.TRANSACTION;
    const range = payload?.range || {};
    const pin = payload?.pin || "";

    try {
      if (target === SCRAPE_TARGET.TRANSACTION) {
        const raw = await scrapeTransaction({ range, pin });
        return { source, target, ok: true, raw };
      }
      if (target === SCRAPE_TARGET.DAILY_ASSET) {
        const raw = await scrapeDailyAsset({ pin });
        return { source, target, ok: true, raw };
      }
      throw new Error(`[shinhan] 알 수 없는 target: ${target}`);
    } catch (err) {
      if (String(err?.message || err) === CANCELLED) {
        return { source, target, ok: false, cancelled: true, error: "수집이 중단되었습니다." };
      }
      return { source, target, ok: false, error: String(err?.message || err) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.SCRAPE_REQUEST) {
      handleScrape(message.payload || {})
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            source: message.payload?.source || SOURCE.SHINHAN,
            target: (message.payload?.targets && message.payload.targets[0]) || null,
            ok: false,
            error: String(err?.message || err),
          })
        );
      return true;
    }
    if (message?.type === MSG.PROBE) {
      const p = message.payload || {};
      const run = p.walk ? () => handleWalkProbe(p.pin || "") : () => handleProbe();
      run()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, report: "진단 실패: " + String(err?.message || err) }));
      return true;
    }
    return false;
  });
})();
