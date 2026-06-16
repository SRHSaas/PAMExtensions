/**
 * Background service worker — 파이프라인 오케스트레이션 + 메시지 라우터.
 *
 * MV3 서비스워커는 **무상태로 깨어났다 종료**된다. 따라서 진행상태(stage 등)는 메모리가
 * 아니라 chrome.storage.local(STORAGE_KEY.PIPELINE_STATE)에 저장한다. 장시간 작업도
 * 단계별로 상태를 저장해 재기동에도 이어지게 한다.
 *
 * 배선의 뼈대(이 파일이 담당):
 *   popup → SCRAPE_REQUEST 수신
 *     → 활성/대상 탭의 content script로 SCRAPE_REQUEST 전달
 *     → content → SCRAPE_RESULT(raw, 배열) 수신
 *     → normalize(raw) 호출            (src/normalize/index.js)
 *     → upload(payload, origin) 호출   (src/upload/client.js)
 *     → popup에 STATUS / UPLOAD_RESULT 전달
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

// ── 설정된 SRHFinance origin 조회 ────────────────────────────────────────────

/** @returns {Promise<string>} options에서 설정한 origin(없으면 dev 기본값). */
async function getOrigin() {
  const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
  return obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
}

// ── 파이프라인 오케스트레이션 ────────────────────────────────────────────────

/**
 * 스크랩→정규화→업로드 파이프라인 1회 실행.
 * @param {import("../shared/messages.js").ScrapeRequestPayload} req
 */
async function runPipeline(req) {
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

    // 1) SCRAPE — 각 target을 content script로 요청해 raw 수집.
    await emitStatus(STAGE.SCRAPING);
    /** @type {import("../shared/messages.js").ScrapeResultPayload[]} */
    const results = [];
    for (const target of targets) {
      await emitStatus(STAGE.SCRAPING, { target });
      const result = await requestScrape(tabId, { ...req, source, targets: [target], tabId });
      if (!result || !result.ok) {
        throw new Error(result?.error || `스크랩 실패(${target}).`);
      }
      results.push(result);
    }

    // 2) NORMALIZE — raw(배열) → 정규 IngestPayload, 그리고 병합.
    //   각 SCRAPE_RESULT.raw 는 배열이다(dailyAsset=날짜 배열, transaction=계좌 배열).
    //   build 함수가 배열을 그대로 받으므로 r.raw 를 그대로 전달한다.
    await emitStatus(STAGE.NORMALIZING);
    const payloads = results.map((r) =>
      r.target === SCRAPE_TARGET.DAILY_ASSET
        ? buildDailyAssetPayload(r.raw, source)
        : buildTransactionPayload(r.raw, source)
    );
    const payload = mergePayloads(payloads);

    // 3) UPLOAD — 사용자 세션 쿠키로 SRHFinance에 적재.
    await emitStatus(STAGE.UPLOADING);
    const origin = await getOrigin();
    const result = await uploadPayload(payload, origin);

    // 400 계약불일치(contractMismatch)는 normalizer 점검이 필요한 신호다 —
    // 사람이 읽을 에러로 명시해 popup에 전달한다(401/403/500/네트워크는 client.js가
    // 이미 사람이 읽을 error 문구를 주므로 그대로 표시).
    if (result && result.contractMismatch === true) {
      const detail = result.error ? ` (${result.error})` : "";
      const message = `정규화 계약 불일치: 업로드 페이로드가 서버 계약과 어긋납니다(normalizer 점검 필요).${detail}`;
      await emitStatus(STAGE.ERROR, { message });
      await emitUploadResult({ ...result, ok: false, error: message });
      return;
    }

    await emitUploadResult(result);
  } catch (err) {
    await emitStatus(STAGE.ERROR, { message: String(err?.message || err) });
    await emitUploadResult({ ok: false, error: String(err?.message || err) });
  }
}

// ── 메시지 라우터 ────────────────────────────────────────────────────────────

/**
 * chrome.runtime 메시지 라우터. SCRAPE_REQUEST만 여기서 받아 파이프라인을 시작한다.
 * (SCRAPE_RESULT는 content가 SCRAPE_REQUEST의 응답으로 직접 반환하므로 여기로 오지 않는다.)
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  switch (message.type) {
    case MSG.SCRAPE_REQUEST: {
      // 비동기 파이프라인 시작. popup에는 즉시 ack만 보내고 진행은 STATUS로 알린다.
      runPipeline(message.payload || {});
      sendResponse({ ok: true, started: true });
      return false; // 동기 응답 완료.
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
