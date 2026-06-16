/**
 * Popup UI 셸 — 상태머신:
 *   (1) 현재 탭이 미래에셋인지 감지 → SRHFinance 로그인 안내
 *   (2) "스크랩 시작" 버튼 → background로 SCRAPE_REQUEST
 *   (3) background의 STATUS 수신 → 진행 표시
 *   (4) UPLOAD_RESULT 수신 → counts 표시
 *
 * popup은 사용자 조작·진행 표시만 한다. 스크랩/정규화/업로드 로직은 갖지 않는다.
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
  [STAGE.UPLOADING]: "업로드 중…",
  [STAGE.DONE]: "완료",
  [STAGE.ERROR]: "오류",
};

const els = {
  brokerBadge: document.getElementById("brokerBadge"),
  guide: document.getElementById("guide"),
  scrapeBtn: document.getElementById("scrapeBtn"),
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
      "미래에셋에 로그인된 탭입니다. SRHFinance에도 로그인돼 있어야 업로드됩니다. 준비되면 스크랩을 시작하세요.";
    els.scrapeBtn.disabled = false;
  } else {
    els.brokerBadge.textContent = "대상 아님";
    els.brokerBadge.className = "badge off";
    els.guide.innerHTML =
      "지원 증권사 페이지가 아닙니다. <b>미래에셋(securities.miraeasset.com)</b>에 로그인한 탭에서 다시 열어주세요.";
    els.scrapeBtn.disabled = true;
  }

  const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
  const origin = obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
  els.originLabel.textContent = "origin: " + origin;
}

// ── (3) 진행 STATUS 렌더 ─────────────────────────────────────────────────────

function renderStatus(stage, message) {
  els.statusText.textContent = message || STAGE_LABEL[stage] || stage;
  els.statusDot.className = "dot";
  if ([STAGE.SCRAPING, STAGE.NORMALIZING, STAGE.UPLOADING].includes(stage)) {
    els.statusDot.classList.add("run");
    els.scrapeBtn.disabled = true;
  } else if (stage === STAGE.DONE) {
    els.statusDot.classList.add("ok");
    els.scrapeBtn.disabled = detectedSource == null;
  } else if (stage === STAGE.ERROR) {
    els.statusDot.classList.add("err");
    els.scrapeBtn.disabled = detectedSource == null;
  } else {
    els.scrapeBtn.disabled = detectedSource == null;
  }
}

// ── (4) 업로드 결과 counts 렌더 ──────────────────────────────────────────────

const COUNT_LABEL = {
  accounts: "계좌",
  daily_assets: "일자별 자산",
  daily_holdings: "보유 종목",
  transactions: "거래",
  dividends: "배당",
};

function renderResult(payload) {
  els.result.classList.remove("hidden");
  if (payload.ok && payload.counts) {
    els.resultError.classList.add("hidden");
    els.counts.classList.remove("hidden");
    els.counts.innerHTML = Object.entries(COUNT_LABEL)
      .map(
        ([k, label]) =>
          `<span class="k">${label}</span><span class="v">${payload.counts[k] ?? 0}</span>`
      )
      .join("");
  } else {
    els.counts.classList.add("hidden");
    els.resultError.classList.remove("hidden");
    const status = payload.status ? ` (HTTP ${payload.status})` : "";
    els.resultError.textContent = (payload.error || "업로드 실패") + status;
  }
}

// ── (2) 스크랩 시작 → SCRAPE_REQUEST ─────────────────────────────────────────

els.scrapeBtn.addEventListener("click", async () => {
  if (!detectedSource) return;
  els.result.classList.add("hidden");
  renderStatus(STAGE.SCRAPING);
  /** @type {import("../shared/messages.js").ScrapeRequestPayload} */
  const payload = {
    source: detectedSource,
    targets: [SCRAPE_TARGET.DAILY_ASSET, SCRAPE_TARGET.TRANSACTION],
    tabId: detectedTabId ?? undefined,
  };
  try {
    await chrome.runtime.sendMessage({ type: MSG.SCRAPE_REQUEST, payload });
  } catch (err) {
    renderStatus(STAGE.ERROR, String(err?.message || err));
  }
});

// ── background → popup 메시지 수신 ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === MSG.STATUS) {
    renderStatus(message.payload?.stage, message.payload?.message);
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

// ── 초기화: 컨텍스트 감지 + 마지막 진행상태 복원 ─────────────────────────────

(async function init() {
  await detectContext();
  // 무상태 서비스워커가 저장해 둔 마지막 상태를 복원(popup 재오픈 대비).
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
