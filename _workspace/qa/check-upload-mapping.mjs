/**
 * QA 검증 — 업로드 클라이언트 상태코드 매핑 ↔ 서버 응답코드 교차 검증.
 *
 * 경계: src/upload/client.js (소비자: 응답코드 해석) ↔
 *       SRHFinance/app/api/ingest/portfolio/route.ts + lib/apiAuth.ts (생산자: 응답코드).
 *
 * 정적 분석(소스 텍스트 패턴)으로 양쪽이 같은 코드 집합을 다루는지 확인한다.
 * 실 fetch는 세션 쿠키/서버 기동이 필요하므로 여기선 코드 경로 정합만 본다.
 *
 * 실행: node _workspace/qa/check-upload-mapping.mjs
 */
import { readFileSync } from "node:fs";

const CLIENT = "D:/Github/SRHSaaS/PAMExtensions/extension/src/upload/client.js";
const ROUTE = "D:/Github/SRHSaaS/SRHFinance/app/api/ingest/portfolio/route.ts";
const AUTH = "D:/Github/SRHSaaS/SRHFinance/lib/apiAuth.ts";

const client = readFileSync(CLIENT, "utf8");
// 주석 줄을 제거한 "코드만" 텍스트(보안 패턴 검사용 — 주석 속 토큰 언급은 위반이 아니다).
const clientCode = client
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
  })
  .join("\n");
const route = readFileSync(ROUTE, "utf8");
const auth = readFileSync(AUTH, "utf8");

const findings = [];
let checks = 0;
function check(cond, location, expected, actual, severity = "P3") {
  checks++;
  if (!cond) findings.push({ location, expected, actual, severity });
}

// 서버가 실제로 내보내는 상태코드 집합(route.ts + apiAuth.ts 텍스트에서 수집).
const serverCodes = new Set();
for (const m of (route + auth).matchAll(/status:\s*(\d{3})/g)) serverCodes.add(m[1]);
// 200 성공(NextResponse.json({ ok:true ... }) — status 명시 없음 = 200).
if (/ok:\s*true/.test(route)) serverCodes.add("200");

// 클라이언트가 분기 처리하는 상태코드.
const clientHandles = {
  "200": /res\.ok/.test(client),
  "401": /status === 401/.test(client),
  "403": /status === 403/.test(client),
  "400": /status === 400/.test(client),
  "500": /status >= 500/.test(client),
};

console.log("서버 응답코드 집합:", [...serverCodes].sort().join(", "));

// 1) 서버가 내는 모든 코드를 클라이언트가 처리하는가.
for (const code of serverCodes) {
  const handled =
    clientHandles[code] || (Number(code) >= 500 && clientHandles["500"]) || (Number(code) >= 200 && Number(code) < 300 && clientHandles["200"]);
  check(handled, `client: HTTP ${code} 분기`, "클라이언트가 처리", "미처리", "P2");
}

// 2) 재시도 정책: 멱등 전제하 5xx/네트워크만 재시도, 4xx는 재시도 안 함.
check(/status >= 500[\s\S]{0,200}continue/.test(client), "client: 5xx 재시도", "5xx → continue(재시도)", "재시도 경로 없음", "P3");
check(/status === 400[\s\S]{0,300}return/.test(client), "client: 400 무재시도", "400 → 즉시 return", "재시도함", "P3");
check(/contractMismatch:\s*true/.test(client), "client: 400 → contractMismatch 신호", "contractMismatch:true(normalizer 통지)", "없음", "P3");

// 3) 보안 불변식: 세션 쿠키만, 토큰/service_role 금지.
check(/credentials:\s*["']include["']/.test(client), "client: 인증 방식", 'credentials:"include"(세션 쿠키)', "없음", "P1");
check(!/service_role|Bearer\s|Authorization/.test(clientCode), "client: 토큰 미사용", "토큰/Authorization 헤더 없음(코드)", "토큰 흔적 발견", "P1");

// 4) 성공 응답에서 counts를 읽는가(서버 IngestCounts 형태).
check(/counts/.test(client) && /data\?\.counts|data\.counts/.test(client), "client: counts 파싱", "서버 counts 사용", "없음", "P3");
check(/ok:\s*true,\s*source[\s\S]{0,40}counts/.test(route), "server: 성공 응답 형태", "{ ok, source, counts }", "불일치", "P3");

console.log(`\n=== 결과: ${checks}건 검사, 불일치 ${findings.length}건 ===`);
const order = { P1: 0, P2: 1, P3: 2 };
findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
for (const f of findings) console.log(`  [${f.severity}] ${f.location}\n      기대: ${f.expected}\n      실제: ${f.actual}`);
if (findings.length === 0) console.log("  PASS — 업로드 상태코드 매핑/보안 불변식 정합.");
process.exit(findings.filter((f) => f.severity === "P1" || f.severity === "P2").length ? 1 : 0);
