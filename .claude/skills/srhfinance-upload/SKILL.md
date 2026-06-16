---
name: srhfinance-upload
description: "정규 페이로드를 SRHFinance에 업로드하는 가이드. 사용자가 로그인한 세션 쿠키로 POST /api/ingest/portfolio 전송(credentials include), 로그인/승인 상태 감지, 401/403/400/500 에러 매핑, 멱등 재시도, 중복방지 manifest, 응답 counts 표시. 업로드·전송·세션연동 작업 시 반드시 사용. integration-engineer 전용."
---

# SRHFinance 업로드 연동 가이드

정규 페이로드를 SRHFinance 웹서비스로 올리는 절차. integration-engineer 전용.
수신 계약: `app/api/ingest/portfolio/route.ts`, 인증: `lib/apiAuth.ts`.

## 핵심: 사용자 세션 재사용

업로드는 **사용자가 이미 로그인한 SRHFinance 세션 쿠키**로만 한다. 서버 `requireApprovedUser`가 세션에서 user_id를 얻어 모든 행에 stamp하고 RLS로 격리한다. 따라서:
- 확장에 service_role 키·API 토큰·비밀번호를 넣지 않는다.
- `fetch(`${origin}/api/ingest/portfolio`, { method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) })`.
- origin은 dev(`http://localhost:3000`)와 배포 도메인이 다르므로 options에서 설정하고 host_permissions에 포함(architect에 요청).

## 엔드포인트 계약

`POST /api/ingest/portfolio`
- 요청 body: 정규 `IngestPayload`(canonical-normalizer 산출).
- 성공 200: `{ ok: true, source, counts: { accounts, daily_assets, daily_holdings, transactions, dividends } }`.
- 멱등: 서버가 복합키 upsert → **재업로드 안전**(데이터 중복/오염 없음). 실패 시 재시도가 안전한 이유.

## 에러 매핑 (사용자 친화 메시지)

| HTTP | 의미 | 처리 |
|------|------|------|
| 401 | 미로그인 | "SRHFinance에 로그인하세요" 안내, 중단(재시도 무의미). SRHFinance 탭 열기 유도 |
| 403 | 미승인(pending/rejected) | "승인된 계정만 업로드 가능" 안내, 중단 |
| 400 | 검증 실패(validateIngest) | 서버 `error` 문구 그대로 노출 + normalizer에 SendMessage(계약 불일치 가능성) |
| 500 | 적재 실패(단계명 포함) | 1회 재시도, 재실패 시 해당 영역 누락 기록 후 다음 영역 진행 |
| 네트워크 | origin 오설정/오프라인 | origin 설정 확인 안내 + 1회 재시도 |

## 로그인/승인 상태 감지

업로드 전 가벼운 사전 점검을 권장한다. 별도 status 엔드포인트가 없으면 **업로드 응답의 401/403으로 판정**하는 것이 가장 단순·정확하다(서버가 권위). 사전 차단이 필요하면 빈 영역 대신 실제 페이로드 첫 업로드 응답으로 분기한다(빈 페이로드는 400이 나므로 상태 판정용으로 부적합).

## 분할 업로드 & manifest

- 영역(일자별/거래)별로 분리 업로드해 부분 실패를 격리한다. 큰 거래도 서버가 100건 배치 처리하므로 한 번에 보내도 되지만, 날짜범위/계좌 단위 분할이 진행 표시·재시도에 유리하다.
- 중복방지: `chrome.storage.local`에 `{ source, kind, key(날짜범위/계좌), uploadedAt }` manifest를 둔다. 멱등이라 중복이 위험하진 않지만 불필요한 트래픽·시간을 줄인다. 같은 키 재수집 시 manifest 엔트리를 무효화해 재업로드되게 한다.

## 산출물

- `src/upload/client.js` — `uploadPayload(payload, origin)` + 에러 매핑 + manifest.
- `_workspace/04_integration_notes.md` — 엔드포인트·에러코드·상태감지·origin 설정 흐름.

## 체크리스트

- [ ] `credentials:"include"`, service_role/토큰 미사용
- [ ] 401/403/400/500 각각 구분 처리, 401/403은 재시도 안 함
- [ ] 400 발생 시 normalizer에 통지
- [ ] origin이 options 설정값 + host_permissions에 포함
- [ ] manifest로 중복 업로드 최소화
