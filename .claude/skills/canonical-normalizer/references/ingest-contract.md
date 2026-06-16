# SRHFinance Ingest 계약 (권위 표)

수신측 권위 원본: `D:/Github/SRHSaaS/SRHFinance/lib/ingest.ts` + `app/api/ingest/portfolio/route.ts`.
이 표는 그 원본의 스냅샷이다. **불일치 의심 시 항상 원본을 다시 읽고 이 표를 갱신**한다.

## 스키마 버전

- `INGEST_SCHEMA_VERSION = 1`. 페이로드 `schema_version`은 1 또는 생략. 다른 값이면 400.

## 검증 규칙 (`validateIngest`)

- payload는 객체여야 함. 아니면 400.
- `accounts/daily_assets/daily_holdings/transactions/dividends`는 각각 **배열이거나 생략**. 배열이 아니면 400.
- 다섯 배열 길이 합이 0이면 400("업로드할 데이터 없음"). → 부분 업로드(일부 배열만) 허용.

## 필드 표

### IngestAccount
| 필드 | 타입 | 필수 | 비고 |
|------|------|------|------|
| account_no | string | ✓ | 서버가 하이픈 제거·trim. 빈 문자열이면 행 스킵 |
| account_type | string\|null | | |
| alias | string\|null | | 없으면 서버가 account_type로 대체 |

### IngestDailyAsset
| 필드 | 타입 | 필수 | 비고 |
|------|------|------|------|
| date | string | ✓ | `YYYY-MM-DD`(서버가 `.`→`-`) |
| account_no | string | ✓ | |
| total_asset | number | | 서버 `num()`로 0 보정 |
| eval_amount | number | | |
| profit_loss | number | | |
| profit_rate | string\|null | | 예 `"3.21%"` |

PK: `(user_id, date, account_no)`.

### IngestDailyHolding
| 필드 | 타입 | 필수 | 비고 |
|------|------|------|------|
| date | string | ✓ | |
| name | string | ✓ | 빈/공백이면 스킵. **클라이언트는 합산하지 않음** |
| category | string\|null | | |
| quantity | number | | |
| buy_amount | number | | |
| eval_amount | number | | |
| profit_loss | number | | |
| profit_rate | string\|null | | 서버가 합산 후 재계산 |

PK: `(user_id, date, name)` — 서버가 (date,name)으로 합산하므로 클라이언트는 행 단위로만 보낸다.

### IngestTransaction
| 필드 | 타입 | 필수 | 비고 |
|------|------|------|------|
| date | string | ✓ | |
| account_no | string | ✓ | |
| type | string | ✓ | |
| name | string\|null | | **null보다 빈 문자열 권장**(unique 키 포함) |
| resolved_name | string\|null | | 보통 비움 — 서버가 보유명 풀로 보강 |
| quantity | number | | |
| amount | number | | 원화 |
| foreign_amount | number | | 외화 |
| fee | number | | |
| balance | number | | |
| unit_price | number\|null | | 상세값 우선, 없으면 (외화우선)금액/수량 |
| broker_quantity | number\|null | | |
| exchange_rate | number\|null | | |
| currency | string\|null | | |
| detail | unknown | | 임의 객체 허용 |

Unique 충돌키(서버 onConflict): `user_id,date,account_no,type,name,seq,amount,foreign_amount`. **seq는 서버가 부여** — 클라이언트는 넣지 않는다.

### IngestDividend
| 필드 | 타입 | 필수 | 비고 |
|------|------|------|------|
| date | string | ✓ | |
| account_no | string | ✓ | |
| type | string | ✓ | `/배당|분배금/` 매칭 거래 |
| name | string\|null | | 빈 문자열 권장 |
| amount | number | | |
| foreign_amount | number | | |
| fee | number | | |

배당은 `ignoreDuplicates: true`로 upsert(수기 reinvested 메모 보호). seq는 서버 부여.

## 서버가 하는 정규화 (클라이언트 금지 목록)

- `user_id` stamp (세션 사용자, `requireApprovedUser`)
- `account_no` 하이픈 제거·trim, `date` `.`→`-`
- daily_holdings (date,name) 합산 + profit_rate 재계산
- transactions/dividends `seq` 부여(중복 키 1부터)
- transactions `resolved_name` 보강(보유명 풀)
- 누락 계좌 FK 자동 보강(자식이 참조하는 account_no)

→ 클라이언트는 위 항목을 **하지 않는다**. 어기면 충돌/오염.

## FK 순서

서버는 accounts → daily_assets → daily_holdings → transactions → dividends 순으로 upsert하고, 자식이 참조하나 빠진 account_no를 자동 보강한다. 클라이언트는 accounts를 함께 보내면 alias가 보존되어 좋다(없어도 서버가 최소행 생성).
