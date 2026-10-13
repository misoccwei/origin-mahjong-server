import { describe, expect, it } from 'vitest';
import { Hand } from '../src/server/engine/hand.js';
import { Match } from '../src/server/engine/match.js';
import { autoAction, decideAction } from '../src/server/engine/ai.js';
import { defaultSettings, type RuleSettings } from '../src/shared/rules.js';
import { kindOf, type TileId } from '../src/shared/tiles.js';
import { uni } from './helpers.js';

function seededRng(seed: number) {
  let s = seed >>> 0;
  return (max: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % max;
  };
}

function totalTiles(h: Hand) {
  return (
    h.wall.length +
    h.hands.reduce((a, x) => a + x.length, 0) +
    h.melds.reduce((a, ms) => a + ms.reduce((b, m) => b + m.tiles.length, 0), 0) +
    h.discards.reduce((a, ds) => a + ds.filter((d) => !d.called).length, 0) +
    (h.phase === 'passReveal' ? h.passReceived.reduce((a, r) => a + (r?.length ?? 0), 0) : 0) +
    (h.kakanPending ? 1 : 0)
  );
}

function playHandWithAI(hand: Hand) {
  let steps = 0;
  while (hand.phase !== 'ended') {
    expect(totalTiles(hand)).toBe(136);
    if (hand.phase === 'passReveal') {
      hand.completePassReveal();
      continue;
    }
    const [seat] = [...hand.pending.keys()];
    const err = hand.act(seat, decideAction(hand, seat));
    expect(err).toBeNull();
    if (++steps > 2000) throw new Error('hand did not finish');
  }
}

function playMatch(settings: RuleSettings, seed: number) {
  const m = new Match(settings, { rng: seededRng(seed) });
  while (!m.finished) {
    const hand = m.startHand();
    playHandWithAI(hand);
    m.completeHand();
  }
  return m;
}

describe('AI 對局模擬', () => {
  const configs: [string, Partial<RuleSettings>][] = [
    ['4人基本加分式', { advanced: false }],
    ['4人進階加分式+換三張', { advanced: true, passThree: true }],
    ['4人進階零和式+小牌限制', { advanced: true, scoring: 'zeroSum', smallHandLimit: true }],
    ['4人基本零和式', { advanced: false, scoring: 'zeroSum' }],
    ['4人初學者 AI', { aiLevel: 'beginner' }],
    ['4人簡單 AI', { aiLevel: 'easy' }],
    ['4人困難 AI', { aiLevel: 'hard', scoring: 'zeroSum' }],
  ];
  for (const [name, extra] of configs) {
    it(name, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const s = { ...defaultSettings(4), ...extra };
        const m = playMatch(s, seed);
        expect(m.history.length).toBe(4);
        if (s.scoring === 'zeroSum') expect(m.scores.reduce((a, b) => a + b, 0)).toBe(0);
      }
    });
  }
  it('2人、3人', () => {
    for (const pc of [2, 3] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const s = { ...defaultSettings(pc), advanced: seed % 2 === 0, passThree: true, scoring: seed > 2 ? ('zeroSum' as const) : ('additive' as const) };
        const m = playMatch(s, seed * 7);
        expect(m.history.length).toBe(pc * 2);
        if (s.scoring === 'zeroSum') expect(m.scores.reduce((a, b) => a + b, 0)).toBe(0);
      }
    }
  });
  it('起始玩家每局輪替、加圈', () => {
    const m = new Match(defaultSettings(4), { firstStart: 2, rng: seededRng(3) });
    const starts: number[] = [];
    while (!m.finished) {
      starts.push(m.startSeat);
      playHandWithAI(m.startHand());
      m.completeHand();
    }
    expect(starts).toEqual([2, 3, 0, 1]);
    m.extend();
    expect(m.finished).toBe(false);
    expect(m.totalHands).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 指定牌山的情境測試
// ---------------------------------------------------------------------------

/**
 * 依各家手牌與摸牌順序組出牌山。
 * hands[seat] 為 13 張；draws 為之後依序摸到的牌；rinshan 為嶺上牌（由尾端取）。
 */
function buildWall(n: number, startSeat: number, hands: string[], draws: string, rinshan = ''): TileId[] {
  const used = new Set<TileId>();
  const take = (k: number) => {
    for (let i = 0; i < 4; i++) if (!used.has(k * 4 + i)) return used.add(k * 4 + i), k * 4 + i;
    throw new Error('too many of kind ' + k);
  };
  const handTiles = hands.map((h) => uni(h).map(take));
  const drawTiles = uni(draws).map(take);
  const rinTiles = uni(rinshan).map(take);
  const rest: TileId[] = [];
  for (let id = 0; id < 136; id++) if (!used.has(id)) rest.push(id);
  const deal: TileId[] = [];
  for (let r = 0; r < 13; r++) for (let i = 0; i < n; i++) deal.push(handTiles[(startSeat + i) % n][r]);
  // 牌山尾端放嶺上牌（pop 從最後取）
  return [...deal, ...drawTiles, ...rest, ...rinTiles.reverse()];
}

function makeHand(hands: string[], draws: string, opts: Partial<RuleSettings> = {}, rinshan = '') {
  const settings = { ...defaultSettings(4), minWinScore: 0, passThree: false, ...opts };
  const h = new Hand({ settings, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, draws, rinshan) });
  h.start();
  return h;
}

const tileOf = (h: Hand, seat: number, ch: string) => h.hands[seat].find((t) => kindOf(t) === uni(ch)[0])!;

/** 輪到誰就打掉摸到的牌、所有鳴牌機會都略過，直到 predicate 成立 */
function autoplayUntil(h: Hand, predicate: () => boolean, limit = 500) {
  for (let i = 0; i < limit && !predicate(); i++) {
    if (h.phase === 'ended') return;
    if (h.phase === 'passReveal') h.completePassReveal();
    for (const [seat, avail] of [...h.pending.entries()]) {
      h.act(seat, avail.kind === 'turn' ? { type: 'discard', tile: h.drawn ?? h.hands[seat][0] } : avail.kind === 'passThree' ? { type: 'passThree', tiles: null } : { type: 'pass' });
      break;
    }
  }
}

const S0 = '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕';

describe('情境', () => {
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

  it('自動摸打：摸切、不鳴牌；只和最高分時放過較低分的和牌', () => {
    // 座位 1：234m 678m 456s 33p 55p 對碰。銃和 3p → 該刻子為明刻（10 分）；自摸可多一暗刻（15 分）
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = new Hand({ settings: { ...defaultSettings(4), minWinScore: 0, passThree: false }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀛') });
    h.start();
    h.drawCount[1] = 1; // 避免成立地和
    expect(autoAction(h, 0, { play: true, win: false, onlyMax: false })).toEqual({ type: 'discard', tile: h.drawn });
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀛') });
    expect(h.pending.get(1)?.ron).toBe(true);
    expect(h.winPreview(1)).toMatchObject({ score: { total: 10 }, best: 15 });
    expect(autoAction(h, 1, { play: true, win: false, onlyMax: false })).toEqual({ type: 'ron' });
    expect(autoAction(h, 1, { play: true, win: false, onlyMax: true })).toEqual({ type: 'pass' });
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

  it('自動摸打：能暗槓或明槓時停下來交給玩家決定（回傳 null）', () => {
    // 座位 0 手上三張 🀇、摸到第四張 → 可暗槓
    const h = makeHand(['🀇🀇🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀚', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀇');
    expect(h.pending.get(0)?.ankan).toEqual([uni('🀇')[0]]);
    expect(autoAction(h, 0, { play: true, win: false, onlyMax: false })).toBeNull();
    // 座位 3 有三張 🀡：座位 2 打出 🀡 時可明槓
    const h2 = makeHand(['🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀈🀉🀊🀌🀍🀎🀛🀛🀛🀚🀓🀔🀕', '🀡🀇🀇🀈🀈🀉🀉🀙🀚🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀆🀁');
    autoplayUntil(h2, () => h2.current === 2 && h2.phase === 'turn');
    h2.act(2, { type: 'discard', tile: tileOf(h2, 2, '🀡') });
    expect(h2.pending.get(3)?.minkan).toBe(true);
    expect(autoAction(h2, 3, { play: true, win: false, onlyMax: false })).toBeNull();
  });

  it('自動和牌（沒開自動摸打）：只有能和時才自動，其他交給玩家', () => {
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = new Hand({ settings: { ...defaultSettings(4), minWinScore: 0, passThree: false }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀛') });
    h.start();
    h.drawCount[1] = 1;
    const winOnly = { play: false, win: true, onlyMax: false };
    expect(autoAction(h, 0, winOnly)).toBeNull(); // 輪到自己打牌：不自動
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀛') });
    expect(autoAction(h, 1, winOnly)).toEqual({ type: 'ron' });
    // 只和最高分：銃和 10 分 < 最高 15 分 → 交給玩家（不自動略過）
    expect(autoAction(h, 1, { ...winOnly, onlyMax: true })).toBeNull();
    expect(autoAction(h, 1, { play: false, win: false, onlyMax: false })).toBeNull();
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

describe('AI 依推薦牌型做牌', () => {
  const others = ['🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];

  it('換三張：朝清一色／混一色，換掉其他花色的牌', () => {
    const h = makeHand(['🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆🀈🀙', ...others], '🀁', { passThree: true });
    const a = decideAction(h, 0, 'normal');
    expect(a.type).toBe('passThree');
    const kinds = (a as { tiles: TileId[] }).tiles.map(kindOf);
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain(uni('🀈')[0]);
  });

  it('和牌最低分數高於底分時，打牌朝期望值最高的牌型', () => {
    // 1～9p＋中中＋2m 3s＋摸 9s：要湊到 40 分，留筒子與中，打掉萬子或索子
    const h = makeHand(['🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆🀈🀒', ...others], '🀘', { minWinScore: 40 });
    const a = decideAction(h, 0, 'normal');
    expect(a.type).toBe('discard');
    const k = kindOf((a as { tile: TileId }).tile);
    expect([uni('🀈')[0], uni('🀒')[0], uni('🀘')[0]]).toContain(k);
  });
});

