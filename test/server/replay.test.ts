import { describe, expect, it } from 'vitest';
import type { Hand } from '../../src/server/engine/hand.js';
import { Match } from '../../src/server/engine/match.js';
import type { GameAction } from '../../src/shared/protocol.js';
import { replayHandOf } from '../../src/server/replay.js';
import { replayFrame, type ReplayFrame } from '../../src/shared/replay.js';
import type { ReplayHand } from '../../src/shared/replaySchema.js';
import { defaultSettings, type RuleSettings } from '../../src/shared/rules.js';
import { autoplayUntil, makeHand, playHandWithAI, seededRng, tileOf } from '../support/hand.js';

// 回放紀錄：用 AI 打完整局，確認只靠事件就能重現每一步的牌桌，播到最後與局結果一致

/** 隨機但積極鳴牌、槓牌、和牌的打法（AI 很少鳴牌，用它涵蓋吃碰槓、搶槓、一炮多響等事件） */
function playHandEagerly(h: Hand, rng: (n: number) => number) {
  const pick = <T,>(xs: T[]) => xs[rng(xs.length)];
  const chance = (pct: number) => rng(100) < pct;
  for (let i = 0; h.phase !== 'ended'; i++) {
    if (i > 2000) throw new Error('hand did not finish');
    if (h.phase === 'passReveal') {
      h.completePassReveal();
      continue;
    }
    const [seat, p] = [...h.pending.entries()][0];
    let a: GameAction;
    if (p.kind === 'passThree') a = { type: 'passThree', tiles: chance(70) ? h.hands[seat].slice(0, 3) : null };
    else if (p.kind === 'turn') {
      if (p.tsumo && chance(60)) a = { type: 'tsumo' };
      else if (p.ankan?.length && chance(80)) a = { type: 'ankan', kind: pick(p.ankan) };
      else if (p.kakan?.length && chance(80)) a = { type: 'kakan', kind: pick(p.kakan) };
      else a = { type: 'discard', tile: pick(h.hands[seat]) };
    } else if (p.ron && chance(80)) a = { type: 'ron' };
    else if (p.minkan && chance(60)) a = { type: 'minkan' };
    else if (p.pon && chance(60)) a = { type: 'pon' };
    else if (p.chi?.length && chance(50)) a = { type: 'chi', tiles: pick(p.chi) };
    else a = { type: 'pass' };
    expect(h.act(seat, a)).toBeNull();
  }
}

function playAndRecord(settings: RuleSettings, seed: number, eager = false): ReplayHand[] {
  const rng = seededRng(seed);
  const m = new Match(settings, { rng });
  const out: ReplayHand[] = [];
  while (!m.finished) {
    const hand = m.startHand();
    if (eager) playHandEagerly(hand, rng);
    else playHandWithAI(hand);
    out.push(replayHandOf(hand, m.handIndex + 1, m.scores));
    m.completeHand();
  }
  return out;
}

const count = (f: ReplayFrame) =>
  f.wallRemaining +
  f.hands.reduce((a, h) => a + h.length, 0) +
  f.drawn.filter((d) => d !== null).length +
  f.melds.reduce((a, ms) => a + ms.reduce((b, m) => b + m.tiles.length, 0), 0) +
  f.discards.reduce((a, ds) => a + ds.filter((d) => !d.called).length, 0) +
  (f.kakan ? 1 : 0);

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function checkHand(h: ReplayHand) {
  for (let step = 0; step <= h.events.length; step++) expect(count(replayFrame(h, step))).toBe(136);
  const end = replayFrame(h, h.events.length);
  end.hands.forEach((hand, s) => {
    const all = end.drawn[s] !== null ? [...hand, end.drawn[s]!] : hand;
    expect(sorted(all)).toEqual(sorted(h.result.hands[s]));
    expect(end.melds[s].map((m) => [m.type, sorted(m.tiles)])).toEqual(h.result.melds[s].map((m) => [m.type, sorted(m.tiles)]));
  });
  if (h.result.kind === 'win') expect(sorted(end.winners)).toEqual(sorted(h.result.winners.map((w) => w.seat)));
  else expect(end.winners).toEqual([]);
}

describe('回放紀錄', () => {
  const variants: [string, Partial<RuleSettings>, number][] = [
    ['4 人', {}, 4],
    ['4 人換三張', { passThree: true }, 4],
    ['3 人', {}, 3],
    ['2 人零和', { scoring: 'zeroSum' }, 2],
  ];
  for (const [name, opts, n] of variants) {
    it(`${name}：每一步牌數守恆，播完與局結果一致`, () => {
      for (const seed of [1, 2]) {
        const hands = playAndRecord({ ...defaultSettings(n as 2 | 3 | 4), ...opts, aiLevel: 'beginner' }, seed);
        expect(hands.length).toBeGreaterThan(0);
        hands.forEach(checkHand);
      }
    });
  }

  it('積極鳴牌：吃碰槓、暗槓、加槓、嶺上都能重現', () => {
    const seen = new Set<string>();
    for (const n of [4, 3, 2] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const hands = playAndRecord({ ...defaultSettings(n), minWinScore: 0, rounds: 1 }, seed, true);
        for (const h of hands) {
          checkHand(h);
          h.events.forEach((e) => seen.add(e.t === 'draw' && e.rinshan ? 'rinshan' : e.t));
          if (h.result.kind === 'draw') seen.add('exhausted');
        }
      }
    }
    expect([...seen].sort()).toEqual(['ankan', 'chi', 'discard', 'draw', 'exhausted', 'kakan', 'minkan', 'pass', 'pon', 'rinshan', 'win']);
  });

  it('搶槓：加槓的牌不會加進鳴牌，停在和牌', () => {
    const h = makeHand(
      ['🀊🀀🀁🀂🀃🀄🀅🀐🀒🀔🀖🀘🀏', '🀊🀊🀍🀍🀎🀎🀏🀃🀃🀄🀅🀆🀁', '🀈🀉🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀐🀑🀒🀓'],
      '🀀🀀🀀🀁🀊',
    );
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀊') });
    for (const s of [...h.pending.keys()]) h.act(s, s === 1 ? { type: 'pon' } : { type: 'pass' });
    h.act(1, { type: 'discard', tile: tileOf(h, 1, '🀁') });
    autoplayUntil(h, () => h.current === 1 && h.phase === 'turn');
    const kan = tileOf(h, 1, '🀊');
    h.act(1, { type: 'kakan', kind: 3 });
    h.act(2, { type: 'ron' });
    const r = replayHandOf(h, 1, [0, 0, 0, 0]);
    expect(r.events.slice(-2)).toEqual([{ t: 'kakan', s: 1, tile: kan }, { t: 'win', s: 2, from: 1, tile: kan }]);
    checkHand(r);
    const end = replayFrame(r, r.events.length);
    expect(end.kakan).toEqual({ seat: 1, tile: kan });
    expect(end.melds[1][0].type).toBe('pon');
  });

  it('一炮多響：每位和牌者各一個和牌事件', () => {
    const h = makeHand(
      ['🀊🀀🀁🀂🀃🀄🀅🀐🀒🀔🀖🀘🀏', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀐🀑🀒🀓', '🀈🀉🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆', '🀈🀉🀌🀍🀎🀙🀚🀛🀜🀝🀞🀡🀡'],
      '🀀',
    );
    const tile = tileOf(h, 0, '🀊');
    h.act(0, { type: 'discard', tile });
    expect(h.pending.get(2)?.ron && h.pending.get(3)?.ron).toBe(true);
    for (const s of [...h.pending.keys()]) h.act(s, { type: 'ron' });
    const r = replayHandOf(h, 1, [0, 0, 0, 0]);
    expect(r.events.filter((e) => e.t === 'win')).toEqual([
      { t: 'win', s: 2, from: 0, tile },
      { t: 'win', s: 3, from: 0, tile },
    ]);
    checkHand(r);
  });

  it('換三張有紀錄，配牌是換牌之前的牌', () => {
    const [h] = playAndRecord({ ...defaultSettings(4), passThree: true, aiLevel: 'beginner' }, 5);
    const pass = h.events.find((e) => e.t === 'pass');
    if (pass?.t === 'pass') {
      pass.sent.forEach((x, s) => x && x.forEach((tile) => expect(h.deal[s]).toContain(tile)));
    }
    expect(h.deal.every((d) => d.length === 13)).toBe(true);
  });
});
