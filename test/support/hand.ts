import { expect } from 'vitest';
import { decideAction } from '../../src/server/engine/ai.js';
import { Hand } from '../../src/server/engine/hand.js';
import { Match } from '../../src/server/engine/match.js';
import { defaultSettings, type RuleSettings } from '../../src/shared/rules.js';
import { kindOf, type TileId } from '../../src/shared/tiles.js';
import { uni } from './tiles.js';

// 引擎測試共用：固定亂數、指定牌山、讓 AI 打完整局等。

export function seededRng(seed: number) {
  let s = seed >>> 0;
  return (max: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % max;
  };
}

export function totalTiles(h: Hand) {
  return (
    h.wall.length +
    h.hands.reduce((a, x) => a + x.length, 0) +
    h.melds.reduce((a, ms) => a + ms.reduce((b, m) => b + m.tiles.length, 0), 0) +
    h.discards.reduce((a, ds) => a + ds.filter((d) => !d.called).length, 0) +
    (h.phase === 'passReveal' ? h.passReceived.reduce((a, r) => a + (r?.length ?? 0), 0) : 0) +
    (h.kakanPending ? 1 : 0)
  );
}

export function playHandWithAI(hand: Hand) {
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

export function playMatch(settings: RuleSettings, seed: number) {
  const m = new Match(settings, { rng: seededRng(seed) });
  while (!m.finished) {
    const hand = m.startHand();
    playHandWithAI(hand);
    m.completeHand();
  }
  return m;
}

/**
 * 依各家手牌與摸牌順序組出牌山。
 * hands[seat] 為 13 張；draws 為之後依序摸到的牌；rinshan 為嶺上牌（由尾端取）。
 */
export function buildWall(n: number, startSeat: number, hands: string[], draws: string, rinshan = ''): TileId[] {
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

export function makeHand(hands: string[], draws: string, opts: Partial<RuleSettings> = {}, rinshan = '') {
  const settings = { ...defaultSettings(4), minWinScore: 0, passThree: false, ...opts };
  const h = new Hand({ settings, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, draws, rinshan) });
  h.start();
  return h;
}

export const tileOf = (h: Hand, seat: number, ch: string) => h.hands[seat].find((t) => kindOf(t) === uni(ch)[0])!;

/** 輪到誰就打掉摸到的牌、所有鳴牌機會都略過，直到 predicate 成立 */
export function autoplayUntil(h: Hand, predicate: () => boolean, limit = 500) {
  for (let i = 0; i < limit && !predicate(); i++) {
    if (h.phase === 'ended') return;
    if (h.phase === 'passReveal') h.completePassReveal();
    for (const [seat, avail] of [...h.pending.entries()]) {
      h.act(seat, avail.kind === 'turn' ? { type: 'discard', tile: h.drawn ?? h.hands[seat][0] } : avail.kind === 'passThree' ? { type: 'passThree', tiles: null } : { type: 'pass' });
      break;
    }
  }
}

/** 不會參與情境的座位 0 手牌（字牌與索子），用來填位置 */
export const S0 = '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕';
