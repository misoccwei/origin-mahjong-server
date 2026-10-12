import { AUTH_PREFIX } from '../shared/protocol.js';

// 瀏覽器端身分：金鑰對保存在 localStorage，私鑰不會送出。
// 優先使用 Ed25519，瀏覽器不支援時改用 ECDSA P-256。

type Alg = 'Ed25519' | 'ECDSA-P256';
interface Stored {
  alg: Alg;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

const STORAGE_KEY = 'origin-mahjong.identity.v1';

const params = (alg: Alg) => (alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' });
const signParams = (alg: Alg) => (alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' });

function load(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

async function generate(): Promise<Stored> {
  for (const alg of ['Ed25519', 'ECDSA-P256'] as Alg[]) {
    try {
      const kp = (await crypto.subtle.generateKey(params(alg), true, ['sign', 'verify'])) as CryptoKeyPair;
      const stored: Stored = {
        alg,
        privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
        publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      } catch {
        /* 無法保存時，本次連線仍可使用 */
      }
      return stored;
    } catch {
      /* 試下一種演算法 */
    }
  }
  throw new Error('此瀏覽器不支援所需的加密功能');
}

let cached: Promise<Stored> | null = null;

export function identityAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function signChallenge(nonce: string) {
  if (!identityAvailable()) throw new Error('需要在 HTTPS 或 localhost 下開啟才能建立身分金鑰');
  cached ??= (async () => load() ?? generate())();
  const id = await cached;
  const key = await crypto.subtle.importKey('jwk', id.privateJwk, params(id.alg), false, ['sign']);
  const sig = await crypto.subtle.sign(signParams(id.alg), key, new TextEncoder().encode(AUTH_PREFIX + nonce));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { alg: id.alg, publicKey: id.publicJwk, signature: b64 };
}
