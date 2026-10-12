import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { AUTH_PREFIX } from '../shared/protocol.js';

// 身分識別：瀏覽器端產生金鑰對（Ed25519，不支援時改用 ECDSA P-256），私鑰只存在瀏覽器。
// 連線時伺服器送出隨機 nonce，客戶端以私鑰簽章，伺服器以公鑰驗證。
// 使用者代碼 = 公鑰指紋，因此不需資料庫即可在重連時辨識同一位使用者。
// 未來導入帳號系統時，只需把 userId 的來源替換為登入資訊。

export type AuthAlg = 'Ed25519' | 'ECDSA-P256';

export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

function canonicalKey(alg: AuthAlg, jwk: JsonWebKey): string | null {
  if (alg === 'Ed25519') {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return null;
    return `OKP|Ed25519|${jwk.x}`;
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  return `EC|P-256|${jwk.x}|${jwk.y}`;
}

export function userIdFromKey(canonical: string): string {
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

/** 驗證簽章，成功回傳 userId，失敗回傳 null */
export async function verifyAuth(nonce: string, alg: AuthAlg, jwk: JsonWebKey, signatureB64: string): Promise<string | null> {
  try {
    const canonical = canonicalKey(alg, jwk);
    if (!canonical || typeof signatureB64 !== 'string' || signatureB64.length > 200) return null;
    const publicJwk: JsonWebKey =
      alg === 'Ed25519' ? { kty: 'OKP', crv: 'Ed25519', x: jwk.x } : { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    const importAlg = alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
    const verifyAlg = alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
    const key = await webcrypto.subtle.importKey('jwk', publicJwk, importAlg, false, ['verify']);
    const data = new TextEncoder().encode(AUTH_PREFIX + nonce);
    const ok = await webcrypto.subtle.verify(verifyAlg, key, Buffer.from(signatureB64, 'base64url'), data);
    return ok ? userIdFromKey(canonical) : null;
  } catch {
    return null;
  }
}
