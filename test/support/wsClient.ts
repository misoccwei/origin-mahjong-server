import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import { AUTH_PREFIX, PROTOCOL_VERSION, type ClientMessage, type GameView, type RoomView, type ServerMessage } from '../../src/shared/protocol.js';

// WebSocket 整合測試用的客戶端：自動完成簽章登入、記下最新的房間與牌局快照，可以等條件成立或自動出牌。

export type KeyPair = { privateKey: webcrypto.CryptoKey; publicJwk: JsonWebKey; alg: 'Ed25519' | 'ECDSA-P256' };

export async function newKey(alg: 'Ed25519' | 'ECDSA-P256' = 'Ed25519'): Promise<KeyPair> {
  const params = alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
  const kp = (await webcrypto.subtle.generateKey(params, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  return { privateKey: kp.privateKey, publicJwk: await webcrypto.subtle.exportKey('jwk', kp.publicKey), alg };
}

export class Client {
  ws!: WebSocket;
  messages: ServerMessage[] = [];
  room: RoomView | null = null;
  game: GameView | null = null;
  userId = '';
  errors: string[] = [];
  closed = false;
  autoplay = false;
  private waiters: (() => void)[] = [];

  constructor(public port: number, public key: KeyPair) {}

  async connect(opts: { badSignature?: boolean; protocol?: number } = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    this.closed = false;
    this.ws.on('message', async (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(msg);
      if (msg.t === 'challenge') {
        const algo = this.key.alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
        const nonce = opts.badSignature ? msg.nonce + 'x' : msg.nonce;
        const sig = await webcrypto.subtle.sign(algo, this.key.privateKey, new TextEncoder().encode(AUTH_PREFIX + nonce));
        this.send({ t: 'auth', alg: this.key.alg, publicKey: this.key.publicJwk, signature: Buffer.from(sig).toString('base64url'), protocol: opts.protocol ?? PROTOCOL_VERSION });
      }
      if (msg.t === 'authOk') this.userId = msg.userId;
      if (msg.t === 'state') {
        this.room = msg.room;
        this.game = msg.game;
        if (this.autoplay) this.play();
      }
      if (msg.t === 'error') this.errors.push(msg.message);
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on('close', () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
    await new Promise((r) => this.ws.once('open', r));
  }

  send(msg: ClientMessage) {
    // 測試依賴固定座位：沒有特別指定時關閉隨機座位
    if (msg.t === 'createRoom') msg = { ...msg, settings: { randomSeats: false, ...msg.settings } };
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor<T>(fn: () => T | undefined | null | false, timeout = 10000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeout) throw new Error('waitFor timeout');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  /** 簡單的自動出牌：能和就和、其餘摸切／略過 */
  play() {
    const g = this.game;
    if (!g || this.room?.paused) return;
    if (g.phase === 'result') {
      if (!g.result!.acknowledged.includes(this.room!.mySeat!)) this.send({ t: 'nextHand' });
      return;
    }
    const p = g.pending;
    if (!p) return;
    let action: ClientMessage & { t: 'action' };
    if (p.kind === 'passThree') action = { t: 'action', handNo: g.handNo, action: { type: 'passThree', tiles: null } };
    else if (p.kind === 'turn')
      action = {
        t: 'action',
        handNo: g.handNo,
        action: p.tsumo ? { type: 'tsumo' } : { type: 'discard', tile: g.myDrawn ?? g.myHand[g.myHand.length - 1] },
      };
    else action = { t: 'action', handNo: g.handNo, action: p.ron ? { type: 'ron' } : { type: 'pass' } };
    this.send(action);
  }

  close() {
    this.ws.close();
  }
}

/**
 * 等到輪到自己打牌。AI 先打時，若打出的牌自己能鳴牌會先出現「鳴牌」選擇；
 * 鳴牌沒有時限的設定下不略過會一直卡住，所以途中遇到就略過。
 */
export async function waitMyTurn(c: Client) {
  return c.waitFor(() => {
    const g = c.game;
    if (g?.pending && g.pending.kind !== 'turn') c.send({ t: 'action', handNo: g.handNo, action: { type: 'pass' } });
    return g?.pending?.kind === 'turn' && g;
  });
}

/**
 * 自動摸打遇到能槓、或和牌沒達到這副聽牌的最高分時會停下來問玩家；
 * 測試裡一律回答「和」或「不槓」（摸切或略過），否則沒有時限時會卡住
 */
export function answerAutoStop(c: Client) {
  const g = c.game;
  const p = g?.pending;
  if (!g || !p) return;
  if (p.tsumo || p.ron) {
    c.send({ t: 'action', handNo: g.handNo, action: { type: p.tsumo ? 'tsumo' : 'ron' } });
  } else if (p.kind === 'turn' && (p.ankan?.length || p.kakan?.length) && g.myDrawn !== null) {
    c.send({ t: 'action', handNo: g.handNo, action: { type: 'discard', tile: g.myDrawn } });
  } else if (p.kind === 'claim' && p.minkan && !p.ron) {
    c.send({ t: 'action', handNo: g.handNo, action: { type: 'pass' } });
  }
}
