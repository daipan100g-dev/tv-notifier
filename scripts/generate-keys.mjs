import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
writeFileSync('vapid-keys.json', JSON.stringify({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: jwk.d,
  OWNER_TOKEN: randomBytes(32).toString('base64url'),
}, null, 2), { mode: 0o600, flag: 'wx' });
console.log('vapid-keys.json に保存しました。このファイルは公開・コミットしないでください。既存キーは上書きしません。');
