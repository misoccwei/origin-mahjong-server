import { describe, expect, it } from 'vitest';
import { baseScoreFor, defaultSettings, meldTileOrder, sanitizeSettings, type Meld } from '../../src/shared/rules.js';

describe('規則設定', () => {
  it('底分依規則預設，可在讓分中逐人設定', () => {
    const d = defaultSettings(4);
    expect(d.advanced).toBe(true);
    expect(baseScoreFor(d, 0)).toBe(0);
    expect(baseScoreFor({ ...d, advanced: false }, 0)).toBe(20);
    const s = sanitizeSettings({ handicaps: { 1: { baseScore: 50 } } }, d);
    expect(baseScoreFor(s, 0)).toBe(0);
    expect(baseScoreFor(s, 1)).toBe(50);
  });

  it('和牌最低分數預設 20，超出範圍時保留原值', () => {
    const d = defaultSettings(4);
    expect(d.minWinScore).toBe(20);
    expect(sanitizeSettings({ minWinScore: 40 }, d).minWinScore).toBe(40);
    expect(sanitizeSettings({ minWinScore: 999 }, d).minWinScore).toBe(20);
  });

  it('新設定的預設值：結算倒數 20 秒、隨機座位開啟；超出範圍或格式錯誤時保留原值', () => {
    const d = defaultSettings(4);
    expect(d.resultSeconds).toBe(20);
    expect(d.randomSeats).toBe(true);
    expect(sanitizeSettings({ resultSeconds: 0, randomSeats: false }, d)).toMatchObject({ resultSeconds: 0, randomSeats: false });
    expect(sanitizeSettings({ resultSeconds: 9999 }, d).resultSeconds).toBe(20);
    expect(sanitizeSettings({ resultSeconds: 'abc' as unknown as number }, d).resultSeconds).toBe(20);
  });

  it('改人數時讓分清空、圈數回到該人數的預設', () => {
    const d = sanitizeSettings({ handicaps: { 3: { baseScore: 30 } } }, defaultSettings(4));
    const two = sanitizeSettings({ playerCount: 2 }, d);
    expect(two.playerCount).toBe(2);
    expect(two.rounds).toBe(2);
    expect(two.handicaps).toEqual({});
  });
});

describe('鳴牌的排列', () => {
  // 座位 1 碰了 5 萬（4 張中的 16），其餘兩張是 17、18
  const pon = (from: number): Meld => ({ type: 'pon', tiles: [16, 17, 18], calledTile: 16, from });

  it('被鳴的牌放在來源方向：下家（左）最左、對家中間、上家（右）最右', () => {
    expect(meldTileOrder(pon(2), 1, 4)).toEqual([16, 17, 18]);
    expect(meldTileOrder(pon(3), 1, 4)).toEqual([17, 16, 18]);
    expect(meldTileOrder(pon(0), 1, 4)).toEqual([17, 18, 16]);
  });

  it('三人時只有左右，兩人時對家放中間；明槓同樣依方向', () => {
    expect(meldTileOrder(pon(2), 1, 3)).toEqual([16, 17, 18]);
    expect(meldTileOrder(pon(0), 1, 3)).toEqual([17, 18, 16]);
    expect(meldTileOrder(pon(0), 1, 2)).toEqual([17, 16, 18]);
    const kan: Meld = { type: 'minkan', tiles: [16, 17, 18, 19], calledTile: 18, from: 0 };
    expect(meldTileOrder(kan, 1, 4)).toEqual([16, 17, 19, 18]);
  });

  it('暗槓不變', () => {
    const ankan: Meld = { type: 'ankan', tiles: [16, 17, 18, 19] };
    expect(meldTileOrder(ankan, 1, 4)).toEqual([16, 17, 18, 19]);
  });
});
