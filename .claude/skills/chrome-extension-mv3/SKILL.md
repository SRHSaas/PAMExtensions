---
name: chrome-extension-mv3
description: "Chrome Manifest V3 확장 설계·구현 가이드. manifest.json(권한·content_scripts·service worker·action·options), background 서비스워커 생애주기, content↔background↔popup 메시지 패싱 규약, chrome.storage 상태관리, 빌드 구성. PAMExtensions 골격을 만들거나 매니페스트·메시지규약·권한·UI셸을 손볼 때 반드시 사용. extension-architect 전용."
---

# Chrome MV3 확장 구현 가이드

PAMExtensions의 골격을 만드는 절차적 지식. extension-architect가 매니페스트·서비스워커·메시지 패싱·UI 셸을 설계할 때 사용한다.

## 왜 MV3이고 왜 이 구조인가

증권사 페이지에서 데이터를 읽으려면 그 페이지 컨텍스트에서 도는 **content script**가 필요하다. content script는 DOM에 접근하지만 확장 API는 제한적이고, 네트워크 업로드·상태 저장은 **service worker(background)**가 맡는다. 사용자 조작·진행 표시는 **popup**이 한다. 셋은 서로 다른 컨텍스트라 **메시지 패싱**으로만 통신한다. 이 경계가 PAMExtensions 파이프라인(스크랩→정규화→업로드)의 물리적 분할선이다.

정책상 증권사 세션을 백그라운드로 연장하지 않는다(쿠키 자동유지 폐지). 확장은 사용자가 **이미 로그인한 탭**에서만 스크랩한다. 따라서 alarms 기반 무인 keepalive·세션 위조 코드는 만들지 않는다.

## 디렉토리 구조 (모듈 경계 = 팀원 경계)

```
manifest.json
src/
├── shared/
│   └── messages.js      ← 메시지 타입·페이로드 스키마 단일 정의 (전원 import)
├── content/
│   └── miraeasset/       ← scraper-engineer (증권사별)
│       └── index.js
├── normalize/            ← normalizer-engineer
│   └── index.js
├── upload/               ← integration-engineer
│   └── client.js
├── background/
│   └── service-worker.js ← 파이프라인 오케스트레이션(메시지 라우팅, 상태 저장)
├── popup/                ← UI 셸 (로그인감지→스크랩→변환→업로드 진행)
│   ├── popup.html
│   └── popup.js
└── options/              ← SRHFinance origin 등 설정
    ├── options.html
    └── options.js
```

각 디렉토리 하나가 한 팀원의 담당이다. **메시지 스키마만은 `src/shared/messages.js`에 단일 정의**하고 모두가 import 한다 — shape 중복 정의가 경계 버그의 1순위 원인이다.

## manifest.json 핵심

```json
{
  "manifest_version": 3,
  "name": "PAMExtensions",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "https://securities.miraeasset.com/*",
    "http://localhost:3000/*"
  ],
  "background": { "service_worker": "src/background/service-worker.js", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html" },
  "options_page": "src/options/options.html",
  "content_scripts": [
    {
      "matches": ["https://securities.miraeasset.com/*"],
      "js": ["src/content/miraeasset/index.js"],
      "run_at": "document_idle"
    }
  ]
}
```

원칙:
- **최소 권한**. `host_permissions`는 실제 스크랩 대상 증권사 + SRHFinance origin만. `<all_urls>` 금지. SRHFinance origin은 dev(localhost)와 배포 도메인이 다르므로 options에서 바꿀 수 있게 하고, 업로드는 `fetch(origin, {credentials:"include"})`로 보낸다.
- 새 증권사 추가 = `host_permissions` + `content_scripts` 항목 추가 + `src/content/{broker}/` 추가. 매니페스트가 확장 지점이다.
- `"type": "module"`로 service worker에서 ES import 사용.

## 메시지 패싱 규약 (인터페이스 계약)

`src/shared/messages.js`에 타입 상수와 페이로드 형태를 한 곳에서 정의한다:

```js
export const MSG = {
  SCRAPE_REQUEST: "SCRAPE_REQUEST",   // popup → background → content
  SCRAPE_RESULT:  "SCRAPE_RESULT",    // content → background  (raw shape)
  UPLOAD_REQUEST: "UPLOAD_REQUEST",   // popup/background → upload
  UPLOAD_RESULT:  "UPLOAD_RESULT",    // background → popup    ({ ok, counts, error })
  STATUS:         "STATUS",           // background → popup    (진행 단계)
};
// 각 메시지의 payload 필드 표는 _workspace/01_architect_interface.md에 문서화한다.
```

흐름: popup이 `SCRAPE_REQUEST`를 background로 보내고 → background가 대상 탭 content script에 전달 → content가 DOM을 긁어 `SCRAPE_RESULT`(raw)를 반환 → background가 normalizer로 정규화 → `UPLOAD_REQUEST`로 upload client 호출 → `UPLOAD_RESULT`를 popup에 표시.

### ⚠ content script는 ESM 모듈이 아니다 (중대 함정)

`background`(service_worker `type:module`)와 `popup`(`<script type="module">`)은 `messages.js`를 정적 `import` 할 수 있지만, **manifest `content_scripts`로 선언된 스크립트는 클래식 스크립트로 실행되어 정적 `import`가 불가능**하다. 최상단에 `import {...} from "..."`를 쓰면 로드 즉시 `Cannot use import statement outside a module`로 스크립트 전체가 죽고, `chrome.runtime.onMessage` 리스너가 등록되지 않아 background의 `chrome.tabs.sendMessage`가 **"Could not establish connection. Receiving end does not exist."**로 실패한다(증상은 "수신자 없음"이라 원인이 import인지 드러나지 않는다).

대응: content script는 자신이 쓰는 소수 메시지 상수를 **인라인 미러**로 두고(값은 `messages.js`와 동기화), 정적 import를 쓰지 않는다. (대규모면 esbuild 번들이 대안이나 로드 단순성을 위해 인라인 우선.)

### 선언형 content script 미주입 + 자동 주입 폴백

선언형 `content_scripts`는 **확장 로드/리로드 이후 페이지가 로드될 때만** 주입된다. 확장을 켜기 전부터 열려 있던 탭에는 주입되지 않아 같은 "Receiving end does not exist"가 난다. background의 메시지 전송을 try/catch로 감싸 실패 시 `chrome.scripting.executeScript({target:{tabId}, files:[...]})`로 직접 주입 후 1회 재시도하면, 사용자가 탭을 수동 새로고침하지 않아도 동작한다(`scripting` 권한 + 대상 host_permission 필요).

## 서비스워커 생애주기

MV3 서비스워커는 **무상태로 깨었다 종료**된다. 진행 상태(스크랩 중/업로드 완료 manifest 등)는 메모리가 아니라 `chrome.storage.local`에 저장한다. 장시간 작업은 단계별로 상태를 저장해 재기동에도 이어지게 한다.

## 빌드

기본은 번들 없이 plain ES modules로 동작하게 둔다(로드 단순). import 그래프가 커지거나 npm 의존성이 필요하면 esbuild 한 줄 번들(`esbuild src/background/service-worker.js --bundle --format=esm`)을 도입한다. 과한 도구체인은 피한다.

## 산출물

- `manifest.json`, `src/shared/messages.js`, `src/background/`, `src/popup/`, `src/options/` 스캐폴드
- `_workspace/01_architect_interface.md` — 메시지 페이로드 필드 표 + 디렉토리 계약(팀원 전원의 기준 문서)

## 체크리스트

- [ ] host_permissions가 대상 origin으로 한정됨(`<all_urls>` 없음)
- [ ] 메시지 스키마가 `src/shared/messages.js` 단일 정의
- [ ] keepalive/쿠키자동유지/세션위조 코드 없음
- [ ] 서비스워커 상태가 chrome.storage에 저장됨
- [ ] SRHFinance origin이 options에서 설정 가능
