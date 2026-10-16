import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomDeps } from '../../src/server/room.js';
import { defaultSettings, type RuleSettings } from '../../src/shared/rules.js';
import { seededRng } from '../support/hand.js';

// Room 的單元測試：直接操作房間與假時鐘，不經過 WebSocket，可以精確控制時間與亂數。
// 連線、協定與多人互動的整合測試在 server.test.ts。

const rooms: Room[] = [];
afterEach(() => {
  rooms.splice(0).forEach((r) => r.destroy());
  vi.useRealTimers();
});

function makeRoom(settings: Partial<RuleSettings>, deps: Partial<RoomDeps> = {}) {
  const room = new Room('0001', { ...defaultSettings(4), ...settings }, {
    isOnline: () => true,
    notify: () => {},
    onUserRemoved: () => {},
    onDestroy: () => {},
    aiDelayMs: 60_000,
    passRevealMs: 60_000,
    waitingOfflineMs: 60_000,
    ...deps,
  });
  rooms.push(room);
  return room;
}

describe('隨機座位', () => {
  const setup = (randomSeats: boolean) => {
    // 洗牌時一律取 0：Fisher-Yates 的結果為 [1, 2, 3, 0]
    const room = makeRoom({ randomSeats, handicaps: { 0: { baseScore: 30 } } }, { rng: () => 0 });
    room.join('host', '房主');
    room.join('guest', '玩家');
    room.addAI('host');
    room.addAI('host');
    room.setReady('guest', true);
    return room;
  };

  it('開始時打亂座位，房主與讓分跟著人走', () => {
    const room = setup(true);
    expect(room.start('host')).toEqual({ ok: true });
    expect(room.seats.map((s) => s?.nickname)).toEqual(['玩家', '電腦 1', '電腦 2', '房主']);
    expect(room.hostSeat).toBe(3);
    expect(room.settings.handicaps).toEqual({ 3: { baseScore: 30 } });
  });

  it('關閉時座位不變', () => {
    const room = setup(false);
    room.start('host');
    expect(room.seats.map((s) => s?.nickname)).toEqual(['房主', '玩家', '電腦 1', '電腦 2']);
    expect(room.hostSeat).toBe(0);
  });
});

describe('結算倒數', () => {
  beforeEach(() => vi.useFakeTimers());

  /** 1 位真人（開自動摸打）＋ 3 個 AI，跑到第一局結束 */
  const playFirstHand = (resultSeconds: number, twoHumans = false) => {
    const room = makeRoom({ resultSeconds, randomSeats: false, passThree: false, turnSeconds: 0, claimSeconds: 0 }, { aiDelayMs: 0, passRevealMs: 0, rng: seededRng(7) });
    room.join('me', '我');
    if (twoHumans) room.join('guest', '玩家'), room.setReady('guest', true);
    while (room.seats.some((s) => !s)) room.addAI('me');
    room.start('me');
    room.setAuto('guest', true, true);
    for (let i = 0; i < 5000 && room.match!.hand?.phase !== 'ended'; i++) {
      // 自動摸打只維持一局，而且遇到能槓、沒達最高分的和牌會停下來問：這裡每一步都重新打開，能和就和、能槓時直接摸切
      room.setAuto('me', true, true);
      const hand = room.match!.hand!;
      const p = hand.pending.get(0);
      if (p?.tsumo) room.action('me', 1, { type: 'tsumo' });
      else if (p?.ron) room.action('me', 1, { type: 'ron' });
      else if (p?.kind === 'turn' && (p.ankan?.length || p.kakan?.length)) room.action('me', 1, { type: 'discard', tile: hand.drawn ?? hand.hands[0][0] });
      else if (p?.kind === 'claim' && p.minkan && !p.ron) room.action('me', 1, { type: 'pass' });
      vi.advanceTimersByTime(1);
    }
    expect(room.match!.hand!.phase).toBe('ended');
    return room;
  };

  it('依房間設定的秒數倒數，時間到自動進入下一局（兩位以上真人）', () => {
    const room = playFirstHand(20, true);
    vi.advanceTimersByTime(19_000);
    expect(room.match!.handIndex).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(room.match!.handIndex).toBe(1);
  });

  it('單人對 AI 時結算不倒數，等玩家按「下一局」', () => {
    const room = playFirstHand(20);
    expect(room.gameView('me')!.deadline).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(room.match!.handIndex).toBe(0);
  });

  it('設為 0 時不倒數，等所有真人按「下一局」', () => {
    const room = playFirstHand(0);
    expect(room.gameView('me')!.deadline).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(room.match!.handIndex).toBe(0);
    room.nextHand('me');
    vi.advanceTimersByTime(1);
    expect(room.match!.handIndex).toBe(1);
  });
});

describe('單人對 AI', () => {
  beforeEach(() => vi.useFakeTimers());

  /** humans 位真人（me、guest…）＋其餘 AI，開始牌局 */
  const setup = (humans = 1) => {
    const room = makeRoom({ randomSeats: false, passThree: false, turnSeconds: 20, claimSeconds: 10 }, { aiDelayMs: 1000, rng: seededRng(3) });
    room.join('me', '我');
    if (humans > 1) room.join('guest', '玩家'), room.setReady('guest', true);
    while (room.seats.some((s) => !s)) room.addAI('me');
    expect(room.start('me')).toEqual({ ok: true });
    return room;
  };

  it('操作不限時（也不能長考）；有兩個真人時照常限時', () => {
    const solo = setup();
    expect(solo.isSolo()).toBe(true);
    const g = solo.gameView('me')!;
    expect(g.solo).toBe(true);
    expect(g.deadline).toBeNull();
    expect(g.thinkAvailable).toBe(false);
    const duo = setup(2);
    expect(duo.isSolo()).toBe(false);
    expect(duo.gameView('me')!.deadline).not.toBeNull();
    expect(duo.finishHandByAI('me')).toEqual({ ok: false, error: '只有一個人對電腦時才能交給 AI 打完' });
  });

  it('交給 AI 快速打完這一局：自己不能再操作，局結束公開 AI 的手牌，下一局恢復', () => {
    const room = setup();
    expect(room.finishHandByAI('me')).toEqual({ ok: true });
    const g = room.gameView('me')!;
    expect(g.fastFinish).toBe(true);
    expect(g.pending).toBeNull();
    expect(room.action('me', 1, { type: 'pass' })).toEqual({ ok: false, error: '這一局已經交給 AI 打完' });
    // 每一步只等 20 毫秒（AI 平常要 1 秒）
    for (let i = 0; i < 1000 && room.match!.hand!.phase !== 'ended'; i++) vi.advanceTimersByTime(20);
    expect(room.match!.hand!.phase).toBe('ended');
    const r = room.gameView('me')!.result!;
    for (const s of [1, 2, 3]) expect(r.hands[s].length).toBeGreaterThan(0);
    room.nextHand('me');
    vi.advanceTimersByTime(1);
    const g2 = room.gameView('me')!;
    expect(g2.handNo).toBe(2);
    expect(g2.fastFinish).toBe(false);
  });
});

describe('回放檔', () => {
  beforeEach(() => vi.useFakeTimers());

  it('牌局結束後才能取得；含每一局的紀錄與暱稱，不含使用者代碼', () => {
    const room = makeRoom({ ...defaultSettings(2), rounds: 1, randomSeats: false, passThree: false }, { aiDelayMs: 10, rng: seededRng(4) });
    room.join('me', '我');
    room.addAI('me');
    room.start('me');
    expect(room.replayFile('me')).toEqual({ ok: false, error: '牌局結束後才能儲存回放' });
    for (let i = 0; i < 10 && room.status === 'playing'; i++) {
      // 每一局都交給 AI 快速打完，結算時按下一局
      room.finishHandByAI('me');
      vi.advanceTimersByTime(60_000);
      room.nextHand('me');
      vi.advanceTimersByTime(1);
    }
    expect(room.status).toBe('finished');
    const r = room.replayFile('me');
    if (!r.ok) throw new Error(r.error);
    expect(r.replay.hands.map((h) => h.handNo)).toEqual([1, 2]);
    expect(r.replay.players).toEqual([
      { seat: 0, name: '我', isAI: false },
      { seat: 1, name: '電腦 1', isAI: true },
    ]);
    expect(r.replay.finalScores).toEqual(room.match!.scores);
    expect(JSON.stringify(r.replay)).not.toContain('"me"');
    expect(room.replayFile('stranger')).toEqual({ ok: false, error: '不在房間中' });
  });
});
