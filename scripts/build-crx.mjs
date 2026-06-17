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

// 주의: 배치 파일은 ASCII 전용으로 생성한다. 한글(UTF-8)을 넣으면
// 한국어 Windows의 cmd.exe가 OEM 코드페이지(CP949)로 파싱하다 깨져
// "내부/외부 명령이 아닙니다" 오류가 난다. 콘솔 메시지는 영문으로 둔다.
const installBat = `@echo off
setlocal
REM ============================================================
REM  PAMExtensions installer (no admin required)
REM  Registers a per-user (HKCU) Chrome/Edge policy to
REM  force-install the extension and auto-update from GitHub.
REM  Do NOT download the .crx manually - this script handles it.
REM  Extension ID: ${extId}
REM ============================================================
echo.
echo  Installing PAMExtensions...
echo.

set "DATA=${forcelistData}"

REM --- Google Chrome ---
reg add "HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /t REG_SZ /d "%DATA%" /f >nul
if %errorlevel%==0 (echo   [OK] Chrome policy set) else (echo   [!!] Chrome policy FAILED)

REM --- Microsoft Edge (applied if installed) ---
reg add "HKCU\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /t REG_SZ /d "%DATA%" /f >nul
if %errorlevel%==0 (echo   [OK] Edge policy set) else (echo   [..] Edge skipped)

echo.
echo  Done. Next steps:
echo    1. Fully close Chrome/Edge (every window)
echo    2. Reopen the browser
echo    3. Open chrome://extensions and confirm PAMExtensions is installed
echo.
echo  Tip: open chrome://policy and click "Reload policies" to apply now.
echo.
pause
endlocal
`;

const uninstallBat = `@echo off
setlocal
echo.
echo  Removing PAMExtensions force-install policy...
echo.
reg delete "HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /f >nul 2>&1
reg delete "HKCU\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v ${POLICY_VALUE} /f >nul 2>&1
echo  Done. Restart Chrome/Edge to remove the extension.
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
