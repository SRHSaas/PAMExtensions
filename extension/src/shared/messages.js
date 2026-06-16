/**
 * 메시지 패싱 규약 — **단일 정의(single source of truth)**.
 *
 * PAMExtensions의 세 컨텍스트(popup / background service worker / content script)는
 * 서로 다른 실행 환경이라 chrome.runtime 메시지로만 통신한다. 이 파일이 그 메시지의
 * 타입 상수(MSG)와 payload 형태를 한 곳에서 정의한다. **모든 팀원은 이 파일을 import**하고
 * 절대 타입 문자열이나 payload 형태를 자기 모듈에서 다시 정의하지 않는다.
 * (shape 중복 정의 = 경계 버그 1순위)
 *
 * 파이프라인 흐름:
 *   popup ──SCRAPE_REQUEST──▶ background ──(chrome.tabs.sendMessage)──▶ content
 *   content ──SCRAPE_RESULT(raw)──▶ background
 *   background ──(normalize, 내부 호출)──▶ IngestPayload
 *   background ──UPLOAD_REQUEST(내부/논리적)──▶ upload client
 *   background ──STATUS──▶ popup            (진행 단계 브로드캐스트)
 *   background ──UPLOAD_RESULT──▶ popup     ({ ok, counts, error })
 *
 * 주의(서버 권위 — 클라이언트가 침범 금지):
 *   - raw / IngestPayload 어디에도 user_id / seq / resolved_name 를 넣지 않는다.
 *   - daily_holdings 를 (date,name)으로 미리 합산하지 않는다(서버가 합산).
 *   payload 필드 표의 권위 문서는 _workspace/01_architect_interface.md.
 */

/**
 * 메시지 타입 상수. 송수신 양쪽 모두 이 상수를 쓴다(문자열 리터럴 금지).
 * @readonly
 * @enum {string}
 */
export const MSG = {
  /** popup → background → content. 대상 탭의 content script에 스크랩을 지시. */
  SCRAPE_REQUEST: "SCRAPE_REQUEST",
  /** content → background. DOM에서 긁은 raw 데이터(소스 고유 형태). */
  SCRAPE_RESULT: "SCRAPE_RESULT",
  /** background → upload(내부 호출). 정규화된 IngestPayload 업로드 요청. */
  UPLOAD_REQUEST: "UPLOAD_REQUEST",
  /** background → popup. 업로드 최종 결과({ ok, counts, error }). */
  UPLOAD_RESULT: "UPLOAD_RESULT",
  /** background → popup. 파이프라인 진행 단계 알림. */
  STATUS: "STATUS",
  /**
   * content(ISOLATED) → background. MAIN-world 페이지 브리지(page-bridge.js)가 선언형
   * content_scripts로 주입되지 않았을 때(확장 전부터 열린 탭 등) background가
   * chrome.scripting.executeScript({world:"MAIN"})로 주입하도록 요청. sendResponse {ok}.
   */
  INJECT_BRIDGE: "INJECT_BRIDGE",
  /**
   * popup → background → content. 진단: 현재 페이지의 프레임(top/contentframe) URL,
   * 페이지 전역(openHp 등) 존재 여부, DOM 표 구조를 수집해 사람이 읽을 보고서로 반환.
   * 콘솔(F12)이 막힌 사이트에서 페이지 구조를 확인하기 위한 용도. sendResponse { ok, report }.
   */
  PROBE: "PROBE",
};

/**
 * 파이프라인 단계 식별자. STATUS 메시지의 `stage` 필드 값이자
 * chrome.storage.local 진행상태에 저장되는 단계값.
 * @readonly
 * @enum {string}
 */
export const STAGE = {
  IDLE: "idle",
  SCRAPING: "scraping",
  NORMALIZING: "normalizing",
  UPLOADING: "uploading",
  DONE: "done",
  ERROR: "error",
};

/**
 * 스크랩 대상 데이터 종류. SCRAPE_REQUEST.payload.targets 와
 * content script 의 scrape 디스패치에 쓰인다.
 * @readonly
 * @enum {string}
 */
export const SCRAPE_TARGET = {
  /** 일자별 자산: 계좌 + 일자별 평가금액 + 보유종목(참조: buildDailyAssetPayload). */
  DAILY_ASSET: "dailyAsset",
  /** 거래내역: 매매/입출금/배당(참조: buildTransactionPayload). */
  TRANSACTION: "transaction",
};

/**
 * 지원 증권사 소스 식별자(IngestPayload.source 와 동일 값).
 * 새 증권사 추가 시 여기에 상수를 더한다.
 * @readonly
 * @enum {string}
 */
export const SOURCE = {
  MIRAEASSET: "miraeasset",
};

// ───────────────────────────────────────────────────────────────────────────
// Payload 형태 (JSDoc typedef). 런타임 강제는 없지만 모든 팀원의 계약 기준이다.
// 권위 표/필드 설명은 _workspace/01_architect_interface.md 참조.
// ───────────────────────────────────────────────────────────────────────────

/**
 * SCRAPE_REQUEST payload — popup이 background로, background가 content로 전달.
 * @typedef {Object} ScrapeRequestPayload
 * @property {string} source            증권사 식별자. SOURCE.* (예: "miraeasset").
 * @property {string[]} targets         스크랩할 종류 배열. SCRAPE_TARGET.* 값.
 * @property {number} [tabId]           대상 탭 id. background가 활성 탭에서 채움(popup은 생략 가능).
 * @property {Object} [range]           수집 기간(선택). content 어댑터가 해석.
 * @property {string} [range.startDate] "YYYY-MM-DD".
 * @property {string} [range.endDate]   "YYYY-MM-DD".
 */

/**
 * SCRAPE_RESULT payload — content → background. **raw(소스 고유) 형태**.
 * 여기서는 숫자/문자 파싱·정규화를 하지 않는다(정규화는 normalize 모듈 담당).
 * raw 형태는 참조 구현(WebPriceTracker/miraeasset)의 output 형태와 동일하게 맞춘다:
 *   dailyAsset raw = { date, accounts:[{accountNo, accountType, alias, totalAsset,
 *                      evalAmount, profitLoss, profitRate}], holdings:[{name, category,
 *                      quantity, buyAmount, evalAmount, profitLoss, profitRate}] }
 *   transaction raw = { acno, account, transactions:[{date, type, name, quantity, amount,
 *                       foreignAmount, fee, balance, unitPrice, brokerQuantity,
 *                       exchangeRate, currency, detail}] }
 * @typedef {Object} ScrapeResultPayload
 * @property {string} source                  증권사 식별자(요청과 동일).
 * @property {string} target                  SCRAPE_TARGET.* (이 raw가 어느 종류인지).
 * @property {boolean} ok                     스크랩 성공 여부.
 * @property {Object|Object[]} [raw]          raw 데이터(target별 형태, 위 주석 참조).
 *                                            한 target에서 여러 날짜/계좌면 배열일 수 있다.
 * @property {string} [error]                 ok=false 시 사람이 읽을 오류 메시지.
 */

/**
 * UPLOAD_REQUEST payload — background → upload client(내부 호출).
 * payload는 lib/ingest.ts 의 IngestPayload 와 **동일 형태**여야 한다.
 * @typedef {Object} UploadRequestPayload
 * @property {string} origin                  업로드 대상 SRHFinance origin(options에서 설정).
 * @property {import("./ingest-types.js").IngestPayload} payload  정규 페이로드(normalize 산출).
 */

/**
 * UPLOAD_RESULT payload — background → popup.
 * counts는 lib/ingest.ts 의 IngestCounts 형태(서버 응답을 그대로 전달).
 * @typedef {Object} UploadResultPayload
 * @property {boolean} ok                      업로드(HTTP 2xx + ok:true) 성공 여부.
 * @property {Object} [counts]                 적재 건수. { accounts, daily_assets,
 *                                             daily_holdings, transactions, dividends }.
 * @property {number} [status]                 HTTP 상태코드(401/403/400/500 등).
 * @property {string} [error]                  실패 시 사람이 읽을 오류 메시지.
 */

/**
 * STATUS payload — background → popup. 진행 단계 알림.
 * @typedef {Object} StatusPayload
 * @property {string} stage                    STAGE.* 값(idle/scraping/.../error).
 * @property {string} [message]                선택적 사람이 읽을 보조 메시지.
 * @property {string} [target]                 진행 중인 SCRAPE_TARGET.*(선택).
 */

/**
 * chrome.storage.local 에 저장되는 파이프라인 진행상태(무상태 서비스워커 재기동 대비).
 * @typedef {Object} PipelineState
 * @property {string} stage                    STAGE.* 현재 단계.
 * @property {string} [source]                 진행 중인 증권사.
 * @property {string[]} [targets]              요청된 스크랩 종류.
 * @property {Object} [lastResult]             마지막 UPLOAD_RESULT payload.
 * @property {string} [error]                  마지막 오류.
 * @property {string} [updatedAt]              ISO 타임스탬프.
 */

/** chrome.storage.local 진행상태 키. */
export const STORAGE_KEY = {
  /** PipelineState 저장 키. */
  PIPELINE_STATE: "pam:pipelineState",
};
