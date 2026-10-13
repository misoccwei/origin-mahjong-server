import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/shared/rules.js';
import { settle } from '../../src/shared/settlement.js';

describe('結算', () => {
  const win = (total: number, yakuPoints: number, seat: number, tsumo: boolean, from?: number) => ({
    seat,
    tsumo,
    from,
    score: { form: 'standard' as const, groups: [], yaku: [], yakuPoints, limit: false, baseScore: total - yakuPoints, total },
  });

  it('加分式基本：和牌者得和牌分數', () => {
    const s = { ...defaultSettings(4), advanced: false };
    expect(settle(s, [win(105, 85, 0, false, 1)], []).deltas).toEqual([105, 0, 0, 0]);
  });

  it('加分式進階：和牌×2，聽牌得分不超過和牌者的得分（和牌分數×2）', () => {
    const s = { ...defaultSettings(4), advanced: true };
    const r = settle(s, [win(15, 15, 0, false, 1)], [{ seat: 2, maxScore: 95 }, { seat: 3, maxScore: 20 }]);
    expect(r.deltas).toEqual([30, 0, 30, 20]);
  });

  it('加分式進階：流局時聽牌得分不設限', () => {
    const s = { ...defaultSettings(4), advanced: true };
    expect(settle(s, [], [{ seat: 2, maxScore: 95 }]).deltas).toEqual([0, 0, 95, 0]);
  });

  it('加分式進階：唯一和牌者 0 分時不結算', () => {
    const s = { ...defaultSettings(4), advanced: true };
    expect(settle(s, [win(0, 0, 0, false, 1)], [{ seat: 2, maxScore: 95 }]).deltas).toEqual([0, 0, 0, 0]);
  });

  it('零和式基本：60 分銃和，非放銃者各付 40，放銃者付 100', () => {
    const s = { ...defaultSettings(4), advanced: false, scoring: 'zeroSum' as const };
    expect(settle(s, [win(60, 40, 0, false, 1)], []).deltas).toEqual([180, -100, -40, -40]);
  });

  it('零和式基本：60 分自摸，各付 60', () => {
    const s = { ...defaultSettings(4), advanced: false, scoring: 'zeroSum' as const };
    expect(settle(s, [win(60, 40, 0, true)], []).deltas).toEqual([180, -60, -60, -60]);
  });

  it('零和式進階：15 分銃和各家分付；85 分銃和放銃者包付 215', () => {
    const s = { ...defaultSettings(4), scoring: 'zeroSum' as const, advanced: true };
    expect(settle(s, [win(15, 15, 0, false, 1)], []).deltas).toEqual([45, -15, -15, -15]);
    expect(settle(s, [win(85, 85, 2, false, 1)], []).deltas).toEqual([-20, -215, 255, -20]);
  });

  it('零和式 3 人、2 人', () => {
    const s3 = { ...defaultSettings(3), advanced: false, scoring: 'zeroSum' as const };
    expect(settle(s3, [win(60, 40, 0, false, 1)], []).deltas).toEqual([120, -80, -40]);
    const s2 = { ...defaultSettings(2), advanced: false, scoring: 'zeroSum' as const };
    expect(settle(s2, [win(60, 40, 0, false, 1)], []).deltas).toEqual([60, -60]);
  });
});
