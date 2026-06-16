/**
 * SRHFinance 업로드 클라이언트 — integration-engineer 담당.
 *
 * 정규 페이로드(IngestPayload)를 **사용자가 이미 로그인한 SRHFinance 세션 쿠키**로
 * `POST {origin}/api/ingest/portfolio` 에 적재한다.
 *
 * ── 보안 불변식(절대 위반 금지) ───────────────────────────────────────────────
 *   - 인증은 오직 브라우저 세션 쿠키(`credentials: "include"`)로만 한다.
 *   - service_role 키 / API 토큰 / 비밀번호를 확장에 절대 넣지 않는다.
 *   - 서버 `requireApprovedUser`(lib/apiAuth.ts)가 세션에서 user_id를 얻어 모든 행에
 *     stamp하고 RLS로 격리한다. 클라이언트는 user_id/seq/resolved_name을 부여하지 않는다.
 *   - host_permissions에 대상 origin이 있어야 쿠키가 전송된다(architect 관리).
 *
 * ── 멱등(idempotent) ─────────────────────────────────────────────────────────
 *   서버는 모든 영역을 **복합키 upsert**한다(route.ts 의 onConflict 참조):
 *     accounts        → (user_id, account_no)
 *     daily_assets    → (user_id, date, account_no)
 *     daily_holdings  → (user_id, date, name)
 *     transactions    → (user_id, date, account_no, type, name, seq, amount, foreign_amount)
 *     dividends       → 위와 동일 + ignoreDuplicates
 *   따라서 같은 페이로드를 두 번 보내도 행이 중복/오염되지 않는다. **재시도가 데이터를
 *   망치지 않으므로** 500/네트워크 오류 시 1회 재시도가 안전하다.
 *
 * 수신 계약 권위 원본: SRHFinance/app/api/ingest/portfolio/route.ts, lib/ingest.ts
 * 시그니처 계약: _workspace/01_architect_interface.md §6
 */

/** 업로드 경로(고정). */
const INGEST_PATH = "/api/ingest/portfolio";

/** 5xx / 네트워크 오류 재시도 횟수(멱등이므로 안전). 1회만 재시도. */
const RETRY_ON_TRANSIENT = 1;

/** 재시도 전 대기(ms). 서버 일시 부하 완화. */
const RETRY_BACKOFF_MS = 600;

/**
 * 400 응답은 거의 항상 normalizer 계약 불일치(IngestPayload shape 어긋남)이다.
 * 호출부(background)가 이 플래그를 보고 normalizer에 SendMessage로 통지하도록
 * 결과에 `contractMismatch: true` 를 실어 보낸다.
 */

// ── origin 조회(options 설정값) ──────────────────────────────────────────────

/** options(chrome.storage.sync)에 저장되는 origin 키. options.js / service-worker.js와 공유. */
const ORIGIN_SETTING_KEY = "srhfinanceOrigin";
/** 미설정 시 dev 기본값(service-worker.js의 DEFAULT_ORIGIN과 동일). */
const DEFAULT_ORIGIN = "http://localhost:3000";

/**
 * 설정된 SRHFinance origin을 chrome.storage.sync(options)에서 읽는다.
 * 함수 인자로 origin이 주어지면 그것을 우선한다(background는 이미 getOrigin으로 읽어 넘긴다).
 * @returns {Promise<string>} "scheme://host[:port]" (끝 슬래시 없음).
 */
export async function getConfiguredOrigin() {
  try {
    const obj = await chrome.storage.sync.get(ORIGIN_SETTING_KEY);
    return obj[ORIGIN_SETTING_KEY] || DEFAULT_ORIGIN;
  } catch {
    // storage 접근 불가(테스트 등) 시 기본값.
    return DEFAULT_ORIGIN;
  }
}

/** origin 끝 슬래시 제거(이중 슬래시 방지). */
function trimTrailingSlash(origin) {
  return String(origin || "").replace(/\/+$/, "");
}

// ── 사람이 읽을 에러 문구(상태코드별) ────────────────────────────────────────

const MSG_401 =
  "SRHFinance에 로그인되어 있지 않습니다. SRHFinance 탭에서 로그인한 뒤 다시 시도하세요.";
const MSG_403 =
  "승인된 SRHFinance 계정만 업로드할 수 있습니다. 계정 승인 후 다시 시도하세요.";
const MSG_400_PREFIX = "업로드 데이터 검증 실패(페이로드 형식 오류): ";
const MSG_500_PREFIX = "서버 적재 실패: ";
const MSG_NETWORK =
  "SRHFinance 서버에 연결하지 못했습니다. origin 설정과 네트워크 상태를 확인하세요.";
const MSG_UNKNOWN = "알 수 없는 오류로 업로드에 실패했습니다.";

// ── 메인: uploadPayload ──────────────────────────────────────────────────────

/**
 * 정규 페이로드를 사용자 세션 쿠키로 SRHFinance에 업로드한다.
 *   POST {origin}/api/ingest/portfolio  (credentials:"include", JSON body=payload)
 *
 * 상태코드 분기:
 *   200 → { ok:true, counts, status:200 }            서버 { ok, source, counts } 파싱.
 *   401 → { ok:false, status:401, error }            미로그인. **재시도 안 함**.
 *   403 → { ok:false, status:403, error }            미승인. **재시도 안 함**.
 *   400 → { ok:false, status:400, error, contractMismatch:true }
 *                                                    검증 실패. 서버 error 그대로 노출 +
 *                                                    normalizer 통지 신호. 재시도 안 함.
 *   500 → { ok:false, status:500, error }            적재 실패. 1회 재시도 후 누락 처리.
 *   네트워크 → { ok:false, error }                    1회 재시도 후 누락 처리(status 없음).
 *
 * @param {import("../shared/messages.js").UploadRequestPayload["payload"]} payload
 * @param {string} [origin]  미지정 시 options(chrome.storage.sync)에서 읽는다.
 * @returns {Promise<import("../shared/messages.js").UploadResultPayload &
 *   { contractMismatch?: boolean }>} { ok, counts?, status?, error?, contractMismatch? }
 */
export async function uploadPayload(payload, origin) {
  const resolvedOrigin = trimTrailingSlash(origin || (await getConfiguredOrigin()));
  const url = `${resolvedOrigin}${INGEST_PATH}`;
  const body = JSON.stringify(payload);

  // 멱등이므로 transient(5xx/네트워크) 오류는 최대 RETRY_ON_TRANSIENT회 재시도.
  let lastTransient = null;
  for (let attempt = 0; attempt <= RETRY_ON_TRANSIENT; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "include", // ← 세션 쿠키만. 토큰/키 절대 금지.
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (networkErr) {
      // fetch 자체 실패 = 네트워크/오프라인/origin 오설정 → transient, 재시도 대상.
      lastTransient = {
        ok: false,
        error: `${MSG_NETWORK} (${String(networkErr?.message || networkErr)})`,
      };
      continue;
    }

    const status = res.status;

    // ── 200: 성공 ──
    if (res.ok) {
      const data = await safeJson(res);
      // 서버 { ok:true, source, counts } 파싱. ok가 명시적으로 false면 실패로 본다.
      if (data && data.ok === false) {
        return {
          ok: false,
          status,
          error: humanError(data) || MSG_UNKNOWN,
        };
      }
      return {
        ok: true,
        status,
        counts: data?.counts ?? emptyCounts(),
      };
    }

    // ── 401: 미로그인 — 재시도 무의미, 즉시 중단 ──
    if (status === 401) {
      const data = await safeJson(res);
      return { ok: false, status, error: humanError(data) || MSG_401 };
    }

    // ── 403: 미승인 — 재시도 무의미, 즉시 중단 ──
    if (status === 403) {
      const data = await safeJson(res);
      return { ok: false, status, error: humanError(data) || MSG_403 };
    }

    // ── 400: 검증 실패 — 서버 error 그대로 노출 + normalizer 통지 신호. 재시도 안 함 ──
    if (status === 400) {
      const data = await safeJson(res);
      const serverError = humanError(data);
      return {
        ok: false,
        status,
        error: MSG_400_PREFIX + (serverError || "(서버 메시지 없음)"),
        // 400은 거의 항상 페이로드 계약 불일치 → background가 normalizer에 통지.
        contractMismatch: true,
      };
    }

    // ── 500(및 기타 5xx): 적재 실패 — transient, 재시도 대상 ──
    if (status >= 500) {
      const data = await safeJson(res);
      lastTransient = {
        ok: false,
        status,
        error: MSG_500_PREFIX + (humanError(data) || `HTTP ${status}`),
      };
      continue;
    }

    // ── 그 외 4xx(예: 404, 405): 재시도 무의미. 즉시 반환 ──
    const data = await safeJson(res);
    return {
      ok: false,
      status,
      error: humanError(data) || `예상치 못한 응답(HTTP ${status}).`,
    };
  }

  // 재시도 소진 — 마지막 transient 결과를 누락 처리로 반환.
  return lastTransient || { ok: false, error: MSG_UNKNOWN };
}

// ── 보조 함수 ────────────────────────────────────────────────────────────────

/** 응답 JSON을 안전하게 파싱(비-JSON/빈 본문이면 null). */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** 서버 응답에서 사람이 읽을 error 문구를 뽑는다(route.ts/apiAuth.ts는 { error } 형태). */
function humanError(data) {
  if (data && typeof data.error === "string" && data.error.trim()) {
    return data.error.trim();
  }
  return null;
}

/** 빈 counts(서버가 counts를 안 줄 때의 안전 기본값). */
function emptyCounts() {
  return {
    accounts: 0,
    daily_assets: 0,
    daily_holdings: 0,
    transactions: 0,
    dividends: 0,
  };
}

/** ms 만큼 대기. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 중복방지 manifest (chrome.storage.local) ─────────────────────────────────
//
// 멱등 업로드라 중복이 데이터를 망치진 않지만, 이미 올린 (source, kind, key) 단위를
// 기록해 불필요한 재업로드 트래픽·시간을 줄인다. 같은 키를 재수집했을 때
// (예: 같은 날짜범위를 다시 긁음) 엔트리를 무효화하면 재업로드되게 만들 수 있다.
//
// 엔트리 형태: { source, kind, key, uploadedAt }
//   source     : SOURCE.* (예: "miraeasset")
//   kind       : 영역/SCRAPE_TARGET (예: "dailyAsset", "transaction")
//   key        : 멱등 단위 식별자(날짜범위/계좌 등 호출부가 정함, 예: "2026-06-16" 또는 "123456789012:2026-05")
//   uploadedAt : ISO 타임스탬프

/** chrome.storage.local 의 manifest 저장 키. */
const MANIFEST_STORAGE_KEY = "pam:uploadManifest";

/** manifest 엔트리의 합성 키(중복 판정 기준). */
function manifestKey(source, kind, key) {
  return `${source}::${kind}::${key}`;
}

/** @returns {Promise<Record<string, { source, kind, key, uploadedAt }>>} */
async function readManifest() {
  try {
    const obj = await chrome.storage.local.get(MANIFEST_STORAGE_KEY);
    return obj[MANIFEST_STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

async function writeManifest(manifest) {
  try {
    await chrome.storage.local.set({ [MANIFEST_STORAGE_KEY]: manifest });
  } catch {
    // storage 실패는 치명적이지 않다(멱등이라 중복 업로드돼도 안전).
  }
}

/**
 * 이미 업로드한 (source, kind, key) 단위인지 조회한다.
 * @returns {Promise<boolean>} true면 이미 올림(스킵 가능).
 */
export async function isUploaded(source, kind, key) {
  const manifest = await readManifest();
  return Boolean(manifest[manifestKey(source, kind, key)]);
}

/**
 * 업로드 성공한 단위를 manifest에 기록한다.
 * @returns {Promise<{ source, kind, key, uploadedAt }>}
 */
export async function recordUploaded(source, kind, key) {
  const manifest = await readManifest();
  const entry = { source, kind, key, uploadedAt: new Date().toISOString() };
  manifest[manifestKey(source, kind, key)] = entry;
  await writeManifest(manifest);
  return entry;
}

/**
 * manifest 엔트리를 무효화한다(같은 키 재수집 시 재업로드되게).
 * @returns {Promise<boolean>} 무효화된 엔트리가 있었으면 true.
 */
export async function invalidateUploaded(source, kind, key) {
  const manifest = await readManifest();
  const k = manifestKey(source, kind, key);
  if (!(k in manifest)) return false;
  delete manifest[k];
  await writeManifest(manifest);
  return true;
}

/** manifest 전체를 비운다(설정 초기화/디버깅용). */
export async function clearManifest() {
  await writeManifest({});
}
