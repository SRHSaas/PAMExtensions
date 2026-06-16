# 04 · 통합 노트 (Integration Engineer)

> `src/upload/client.js`의 동작 계약 — 엔드포인트, 에러코드, 로그인/승인 상태감지,
> origin 설정, 중복방지 manifest. scraper/normalizer/architect/qa 공유 기준.
> 작성: integration-engineer · 2026-06-16
> 수신 계약 권위 원본: `SRHFinance/app/api/ingest/portfolio/route.ts`, `SRHFinance/lib/ingest.ts`, `SRHFinance/lib/apiAuth.ts`
> 시그니처 계약: `_workspace/01_architect_interface.md` §6

---

## 1. 엔드포인트

| 항목 | 값 |
|---|---|
| 메서드 | `POST` |
| 경로 | `{origin}/api/ingest/portfolio` |
| 인증 | **사용자 세션 쿠키만** (`credentials: "include"`) |
| 요청 헤더 | `Content-Type: application/json` |
| 요청 본문 | 정규 `IngestPayload` (normalize 산출) JSON |
| 성공 응답 | `200 { ok: true, source, counts }` |
| 실패 응답 | `4xx/5xx { error: string }` |

```js
fetch(`${origin}/api/ingest/portfolio`, {
  method: "POST",
  credentials: "include",                       // ← 세션 쿠키. 토큰/키 절대 금지.
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

서버 `requireApprovedUser`(lib/apiAuth.ts)가 **세션에서 user_id를 stamp**하고 RLS로 격리한다.
확장에는 service_role 키·API 토큰·비밀번호를 넣지 않는다. user_id/seq/resolved_name도 부여하지 않는다(서버 권위).

### 1.1 멱등성 (재시도 안전성 근거)

route.ts는 모든 영역을 **복합키 upsert** 한다 → 같은 페이로드 재전송이 행을 중복/오염시키지 않는다.

| 영역 | onConflict 키 |
|---|---|
| accounts | `(user_id, account_no)` |
| daily_assets | `(user_id, date, account_no)` |
| daily_holdings | `(user_id, date, name)` |
| transactions | `(user_id, date, account_no, type, name, seq, amount, foreign_amount)` |
| dividends | 위와 동일 + `ignoreDuplicates`(수기 reinvested 메모 보호) |

→ **500/네트워크 오류 시 재시도가 데이터를 망치지 않는다.** transactions는 서버가 100건 배치 처리하므로 대용량도 한 번에 전송 가능.

---

## 2. 에러코드 표

`uploadPayload(payload, origin)` → `{ ok, counts?, status?, error?, contractMismatch? }`

| HTTP / 상황 | 의미 | 재시도 | 클라이언트 처리 | 사용자 문구(요지) |
|---|---|---|---|---|
| **200** | 성공 | – | 서버 `{ok,source,counts}`에서 `counts` 파싱 → `{ ok:true, status:200, counts }` | 적재 건수 표시 |
| **401** | 미로그인 (auth.getUser null) | **안 함** | `{ ok:false, status:401, error }` 즉시 중단 | "SRHFinance에 로그인되어 있지 않습니다. SRHFinance 탭에서 로그인 후 재시도." |
| **403** | 미승인 (profiles.status ≠ approved) | **안 함** | `{ ok:false, status:403, error }` 즉시 중단 | "승인된 SRHFinance 계정만 업로드 가능. 승인 후 재시도." |
| **400** | 검증 실패 (validateIngest / JSON 파싱) | **안 함** | `{ ok:false, status:400, error, contractMismatch:true }` — 서버 `error` 그대로 노출 + **계약불일치 신호** | "업로드 데이터 검증 실패: {서버 error}" |
| **500** (및 기타 5xx) | 적재 실패 (단계명 포함) | **1회** | 재시도 후 재실패 시 `{ ok:false, status:500, error }` 누락 처리 | "서버 적재 실패: {서버 error}" |
| **네트워크** (fetch throw) | origin 오설정/오프라인 | **1회** | 재시도 후 `{ ok:false, error }`(status 없음) | "서버에 연결하지 못했습니다. origin 설정·네트워크 확인." |
| 기타 4xx (404/405 등) | 경로/메서드 오류 | 안 함 | `{ ok:false, status, error }` 즉시 반환 | "예상치 못한 응답(HTTP {status})." |

재시도 정책: `RETRY_ON_TRANSIENT = 1`, `RETRY_BACKOFF_MS = 600`. transient(5xx/네트워크)만 재시도. 401/403/400/기타4xx는 재시도 무의미하므로 즉시 중단.

### 2.1 400 → normalizer 통지 (중요)

400은 **거의 항상 normalizer 계약 불일치**(IngestPayload shape가 lib/ingest.ts 기대와 어긋남)이다.
클라이언트는 결과에 `contractMismatch: true`를 실어 반환한다 → **background가 이를 보고 normalizer에 SendMessage로 통지**해야 한다.
서버 `error` 문구(예: `"daily_assets는 배열이어야 합니다."`)를 그대로 보존해 원인 추적이 가능하게 한다.

> qa-verifier 주목: 400 응답 처리 시 (a) 서버 error 원문 노출 여부, (b) `contractMismatch` 신호 전파 여부를 검증 포인트로 삼는다.

---

## 3. 로그인 / 승인 상태감지 흐름

별도 status 엔드포인트가 없다. **서버가 권위**이므로 업로드 응답의 401/403으로 판정하는 것이 가장 단순·정확하다.

```
uploadPayload(payload, origin)
  │
  ├─ 200 ──────────────▶ 로그인 O + 승인 O + 적재 성공 → counts 표시
  ├─ 401 ──────────────▶ 미로그인       → 안내 + SRHFinance 탭 열기 유도, 중단
  ├─ 403 ──────────────▶ 미승인(pending/rejected) → 안내, 중단
  ├─ 400 ──────────────▶ 페이로드 검증 실패 → 서버 error 노출 + normalizer 통지
  ├─ 500 ──────────────▶ 적재 실패 → 1회 재시도 → 누락 기록
  └─ network ──────────▶ origin/오프라인 → 1회 재시도 → origin 확인 안내
```

- **빈 페이로드로 상태를 사전 점검하지 않는다** — validateIngest가 빈 본문을 400으로 막으므로 상태 판정용으로 부적합하다. 실제 페이로드 첫 업로드 응답으로 분기한다.
- 401/403은 사용자 행동(로그인/승인)이 선행돼야 하므로 재시도가 무의미 → 즉시 중단.

---

## 4. origin 설정

| 항목 | 값 |
|---|---|
| 저장소 | `chrome.storage.sync` |
| 키 | `srhfinanceOrigin` (options.js / service-worker.js와 공유) |
| dev 기본값 | `http://localhost:3000` |
| 형식 | `scheme://host[:port]` (끝 슬래시 없음, options.js가 정규화) |

- `uploadPayload(payload, origin)`는 인자로 origin을 받되, 미지정 시 `getConfiguredOrigin()`이 `chrome.storage.sync`에서 읽는다(미설정 시 dev 기본값).
- background(service-worker.js)는 이미 `getOrigin()`으로 읽어 인자로 넘긴다 → 클라이언트는 그 값을 우선 사용.
- 클라이언트는 origin 끝 슬래시를 한 번 더 정리해 `{origin}//api/...` 이중 슬래시를 방지한다.
- **host_permissions 요구**: 쿠키가 전송되려면 manifest의 `host_permissions`에 대상 origin이 포함돼야 한다(architect 관리). dev/배포 도메인 둘 다 등록 필요.

---

## 5. 중복방지 manifest 설계

`chrome.storage.local` 키 `pam:uploadManifest`에 업로드 단위를 기록한다. 멱등이라 중복이 위험하진 않지만 **불필요한 트래픽·시간을 줄인다.**

엔트리 형태:
```js
{ source, kind, key, uploadedAt }
//  source     : SOURCE.* (예: "miraeasset")
//  kind       : 영역/SCRAPE_TARGET (예: "dailyAsset", "transaction")
//  key        : 멱등 단위 식별자 — 날짜범위/계좌 등 호출부가 정함
//               (예: "2026-06-16", "123456789012:2026-05")
//  uploadedAt : ISO 타임스탬프
```

합성 키: `` `${source}::${kind}::${key}` ``.

export 헬퍼:

| 함수 | 용도 |
|---|---|
| `isUploaded(source, kind, key)` | 이미 올린 단위인지 조회(스킵 판정) |
| `recordUploaded(source, kind, key)` | 업로드 성공 후 기록 |
| `invalidateUploaded(source, kind, key)` | 같은 키 **재수집 시 무효화** → 재업로드되게 |
| `clearManifest()` | 전체 초기화(디버깅/설정 리셋) |

- 호출부(background)가 영역별로 분리 업로드할 때 `key`를 날짜범위/계좌 단위로 정해 부분 진행/재시도 격리에 활용한다.
- 같은 날짜범위를 다시 긁었을 때(데이터 갱신) `invalidateUploaded`로 엔트리를 비우면 재업로드된다. 멱등이므로 재업로드돼도 안전.

---

## 6. background 배선 (placeholder 교체)

`src/background/service-worker.js`의 `uploadPlaceholder(payload, origin)` →
`uploadPayload(payload, origin)`로 교체하면 연결된다. 상단 주석 import 활성화:

```js
import { uploadPayload } from "../upload/client.js";
// ...
const origin = await getOrigin();
const result = await uploadPayload(payload, origin);  // { ok, counts?, status?, error?, contractMismatch? }
await emitUploadResult(result);
// result.contractMismatch === true 이면 normalizer에 SendMessage로 계약불일치 통지.
```

- `UploadResultPayload` 계약(`{ ok, counts?, status?, error? }`)을 그대로 만족한다. `contractMismatch`는 background 내부 라우팅용 추가 필드(popup엔 전달 안 해도 무방).
- background `getOrigin()`과 클라이언트 `getConfiguredOrigin()`은 같은 키(`srhfinanceOrigin`)·기본값(`http://localhost:3000`)을 쓰므로 일관적이다.

---

## 7. 본문 적합성 검증 (03 샘플 기준)

`_workspace/03_normalizer_payload_samples/*.json`을 `lib/ingest.ts`의 `validateIngest`/필드 타입에 대조한 결과 **둘 다 적합**:

| 샘플 | validateIngest | 비고 |
|---|---|---|
| `dailyAsset.sample.json` | PASS | `profit_rate`가 문자열("9.12%") — 서버 `string \| null` 일치. accounts/daily_assets/daily_holdings 채움. |
| `transaction.sample.json` | PASS | `account_type: null`(서버 `?: string\|null`), `detail` 객체(서버 `unknown`), `unit_price/exchange_rate: null` 허용. transactions+dividends 분리됨. |

확인 사항:
- `schema_version: 1` == `INGEST_SCHEMA_VERSION`(불일치 시 400).
- 5개 영역 배열 중 최소 1개 비어있지 않음(total > 0, 아니면 400).
- 날짜 `"YYYY-MM-DD"`, account_no 하이픈 없음 — 서버도 정리하지만 어댑터가 맞춤(표준).
- 클라이언트는 user_id/seq/resolved_name 미부여, daily_holdings 미리합산 안 함 — 샘플도 준수.

---

## 8. qa-verifier 검증 포인트 (업로드 응답 처리)

1. **200**: 서버 `{ok,source,counts}`에서 `counts` 추출 → `{ ok:true, status:200, counts }`. counts 누락 시 0 기본값.
2. **401/403**: 재시도 0회(단일 fetch), 사용자 친화 메시지, 즉시 중단.
3. **400**: 서버 `error` 원문 노출 + `contractMismatch:true` → normalizer 통지 트리거.
4. **500**: 정확히 1회 재시도(총 2 fetch), 재실패 시 누락 처리. 단계명 포함 서버 메시지 보존.
5. **네트워크**: fetch throw 1회 재시도, origin/네트워크 확인 안내(status 없음).
6. **멱등**: 동일 페이로드 2회 업로드 시 counts 동일·중복 행 없음(upsert).
7. **보안**: 요청 헤더에 토큰/Authorization 없음, `credentials:"include"`만, service_role 미사용.
8. **manifest**: record→isUploaded(true)→invalidate→isUploaded(false) 라운드트립.
