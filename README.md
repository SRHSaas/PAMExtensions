# PAMExtensions

증권사 포트폴리오를 **스크랩 → 정규화 → 로그인된 SRHFinance 세션으로 업로드**하는 Chrome(MV3) 확장.

---

## 설치 (사용자용) — Windows, 관리자 권한 불필요

개발자 모드 없이 자동 설치·자동 업데이트됩니다.

1. [**Releases**](https://github.com/SRHSaas/PAMExtensions/releases/latest) 페이지로 이동
2. **`install.bat`** 다운로드
3. 다운로드한 `install.bat` **더블클릭** (경고가 뜨면 "추가 정보 → 실행")
4. 열려 있는 **Chrome(또는 Edge)을 완전히 종료** 후 다시 실행
5. 주소창에 `chrome://extensions` → **PAMExtensions** 가 설치되어 있으면 완료

> 즉시 확인하려면 `chrome://policy` 접속 → **정책 다시 로드** 클릭.

### 동작 원리
`install.bat` 은 현재 사용자(HKCU)의 Chrome/Edge 정책에 확장을 **강제설치(force-install)** 로 등록하고, 업데이트 주소를 이 저장소의 최신 릴리스로 지정합니다. 이후 새 버전이 릴리스되면 브라우저가 **자동으로 업데이트**합니다. 관리자 권한이 필요 없습니다.

### 제거
Releases에서 **`uninstall.bat`** 을 받아 더블클릭한 뒤 브라우저를 재시작하세요.

> ⚠️ 강제설치된 확장은 `chrome://extensions` 화면의 휴지통 버튼으로 제거되지 않습니다. 반드시 `uninstall.bat` 을 사용하세요.

### macOS / Linux
이 방식은 Windows 레지스트리 정책 기반이라 지원되지 않습니다. 해당 OS에서는 개발자 모드로 압축해제 로드(아래 "개발" 참고)를 사용하거나, 웹스토어 배포를 검토하세요.

---

## 릴리스 (유지보수자용)

### 최초 1회 설정 — 서명키를 GitHub 시크릿으로 등록
확장 ID는 서명키에서 파생되며 **항상 같은 키로 서명**해야 ID가 유지됩니다. 키는 `build/key.pem` 에 있고 **절대 커밋하지 않습니다**(`.gitignore` 처리됨).

```bash
# 키가 없다면 먼저 생성 (ID/manifest key 출력)
node scripts/keygen.mjs

# 로컬 개인키를 리포지토리 시크릿으로 등록 (gh CLI)
gh secret set CRX_PRIVATE_KEY < build/key.pem
```

> 현재 확장 ID: **`bfigkpjffbehjcjdapacmpjimgbdoilb`**
> `extension/manifest.json` 의 `"key"` 필드(공개키)와 이 서명키는 한 쌍이며, 빌드 시 일치 여부를 검증합니다.

### 새 버전 배포
1. `extension/manifest.json` 의 `version` 을 올린다 (예: `0.2.0` → `0.2.1`)
2. 커밋 후 **같은 버전으로 태그를 push**:
   ```bash
   git commit -am "release: v0.2.1"
   git tag v0.2.1
   git push origin main --tags
   ```
3. `.github/workflows/release.yml` 가 자동으로:
   - `.crx` 서명, `updates.xml`·`install.bat`·`uninstall.bat` 생성
   - GitHub Release에 4개 자산 첨부
4. 기존 사용자는 다음 폴링 때 **자동 업데이트**됨 (URL 고정: `releases/latest/download/...`).

### 로컬 빌드(검증용)
```bash
npm ci
npm run build      # dist/ 에 PAMExtensions.crx, updates.xml, install.bat, uninstall.bat 생성
```

---

## 개발 (개발자 모드 로드)
`chrome://extensions` → 개발자 모드 ON → **압축해제된 확장 프로그램 로드** → `extension/` 폴더 지정.
(자세한 구조·정책은 [`CLAUDE.md`](./CLAUDE.md) 참고.)
