// 릴리스 산출물 빌드:
//   dist/PAMExtensions.crx   (서명된 확장 패키지)
//   dist/updates.xml         (Chrome 자동업데이트 매니페스트)
//   dist/install.bat         (사용자용 1클릭 설치기 — HKCU 정책, 관리자 불필요)
//   dist/uninstall.bat       (제거기)
//
// 자동업데이트 URL은 GitHub Releases의 "latest/download" 고정 경로를 사용한다.
// 따라서 새 릴리스를 올릴 때마다(= manifest version 증가) 기존 설치본이 자동 갱신된다.
import crx3 from 'crx3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'SRHSaas/PAMExtensions';
const BASE = `https://github.com/${REPO}/releases/latest/download`;
const CRX_NAME = 'PAMExtensions.crx';
const KEY_PATH = process.env.CRX_KEY_PATH || 'build/key.pem';
const OUT = 'dist';
const POLICY_VALUE = '1'; // ExtensionInstallForcelist 레지스트리 값 이름

function fail(msg) {
  console.error('[build] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(KEY_PATH)) {
  fail(`개인키가 없습니다: ${KEY_PATH}\n  로컬: node scripts/keygen.mjs 실행\n  CI:  시크릿 CRX_PRIVATE_KEY 를 ${KEY_PATH} 로 기록`);
}

const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const version = manifest.version;

// 개인키 → 공개키 SPKI DER → manifest key / 확장 ID (crx3와 동일 도출)
const der = crypto.createPublicKey(fs.readFileSync(KEY_PATH, 'utf8')).export({ type: 'spki', format: 'der' });
const manifestKey = der.toString('base64');
const extId = crypto.createHash('sha256').update(der).digest().slice(0, 16)
  .toString('hex').split('').map((x) => (parseInt(x, 16) + 0x0a).toString(26)).join('');

if (manifest.key && manifest.key !== manifestKey) {
  fail('manifest.json 의 "key" 가 서명키와 불일치합니다. 같은 키로 패킹해야 확장 ID가 유지됩니다.');
}

fs.mkdirSync(OUT, { recursive: true });

await crx3(['extension/manifest.json'], {
  keyPath: KEY_PATH,
  crxPath: path.join(OUT, CRX_NAME),
  xmlPath: path.join(OUT, 'updates.xml'),
  appVersion: version,
  crxURL: `${BASE}/${CRX_NAME}`,
});

// install.bat / uninstall.bat 생성 (ID·URL을 박아 넣음)
const updateUrl = `${BASE}/updates.xml`;
const forcelistData = `${extId};${updateUrl}`;

const installBat = `@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  PAMExtensions 설치기 (관리자 권한 불필요)
REM  HKCU 정책으로 Chrome/Edge에 확장을 강제설치하고
REM  GitHub Releases에서 자동 업데이트되도록 등록합니다.
REM  확장 ID: ${extId}
REM ============================================================
echo.
echo  PAMExtensions 를 설치합니다...
echo.

set "DATA=${forcelistData}"

REM --- Google Chrome ---
reg add "HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /t REG_SZ /d "%DATA%" /f >nul
if %errorlevel%==0 (echo   [OK] Chrome 정책 등록) else (echo   [!!] Chrome 정책 등록 실패)

REM --- Microsoft Edge (설치되어 있으면 적용) ---
reg add "HKCU\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /t REG_SZ /d "%DATA%" /f >nul
if %errorlevel%==0 (echo   [OK] Edge 정책 등록) else (echo   [..] Edge 건너뜀)

echo.
echo  완료! 다음을 진행하세요:
echo    1) 열려 있는 Chrome/Edge 를 완전히 종료(모든 창)
echo    2) 다시 실행
echo    3) 주소창에 chrome://extensions 입력 → PAMExtensions 자동 설치 확인
echo.
echo  (즉시 확인: chrome://policy 에서 "정책 다시 로드" 클릭)
echo.
pause
endlocal
`;

const uninstallBat = `@echo off
chcp 65001 >nul
setlocal
echo.
echo  PAMExtensions 강제설치 정책을 제거합니다...
echo.
reg delete "HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /f >nul 2>&1
reg delete "HKCU\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /f >nul 2>&1
echo  완료. Chrome/Edge 를 재시작하면 확장이 제거됩니다.
echo.
pause
endlocal
`;

fs.writeFileSync(path.join(OUT, 'install.bat'), installBat);
fs.writeFileSync(path.join(OUT, 'uninstall.bat'), uninstallBat);

console.log('[build] dist/ 생성 완료');
console.log('  - ' + CRX_NAME + ' (v' + version + ')');
console.log('  - updates.xml  (codebase=' + BASE + '/' + CRX_NAME + ')');
console.log('  - install.bat / uninstall.bat');
console.log('  - 확장 ID: ' + extId);
