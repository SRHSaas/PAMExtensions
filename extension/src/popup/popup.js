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
  [SOURCE.SHINHAN]: "shinhansec.com",
};

// 사람이 읽을 증권사 라벨/host 안내(가이드 문구·PIN 노출 판단에 사용).
const BROKER_LABEL = {
  [SOURCE.MIRAEASSET]: "미래에셋(securities.miraeasset.com)",
  [SOURCE.SHINHAN]: "신한투자증권(shinhansec.com)",
};

// 거래(2차) PIN 입력칸을 노출할 증권사. 거래내역 조회 시 PIN을 요구하는 곳만.
const PIN_SOURCES = new Set([SOURCE.SHINHAN]);

// 증권사별 지원 스크랩 대상. 미구현 영역은 팝업에서 비활성화해 수집 실패를 막는다.
// (신한은 현재 거래내역만 구현 — 잔고/일자별자산은 추후.)
const SUPPORTED_TARGETS = {
  [SOURCE.MIRAEASSET]: new Set([SCRAPE_TARGET.DAILY_ASSET, SCRAPE_TARGET.TRANSACTION]),
  [SOURCE.SHINHAN]: new Set([SCRAPE_TARGET.DAILY_ASSET, SCRAPE_TARGET.TRANSACTION]),
};

// 거래 PIN을 **브라우저 세션 동안** 보관하는 키(매번 재입력 방지). chrome.storage.session 은
// 메모리에만 있고 **디스크에 기록되지 않으며** 브라우저를 완전히 닫으면 사라진다(local보다 안전).
// 정규 페이로드(pendingPayload)·진행상태에는 절대 들어가지 않는다 — 팝업↔세션스토리지 한정.
const PIN_STORAGE_KEY = "pam:txnPin";

/** 세션에 보관된 PIN 복원(없거나 미지원이면 ""). */
async function loadSavedPin() {
  try {
    if (!chrome.storage.session) return "";
    const o = await chrome.storage.session.get(PIN_STORAGE_KEY);
    return o[PIN_STORAGE_KEY] || "";
  } catch (e) {
    return "";
  }
}
/** PIN을 세션에 저장(빈 값이면 삭제). 디스크 저장 아님. */
async function savePin(pin) {
  try {
    if (!chrome.storage.session) return;
    if (pin) await chrome.storage.session.set({ [PIN_STORAGE_KEY]: pin });
    else await chrome.storage.session.remove(PIN_STORAGE_KEY);
  } catch (e) {
    /* ignore */
  }
}

/** 오늘 "YYYY-MM-DD"(date input 기본값용). */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
  pinRow: document.getElementById("pinRow"),
  pinInput: document.getElementById("pinInput"),
  collectBtn: document.getElementById("collectBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  preview: document.getElementById("preview"),
  previewCounts: document.getElementById("previewCounts"),
  downloadBtn: document.getElementById("downloadBtn"),
  uploadBtn: document.getElementById("uploadBtn"),
  probeBtn: document.getElementById("probeBtn"),
  walkBtn: document.getElementById("walkBtn"),
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
    const label = BROKER_LABEL[detectedSource] || detectedSource;
    els.brokerBadge.textContent = detectedSource;
    els.brokerBadge.className = "badge on";
    els.guide.textContent =
      `${label}에 로그인된 탭입니다. SRHFinance에도 로그인돼 있어야 업로드됩니다. 대상/기간을 고른 뒤 수집하세요.`;
    els.probeBtn.disabled = false;
    els.walkBtn.disabled = false;
  } else {
    const known = Object.values(BROKER_LABEL).join(", ");
    els.brokerBadge.textContent = "대상 아님";
    els.brokerBadge.className = "badge off";
    els.guide.innerHTML =
      `지원 증권사 페이지가 아닙니다. 지원: <b>${known}</b>. 해당 증권사에 로그인한 탭에서 다시 열어주세요.`;
    els.probeBtn.disabled = true;
    els.walkBtn.disabled = true;
  }

  // 거래 PIN 입력칸은 PIN을 요구하는 증권사(신한 등)에서만 노출.
  const pinNeeded = !!(detectedSource && PIN_SOURCES.has(detectedSource));
  els.pinRow.classList.toggle("hidden", !pinNeeded);
  // 세션에 보관된 PIN 복원(매번 재입력 방지).
  if (pinNeeded && !els.pinInput.value) {
    const saved = await loadSavedPin();
    if (saved) els.pinInput.value = saved;
  }

  // 미구현 스크랩 대상은 비활성화(예: 신한 일자별 자산). 지원 대상만 체크 가능.
  const supported = detectedSource ? SUPPORTED_TARGETS[detectedSource] : null;
  const dailyOk = !supported || supported.has(SCRAPE_TARGET.DAILY_ASSET);
  const txOk = !supported || supported.has(SCRAPE_TARGET.TRANSACTION);
  els.targetDaily.disabled = !dailyOk;
  els.targetTx.disabled = !txOk;
  if (!dailyOk) els.targetDaily.checked = false;
  if (!txOk) els.targetTx.checked = false;
  // 비활성 대상 라벨에 안내(중복 추가 방지).
  const dailyLabel = document.querySelector('label[for="targetDaily"]');
  if (dailyLabel) {
    dailyLabel.textContent = "일자별 자산" + (dailyOk ? "" : " (이 증권사 미지원)");
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
  // 수집(SCRAPE/NORMALIZE) 진행 중에만 '수집 중단' 버튼 표시. 새 진행 시작 시 재활성화.
  const collecting = [STAGE.SCRAPING, STAGE.NORMALIZING].includes(stage);
  els.cancelBtn.classList.toggle("hidden", !collecting);
  if (collecting) els.cancelBtn.disabled = false;
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
  // 지정 모드 진입 시 시작/종료일 기본값을 오늘로(비어 있을 때만 — 사용자 입력 보존).
  if (manual) {
    const t = todayStr();
    if (!els.startDate.value) els.startDate.value = t;
    if (!els.endDate.value) els.endDate.value = t;
  }
}

els.modeAuto.addEventListener("change", syncRangeModeUI);
els.modeManual.addEventListener("change", syncRangeModeUI);
// PIN 입력 시 즉시 세션에 보관(다음 팝업 열 때 복원). 디스크 저장 아님.
els.pinInput.addEventListener("input", () => savePin(els.pinInput.value.trim()));
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

  // 거래 PIN — PIN 요구 증권사에서 입력된 값만 메모리로 동봉(저장 안 함). 빈 값이면 생략.
  if (PIN_SOURCES.has(detectedSource)) {
    const pin = els.pinInput.value.trim();
    if (pin) payload.pin = pin;
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

// ── (3b) 수집 중단 → CANCEL ──────────────────────────────────────────────────

els.cancelBtn.addEventListener("click", () => {
  els.cancelBtn.disabled = true;
  els.statusText.textContent = "중단 요청됨 — 현재 항목 후 멈춥니다…";
  // fire-and-ack: 플래그만 켠다. 실제 중단은 background/content가 다음 날짜·계좌에서 처리하고
  // COLLECT_RESULT(cancelled)로 알린다.
  chrome.runtime.sendMessage({ type: MSG.CANCEL, payload: {} }).catch(() => {});
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

async function runProbe(walk) {
  els.probeBox.classList.remove("hidden");
  els.probeOut.value = walk ? "자동 순회 진단 중… (여러 페이지를 도는 동안 잠시 걸립니다)" : "진단 중…";
  els.probeBtn.disabled = true;
  els.walkBtn.disabled = true;
  try {
    // walk 진단 시 PIN 페이지도 조회·덤프하도록 세션 PIN을 함께 전달(메모리만).
    const pin = walk && PIN_SOURCES.has(detectedSource) ? els.pinInput.value.trim() : undefined;
    const res = await chrome.runtime.sendMessage({
      type: MSG.PROBE,
      payload: { tabId: detectedTabId ?? undefined, source: detectedSource ?? undefined, walk, pin },
    });
    els.probeOut.value = (res && res.report) || "(보고서 없음) " + JSON.stringify(res || {});
  } catch (err) {
    els.probeOut.value = "진단 실패: " + String(err?.message || err);
  } finally {
    els.probeBtn.disabled = detectedSource == null;
    els.walkBtn.disabled = detectedSource == null;
    els.probeOut.focus();
    els.probeOut.select();
  }
}

els.probeBtn.addEventListener("click", () => runProbe(false));
els.walkBtn.addEventListener("click", () => runProbe(true));

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
    } else if (p.cancelled) {
      // 사용자 중단 — 에러가 아니라 대기 상태로 복귀(미리보기는 띄우지 않음).
      renderStatus(STAGE.IDLE, p.error || "수집이 중단되었습니다.");
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
