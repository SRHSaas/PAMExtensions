/**
 * Options — SRHFinance origin 설정.
 *
 * origin은 chrome.storage.sync에 저장돼 background(업로드)와 popup(표시)이 공유한다.
 * dev(localhost)와 배포 도메인을 전환할 수 있게 한다. 저장 값은 프로토콜+호스트만(끝 슬래시 제거).
 *
 * 호스트 권한(최소권한 원칙):
 *   매니페스트의 정적 host_permissions에는 미래에셋 + dev(localhost:3000)만 둔다(광범위 박지 않음).
 *   임의 배포 origin으로 `credentials:"include"` fetch가 세션 쿠키를 실으려면 그 origin이
 *   권한에 있어야 하므로, 저장 시 chrome.permissions.request로 origin 매칭 패턴(origin + 슬래시스타)
 *   런타임 권한을 요청한다(매니페스트 optional_host_permissions: https 전체 범위 내).
 *   사용자 제스처(저장 클릭/Enter)에서 호출해야 권한 프롬프트가 뜬다.
 *
 * 주의: 이 키 이름("srhfinanceOrigin")과 storage 영역(sync)은 service-worker.js의
 * ORIGIN_SETTING_KEY / getOrigin() 과 일치해야 한다.
 */

const ORIGIN_SETTING_KEY = "srhfinanceOrigin";
const DEFAULT_ORIGIN = "http://localhost:3000";

const els = {
  origin: document.getElementById("origin"),
  save: document.getElementById("save"),
  saved: document.getElementById("saved"),
  err: document.getElementById("err"),
  presets: document.querySelectorAll(".preset"),
};

/**
 * origin 문자열을 정규화·검증한다. 유효하면 "scheme://host[:port]"(끝 슬래시 없음) 반환.
 * @param {string} raw
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
function normalizeOrigin(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "origin을 입력하세요." };
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: "유효한 URL이 아닙니다(예: https://example.com)." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "http 또는 https origin만 허용됩니다." };
  }
  return { ok: true, origin: u.origin };
}

async function load() {
  const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
  els.origin.value = obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
}

/** origin → host 권한 매칭 패턴("scheme://host[:port]/*"). */
function originMatchPattern(origin) {
  return origin.replace(/\/+$/, "") + "/*";
}

/**
 * 저장하려는 origin의 호스트 권한을 보장한다. 이미(정적 host_permissions 또는 이전 grant로)
 * 있으면 즉시 true, 없으면 사용자에게 런타임 권한을 요청한다.
 * @param {string} origin  "scheme://host[:port]"
 * @returns {Promise<boolean>} 권한이 확보되면 true.
 */
async function ensureHostPermission(origin) {
  const origins = [originMatchPattern(origin)];
  try {
    const has = await chrome.permissions.contains({ origins });
    if (has) return true;
    // 사용자 제스처(클릭/Enter)에서 호출되므로 권한 프롬프트가 표시된다.
    return await chrome.permissions.request({ origins });
  } catch (e) {
    els.err.textContent =
      "호스트 권한 요청 중 오류: " + String(e?.message || e);
    return false;
  }
}

async function save() {
  els.err.textContent = "";
  const res = normalizeOrigin(els.origin.value);
  if (!res.ok) {
    els.err.textContent = res.error;
    return;
  }
  els.origin.value = res.origin; // 정규화 값으로 반영.

  // origin으로 업로드 fetch가 세션 쿠키를 실으려면 그 origin의 호스트 권한이 필요하다.
  // 권한이 거부되면 저장하지 않는다(업로드 불가 상태로 저장돼 혼란 주는 것 방지).
  const granted = await ensureHostPermission(res.origin);
  if (!granted) {
    els.err.textContent =
      "이 origin에 대한 권한이 거부되어 업로드할 수 없습니다. 권한을 허용한 뒤 다시 저장하세요.";
    return;
  }

  await chrome.storage.sync.set({ [ORIGIN_SETTING_KEY]: res.origin });
  els.saved.classList.add("show");
  setTimeout(() => els.saved.classList.remove("show"), 1500);
}

els.save.addEventListener("click", save);
els.origin.addEventListener("keydown", (e) => {
  if (e.key === "Enter") save();
});
els.presets.forEach((p) =>
  p.addEventListener("click", () => {
    els.origin.value = p.dataset.origin || "";
    els.err.textContent = "";
  })
);

load();
