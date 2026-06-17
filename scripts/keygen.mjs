// 릴리스 서명용 RSA 개인키를 생성/로드하고, 그로부터 파생되는
//   - Chrome 확장 ID (a-p 인코딩)
//   - manifest "key" 필드(공개키 SPKI DER base64)
// 를 출력한다. crx3와 동일한 도출식을 사용해 .crx 서명 ID와 일치시킨다.
//
// 개인키(build/key.pem)는 절대 커밋하지 않는다(.gitignore). CI에서는
// 이 파일 내용을 리포지토리 시크릿 CRX_PRIVATE_KEY 로 주입한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_PATH = process.env.CRX_KEY_PATH || 'build/key.pem';

fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });

let pem;
if (fs.existsSync(KEY_PATH)) {
  pem = fs.readFileSync(KEY_PATH, 'utf8');
} else {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
  pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(KEY_PATH, pem);
  console.error(`[keygen] 새 개인키 생성: ${KEY_PATH} (커밋 금지)`);
}

const publicKey = crypto.createPublicKey(pem);
const der = publicKey.export({ type: 'spki', format: 'der' });

// manifest "key": 공개키 SPKI DER 를 base64
const manifestKey = der.toString('base64');

// 확장 ID: SHA256(SPKI DER) 앞 16바이트 → hex → 각 자리(+10).toString(26) = a-p
const hash = crypto.createHash('sha256').update(der).digest().slice(0, 16);
const extId = hash
  .toString('hex')
  .split('')
  .map((x) => (parseInt(x, 16) + 0x0a).toString(26))
  .join('');

const identity = { extId, manifestKey };
fs.writeFileSync('build/identity.json', JSON.stringify(identity, null, 2) + '\n');

console.log('EXT_ID=' + extId);
console.log('MANIFEST_KEY=' + manifestKey);
console.error('\n[keygen] build/identity.json 에 저장됨.');
console.error('[keygen] manifest.json 의 "key" 필드에 위 MANIFEST_KEY 값을 넣으세요(자동 적용은 build 스크립트가 검증).');
