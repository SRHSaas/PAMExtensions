/**
 * Background service worker — 파이프라인 오케스트레이션 + 메시지 라우터.
 *
 * MV3 서비스워커는 **무상태로 깨어났다 종료**된다. 따라서 진행상태(stage 등)는 메모리가
 * 아니라 chrome.storage.local(STORAGE_KEY.PIPELINE_STATE)에 저장한다. 장시간 작업도
 * 단계별로 상태를 저장해 재기동에도 이어지게 한다.
 *
 * 배선의 뼈대(이 파일이 담당) — **2단계 파이프라인**: 수집(COLLECT) → 업로드(UPLOAD).
 *   1) popup → COLLECT 수신
 *      → (auto면) SRHFinance last-dates 조회로 target별 증분 기간 계산
 *      → 활성/대상 탭의 content script로 SCRAPE_REQUEST(target별 range) 전달
 *      → content → SCRAPE_RESULT(raw, 배열) 수신
 *      → normalize(raw) 호출            (src/normalize/index.js)
 *      → 정규 페이로드를 chrome.storage.local[PENDING_PAYLOAD]에 저장(업로드 안 함)
 *      → popup에 counts/usedRanges 응답 + STATUS(COLLECTED)
 *   2) popup → UPLOAD 수신
 *      → 저장된 페이로드를 upload(payload, origin) 호출 (src/upload/client.js)
 *      → popup에 STATUS / UPLOAD_RESULT 전달
 *   (선택) popup → LAST_DATES: 자동 기간 안내 표시용 last-dates 조회.
 *
 * 금지(서버 권위 침범): user_id/seq/resolved_name 부여, daily_holdings 미리합산,
 * 쿠키 자동유지/keepalive/세션위조, service_role/별도 토큰. 업로드는 사용자 세션 쿠키만.
 */
import {
  MSG,
  STAGE,
  SCRAPE_TARGET,
  STORAGE_KEY,
} from "../shared/messages.js";

// ───────────────────────────────────────────────────────────────────────────
// 모듈 경계 — 완성된 팀원 모듈 실배선(시그니처는 01_architect_interface.md §6 계약과 일치).
//   normalizer-engineer → src/normalize/index.js
//     buildDailyAssetPayload(raw, source) / buildTransactionPayload(raw, source) → IngestPayload
//     mergePayloads(payloads) → IngestPayload  (영역 배열 concat, 미리합산 금지)
//   integration-engineer → src/upload/client.js
//     uploadPayload(payload, origin) → { ok, counts?, status?, error?, contractMismatch? }
//   content(scraper) → src/content/miraeasset/index.js: SCRAPE_RESULT.raw 는 **배열**
//     (dailyAsset=날짜 배열, transaction=계좌 배열). build 함수에 그대로 전달한다.
// ───────────────────────────────────────────────────────────────────────────
import {
  buildDailyAssetPayload,
  buildTransactionPayload,
  mergePayloads,
} from "../normalize/index.js";
import { uploadPayload } from "../upload/client.js";

/** options에서 설정하는 SRHFinance origin(미설정 시 dev 기본값). */
const DEFAULT_ORIGIN = "http://localhost:3000";
/** options(chrome.storage.sync)에 저장되는 origin 키. options.js와 공유. */
const ORIGIN_SETTING_KEY = "srhfinanceOrigin";

// ── 진행상태 저장/조회 (무상태 서비스워커 대비) ──────────────────────────────

/**
 * 파이프라인 진행상태를 chrome.storage.local에 저장한다.
 * @param {Partial<import("../shared/messages.js").PipelineState>} patch
 * @returns {Promise<import("../shared/messages.js").PipelineState>}
 */
async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_KEY.PIPELINE_STATE]: next });
  return next;
}

/** @returns {Promise<import("../shared/messages.js").PipelineState>} */
async function getState() {
  const obj = await chrome.storage.local.get(STORAGE_KEY.PIPELINE_STATE);
  return obj[STORAGE_KEY.PIPELINE_STATE] || { stage: STAGE.IDLE };
}

// ── popup으로 STATUS / 결과 브로드캐스트 ─────────────────────────────────────

/**
 * STATUS 메시지를 popup으로 보낸다(+진행상태 저장). popup이 닫혀 있으면
 * sendMessage가 실패할 수 있으므로 오류는 삼킨다(상태는 storage에 남는다).
 * @param {string} stage  STAGE.*
 * @param {{ message?: string, target?: string }} [extra]
 */
async function emitStatus(stage, extra = {}) {
  await setState({ stage, error: stage === STAGE.ERROR ? extra.message : undefined });
  chrome.runtime
    .sendMessage({ type: MSG.STATUS, payload: { stage, ...extra } })
    .catch(() => {});
}

/**
 * UPLOAD_RESULT 메시지를 popup으로 보낸다(+마지막 결과 저장).
 * @param {import("../shared/messages.js").UploadResultPayload} payload
 */
async function emitUploadResult(payload) {
  await setState({ stage: payload.ok ? STAGE.DONE : STAGE.ERROR, lastResult: payload });
  chrome.runtime
    .sendMessage({ type: MSG.UPLOAD_RESULT, payload })
    .catch(() => {});
}

/**
 * COLLECT_RESULT 메시지를 popup으로 broadcast 한다. COLLECT는 장시간 작업이라
 * sendMessage 응답으로 결과를 돌려줄 수 없다(팝업이 닫히면 채널이 끊김). 진행상태와
 * pendingPayload는 이미 storage에 저장돼 있으므로, 이 메시지는 실시간 미리보기 갱신용이다
 * (popup이 닫혀 있으면 catch로 삼키고, 재오픈 시 storage에서 복원한다).
 * @param {import("../shared/messages.js").CollectResultPayload} payload
 */
async function emitCollectResult(payload) {
  chrome.runtime
    .sendMessage({ type: MSG.COLLECT_RESULT, payload })
    .catch(() => {});
}

// ── 대상 탭으로 SCRAPE_REQUEST 전달 → SCRAPE_RESULT 수신 ─────────────────────

/**
 * 대상 탭의 content script에 SCRAPE_REQUEST를 보내고 SCRAPE_RESULT를 받는다.
 * content script는 manifest의 content_scripts로 이미 주입돼 있다(document_idle).
 * @param {number} tabId
 * @param {import("../shared/messages.js").ScrapeRequestPayload} payload
 * @returns {Promise<import("../shared/messages.js").ScrapeResultPayload>}
 */
async function requestScrape(tabId, payload) {
  const msg = { type: MSG.SCRAPE_REQUEST, payload };
  try {
    // content script는 SCRAPE_RESULT payload를 응답으로 반환한다(아래 계약).
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    // "Could not establish connection. Receiving end does not exist." —
    // 확장 로드/리로드 전부터 열려 있던 탭에는 선언형 content script가 자동 주입되지 않는다.
    // scripting 권한 + 미래에셋 host_permission이 있으므로 직접 주입 후 1회 재시도한다.
    // (정상 로드된 탭이면 위 sendMessage가 바로 성공해 이 경로는 타지 않는다.)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/miraeasset/index.js"],
    });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// ── MAIN-world 페이지 브리지 주입 (선언형 주입 실패 폴백) ────────────────────

/**
 * page-bridge.js 를 대상 탭의 **top 프레임 MAIN world** 에 주입한다.
 * 선언형 content_scripts(world:MAIN)가 어떤 이유로든 적용되지 않은 탭(확장 로드 전부터 열린 탭,
 * world 미지원 등)을 위한 폴백. content(ISOLATED)가 same-frame ping 무응답 시 INJECT_BRIDGE 로 요청.
 * 브리지는 멱등(중복 설치 가드)하므로 중복 주입돼도 안전하다.
 * @param {number} tabId
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function injectPageBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, // top 프레임만. 브리지가 contentframe 전역까지 탐색함.
      world: "MAIN",
      files: ["src/content/miraeasset/page-bridge.js"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ── 진단(PROBE) — content에 위임, 미주입 탭은 주입 후 재시도 ──────────────────

/**
 * 대상 탭의 content script에 PROBE를 보내 페이지 구조 보고서를 받는다.
 * content script가 아직 없으면(확장 로드 전 열린 탭) 직접 주입 후 1회 재시도.
 * @param {number} tabId
 * @returns {Promise<{ ok:boolean, report:string }>}
 */
async function probeTab(tabId) {
  const msg = { type: MSG.PROBE };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/miraeasset/index.js"],
    });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// ── 설정된 SRHFinance origin 조회 ────────────────────────────────────────────

/** @returns {Promise<string>} options에서 설정한 origin(없으면 dev 기본값). */
async function getOrigin() {
  const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
  return obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
}

// ── 날짜 헬퍼(자동 증분 기간 계산) ──────────────────────────────────────────

/** 자동 기간의 기본 시작일(last-dates에 값이 없을 때). */
const DEFAULT_START_DATE = "2020-01-01";
/** SRHFinance 마지막 수집일 조회 경로(GET, 세션 쿠키). */
const LAST_DATES_PATH = "/api/ingest/last-dates";

/** Date → "YYYY-MM-DD"(로컬 기준). */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 오늘 "YYYY-MM-DD". */
function todayYmd() {
  return ymd(new Date());
}

/**
 * SRHFinance에서 마지막 수집일을 조회한다(자동 증분 기간 계산용).
 * GET {origin}/api/ingest/last-dates (세션 쿠키). 응답 { daily_last, tx_last }(둘 다 "YYYY-MM-DD"|null).
 * @param {string} origin
 * @returns {Promise<{ daily_last: string|null, tx_last: string|null }>}
 * @throws 엔드포인트 없음/네트워크/미로그인 시 사람이 읽을 메시지로 throw.
 */
async function fetchLastDates(origin) {
  const url = `${String(origin || "").replace(/\/+$/, "")}${LAST_DATES_PATH}`;
  let res;
  try {
    res = await fetch(url, { method: "GET", credentials: "include" });
  } catch (err) {
    throw new Error(
      "자동 기간 조회 실패 — SRHFinance에 last-dates API가 없거나 로그인 필요. 수동 기간을 쓰세요."
    );
  }
  if (!res.ok) {
    throw new Error(
      "자동 기간 조회 실패 — SRHFinance에 last-dates API가 없거나 로그인 필요. 수동 기간을 쓰세요."
    );
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      "자동 기간 조회 실패 — SRHFinance에 last-dates API가 없거나 로그인 필요. 수동 기간을 쓰세요."
    );
  }
  return {
    daily_last: data?.daily_last ?? null,
    tx_last: data?.tx_last ?? null,
  };
}

/**
 * rangeMode/target에 따라 target별 사용 기간을 계산한다.
 *   manual → 모든 target에 받은 range 그대로.
 *   auto   → last-dates 조회 후 target별 증분 기간(시작일 = 마지막 수집일 자체, 그날 포함):
 *            dailyAsset → {start: daily_last 또는 기본시작, end: 오늘}
 *            transaction → {start: tx_last 또는 기본시작, end: 오늘}
 * @param {string[]} targets
 * @param {"auto"|"manual"} rangeMode
 * @param {{startDate?:string,endDate?:string}|undefined} manualRange
 * @param {string} origin
 * @returns {Promise<Record<string,{startDate:string,endDate:string}>>}
 */
async function computeRanges(targets, rangeMode, manualRange, origin) {
  /** @type {Record<string,{startDate:string,endDate:string}>} */
  const ranges = {};
  if (rangeMode === "manual") {
    const r = {
      startDate: manualRange?.startDate,
      endDate: manualRange?.endDate,
    };
    for (const t of targets) ranges[t] = r;
    return ranges;
  }

  // auto: 마지막 수집일 조회 → target별 증분.
  // 시작일 = 마지막 수집일 자체(그날 포함, +1 아님). 이유:
  //  (1) 거래내역: 마지막 업로드 시점 이후에도 같은 날짜의 거래가 더 발생할 수 있어 그날을 다시 수집해야 함.
  //  (2) 일자별자산: 마지막 날 스냅샷이 장중(미확정) 값일 수 있어, 그날 종가 기준으로 다시 받아 덮어써야 함.
  // 같은 날짜 재수집의 중복은 SRHFinance ingest의 upsert로 정리된다.
  const { daily_last, tx_last } = await fetchLastDates(origin);
  const today = todayYmd();
  for (const t of targets) {
    const last = t === SCRAPE_TARGET.TRANSACTION ? tx_last : daily_last;
    const startDate = last || DEFAULT_START_DATE;
    ranges[t] = { startDate, endDate: today };
  }
  return ranges;
}

// ── 2단계 파이프라인 (1) 수집: 스크랩 + 정규화 + 저장 ────────────────────────

/**
 * 수집 단계: 각 target을 스크랩→정규화→병합한 뒤 chrome.storage.local에 저장한다.
 * 업로드는 하지 않는다(미리보기 후 별도 UPLOAD).
 * @param {import("../shared/messages.js").CollectRequestPayload} req
 * @returns {Promise<import("../shared/messages.js").CollectResultPayload>}
 */
async function runCollect(req) {
  try {
    // 대상 탭 결정: 요청에 tabId 없으면 활성 탭.
    let tabId = req.tabId;
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    if (tabId == null) throw new Error("대상 탭을 찾을 수 없습니다.");

    const source = req.source;
    const targets = req.targets?.length ? req.targets : [SCRAPE_TARGET.DAILY_ASSET];
    const rangeMode = req.rangeMode === "manual" ? "manual" : "auto";

    // 0) 기간 계산(auto면 SRHFinance last-dates 조회 — 실패 시 사람이 읽을 메시지로 중단).
    const origin = await getOrigin();
    const usedRanges = await computeRanges(targets, rangeMode, req.range, origin);

    // 1) SCRAPE — target별로 해당 range를 실어 content에 요청.
    await emitStatus(STAGE.SCRAPING);
    /** @type {import("../shared/messages.js").ScrapeResultPayload[]} */
    const results = [];
    for (const target of targets) {
      await emitStatus(STAGE.SCRAPING, { target });
      const result = await requestScrape(tabId, {
        source,
        targets: [target],
        tabId,
        range: usedRanges[target],
      });
      if (!result || !result.ok) {
        throw new Error(result?.error || `스크랩 실패(${target}).`);
      }
      results.push(result);
    }

    // 2) NORMALIZE — raw(배열) → 정규 IngestPayload, 병합.
    await emitStatus(STAGE.NORMALIZING);
    const payloads = results.map((r) =>
      r.target === SCRAPE_TARGET.DAILY_ASSET
        ? buildDailyAssetPayload(r.raw, source)
        : buildTransactionPayload(r.raw, source)
    );
    const payload = mergePayloads(payloads);

    const counts = {
      accounts: payload.accounts?.length || 0,
      daily_assets: payload.daily_assets?.length || 0,
      daily_holdings: payload.daily_holdings?.length || 0,
      transactions: payload.transactions?.length || 0,
      dividends: payload.dividends?.length || 0,
    };

    // 3) 저장 — 업로드 전 미리보기/업로드 입력으로 chrome.storage.local에 보관.
    /** @type {import("../shared/messages.js").PendingPayload} */
    const pending = {
      payload,
      counts,
      source,
      usedRanges,
      collectedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [STORAGE_KEY.PENDING_PAYLOAD]: pending });

    await emitStatus(STAGE.COLLECTED, { message: "수집 완료 — 미리보기 후 업로드하세요." });
    // fire-and-ack: 결과는 응답이 아니라 broadcast + storage로 알린다(popup이 닫혀도 안전).
    await emitCollectResult({ ok: true, counts, usedRanges });
  } catch (err) {
    const message = String(err?.message || err);
    await emitStatus(STAGE.ERROR, { message });
    await emitCollectResult({ ok: false, error: message });
  }
}

// ── 2단계 파이프라인 (2) 업로드: 저장된 페이로드 적재 ────────────────────────

/**
 * 업로드 단계: 저장된 pendingPayload를 사용자 세션 쿠키로 SRHFinance에 적재한다.
 * @returns {Promise<import("../shared/messages.js").UploadResultPayload & { contractMismatch?: boolean }>}
 */
async function runUpload() {
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY.PENDING_PAYLOAD);
    /** @type {import("../shared/messages.js").PendingPayload|undefined} */
    const pending = obj[STORAGE_KEY.PENDING_PAYLOAD];
    if (!pending || !pending.payload) {
      const message = "업로드할 수집 데이터가 없습니다. 먼저 수집을 실행하세요.";
      await emitStatus(STAGE.ERROR, { message });
      const res = { ok: false, error: message };
      await emitUploadResult(res);
      return res;
    }

    await emitStatus(STAGE.UPLOADING);
    const origin = await getOrigin();
    const result = await uploadPayload(pending.payload, origin);

    // 400 계약불일치는 normalizer 점검 신호 — 사람이 읽을 에러로 명시.
    if (result && result.contractMismatch === true) {
      const detail = result.error ? ` (${result.error})` : "";
      const message = `정규화 계약 불일치: 업로드 페이로드가 서버 계약과 어긋납니다(normalizer 점검 필요).${detail}`;
      await emitStatus(STAGE.ERROR, { message });
      const res = { ...result, ok: false, error: message };
      await emitUploadResult(res);
      return res;
    }

    // 성공 시 pendingPayload에 uploadedAt 기록(재업로드 방지·이력 표시용).
    if (result?.ok) {
      await chrome.storage.local.set({
        [STORAGE_KEY.PENDING_PAYLOAD]: { ...pending, uploadedAt: new Date().toISOString() },
      });
    }

    await emitUploadResult(result);
    return result;
  } catch (err) {
    const message = String(err?.message || err);
    await emitStatus(STAGE.ERROR, { message });
    const res = { ok: false, error: message };
    await emitUploadResult(res);
    return res;
  }
}

// ── 메시지 라우터 ────────────────────────────────────────────────────────────

/**
 * chrome.runtime 메시지 라우터. 2단계 파이프라인: COLLECT(수집) → UPLOAD(업로드).
 * (SCRAPE_RESULT는 content가 SCRAPE_REQUEST의 응답으로 직접 반환하므로 여기로 오지 않는다.)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  switch (message.type) {
    case MSG.COLLECT: {
      // 장시간 작업(여러 날짜 스크랩). **fire-and-ack**: 즉시 ack만 하고 작업은 비동기로
      // 시작한다. 진행은 STATUS, 최종 결과는 COLLECT_RESULT 브로드캐스트 + storage 저장으로
      // 알린다. popup이 응답을 기다리지 않으므로 팝업이 닫혀도 채널 끊김 오류가 없다.
      runCollect(message.payload || {}); // await 하지 않음.
      sendResponse({ ok: true, started: true });
      return false; // 동기 ack 완료 — 채널 즉시 닫혀도 OK.
    }
    case MSG.UPLOAD: {
      // 업로드도 길 수 있다. COLLECT와 동일한 fire-and-ack. 결과는 UPLOAD_RESULT
      // 브로드캐스트 + storage(emitUploadResult)로 알린다.
      runUpload(); // await 하지 않음.
      sendResponse({ ok: true, started: true });
      return false; // 동기 ack 완료.
    }
    case MSG.LAST_DATES: {
      // 자동 기간 안내 표시용. SRHFinance last-dates 조회 결과를 회신.
      (async () => {
        const origin = await getOrigin();
        try {
          const { daily_last, tx_last } = await fetchLastDates(origin);
          return { ok: true, daily_last, tx_last };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // 비동기 응답.
    }
    case MSG.INJECT_BRIDGE: {
      // content(ISOLATED)가 same-frame ping 무응답 시 MAIN-world 브리지 주입을 요청.
      // 요청 보낸 탭(sender.tab)의 top 프레임에 page-bridge.js 를 주입하고 결과를 회신한다.
      const tabId = sender?.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "발신 탭 식별 불가(sender.tab 없음)." });
        return false;
      }
      injectPageBridge(tabId).then(sendResponse);
      return true; // 비동기 응답.
    }
    case MSG.PROBE: {
      // popup → 진단 요청. payload.tabId(없으면 활성 탭)의 content에 위임해 보고서를 회신.
      (async () => {
        let tabId = message.payload?.tabId;
        if (tabId == null) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id;
        }
        if (tabId == null) return { ok: false, report: "대상 탭을 찾을 수 없습니다." };
        return probeTab(tabId);
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, report: String(e?.message || e) }));
      return true; // 비동기 응답.
    }
    // STATUS / UPLOAD_RESULT 는 background가 popup으로 보내는 단방향 메시지라 수신 분기 불필요.
    default:
      return false;
  }
});

// 서비스워커 콜드스타트 시 상태 정리 훅(선택). 진행 중이던 작업은 재개하지 않고
// IDLE로 두되, 마지막 결과는 storage에 보존된다(무상태 전제).
chrome.runtime.onStartup?.addListener(() => {
  // no-op: 자동 재개/ keepalive 금지. 사용자가 다시 트리거해야 한다.
});
