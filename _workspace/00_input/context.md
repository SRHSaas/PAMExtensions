# PAMExtensions 빌드 컨텍스트 (초기 빌드)

생성일: 2026-06-16
실행 모드: 초기 빌드 (`_workspace/` 미존재 → 신규)

## 범위
미래에셋(miraeasset)을 첫 증권사로 하는 MV3 확장의 전체 파이프라인 스캐폴드 + 동작 모듈:
스크랩(로그인된 탭) → 정규화(canonical IngestPayload) → 사용자 SRHFinance 세션으로 업로드.

## 대상/설정
- 첫 증권사: 미래에셋 `https://securities.miraeasset.com/*`
- SRHFinance 업로드 origin: **options에서 설정 가능**. dev 기본값 `http://localhost:3000`, 배포 도메인은 사용자가 options에서 지정.
- 업로드 엔드포인트: `POST {origin}/api/ingest/portfolio` (credentials: include, 세션 쿠키)

## 외부 계약 (권위 원본 — 수정 금지, 일치 대상)
- 정규 페이로드 계약: `D:/Github/SRHSaaS/SRHFinance/lib/ingest.ts`
- 수신 엔드포인트: `D:/Github/SRHSaaS/SRHFinance/app/api/ingest/portfolio/route.ts`
- 인증 가드: `D:/Github/SRHSaaS/SRHFinance/lib/apiAuth.ts` (requireApprovedUser → 401/403)
- 참조 스크래퍼(Playwright): `D:/Github/SRHSaaS/WebPriceTracker/miraeasset/{scraper.js, canonical.js, upload.js, index.js, config.json}`

## 금지 사항 (서버 권위 침범 = 데이터 오염)
- 클라이언트가 `user_id` / `seq` / `resolved_name` 부여 금지
- daily_holdings (date,name) 미리합산 금지
- 쿠키 자동유지 / 세션 위조 / keepalive 금지
- service_role 키 / 별도 API 토큰 사용 금지 (오직 사용자 세션 쿠키)

## schema_version
현재 1 (`INGEST_SCHEMA_VERSION`). 페이로드 schema_version은 1.
