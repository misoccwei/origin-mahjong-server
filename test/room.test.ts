import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/rules.js';
import { Room } from '../src/server/room.js';

const rooms: Room[] = [];
afterEach(() => rooms.splice(0).forEach((r) => r.destroy()));

function makeRoom(randomSeats: boolean) {
  const settings = { ...defaultSettings(4), randomSeats, handicaps: { 0: { baseScore: 30 } } };
  const room = new Room('0001', settings, {
    isOnline: () => true,
    notify: () => {},
    onUserRemoved: () => {},
    onDestroy: () => {},
    aiDelayMs: 60_000,
    passRevealMs: 60_000,
    waitingOfflineMs: 60_000,
    // 洗牌時一律取 0：Fisher-Yates 的結果為 [1, 2, 3, 0]
    rng: () => 0,
  });
  rooms.push(room);
  room.join('host', '房主');
  room.join('guest', '玩家');
  room.addAI('host');
  room.addAI('host');
  room.setReady('guest', true);
  return room;
}

describe('隨機座位', () => {
  it('開始時打亂座位，房主與讓分跟著人走', () => {
    const room = makeRoom(true);
    expect(room.start('host')).toEqual({ ok: true });
    expect(room.seats.map((s) => s?.nickname)).toEqual(['玩家', '電腦 1', '電腦 2', '房主']);
    expect(room.hostSeat).toBe(3);
    expect(room.settings.handicaps).toEqual({ 3: { baseScore: 30 } });
  });

  it('關閉時座位不變', () => {
    const room = makeRoom(false);
    room.start('host');
    expect(room.seats.map((s) => s?.nickname)).toEqual(['房主', '玩家', '電腦 1', '電腦 2']);
    expect(room.hostSeat).toBe(0);
  });
});
