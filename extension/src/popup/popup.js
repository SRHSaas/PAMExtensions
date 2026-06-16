/**
 * Popup UI 셸 — 2단계 파이프라인 상태머신:
 *   (1) 현재 탭이 미래에셋인지 감지 → SRHFinance 로그인 안내
 *   (2) 스크랩 대상(체크박스) + 기간 모드(자동/지정) 선택
 *   (3) "수집" 버튼 → background로 COLLECT (스크랩+정규화, 저장만)
 *   (4) 미리보기(영역별 건수) → "JSON 다운로드" / "업로드"
 *   (5) "업로드" 버튼 → background로 UPLOAD → counts/에러 표시
 *
 * popup은 사용자 조작·진행 표시만 한다. 스크랩/정규화/업로드 로직은 갖지 않는다.
 * (단, JSON 다운로드는 저장된 페이로드를 popup 컨텍스트에서 Blob으로 만들어 다운로드 —
 *  서버를 거치지 않는 순수 로컬 동작이라 예외적으로 popup이 처리한다.)
 */
import {
  MSG,
  STAGE,
  SOURCE,
  SCRAPE_TARGET,
  STORAGE_KEY,
} from "../shared/messages.js";

// 지원 증권사 → host 매칭 패턴. 새 증권사 추가 시 여기와 manifest를 함께 갱신.
const BROKER_HOSTS = {
  [SOURCE.MIRAEASSET]: "securities.miraeasset.com",
};

const ORIGIN_SETTING_KEY = "srhfinanceOrigin";
const DEFAULT_ORIGIN = "http://localhost:3000";

const STAGE_LABEL = {
  [STAGE.IDLE]: "대기 중",
  [STAGE.SCRAPING]: "스크랩 중…",
  [STAGE.NORMALIZING]: "정규화 중…",
  [STAGE.COLLECTED]: "수집 완료 — 업로드 대기",
  [STAGE.UPLOADING]: "업로드 중…",
  [STAGE.DONE]: "완료",
  [STAGE.ERROR]: "오류",
};

const els = {
  brokerBadge: document.getElementById("brokerBadge"),
  guide: document.getElementById("guide"),
  targetDaily: document.getElementById("targetDaily"),
  targetTx: document.getElementById("targetTx"),
  modeAuto: document.getElementById("modeAuto"),
  modeManual: document.getElementById("modeManual"),
  autoNote: document.getElementById("autoNote"),
  dateInputs: document.getElementById("dateInputs"),
  startDate: document.getElementById("startDate"),
  endDate: document.getElementById("endDate"),
  collectBtn: document.getElementById("collectBtn"),
  preview: document.getElementById("preview"),
  previewCounts: document.getElementById("previewCounts"),
  downloadBtn: document.getElementById("downloadBtn"),
  uploadBtn: document.getElementById("uploadBtn"),
  probeBtn: document.getElementById("probeBtn"),
  probeBox: document.getElementById("probeBox"),
  probeOut: document.getElementById("probeOut"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  result: document.getElementById("result"),
  resultError: document.getElementById("resultError"),
  counts: document.getElementById("counts"),
  originLabel: document.getElementById("originLabel"),
  openOptions: document.getElementById("openOptions"),
};

/** 현재 활성 탭에서 감지된 증권사 source(없으면 null). */
let detectedSource = null;
let detectedTabId = null;
/** 진행 중(수집/업로드)이면 true — 버튼 비활성 게이팅용. */
let busy = false;

// ── (1) 현재 탭 감지 + origin 표시 ───────────────────────────────────────────

async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  detectedTabId = tab?.id ?? null;
  const url = tab?.url || "";

  detectedSource = null;
  for (const [source, host] of Object.entries(BROKER_HOSTS)) {
    if (url.includes(host)) {
      detectedSource = source;
      break;
    }
  }

  if (detectedSource) {
    els.brokerBadge.textContent = detectedSource;
    els.brokerBadge.className = "badge on";
    els.guide.textContent =
      "미래에셋에 로그인된 탭입니다. SRHFinance에도 로그인돼 있어야 업로드됩니다. 대상/기간을 고른 뒤 수집하세요.";
    els.probeBtn.disabled = false;
  } else {
    els.brokerBadge.textContent = "대상 아님";
    els.brokerBadge.className = "badge off";
    els.guide.innerHTML =
      "지원 증권사 페이지가 아닙니다. <b>미래에셋(securities.miraeasset.com)</b>에 로그인한 탭에서 다시 열어주세요.";
    els.probeBtn.disabled = true;
  }

  const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
  const origin = obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
  els.originLabel.textContent = "origin: " + origin;

  updateCollectEnabled();
}

// ── 선택 상태 헬퍼 ───────────────────────────────────────────────────────────

/** 체크된 스크랩 대상 배열. */
function selectedTargets() {
  const t = [];
  if (els.targetDaily.checked) t.push(SCRAPE_TARGET.DAILY_ASSET);
  if (els.targetTx.checked) t.push(SCRAPE_TARGET.TRANSACTION);
  return t;
}

/** 현재 기간 모드("auto"|"manual"). */
function rangeMode() {
  return els.modeManual.checked ? "manual" : "auto";
}

/** 수집 버튼 활성화: 대상 1개 이상 + 미래에셋 탭 + 진행 중 아님. */
function updateCollectEnabled() {
  const ok = !busy && detectedSource != null && selectedTargets().length > 0;
  els.collectBtn.disabled = !ok;
}

// ── (3) 진행 STATUS 렌더 ─────────────────────────────────────────────────────

function renderStatus(stage, message) {
  els.statusText.textContent = message || STAGE_LABEL[stage] || stage;
  els.statusDot.className = "dot";
  const running = [STAGE.SCRAPING, STAGE.NORMALIZING, STAGE.UPLOADING].includes(stage);
  busy = running;
  if (running) {
    els.statusDot.classList.add("run");
  } else if (stage === STAGE.DONE || stage === STAGE.COLLECTED) {
    els.statusDot.classList.add("ok");
  } else if (stage === STAGE.ERROR) {
    els.statusDot.classList.add("err");
  }
  els.uploadBtn.disabled = busy;
  els.downloadBtn.disabled = busy;
  updateCollectEnabled();
}

// ── (4) 건수 렌더(미리보기 + 업로드 결과 공용) ───────────────────────────────

const COUNT_LABEL = {
  accounts: "계좌",
  daily_assets: "일자별 자산",
  daily_holdings: "보유 종목",
  transactions: "거래",
  dividends: "배당",
};

function countsHtml(counts) {
  return Object.entries(COUNT_LABEL)
    .map(
      ([k, label]) =>
        `<span class="k">${label}</span><span class="v">${counts?.[k] ?? 0}</span>`
    )
    .join("");
}

/** 미리보기 영역 표시(수집 결과 counts). */
function renderPreview(counts) {
  els.preview.classList.remove("hidden");
  els.previewCounts.innerHTML = countsHtml(counts);
}

/** 업로드 결과 렌더. */
function renderResult(payload) {
  els.result.classList.remove("hidden");
  if (payload.ok && payload.counts) {
    els.resultError.classList.add("hidden");
    els.counts.classList.remove("hidden");
    els.counts.innerHTML = countsHtml(payload.counts);
  } else {
    els.counts.classList.add("hidden");
    els.resultError.classList.remove("hidden");
    const status = payload.status ? ` (HTTP ${payload.status})` : "";
    els.resultError.textContent = (payload.error || "업로드 실패") + status;
  }
}

// ── 기간 모드 UI 토글 ────────────────────────────────────────────────────────

function syncRangeModeUI() {
  const manual = rangeMode() === "manual";
  els.dateInputs.classList.toggle("hidden", !manual);
  els.autoNote.classList.toggle("hidden", manual);
}

els.modeAuto.addEventListener("change", syncRangeModeUI);
els.modeManual.addEventListener("change", syncRangeModeUI);
els.targetDaily.addEventListener("change", updateCollectEnabled);
els.targetTx.addEventListener("change", updateCollectEnabled);

// ── (3) 수집 → COLLECT ───────────────────────────────────────────────────────

els.collectBtn.addEventListener("click", async () => {
  if (!detectedSource) return;
  const targets = selectedTargets();
  if (targets.length === 0) return;

  const mode = rangeMode();
  /** @type {import("../shared/messages.js").CollectRequestPayload} */
  const payload = {
    source: detectedSource,
    targets,
    tabId: detectedTabId ?? undefined,
    rangeMode: mode,
  };
  if (mode === "manual") {
    const startDate = els.startDate.value;
    const endDate = els.endDate.value;
    if (!startDate || !endDate) {
      renderStatus(STAGE.ERROR, "지정 기간: 시작일과 종료일을 입력하세요.");
      return;
    }
    payload.range = { startDate, endDate };
  }

  els.result.classList.add("hidden");
  els.preview.classList.add("hidden");
  renderStatus(STAGE.SCRAPING);
  // fire-and-forget: COLLECT는 장시간 작업이라 응답을 기다리지 않는다(팝업이 닫히면
  // 채널이 끊겨 "message channel closed"가 난다). 진행은 STATUS, 결과는 COLLECT_RESULT
  // 브로드캐스트로 받고, 팝업이 닫혔다 열려도 storage에서 복원한다(init 참조).
  // sendMessage는 ack만 받고 결과는 무시한다(에러도 catch로 삼킴 — 팝업이 닫혀도 무해).
  chrome.runtime.sendMessage({ type: MSG.COLLECT, payload }).catch(() => {});
});

// ── (4) JSON 다운로드(로컬, 서버 안 거침) ────────────────────────────────────

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

els.downloadBtn.addEventListener("click", async () => {
  const { [STORAGE_KEY.PENDING_PAYLOAD]: pending } = await chrome.storage.local.get(
    STORAGE_KEY.PENDING_PAYLOAD
  );
  if (!pending || !pending.payload) {
    renderStatus(STAGE.ERROR, "다운로드할 수집 데이터가 없습니다. 먼저 수집하세요.");
    return;
  }
  const blob = new Blob([JSON.stringify(pending.payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pam-${pending.source || "miraeasset"}-${timestampName()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ── (5) 업로드 → UPLOAD ──────────────────────────────────────────────────────

els.uploadBtn.addEventListener("click", () => {
  els.result.classList.add("hidden");
  renderStatus(STAGE.UPLOADING);
  // fire-and-forget(COLLECT와 동일). 결과는 UPLOAD_RESULT 브로드캐스트로 받는다.
  chrome.runtime.sendMessage({ type: MSG.UPLOAD, payload: {} }).catch(() => {});
});

// ── (2b) 진단: 페이지 구조를 읽어 팝업에 표시(콘솔 없이 복사용) ───────────────

els.probeBtn.addEventListener("click", async () => {
  els.probeBox.classList.remove("hidden");
  els.probeOut.value = "진단 중…";
  els.probeBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.PROBE,
      payload: { tabId: detectedTabId ?? undefined },
    });
    els.probeOut.value =
      (res && res.report) || "(보고서 없음) " + JSON.stringify(res || {});
  } catch (err) {
    els.probeOut.value = "진단 실패: " + String(err?.message || err);
  } finally {
    els.probeBtn.disabled = detectedSource == null;
    els.probeOut.focus();
    els.probeOut.select();
  }
});

// ── background → popup 메시지 수신(STATUS / COLLECT_RESULT / UPLOAD_RESULT) ───
// 장시간 작업(COLLECT/UPLOAD)은 응답이 아니라 이 브로드캐스트로 결과를 받는다.

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === MSG.STATUS) {
    renderStatus(message.payload?.stage, message.payload?.message);
  } else if (message.type === MSG.COLLECT_RESULT) {
    const p = message.payload || {};
    if (p.ok) {
      renderStatus(STAGE.COLLECTED);
      renderPreview(p.counts);
    } else {
      renderStatus(STAGE.ERROR, p.error || "수집 실패");
    }
  } else if (message.type === MSG.UPLOAD_RESULT) {
    renderStatus(message.payload?.ok ? STAGE.DONE : STAGE.ERROR);
    renderResult(message.payload || {});
  }
});

// 옵션 페이지 열기.
els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── 초기화: 컨텍스트 감지 + 수집/진행상태 복원 ───────────────────────────────

(async function init() {
  syncRangeModeUI();
  await detectContext();

  // 이미 수집된 페이로드가 있으면 미리보기 복원(바로 업로드 가능).
  const { [STORAGE_KEY.PENDING_PAYLOAD]: pending } = await chrome.storage.local.get(
    STORAGE_KEY.PENDING_PAYLOAD
  );
  if (pending && pending.counts) {
    renderPreview(pending.counts);
  }

  // 무상태 서비스워커가 저장해 둔 마지막 진행상태 복원.
  const { [STORAGE_KEY.PIPELINE_STATE]: state } = await chrome.storage.local.get(
    STORAGE_KEY.PIPELINE_STATE
  );
  if (state) {
    renderStatus(state.stage, undefined);
    if (state.lastResult) renderResult(state.lastResult);
  } else {
    renderStatus(STAGE.IDLE);
  }
})();
