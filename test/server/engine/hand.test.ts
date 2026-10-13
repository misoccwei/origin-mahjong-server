import { describe, expect, it } from 'vitest';
import { Hand } from '../../../src/server/engine/hand.js';
import { defaultSettings } from '../../../src/shared/rules.js';
import { kindOf } from '../../../src/shared/tiles.js';
import { S0, autoplayUntil, buildWall, makeHand, seededRng, tileOf } from '../../support/hand.js';
import { uni } from '../../support/tiles.js';

// 一局的狀態機：用指定的牌山重現各種情境（鳴牌優先順序、搶槓、嶺上、流局、換三張、計分規則等）。

describe('一局（指定牌山）', () => {
  it('碰優先於吃；碰後由碰牌者打牌且不能自摸', () => {
    const h = makeHand([S0, '🀈🀉🀙🀚🀛🀜🀝🀞🀟🀠🀡🀖🀗', '🀇🀇🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀘', '🀊🀋🀌🀍🀎🀏🀙🀚🀛🀜🀝🀞🀟'], '🀇');
    expect(h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀇') })).toBeNull();
    expect(h.pending.get(1)?.chi?.length).toBeGreaterThan(0);
    expect(h.pending.get(2)?.pon).toBe(true);
    expect(h.act(1, { type: 'chi', tiles: h.pending.get(1)!.chi![0] })).toBeNull();
    for (const s of [...h.pending.keys()]) if (s !== 2) h.act(s, { type: 'pass' });
    expect(h.act(2, { type: 'pon' })).toBeNull();
    expect(h.current).toBe(2);
    expect(h.melds[2][0].type).toBe('pon');
    expect(h.melds[1]).toHaveLength(0);
    expect(h.pending.get(2)?.kind).toBe('turn');
    expect(h.pending.get(2)?.tsumo).toBeUndefined();
    expect(h.discards[0][0].called).toBe(true);
  });

  it('多人同時銃和', () => {
    const h = makeHand([S0, '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀚', '🀙🀚🀛🀜🀝🀞🀟🀠🀡🀇🀈🀉🀚', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀚');
    expect(h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀚') })).toBeNull();
    expect(h.pending.get(1)?.ron).toBe(true);
    expect(h.pending.get(2)?.ron).toBe(true);
    h.act(1, { type: 'ron' });
    h.act(2, { type: 'ron' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    expect(h.phase).toBe('ended');
    expect(h.result!.winners.map((w) => w.seat)).toEqual([1, 2]);
    expect(h.result!.deltas[1]).toBeGreaterThan(0);
    expect(h.result!.deltas[2]).toBeGreaterThan(0);
    expect(h.result!.deltas[0]).toBe(0); // 加分式：放銃不扣分
  });

  it('不能用他人捨牌和牌時仍可選擇略過，之後照常進行', () => {
    const h = makeHand([S0, '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀚', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀚🀗');
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀚') });
    h.act(1, { type: 'pass' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    expect(h.current).toBe(1);
    expect(h.phase).toBe('turn');
  });

  it('暗槓後嶺上開花', () => {
    const h = makeHand(['🀀🀀🀀🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀚🀛🀜🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀚🀛🀜🀝', '🀁🀁🀂🀂🀃🀃🀄🀄🀅🀅🀆🀆🀞'], '🀀', {}, '🀙');
    expect(h.pending.get(0)?.ankan).toContain(27);
    h.act(0, { type: 'ankan', kind: 27 });
    expect(h.melds[0][0].type).toBe('ankan');
    expect(h.pending.get(0)?.tsumo).toBe(true);
    h.act(0, { type: 'tsumo' });
    const names = h.result!.winners[0].score.yaku.map((y) => y.name);
    expect(names).toContain('嶺上開花');
    expect(names).toContain('一槓子');
    expect(names).toContain('不求人');
  });

  it('搶槓：他人加槓的牌可宣告和牌，視為加槓者放銃', () => {
    const h = makeHand(
      ['🀊🀀🀁🀂🀃🀄🀅🀐🀒🀔🀖🀘🀏', '🀊🀊🀍🀍🀎🀎🀏🀃🀃🀄🀅🀆🀁', '🀈🀉🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀐🀑🀒🀓'],
      '🀀🀀🀀🀁🀊',
      { scoring: 'zeroSum' },
    );
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀊') });
    expect(h.pending.get(2)?.ron).toBe(true);
    for (const s of [...h.pending.keys()]) h.act(s, s === 1 ? { type: 'pon' } : { type: 'pass' });
    expect(h.melds[1][0].type).toBe('pon');
    h.act(1, { type: 'discard', tile: tileOf(h, 1, '🀁') });
    autoplayUntil(h, () => h.current === 1 && h.phase === 'turn');
    expect(kindOf(h.drawn!)).toBe(3); // 🀊
    expect(h.pending.get(1)?.kakan).toContain(3);
    h.act(1, { type: 'kakan', kind: 3 });
    expect(h.phase).toBe('chankan');
    expect(h.pending.get(2)?.ron).toBe(true);
    h.act(2, { type: 'ron' });
    const w = h.result!.winners[0];
    expect(w.seat).toBe(2);
    expect(w.from).toBe(1);
    expect(w.score.yaku.map((y) => y.name)).toContain('搶槓');
  });

  it('沒人搶槓時完成加槓並補嶺上牌', () => {
    const h = makeHand(
      ['🀊🀀🀁🀂🀃🀄🀅🀐🀒🀔🀖🀘🀏', '🀊🀊🀍🀍🀎🀎🀏🀃🀃🀄🀅🀆🀁', '🀈🀉🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀐🀑🀒🀓'],
      '🀀🀀🀀🀁🀊',
    );
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀊') });
    for (const s of [...h.pending.keys()]) h.act(s, s === 1 ? { type: 'pon' } : { type: 'pass' });
    h.act(1, { type: 'discard', tile: tileOf(h, 1, '🀁') });
    autoplayUntil(h, () => h.current === 1 && h.phase === 'turn');
    const before = h.wallRemaining;
    h.act(1, { type: 'kakan', kind: 3 });
    h.act(2, { type: 'pass' });
    expect(h.melds[1][0].type).toBe('kakan');
    expect(h.melds[1][0].tiles).toHaveLength(4);
    expect(h.wallRemaining).toBe(before - 1);
    expect(h.current).toBe(1);
  });

  it('零和式同巡跟打免責：視為最先打出者放銃', () => {
    const hands = [S0, '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃', '🀙🀚🀛🀜🀝🀞🀟🀠🀡🀇🀈🀉🀚', '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀘'];
    const h = makeHand(hands, '🀖🀗🀕🀚🀚', { scoring: 'zeroSum' });
    // 前三家摸切；座位 3 摸 🀚 打出，座位 2 略過；座位 0 摸 🀚 打出，座位 2 銃和
    autoplayUntil(h, () => h.phase === 'claim' && kindOf(h.lastDiscard!.tile) === 10 && h.lastDiscard!.seat === 3);
    h.act(2, { type: 'pass' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    autoplayUntil(h, () => h.phase === 'claim' && h.lastDiscard!.seat === 0 && kindOf(h.lastDiscard!.tile) === 10);
    h.act(2, { type: 'ron' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    const w = h.result!.winners[0];
    expect(w.seat).toBe(2);
    expect(w.from).toBe(3);
    expect(h.result!.deltas.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('零和式同巡跟打免責：最先打出者為和牌者本人時以自摸計', () => {
    const hands = [S0, '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃', '🀙🀚🀛🀜🀝🀞🀟🀠🀡🀇🀈🀉🀚', '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀘'];
    const h = makeHand(hands, '🀖🀗🀚🀚', { scoring: 'zeroSum' });
    autoplayUntil(h, () => h.current === 2 && h.phase === 'turn');
    expect(h.pending.get(2)?.tsumo).toBe(true);
    h.act(2, { type: 'discard', tile: h.drawn! }); // 放棄自摸
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    autoplayUntil(h, () => h.phase === 'claim' && h.lastDiscard!.seat === 3);
    h.act(2, { type: 'ron' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    const w = h.result!.winners[0];
    expect(w.tsumo).toBe(true);
    const d = h.result!.deltas;
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[3]);
  });

  it('換三張：不換的玩家手牌不變，上家的牌交給下一位換牌者', () => {
    const h = makeHand([S0, '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃', '🀙🀚🀛🀜🀝🀞🀟🀠🀡🀇🀈🀉🀚', '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀘'], '', { advanced: true, passThree: true });
    expect(h.phase).toBe('passThree');
    const pick = (seat: number) => h.hands[seat].slice(0, 3);
    const p0 = pick(0);
    const p2 = pick(2);
    const p3 = pick(3);
    h.act(0, { type: 'passThree', tiles: p0 });
    h.act(1, { type: 'passThree', tiles: null });
    h.act(2, { type: 'passThree', tiles: p2 });
    h.act(3, { type: 'passThree', tiles: p3 });
    // 亮牌階段：收到的牌先不放進手牌，不換的 1 什麼都沒收到
    expect(h.phase).toBe('passReveal');
    expect(h.passReceived[2]).toEqual([...p0].sort((a, b) => a - b));
    expect(h.passReceived[1]).toBeNull();
    expect(h.passSent[0]).toEqual([...p0].sort((a, b) => a - b));
    expect(h.passSent[1]).toBeNull();
    expect(h.hands[2]).toHaveLength(10);
    h.completePassReveal();
    // 0 → 2（經過不傳的 1），2 → 3，3 → 0
    expect(p0.every((t) => h.hands[2].includes(t))).toBe(true);
    expect(p2.every((t) => h.hands[3].includes(t))).toBe(true);
    expect(p3.every((t) => h.hands[0].includes(t))).toBe(true);
    expect(h.phase).toBe('turn');
    expect(h.hands[0]).toHaveLength(14);
  });

  it('換三張：只有一人換牌時不交換', () => {
    const h = makeHand([S0, '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃', '🀙🀚🀛🀜🀝🀞🀟🀠🀡🀇🀈🀉🀚', '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀙🀘'], '', { advanced: true, passThree: true });
    const before = h.hands.map((x) => [...x]);
    h.act(0, { type: 'passThree', tiles: h.hands[0].slice(0, 3) });
    for (const s of [1, 2, 3]) h.act(s, { type: 'passThree', tiles: null });
    expect(h.phase).toBe('passReveal');
    expect(h.passReceived.every((r) => r === null)).toBe(true);
    h.completePassReveal();
    expect(h.hands[1]).toEqual(before[1]);
    expect(h.hands[0].slice(0, 13).length).toBe(13);
  });

  it('摸到剩王牌時流局，海底牌可自摸', () => {
    const settings = defaultSettings(4);
    const h = new Hand({ settings, startSeat: 1, smallHandAvailable: [true, true, true, true], rng: seededRng(42) });
    h.start();
    autoplayUntil(h, () => false, 5000);
    expect(h.phase).toBe('ended');
    expect(h.result!.kind).toBe('draw');
    expect(h.wallRemaining).toBe(12);
  });

  it('小牌限制：本輪已和過小牌者不能再和未滿 20 分的牌', () => {
    // 座位 1：234m 678m 333p 456s + 2p 單騎 → 斷么九＋不求人＋一暗刻 = 15 分
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀛🀛🀛🀚🀓🀔🀕', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const settings = { ...defaultSettings(4), advanced: true, smallHandLimit: true, passThree: false, minWinScore: 0 };
    const mk = (avail: boolean[]) => {
      const h = new Hand({ settings, startSeat: 0, smallHandAvailable: avail, wall: buildWall(4, 0, hands, '🀚') });
      h.start();
      h.drawCount[1] = 1; // 避免成立地和
      h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀚') });
      return h;
    };
    expect(mk([true, true, true, true]).pending.get(1)?.ron).toBe(true);
    expect(mk([true, false, true, true]).pending.get(1)?.ron).toBeUndefined();
  });

  it('地和：第一次摸牌前銃和', () => {
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀛🀛🀛🀚🀓🀔🀕', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = new Hand({ settings: { ...defaultSettings(4), advanced: false, passThree: false, minWinScore: 0 }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀚') });
    h.start();
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀚') });
    h.act(1, { type: 'ron' });
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'pass' });
    expect(h.result!.winners[0].score.yaku.map((y) => y.name)).toEqual(['地和']);
    expect(h.result!.winners[0].score.total).toBe(180);
  });

  it('聽牌提示：聽的牌與剩餘張數（扣掉自己看得到的牌）', () => {
    // 座位 1：234m 678m 456s 33p 55p 對碰 3p／5p
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = makeHand(hands, '🀀');
    expect(h.waitsFor(1)).toEqual([
      { kind: uni('🀛')[0], left: 2 },
      { kind: uni('🀝')[0], left: 2 },
    ]);
    expect(h.waitsFor(0)).toEqual([]);
    // 輪到自己摸牌後（14 張）改由「打出後聽」提示
    h.act(0, { type: 'discard', tile: h.drawn! });
    expect(h.current).toBe(1);
    expect(h.waitsFor(1)).toEqual([]);
  });

  it('和牌最低分數：未達標不能和牌', () => {
    // 座位 1 單騎 🀚：斷么九＋不求人＋一暗刻 = 15 分（進階規則無底分）
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀛🀛🀛🀚🀓🀔🀕', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const mk = (minWinScore: number) => {
      const h = new Hand({ settings: { ...defaultSettings(4), passThree: false, minWinScore }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀚') });
      h.start();
      h.drawCount[1] = 1; // 避免成立地和
      h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀚') });
      return h;
    };
    expect(mk(15).pending.get(1)?.ron).toBe(true);
    expect(mk(20).pending.get(1)?.ron).toBeUndefined();
  });

  it('聽牌預計得分：所有聽的牌 × 自摸／銃和的最低與最高；未達和牌最低分數的不列入', () => {
    // 座位 1：234m 678m 456s 33p 55p 對碰。銃和 10 分（明刻），自摸 15 分（多一暗刻）
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const mk = (minWinScore: number) => makeHand(hands, '🀀', { minWinScore, expansion: false });
    expect(mk(0).waitScore(1)).toEqual({ min: 10, max: 15 });
    expect(mk(12).waitScore(1)).toEqual({ min: 15, max: 15 });
    expect(mk(20).waitScore(1)).toBeNull();
    // 座位 2 也聽牌（一氣通貫）；座位 0 正在打牌（手上 14 張）時不計算
    expect(mk(0).waitScore(2)).toEqual({ min: 55, max: 55 });
    expect(mk(0).waitScore(0)).toBeNull();
  });
});
