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
  const playFirstHand = (resultSeconds: number) => {
    const room = makeRoom({ resultSeconds, randomSeats: false, passThree: false, turnSeconds: 0, claimSeconds: 0 }, { aiDelayMs: 0, passRevealMs: 0, rng: seededRng(7) });
    room.join('me', '我');
    for (let i = 0; i < 3; i++) room.addAI('me');
    room.start('me');
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

  it('依房間設定的秒數倒數，時間到自動進入下一局', () => {
    const room = playFirstHand(20);
    vi.advanceTimersByTime(19_000);
    expect(room.match!.handIndex).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(room.match!.handIndex).toBe(1);
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
