import { describe, expect, it } from 'vitest';
import { evaluateWin, bestTenpaiScore, waitingKinds } from '../src/shared/scoring.js';
import { settle } from '../src/shared/settlement.js';
import { baseScoreFor, defaultSettings, sanitizeSettings, type Meld } from '../src/shared/rules.js';
import { WEST, EAST } from '../src/shared/tiles.js';
import { meld, uni } from './helpers.js';

interface Case {
  hand: string;
  melds?: Meld[];
  win: string;
  tsumo?: boolean;
  advanced?: boolean;
  seatWind?: number;
}

function score(c: Case) {
  const winTile = uni(c.win)[0];
  return evaluateWin({
    concealed: [...uni(c.hand), winTile],
    melds: c.melds ?? [],
    winTile,
    tsumo: !!c.tsumo,
    seatWind: c.seatWind ?? EAST,
    advanced: !!c.advanced,
    baseScore: c.advanced ? 0 : 20,
  });
}

const names = (c: Case) => score(c)!.yaku.map((y) => y.name);

// 規則書牌型表中的每個牌例：確認牌型成立
const tableExamples: [string, Case][] = [
  ['不求人', { hand: '🀋🀌🀍🀛🀛🀛🀞🀠🀓🀔🀕🀀🀀', win: '🀟' }],
  ['全求人', { hand: '🀀', melds: [meld('🀉🀊🀋'), meld('🀛🀛🀛'), meld('🀞🀟🀠'), meld('🀓🀔🀕')], win: '🀀' }],
  ['斷么九', { hand: '🀞🀠🀔🀔🀕🀕🀕', melds: [meld('🀋🀌🀍'), meld('🀚🀛🀜')], win: '🀟' }],
  ['全帶么九', { hand: '🀇🀈🀉🀟🀠🀀🀀', melds: [meld('🀐🀑🀒'), meld('🀘🀘🀘')], win: '🀡' }],
  ['二對清么', { hand: '🀉🀉🀉🀔🀔🀟🀠', melds: [meld('🀐🀑🀒'), meld('🀘🀘🀘')], win: '🀞' }],
  ['三對清么', { hand: '🀘🀘🀀🀀', melds: [meld('🀑🀒🀓'), meld('🀡🀡🀡'), meld('🀂🀂🀂')], win: '🀘' }],
  ['四對清么', { hand: '🀈🀉🀊🀙🀙🀘🀘', melds: [meld('🀒🀓🀔'), meld('🀡🀡🀡')], win: '🀘' }],
  ['五對清么', { hand: '🀘🀘🀀🀀', melds: [meld('🀐🀐🀐'), meld('🀡🀡🀡🀡'), meld('🀒🀓🀔')], win: '🀘' }],
  ['六對清么', { hand: '🀉🀉🀙🀙🀙🀘🀘', melds: [meld('🀐🀐🀐'), meld('🀡🀡🀡')], win: '🀘' }],
  ['七對清么', { hand: '🀇🀇🀙🀚🀛🀘🀘', melds: [meld('🀐🀐🀐🀐'), meld('🀡🀡🀡🀡')], win: '🀘' }],
  ['五門齊', { hand: '🀋🀌🀍🀞🀠🀆🀆', melds: [meld('🀓🀔🀕'), meld('🀀🀀🀀')], win: '🀟' }],
  ['缺一色', { hand: '🀈🀉🀊🀋🀌🀑🀑', melds: [meld('🀎🀎🀎'), meld('🀘🀘🀘')], win: '🀊' }],
  ['混一色', { hand: '🀈🀉🀊🀋🀌🀀🀀', melds: [meld('🀎🀎🀎'), meld('🀂🀂🀂')], win: '🀊' }],
  ['清一色', { hand: '🀚🀛🀜🀝🀞🀟🀠🀡🀡🀡', melds: [meld('🀜🀝🀞')], win: '🀝' }],
  ['字一色', { hand: '🀀🀀🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀅🀅🀅'), meld('🀆🀆🀆')], win: '🀂' }],
  ['平和', { hand: '🀞🀠🀓🀔🀕🀀🀀', melds: [meld('🀋🀌🀍'), meld('🀙🀚🀛')], win: '🀟' }],
  ['碰碰和', { hand: '🀠🀠🀘🀘', melds: [meld('🀋🀋🀋'), meld('🀙🀙🀙'), meld('🀀🀀🀀')], win: '🀠' }],
  ['一暗刻', { hand: '🀉🀊🀋🀠🀠🀑🀒🀓🀘🀘', melds: [meld('🀀🀀🀀')], win: '🀠', tsumo: true }],
  ['二暗刻', { hand: '🀉🀉🀉🀠🀠🀑🀒🀓🀘🀘', melds: [meld('🀀🀀🀀')], win: '🀠', tsumo: true }],
  ['三暗刻', { hand: '🀉🀉🀉🀌🀌🀌🀠🀠🀘🀘', melds: [meld('🀑🀒🀓')], win: '🀠', tsumo: true }],
  ['四暗刻', { hand: '🀉🀉🀉🀌🀌🀌🀠🀠🀘🀘🀀🀀🀀', win: '🀠', tsumo: true }],
  ['一槓子', { hand: '🀉🀊🀋🀠🀠🀘🀘', melds: [meld('🀙🀙🀙'), meld('🀀🀀🀀🀀')], win: '🀠' }],
  ['二槓子', { hand: '🀉🀊🀋🀠🀠🀘🀘', melds: [meld('🀙🀙🀙🀙'), meld('🀀🀀🀀🀀')], win: '🀠' }],
  ['三槓子', { hand: '🀉🀊🀋🀠', melds: [meld('🀋🀋🀋🀋'), meld('🀙🀙🀙🀙'), meld('🀀🀀🀀🀀')], win: '🀠' }],
  ['四槓子', { hand: '🀠', melds: [meld('🀉🀉🀉🀉'), meld('🀋🀋🀋🀋'), meld('🀙🀙🀙🀙'), meld('🀀🀀🀀🀀')], win: '🀠' }],
  ['番牌', { hand: '🀛🀛🀓🀔🀕🀆🀆', melds: [meld('🀋🀌🀍'), meld('🀞🀟🀠')], win: '🀆' }],
  ['小三元', { hand: '🀞🀟🀠🀓🀔🀕🀆🀅🀅🀅', melds: [meld('🀄🀄🀄')], win: '🀆' }],
  ['大三元', { hand: '🀞🀟🀠🀍🀍🀆🀆🀅🀅🀅', melds: [meld('🀄🀄🀄')], win: '🀆' }],
  ['小三風', { hand: '🀌🀍🀎🀁🀁🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀞🀟🀠')], win: '🀂' }],
  ['大三風', { hand: '🀗🀗🀁🀁🀂🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀞🀟🀠')], win: '🀁' }],
  ['小四喜', { hand: '🀌🀍🀎🀁🀁🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀀🀀🀀')], win: '🀂' }],
  ['大四喜', { hand: '🀗🀗🀁🀁🀂🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀀🀀🀀')], win: '🀁' }],
  // 進階牌型
  ['五數鄰', { hand: '🀚🀚🀚🀑🀒🀓🀔', melds: [meld('🀇🀈🀉'), meld('🀙🀙🀙')], win: '🀔', advanced: true }],
  ['四數鄰', { hand: '🀚🀚🀚🀑🀒🀓🀓', melds: [meld('🀇🀈🀉'), meld('🀙🀙🀙')], win: '🀓', advanced: true }],
  ['三數鄰', { hand: '🀍🀎🀏🀟🀠🀡🀡', melds: [meld('🀗🀗🀗'), meld('🀘🀘🀘')], win: '🀡', advanced: true }],
  ['二數鄰', { hand: '🀋🀋🀞🀞', melds: [meld('🀌🀌🀌'), meld('🀝🀝🀝'), meld('🀕🀕🀕')], win: '🀋', advanced: true }],
  ['一氣通貫', { hand: '🀊🀋🀌🀍🀎🀀🀀', melds: [meld('🀇🀈🀉'), meld('🀚🀚🀚')], win: '🀏', advanced: true }],
  ['三連刻', { hand: '🀑🀑🀀🀀', melds: [meld('🀐🀐🀐'), meld('🀒🀒🀒'), meld('🀙🀚🀛')], win: '🀑', advanced: true }],
  ['四連刻', { hand: '🀑🀑🀀🀀', melds: [meld('🀐🀐🀐'), meld('🀒🀒🀒'), meld('🀓🀓🀓')], win: '🀑', advanced: true }],
  ['九蓮寶燈', { hand: '🀙🀙🀙🀚🀛🀜🀜🀝🀟🀠🀡🀡🀡', win: '🀞', advanced: true }],
  ['三色通貫', { hand: '🀇🀈🀉🀟🀡🀓🀔🀕🀀🀀', melds: [meld('🀙🀙🀙')], win: '🀠', advanced: true }],
  ['三色同順', { hand: '🀛🀜🀒🀓🀔🀀🀀', melds: [meld('🀉🀊🀋'), meld('🀙🀙🀙')], win: '🀝', advanced: true }],
  ['三色連刻', { hand: '🀌🀌🀌🀟🀟🀗🀗🀗🀀🀀', melds: [meld('🀌🀍🀎')], win: '🀟', advanced: true }],
  ['三色同刻', { hand: '🀉🀊🀋🀠🀠🀀🀀', melds: [meld('🀎🀎🀎'), meld('🀗🀗🀗')], win: '🀠', advanced: true }],
  ['一般高', { hand: '🀉🀊🀟🀟🀟🀓🀔🀕🀀🀀', melds: [meld('🀉🀊🀋')], win: '🀋', advanced: true }],
  ['二般高', { hand: '🀉🀊🀟🀟🀠🀠🀡🀡🀀🀀', melds: [meld('🀉🀊🀋')], win: '🀋', advanced: true }],
  ['三同順', { hand: '🀉🀉🀓🀓🀔🀔🀕🀕🀀🀀', melds: [meld('🀓🀔🀕')], win: '🀉', advanced: true }],
  ['四同順', { hand: '🀉🀉🀓🀓🀔🀕🀕', melds: [meld('🀓🀔🀕'), meld('🀓🀔🀕')], win: '🀔', advanced: true }],
  ['七對子', { hand: '🀉🀉🀋🀋🀌🀌🀟🀘🀘🀘🀘🀀🀀', win: '🀟', advanced: true }],
  ['十三么九', { hand: '🀇🀏🀙🀡🀡🀐🀘🀀🀁🀂🀃🀅🀆', win: '🀄', advanced: true }],
];

describe('牌型表牌例', () => {
  for (const [name, c] of tableExamples) {
    it(name, () => {
      const s = score(c);
      expect(s, `${name} 應為和牌形`).not.toBeNull();
      expect(names(c)).toContain(name);
    });
  }
});

describe('分數計算', () => {
  it('小三元實質 60 分（含兩組番牌）', () => {
    const s = score({ hand: '🀞🀟🀠🀓🀔🀕🀆🀅🀅🀅', melds: [meld('🀄🀄🀄')], win: '🀆', advanced: true })!;
    const fan = s.yaku.find((y) => y.name === '番牌')!;
    expect(fan.count).toBe(2);
    expect(s.yaku.find((y) => y.name === '小三元')!.points + fan.points).toBe(60);
  });

  it('二般高實質 85 分（必加計平和）', () => {
    const s = score({ hand: '🀉🀊🀟🀟🀠🀠🀡🀡🀀🀀', melds: [meld('🀉🀊🀋')], win: '🀋', advanced: true })!;
    expect(s.yaku.map((y) => y.name)).toEqual(expect.arrayContaining(['二般高', '平和']));
    expect(s.yaku.find((y) => y.name === '二般高')!.points + s.yaku.find((y) => y.name === '平和')!.points).toBe(85);
  });

  it('七對子實質 45 分（必加計不求人）', () => {
    const s = score({ hand: '🀉🀉🀋🀋🀌🀌🀟🀘🀘🀘🀘🀀🀀', win: '🀟', advanced: true })!;
    expect(s.form).toBe('sevenPairs');
    expect(s.yaku.find((y) => y.name === '七對子')!.points + s.yaku.find((y) => y.name === '不求人')!.points).toBe(45);
  });

  it('五門齊 20 分', () => {
    const s = score({ hand: '🀋🀌🀍🀞🀠🀆🀆', melds: [meld('🀓🀔🀕'), meld('🀀🀀🀀')], win: '🀟' })!;
    expect(s.yaku.find((y) => y.name === '五門齊')!.points).toBe(20);
  });

  it('五門齊必須是四面子一雀頭：七對子不計', () => {
    const s = score({ hand: '🀇🀇🀙🀙🀐🀐🀀🀀🀆🀆🀉🀉🀘', win: '🀘', advanced: true })!;
    expect(s.form).toBe('sevenPairs');
    expect(s.yaku.map((y) => y.name)).not.toContain('五門齊');
  });

  it('三暗刻 40 分', () => {
    const s = score({ hand: '🀉🀉🀉🀌🀌🀌🀠🀠🀘🀘', melds: [meld('🀑🀒🀓')], win: '🀠', tsumo: true })!;
    expect(s.yaku.find((y) => y.name === '三暗刻')!.points).toBe(40);
  });

  it('同系列只計最高分：二暗刻不計一暗刻', () => {
    const n = names({ hand: '🀉🀉🀉🀠🀠🀑🀒🀓🀘🀘', melds: [meld('🀀🀀🀀')], win: '🀠', tsumo: true });
    expect(n).toContain('二暗刻');
    expect(n).not.toContain('一暗刻');
  });

  it('銃和完成的刻子作明刻計', () => {
    const n = names({ hand: '🀉🀉🀉🀠🀠🀑🀒🀓🀘🀘', melds: [meld('🀀🀀🀀')], win: '🀠' });
    expect(n).toContain('一暗刻');
    expect(n).not.toContain('二暗刻');
  });

  it('多種拆法取最高分（三暗刻 > 平和）', () => {
    // 規則書例：🀒🀓🀔🀒🀓🀔🀓🀔🀘🀘 + 明順 🀇🀈🀉，自摸 🀒
    const s = score({ hand: '🀒🀓🀔🀒🀓🀔🀓🀔🀘🀘', melds: [meld('🀇🀈🀉')], win: '🀒', tsumo: true })!;
    expect(s.yaku.map((y) => y.name)).toContain('三暗刻');
    expect(s.yaku.map((y) => y.name)).not.toContain('平和');
  });

  it('進階規則：同一手牌取三同順或三連刻的 80 分', () => {
    const s = score({ hand: '🀒🀓🀔🀒🀓🀔🀓🀔🀘🀘', melds: [meld('🀇🀈🀉')], win: '🀒', tsumo: true, advanced: true })!;
    expect(s.yakuPoints).toBeGreaterThanOrEqual(80);
  });

  it('清一色＋一暗刻：基本規則 105 分', () => {
    const s = score({ hand: '🀚🀛🀜🀝🀞🀟🀠🀡🀡🀡', melds: [meld('🀜🀝🀞')], win: '🀝' })!;
    expect(s.yaku.map((y) => y.name)).toEqual(expect.arrayContaining(['清一色', '一暗刻']));
  });

  it('單項滿貫牌型取最高分單項：字一色＋大四喜計 320', () => {
    const s = score({ hand: '🀅🀂🀂🀂', melds: [meld('🀃🀃🀃'), meld('🀀🀀🀀'), meld('🀁🀁🀁')], win: '🀅' })!;
    expect(s.yakuPoints).toBe(320);
    expect(s.yaku.map((y) => y.name)).toEqual(['大四喜']);
    expect(s.total).toBe(340);
  });

  it('累計超過 160 分以 160 分計', () => {
    // 清一色 80 + 三暗刻 40 + 碰碰和 40 + ... 進階
    const s = score({ hand: '🀇🀇🀇🀈🀈🀈🀉🀉🀉🀏🀏🀏🀋', win: '🀋', tsumo: true, advanced: true })!;
    expect(s.yakuPoints).toBe(160);
    expect(s.limit).toBe(true);
  });

  it('非和牌形回傳 null', () => {
    expect(score({ hand: '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀚🀛🀜', win: '🀀' })).toBeNull();
  });

  it('基本規則不承認七對子', () => {
    expect(score({ hand: '🀉🀉🀋🀋🀌🀌🀟🀘🀘🀗🀗🀀🀀', win: '🀟' })).toBeNull();
  });
});

describe('聽牌', () => {
  it('規則書聽牌例', () => {
    const w = (h: string) => waitingKinds(uni(h), [], false).sort((a, b) => a - b);
    expect(w('🀇🀇🀇🀈🀉🀊🀋🀌🀍🀎🀏🀏🀏')).toEqual(uni('🀇🀈🀉🀊🀋🀌🀍🀎🀏'));
  });

  it('自己用盡 4 張的牌不算聽牌', () => {
    // 手中 🀉🀉🀉 + 暗槓 🀉，等 🀉 的單騎
    const melds = [meld('🀉🀉🀉🀉', false)];
    const waits = waitingKinds(uni('🀇🀈🀊🀋🀌🀍🀎🀏🀀🀀'), melds, false);
    expect(waits).not.toContain(uni('🀉')[0]);
  });

  it('聽牌得分：西家大三風例 95 分', () => {
    // 依規則書：自摸西風時 大三風80+番牌10+一暗刻5
    const melds = [meld('🀃🀃🀃'), meld('🀁🀁🀁')];
    const r = bestTenpaiScore(uni('🀔🀔🀙🀚🀛🀂🀂'), melds, WEST, true, 0)!;
    expect(r).not.toBeNull();
    expect(r.score.total).toBe(95);
  });
});

describe('聽牌最高分的和法', () => {
  it('回傳得分最高的那張牌與自摸／銃和（對碰：自摸多一暗刻）', () => {
    // 234m 678m 456s 33p 55p：銃和該刻子為明刻 10 分，自摸 15 分
    const r = bestTenpaiScore(uni('🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝'), [], EAST, true, 0)!;
    expect(r.waits).toEqual(uni('🀛🀝'));
    expect(r.tsumo).toBe(true);
    expect(r.waits).toContain(r.tile);
    expect(r.score.total).toBe(15);
    expect(r.score.yaku.map((y) => y.name)).toContain('一暗刻');
  });
});

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

  it('加分式進階：和牌×2，聽牌得分不超過和牌者的原始和牌分數（不乘 2）', () => {
    const s = { ...defaultSettings(4), advanced: true };
    const r = settle(s, [win(15, 15, 0, false, 1)], [{ seat: 2, maxScore: 95 }, { seat: 3, maxScore: 10 }]);
    expect(r.deltas).toEqual([30, 0, 15, 10]);
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

describe('底分與和牌最低分數設定', () => {
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
});
