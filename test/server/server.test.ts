import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import type { RuleSettings } from '../../src/shared/rules.js';
import { Client, answerAutoStop, newKey, waitMyTurn, type KeyPair } from '../support/wsClient.js';

let server: RunningServer;
const clients: Client[] = [];

async function client(nickname?: string, key?: KeyPair) {
  const c = new Client(server.port, key ?? (await newKey()));
  clients.push(c);
  await c.connect();
  await c.waitFor(() => c.userId);
  if (nickname) {
    c.send({ t: 'setNickname', name: nickname });
    await c.waitFor(() => c.messages.find((m) => m.t === 'nicknameOk' || m.t === 'error'));
  }
  return c;
}

/**
 * 兩個真人（房主＋自動出牌的玩家）加一個 AI 的三人房，座位依序是房主、玩家、AI。
 * 只有一個真人時是「單人對 AI」（不限時、公開 AI 手牌），要測限時與手牌遮蔽時用這個。
 */
async function duoRoom(name: string, settings: Partial<RuleSettings>) {
  const host = await client(name);
  host.send({ t: 'createRoom', settings: { playerCount: 3, ...settings } });
  const room = await host.waitFor(() => host.room);
  const guest = await client(name + 'g');
  guest.autoplay = true;
  guest.send({ t: 'joinRoom', roomId: room.id });
  await guest.waitFor(() => guest.room);
  host.send({ t: 'addAI' });
  await host.waitFor(() => host.room?.players.every((p) => p.nickname));
  guest.send({ t: 'ready', ready: true });
  await host.waitFor(() => host.room?.players[1].ready);
  return host;
}

beforeAll(async () => {
  server = await startServer({ port: 0, aiDelayMs: 0, resultMs: 200, passRevealMs: 100, log: () => {}, waitingOfflineMs: 300, sweepIntervalMs: 100 });
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
});
afterAll(async () => {
  await server.close();
});

describe('身分與暱稱', () => {
  it('簽章驗證成功取得使用者代碼，同一把金鑰重連得到相同代碼', async () => {
    const key = await newKey();
    const a = await client(undefined, key);
    const first = a.userId;
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    a.close();
    const b = await client(undefined, key);
    expect(b.userId).toBe(first);
  });

  it('支援 ECDSA P-256', async () => {
    const a = await client(undefined, await newKey('ECDSA-P256'));
    expect(a.userId).toHaveLength(22);
  });

  it('簽章錯誤會被拒絕', async () => {
    const c = new Client(server.port, await newKey());
    clients.push(c);
    await c.connect({ badSignature: true });
    await c.waitFor(() => c.closed);
    expect(c.userId).toBe('');
  });

  it('暱稱不可與他人重複（不分大小寫），重連保留暱稱', async () => {
    const key = await newKey();
    const a = await client('Alice', key);
    const b = await client('alice');
    expect(b.errors.at(-1)).toContain('已經有人使用');
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    // 斷線期間暱稱仍保留
    const c = await client('ALICE');
    expect(c.errors.at(-1)).toContain('已經有人使用');
    const a2 = await client(undefined, key);
    const ok = a2.messages.find((m) => m.t === 'authOk');
    expect(ok && ok.t === 'authOk' && ok.nickname).toBe('Alice');
  });

  it('請求帶 rid 時，處理完（錯誤訊息、狀態推送都送出後）回 done；沒帶 rid 不回', async () => {
    const a = await client('Rid');
    // 設定暱稱後伺服器會再推送一次狀態（登入時也有一次）；先等 nicknameOk 之後的那次到，才不會被算進第一個請求的回覆
    await a.waitFor(() => a.messages.slice(a.messages.findIndex((m) => m.t === 'nicknameOk')).some((m) => m.t === 'state'));
    const sendRaw = (msg: object) => (a as unknown as { ws: { send: (s: string) => void } }).ws.send(JSON.stringify(msg));
    // 送出請求，回傳到 done 為止收到的訊息種類
    const req = async (msg: object, rid: number) => {
      const from = a.messages.length;
      sendRaw({ ...msg, rid });
      await a.waitFor(() => a.messages.some((m) => m.t === 'done' && m.rid === rid));
      return a.messages.slice(from).map((m) => m.t);
    };
    expect(await req({ t: 'joinRoom', roomId: '0000' }, 1)).toEqual(['error', 'done']);
    expect(await req({ t: 'createRoom', settings: { randomSeats: false } }, 2)).toEqual(['state', 'done']);
    a.send({ t: 'addAI' });
    await a.waitFor(() => a.room?.players[1].nickname);
    expect(a.messages.filter((m) => m.t === 'done')).toHaveLength(2);
  });

  it('同一使用者從新連線登入時，舊連線被踢除', async () => {
    const key = await newKey();
    const a = await client('Dup', key);
    await client(undefined, key);
    await a.waitFor(() => a.closed);
    expect(a.messages.some((m) => m.t === 'kicked')).toBe(true);
  });

  it('未設定暱稱不能建立房間', async () => {
    const a = await client();
    a.send({ t: 'createRoom' });
    await a.waitFor(() => a.errors.length);
    expect(a.errors[0]).toContain('暱稱');
  });
});

describe('房間', () => {
  it('建立、加入、滿房、預設圈數', async () => {
    const host = await client('Host1');
    host.send({ t: 'createRoom', settings: { playerCount: 2 } });
    const room = await host.waitFor(() => host.room);
    expect(room.id).toMatch(/^\d{4}$/);
    expect(room.settings.rounds).toBe(2);
    const b = await client('B1');
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room?.players.filter((p) => p.nickname).length === 2);
    const c = await client('C1');
    c.send({ t: 'joinRoom', roomId: room.id });
    await c.waitFor(() => c.errors.length);
    expect(c.errors[0]).toContain('已滿');
    c.send({ t: 'joinRoom', roomId: '000000' });
    await c.waitFor(() => c.errors.length > 1);
    expect(c.errors[1]).toContain('找不到');
  });

  it('只有房主可以改設定、加 AI；設定經過驗證', async () => {
    const host = await client('Host2');
    host.send({ t: 'createRoom', settings: { playerCount: 3, rounds: 99 as never } });
    const room = await host.waitFor(() => host.room);
    expect(room.settings.playerCount).toBe(3);
    expect(room.settings.rounds).toBe(2);
    const b = await client('B2');
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room);
    b.send({ t: 'addAI' });
    await b.waitFor(() => b.errors.length);
    expect(b.errors[0]).toContain('房主');
    host.send({ t: 'updateSettings', settings: { advanced: true, rounds: 3 } });
    await host.waitFor(() => host.room?.settings.advanced && host.room.settings.rounds === 3);
  });

  it('等待中斷線過久會被移出座位；房主離開時轉移給下一位', async () => {
    const host = await client('Host3');
    host.send({ t: 'createRoom' });
    const room = await host.waitFor(() => host.room);
    const b = await client('B3');
    b.send({ t: 'joinRoom', roomId: room.id });
    await host.waitFor(() => host.room?.players[1].nickname === 'B3');
    host.send({ t: 'leaveRoom' });
    await b.waitFor(() => b.room?.hostSeat === 1);
    const c = await client('C3');
    c.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room?.players.some((p) => p.nickname === 'C3'));
    c.close();
    await b.waitFor(() => !b.room?.players.some((p) => p.nickname === 'C3'), 3000);
  });
});

describe('語音 signaling', () => {
  it('只轉送給同房間的其他真人；房外的人收不到，也不能轉給自己', async () => {
    const a = await client('Rtc1');
    a.send({ t: 'createRoom', settings: { playerCount: 3 } });
    const room = await a.waitFor(() => a.room);
    const b = await client('Rtc2');
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room);
    const outsider = await client('Rtc3');
    const data = { k: 'hello' as const, sid: 's1', mic: true };
    a.send({ t: 'rtc', to: b.userId, data });
    const got = await b.waitFor(() => b.messages.find((m) => m.t === 'rtc'));
    expect(got).toEqual({ t: 'rtc', from: a.userId, data });
    // 房外的人不能傳給房內的人，也收不到房內的訊息
    outsider.send({ t: 'rtc', to: b.userId, data });
    a.send({ t: 'rtc', to: outsider.userId, data });
    a.send({ t: 'rtc', to: a.userId, data });
    a.send({ t: 'ping' });
    await a.waitFor(() => a.messages.find((m) => m.t === 'pong'));
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.filter((m) => m.t === 'rtc')).toHaveLength(1);
    expect(outsider.messages.some((m) => m.t === 'rtc')).toBe(false);
    expect(a.messages.some((m) => m.t === 'rtc')).toBe(false);
  });

  it('/ice-servers 提供 ICE 設定', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/ice-servers`);
    const list = await r.json();
    expect(Array.isArray(list) && list.length > 0).toBe(true);
  });
});

describe('觀戰', () => {
  it('觀戰者只看到公開資訊、不能操作也不能參與語音；房間關閉時一起離開', async () => {
    const host = await client('Sp1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0, passThree: false } });
    const room = await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'start' });
    await host.waitFor(() => host.game);
    const spec = await client('Sp2');
    spec.send({ t: 'spectate', roomId: room.id });
    const g = await spec.waitFor(() => spec.game);
    expect(spec.room!.mySeat).toBeNull();
    expect(g.myHand).toEqual([]);
    expect(g.pending).toBeNull();
    expect(spec.room!.players[0].handCount).toBeGreaterThan(0);
    await host.waitFor(() => host.room?.spectators.some((s) => s.nickname === 'Sp2'));
    // 不能操作
    spec.send({ t: 'action', handNo: g.handNo, action: { type: 'pass' } });
    spec.send({ t: 'ready', ready: true });
    await spec.waitFor(() => spec.errors.length >= 2);
    // 不能參與語音（傳不出去）
    spec.send({ t: 'rtc', to: host.userId, data: { k: 'hello', sid: 'x', mic: true } });
    // 已在觀戰時不能再加入別的房間
    spec.send({ t: 'joinRoom', roomId: room.id });
    await spec.waitFor(() => spec.errors.some((e) => e.includes('已經開始')));
    host.send({ t: 'ping' });
    await host.waitFor(() => host.messages.find((m) => m.t === 'pong'));
    expect(host.messages.some((m) => m.t === 'rtc')).toBe(false);
    // 最後一位真人離開 → 房間關閉，觀戰者也回到大廳
    host.send({ t: 'leaveRoom' });
    await spec.waitFor(() => spec.room === null);
  });

  it('等待中觀戰後入座；房主關閉觀戰時觀戰者被請出', async () => {
    const host = await client('Sp3');
    host.send({ t: 'createRoom', settings: { playerCount: 3 } });
    const room = await host.waitFor(() => host.room);
    const a = await client('Sp4');
    a.send({ t: 'spectate', roomId: room.id });
    await a.waitFor(() => a.room && a.room.mySeat === null);
    a.send({ t: 'joinRoom', roomId: room.id });
    await a.waitFor(() => a.room?.mySeat === 1);
    expect(a.room!.spectators).toEqual([]);
    const b = await client('Sp5');
    b.send({ t: 'spectate', roomId: room.id });
    await b.waitFor(() => b.room);
    host.send({ t: 'updateSettings', settings: { allowSpectators: false } });
    await b.waitFor(() => b.room === null);
    b.send({ t: 'spectate', roomId: room.id });
    await b.waitFor(() => b.errors.some((e) => e.includes('不開放觀戰')));
  });
});

describe('對局', () => {
  it('2 真人 + 2 AI 打完一圈，結算後加一圈', async () => {
    const host = await client('P1');
    host.send({ t: 'createRoom', settings: { playerCount: 4, turnSeconds: 0, claimSeconds: 0 } });
    const room = await host.waitFor(() => host.room);
    const b = await client('P2');
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room);
    host.send({ t: 'addAI' });
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players.every((p) => p.nickname));
    host.autoplay = b.autoplay = true;
    b.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[1].ready);
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
    const g = await host.waitFor(() => host.game);
    expect(g.myHand.length).toBeGreaterThanOrEqual(13);
    expect(g.totalHands).toBe(4);
    // 看不到他人手牌
    expect(JSON.stringify(host.room)).not.toContain('myHand');
    await host.waitFor(() => host.room?.status === 'finished', 60000);
    expect(host.room!.history).toHaveLength(4);
    const scores = host.room!.players.map((p) => p.score);
    const sum = host.room!.history.reduce((a, h) => a.map((x, i) => x + h.deltas[i]), [0, 0, 0, 0]);
    expect(scores).toEqual(sum);
    // 結束後可以重看每一局：自己的手牌看得到；沒和牌、沒聽牌、沒展示的他人手牌不公開
    const replays = host.room!.replays;
    expect(replays.map((x) => x.handNo)).toEqual([1, 2, 3, 4]);
    for (const { result: r } of replays) {
      expect(r.hands[0].length).toBeGreaterThan(0);
      for (let s = 1; s < 4; s++) {
        const visible = r.winners.some((w) => w.seat === s) || r.tenpai.some((t) => t.seat === s) || r.shown.includes(s);
        if (!visible) expect(r.hands[s]).toEqual([]);
      }
    }
    // 回放檔：要求時才送，含每一局完整的紀錄（四家手牌都公開）
    expect(host.messages.some((m) => m.t === 'replay')).toBe(false);
    host.send({ t: 'getReplay' });
    const file = await host.waitFor(() => host.messages.find((m) => m.t === 'replay'));
    if (file.t !== 'replay') throw new Error();
    expect(file.replay.hands.map((h) => h.handNo)).toEqual([1, 2, 3, 4]);
    expect(file.replay.hands.every((h) => h.deal.every((d) => d.length === 13))).toBe(true);
    expect(file.replay.finalScores).toEqual(scores);
    // 加一圈
    b.send({ t: 'extend' });
    await b.waitFor(() => b.errors.some((e) => e.includes('房主')));
    host.send({ t: 'extend' });
    await host.waitFor(() => host.room?.status === 'playing');
    expect(host.room!.replays).toEqual([]);
    await host.waitFor(() => host.room?.status === 'finished' && host.room.history.length === 8, 60000);
    // 加圈前的局也還看得到
    expect(host.room!.replays.map((x) => x.handNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('真人斷線時暫停，由房主決定 AI 代打；重連後拿回控制權', async () => {
    const host = await client('Q1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0, rounds: 4 } });
    const room = await host.waitFor(() => host.room);
    const keyB = await newKey();
    const b = await client('Q2', keyB);
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room);
    host.autoplay = true;
    b.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[1].ready);
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
    b.close();
    const paused = await host.waitFor(() => host.room?.paused);
    expect(paused.disconnectedSeats).toEqual([1]);
    expect(paused.deciderSeat).toBe(0);
    host.send({ t: 'decide', choice: 'ai' });
    await host.waitFor(() => !host.room?.paused && host.room?.players[1].aiControlled);
    // 牌局在 AI 代打下繼續進行
    const before = host.game?.handNo ?? 0;
    await host.waitFor(() => (host.game?.handNo ?? 0) > before || host.room?.status === 'finished', 30000);
    const b2 = await client(undefined, keyB);
    await b2.waitFor(() => b2.room?.status === 'playing' || b2.room?.status === 'finished');
    expect(b2.room!.players[1].aiControlled).toBe(false);
    expect(b2.room!.players[1].connected).toBe(true);
  });

  it('房主斷線時由房主的下家決定；可以解散牌局', async () => {
    const host = await client('R1');
    host.send({ t: 'createRoom', settings: { playerCount: 3, turnSeconds: 0, claimSeconds: 0 } });
    const room = await host.waitFor(() => host.room);
    const b = await client('R2');
    const c = await client('R3');
    b.send({ t: 'joinRoom', roomId: room.id });
    await b.waitFor(() => b.room);
    c.send({ t: 'joinRoom', roomId: room.id });
    await c.waitFor(() => c.room);
    for (const x of [b, c]) x.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[1].ready && host.room.players[2].ready);
    host.send({ t: 'start' });
    await c.waitFor(() => c.room?.status === 'playing');
    host.close();
    const paused = await b.waitFor(() => b.room?.paused);
    expect(paused.deciderSeat).toBe(1);
    c.send({ t: 'decide', choice: 'dissolve' });
    await c.waitFor(() => c.errors.some((e) => e.includes('其他玩家')));
    // 任何人都可以在暫停時離開
    c.send({ t: 'leaveRoom' });
    await c.waitFor(() => c.room === null);
    const p2 = await b.waitFor(() => b.room?.paused?.disconnectedSeats.length === 2 && b.room.paused);
    expect(p2.deciderSeat).toBe(1);
    b.send({ t: 'decide', choice: 'dissolve' });
    await b.waitFor(() => b.room?.status === 'finished' && b.room.dissolved);
  });

  it('只有房主可以開始，且其他真人都要準備', async () => {
    const host = await client('V1');
    host.send({ t: 'createRoom', settings: { playerCount: 2 } });
    const room = await host.waitFor(() => host.room);
    host.send({ t: 'start' });
    await host.waitFor(() => host.errors.some((e) => e.includes('坐滿')));
    const b = await client('V2');
    b.send({ t: 'joinRoom', roomId: room.id });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'start' });
    await host.waitFor(() => host.errors.some((e) => e.includes('準備')));
    b.send({ t: 'start' });
    await b.waitFor(() => b.errors.some((e) => e.includes('房主')));
    b.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[1].ready);
    expect(host.room!.status).toBe('waiting');
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
  });

  it('自動摸打：開啟後不用操作也能打完一局；換三張有亮牌階段', async () => {
    const host = await client('W1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0 } });
    await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'setAuto', on: true, win: false });
    await host.waitFor(() => host.room?.players[0].autoPlay);
    host.send({ t: 'start' });
    await host.waitFor(() => host.game?.phase === 'passReveal');
    // 局一結束自動摸打就關掉
    await host.waitFor(() => (answerAutoStop(host), host.game?.phase === 'result' && !host.game.auto.on), 20000);
  });

  it('電腦難度：只有房主能改，立即生效且不重設準備；牌局中也能改', async () => {
    const host = await client('X1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0 } });
    const room = await host.waitFor(() => host.room);
    const b = await client('X2');
    b.send({ t: 'joinRoom', roomId: room.id });
    await host.waitFor(() => host.room?.players[1].nickname);
    b.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[1].ready);
    b.send({ t: 'setAILevel', level: 'hard' });
    await b.waitFor(() => b.errors.some((e) => e.includes('房主')));
    host.send({ t: 'setAILevel', level: 'beginner' });
    await host.waitFor(() => host.room?.settings.aiLevel === 'beginner');
    expect(host.room!.players[1].ready).toBe(true);
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
    host.send({ t: 'setAILevel', level: 'hard' });
    await b.waitFor(() => b.room?.settings.aiLevel === 'hard');
  });

  it('局結束：沒和牌也沒聽牌的手牌不公開（AI 也是），可以自己展示', async () => {
    const host = await duoRoom('Y1', { turnSeconds: 0, claimSeconds: 0, passThree: false });
    host.send({ t: 'setAuto', on: true, win: false });
    host.send({ t: 'start' });
    const g = await host.waitFor(() => (answerAutoStop(host), host.game?.phase === 'result' && host.game), 20000);
    expect(g.solo).toBe(false);
    const r = g.result!;
    const visible = (s: number) => s === 0 || r.winners.some((w) => w.seat === s) || r.tenpai.some((t) => t.seat === s);
    expect(r.hands[1].length > 0).toBe(visible(1));
    expect(r.hands[2].length > 0).toBe(visible(2));
    expect(r.hands[0].length).toBeGreaterThan(0);
    host.send({ t: 'showHand' });
    await host.waitFor(() => host.game?.result?.shown.includes(0));
  });

  it('回歸：網頁與伺服器協定版本不同時拒絕連線並提示重新整理', async () => {
    const c = new Client(server.port, await newKey());
    clients.push(c);
    await c.connect({ protocol: PROTOCOL_VERSION - 1 });
    const kicked = await c.waitFor(() => c.messages.find((m) => m.t === 'kicked'));
    expect(kicked).toMatchObject({ reason: expect.stringContaining('重新整理') });
    await c.waitFor(() => c.closed);
    expect(c.userId).toBe('');
  });

  it('回歸：換三張有交換時，亮牌階段送出換出與收到的牌，結束後仍保留', async () => {
    const host = await client('Z1');
    host.send({ t: 'createRoom', settings: { playerCount: 4, turnSeconds: 0, claimSeconds: 0, aiLevel: 'normal' } });
    await host.waitFor(() => host.room);
    for (let i = 0; i < 3; i++) host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players.every((p) => p.nickname));
    host.send({ t: 'start' });
    const g = await host.waitFor(() => host.game?.pending?.kind === 'passThree' && host.game);
    const chosen = g.myHand.slice(0, 3);
    host.send({ t: 'action', handNo: g.handNo, action: { type: 'passThree', tiles: chosen } });
    // 普通 AI 一定會換，所以一定有交換
    const reveal = await host.waitFor(() => host.game?.phase === 'passReveal' && host.game);
    expect(reveal.passSent).toEqual([...chosen].sort((a, b) => a - b));
    expect(reveal.passReceived).toHaveLength(3);
    expect(reveal.myHand).toHaveLength(10);
    expect(reveal.deadline).toBeGreaterThan(0);
    const after = await host.waitFor(() => host.game?.phase !== 'passReveal' && host.game?.phase !== 'passThree' && host.game);
    expect(after.passSent).toEqual(reveal.passSent);
    expect(after.passReceived!.every((t) => after.myHand.includes(t) || host.room!.players[0].discards.some((d) => d.tile === t))).toBe(true);
  });

  it('回歸：剛打出的牌會出現在 recentDiscard', async () => {
    const host = await client('Z2');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0, passThree: false } });
    await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'start' });
    const g = await waitMyTurn(host);
    const tile = g.myDrawn ?? g.myHand[0];
    host.send({ t: 'action', handNo: g.handNo, action: { type: 'discard', tile } });
    // AI 沒有延遲時，下一個狀態可能和這個狀態在同一批訊息裡到達，所以檢查收過的所有狀態，而不只是最新的
    await host.waitFor(() => host.messages.some((m) => m.t === 'state' && m.game?.recentDiscard?.seat === 0 && m.game.recentDiscard.tile === tile));
  });

  it('只剩 AI（其他真人交給 AI 代打後，最後一位真人也離開）時結束牌局', async () => {
    const host = await client('AA1');
    host.send({ t: 'createRoom', settings: { playerCount: 3, turnSeconds: 0, claimSeconds: 0 } });
    const room = await host.waitFor(() => host.room);
    const keyB = await newKey();
    const b = await client('AA2', keyB);
    b.send({ t: 'joinRoom', roomId: room.id });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'addAI' });
    b.send({ t: 'ready', ready: true });
    await host.waitFor(() => host.room?.players[2].nickname && host.room.players[1].ready);
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
    b.close();
    await host.waitFor(() => host.room?.paused);
    host.send({ t: 'decide', choice: 'ai' });
    await host.waitFor(() => host.room?.players[1].aiControlled);
    // 最後一位真人離開：只剩 AI 與 AI 代打，牌局結束（解散）
    host.send({ t: 'leaveRoom' });
    await host.waitFor(() => host.room === null);
    const b2 = await client(undefined, keyB);
    const r = await b2.waitFor(() => b2.room);
    expect(r.status).toBe('finished');
    expect(r.dissolved).toBe(true);
  });

  it('只有一位真人斷線（沒交給 AI）時是暫停，不會結束牌局', async () => {
    const keyA = await newKey();
    const host = await client('AB1', keyA);
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0 } });
    await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'start' });
    await host.waitFor(() => host.room?.status === 'playing');
    host.close();
    const back = await client(undefined, keyA);
    const r = await back.waitFor(() => back.room);
    expect(r.status).toBe('playing');
    expect(r.dissolved).toBe(false);
  });

  it('自動摸打與自動和牌都只維持一局（下一局自動關閉）；不鳴牌一直有效', async () => {
    const host = await client('AC1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0, passThree: false } });
    await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'setAuto', on: true, win: true, noCall: true });
    host.send({ t: 'start' });
    await host.waitFor(() => host.game?.auto.on && host.game.auto.win && host.game.auto.noCall && host.game);
    await host.waitFor(() => (answerAutoStop(host), host.game?.phase === 'result'), 20000);
    host.send({ t: 'nextHand' });
    const g2 = await host.waitFor(() => host.game?.handNo === 2 && host.game);
    expect(g2.auto.on).toBe(false);
    expect(g2.auto.win).toBe(false);
    expect(g2.auto.noCall).toBe(true);
  });

  it('長考：自己的回合延長 60 秒，每局只能一次', async () => {
    const host = await duoRoom('AD1', { turnSeconds: 20, claimSeconds: 10, passThree: false });
    host.send({ t: 'start' });
    const g = await waitMyTurn(host);
    expect(g.thinkAvailable).toBe(true);
    const before = g.deadline!;
    host.send({ t: 'think' });
    const after = await host.waitFor(() => ((host.game?.deadline ?? 0) > before + 50_000 ? host.game : null));
    expect(after.thinkAvailable).toBe(false);
    host.send({ t: 'think' });
    await host.waitFor(() => host.errors.some((e) => e.includes('長考過')));
  });

  it('大廳房間列表：等待中有空位的可以加入；坐滿後仍可觀戰，不允許觀戰就不列出', async () => {
    const host = await client('AE1');
    host.send({ t: 'createRoom', settings: { playerCount: 2 } });
    const room = await host.waitFor(() => host.room);
    const viewer = await client('AE2');
    viewer.send({ t: 'listRooms' });
    const list = await viewer.waitFor(() => viewer.messages.find((m) => m.t === 'roomList'));
    expect(list).toMatchObject({ rooms: expect.arrayContaining([expect.objectContaining({ id: room.id, hostName: 'AE1', seated: 1, playerCount: 2 })]) });
    expect(list).toMatchObject({ rooms: expect.arrayContaining([expect.objectContaining({ id: room.id, joinable: true, spectatable: true })]) });
    // 坐滿之後不能加入，但還能觀戰
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    const listOf = async () => {
      viewer.messages.length = 0;
      viewer.send({ t: 'listRooms' });
      const m = await viewer.waitFor(() => viewer.messages.find((x) => x.t === 'roomList'));
      return m.t === 'roomList' ? m.rooms.find((r) => r.id === room.id) : undefined;
    };
    expect(await listOf()).toMatchObject({ joinable: false, spectatable: true });
    // 不允許觀戰：坐滿就不列出
    host.send({ t: 'updateSettings', settings: { allowSpectators: false } });
    await host.waitFor(() => host.room?.settings.allowSpectators === false);
    expect(await listOf()).toBeUndefined();
  });

  it('逾時自動摸切', async () => {
    const host = await duoRoom('T1', { turnSeconds: 1, claimSeconds: 1 });
    host.send({ t: 'start' });
    await host.waitFor(() => host.game?.pending?.kind === 'turn' || host.game?.pending?.kind === 'passThree', 5000);
    const discards = () => host.room!.players[0].discards.length;
    await host.waitFor(() => discards() >= 1, 8000);
  });

  it('不合法的行動被拒絕', async () => {
    const host = await client('U1');
    host.send({ t: 'createRoom', settings: { playerCount: 2, turnSeconds: 0, claimSeconds: 0, passThree: false } });
    await host.waitFor(() => host.room);
    host.send({ t: 'addAI' });
    await host.waitFor(() => host.room?.players[1].nickname);
    host.send({ t: 'start' });
    const g = await waitMyTurn(host);
    host.send({ t: 'action', handNo: g.handNo, action: { type: 'discard', tile: 9999 } });
    await host.waitFor(() => host.errors.length);
    expect(host.errors[0]).toContain('手中沒有');
    host.send({ t: 'action', handNo: g.handNo + 5, action: { type: 'discard', tile: g.myHand[0] } });
    await host.waitFor(() => host.errors.length > 1);
    expect(host.errors[1]).toContain('局數');
  });
});
