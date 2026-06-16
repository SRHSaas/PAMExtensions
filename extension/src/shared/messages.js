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
   * popup → background. **2단계 파이프라인 1단계**: 스크랩+정규화만 수행하고
   * 결과 페이로드를 chrome.storage.local[STORAGE_KEY.PENDING_PAYLOAD]에 저장한다.
   * (업로드는 하지 않는다 — 업로드 전 미리보기를 위해 분리.)
   *
   * **장시간 작업 — fire-and-ack**: COLLECT는 여러 날짜를 스크랩하는 장시간 작업이다.
   * popup이 sendMessage 응답으로 결과를 기다리면, 팝업이 포커스를 잃어 닫히는 순간
   * 채널이 끊겨 "message channel closed" 오류가 난다. 따라서 background는 즉시
   * { ok:true, started:true } ack만 하고(return false), 작업 진행은 STATUS로,
   * 최종 결과는 COLLECT_RESULT 브로드캐스트 + storage 저장으로 알린다.
   * payload = CollectRequestPayload.
   */
  COLLECT: "COLLECT",
  /**
   * background → popup. 수집(COLLECT) **최종 결과** 브로드캐스트.
   * background가 작업 완료 시 pendingPayload를 storage에 저장한 뒤 이 메시지를 broadcast.
   * popup은 onMessage로 받아 미리보기를 띄운다. payload = CollectResultPayload.
   */
  COLLECT_RESULT: "COLLECT_RESULT",
  /**
   * popup → background. **2단계 파이프라인 2단계**: 저장된 pendingPayload를
   * 사용자 세션 쿠키로 업로드한다. payload = {}(빈 객체).
   *
   * **장시간 작업 — fire-and-ack**: 업로드도 길 수 있으므로 COLLECT와 동일하게
   * 즉시 ack(return false)하고, 결과는 UPLOAD_RESULT 브로드캐스트 + storage로 알린다.
   * 성공 시 pendingPayload에 uploadedAt 기록.
   */
  UPLOAD: "UPLOAD",
  /**
   * popup → background. 자동(증분) 기간 표시용. background가 SRHFinance
   * GET {origin}/api/ingest/last-dates 를 세션 쿠키로 호출해 마지막 수집일을 반환.
   * sendResponse {ok, daily_last?, tx_last?, error?}. (선택 — 자동 기간 안내 표시용.)
   * (이 메시지는 짧은 단발 조회라 sendResponse 응답 방식이 안전하다.)
   */
  LAST_DATES: "LAST_DATES",
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
  /** 수집(스크랩+정규화) 완료 — 페이로드가 저장됐고 미리보기/업로드 대기 중. */
  COLLECTED: "collected",
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

/**
 * COLLECT payload — popup → background. 수집(스크랩+정규화)만 요청.
 * @typedef {Object} CollectRequestPayload
 * @property {string} source            증권사 식별자. SOURCE.*.
 * @property {string[]} targets         스크랩할 종류 배열. SCRAPE_TARGET.* 값(1개 이상).
 * @property {number} [tabId]           대상 탭 id. 미지정 시 background가 활성 탭으로 채움.
 * @property {"auto"|"manual"} rangeMode 자동(증분, last-dates 기반) / 지정(수동 range).
 * @property {Object} [range]           rangeMode="manual"일 때 모든 target에 적용할 기간.
 * @property {string} [range.startDate] "YYYY-MM-DD".
 * @property {string} [range.endDate]   "YYYY-MM-DD".
 */

/**
 * COLLECT 응답 — background → popup(sendResponse).
 * @typedef {Object} CollectResultPayload
 * @property {boolean} ok                수집(스크랩+정규화+저장) 성공 여부.
 * @property {Object} [counts]           영역별 건수 { accounts, daily_assets,
 *                                       daily_holdings, transactions, dividends }.
 * @property {Object} [usedRanges]       target별 실제 사용 기간 { [target]: {startDate,endDate} }.
 * @property {string} [error]            실패 시 사람이 읽을 오류 메시지.
 */

/**
 * chrome.storage.local 에 저장되는 수집 결과(업로드 전 미리보기·업로드 입력).
 * @typedef {Object} PendingPayload
 * @property {import("./ingest-types.js").IngestPayload} payload  정규 페이로드(업로드 입력).
 * @property {Object} counts             영역별 건수(미리보기 표시용).
 * @property {string} source             증권사 식별자.
 * @property {Object} usedRanges         target별 실제 사용 기간.
 * @property {string} collectedAt        ISO 타임스탬프(수집 시각).
 * @property {string} [uploadedAt]       ISO 타임스탬프(업로드 성공 시각. 없으면 미업로드).
 */

/** chrome.storage.local 진행상태 키. */
export const STORAGE_KEY = {
  /** PipelineState 저장 키. */
  PIPELINE_STATE: "pam:pipelineState",
  /** PendingPayload 저장 키(수집 결과 — 업로드 전 미리보기/업로드 입력). */
  PENDING_PAYLOAD: "pam:pendingPayload",
};
