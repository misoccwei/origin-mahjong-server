import type { GameAction } from '../../shared/protocol.js';
import type { AILevel } from '../../shared/rules.js';
import { shanten } from '../../shared/shanten.js';
import { KIND_COUNT, isDragon, isHonor, isTerminal, kindOf, suitOf, type TileId, type TileKind } from '../../shared/tiles.js';
import type { Hand } from './hand.js';

// AI：以向聽數與有效牌數決定打牌，並帶有少量牌型傾向（番牌、混／清一色）。
// 只使用該座位看得到的資訊（自己的手牌、所有人的捨牌與鳴牌）。
// 難度：beginner 大多亂打；easy 只看向聽數且偶爾亂打、不鳴牌；normal 為基本策略；hard 另外會避開危險牌（防守）。

function countsOf(tiles: TileId[]): number[] {
  const c = new Array(KIND_COUNT).fill(0);
  for (const t of tiles) c[kindOf(t)]++;
  return c;
}

function visibleCounts(hand: Hand, seat: number): number[] {
  const c = countsOf(hand.hands[seat]);
  for (const ds of hand.discards) for (const d of ds) if (!d.called) c[kindOf(d.tile)]++;
  for (const ms of hand.melds) for (const m of ms) for (const t of m.tiles) c[kindOf(t)]++;
  return c;
}

/** 主要花色（數牌最多的花色）與其占比，用來判斷是否走混／清一色 */
function flushLean(counts: number[]): { suit: number; ratio: number } {
  const bySuit = [0, 0, 0];
  let honors = 0;
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (!counts[k]) continue;
    total += counts[k];
    if (isHonor(k)) honors += counts[k];
    else bySuit[suitOf(k)] += counts[k];
  }
  const suit = bySuit.indexOf(Math.max(...bySuit));
  return { suit, ratio: total ? (bySuit[suit] + honors) / total : 0 };
}

interface Ctx {
  hand: Hand;
  seat: number;
  advanced: boolean;
  meldCount: number;
  visible: number[];
  seatWind: TileKind;
  level: AILevel;
  /** 打出某種牌的危險度（0～1），hard 才有 */
  danger?: (k: TileKind) => number;
  dangerWeight?: number;
}

function ukeire(counts: number[], ctx: Ctx, current: number): number {
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    const left = 4 - ctx.visible[k];
    if (left <= 0) continue;
    counts[k]++;
    if (shanten(counts, ctx.meldCount, ctx.advanced) < current) total += left;
    counts[k]--;
  }
  return total;
}

/** 單張牌的保留價值（越高越想留） */
function tileValue(k: TileKind, counts: number[], ctx: Ctx, lean: { suit: number; ratio: number }): number {
  let v = 0;
  if (isHonor(k)) {
    v += counts[k] >= 2 ? 3 : -1;
    if (isDragon(k) || k === ctx.seatWind) v += counts[k] >= 2 ? 3 : 0.5;
  } else {
    v += isTerminal(k) ? 0 : 1;
    const n = k % 9;
    if (n > 0 && counts[k - 1]) v += 1;
    if (n < 8 && counts[k + 1]) v += 1;
    if ((ctx.advanced || ctx.level === 'hard') && lean.ratio >= 0.6) v += suitOf(k) === lean.suit ? 3 : -3;
  }
  return v;
}

function bestDiscard(tiles: TileId[], ctx: Ctx): { tile: TileId; shanten: number } {
  const counts = countsOf(tiles);
  const lean = flushLean(counts);
  let best: { tile: TileId; score: number; shanten: number } | null = null;
  const seen = new Set<TileKind>();
  for (const t of tiles) {
    const k = kindOf(t);
    if (seen.has(k)) continue;
    seen.add(k);
    counts[k]--;
    const s = shanten(counts, ctx.meldCount, ctx.advanced);
    const simple = ctx.level === 'easy' || ctx.level === 'beginner';
    const u = simple ? 0 : ukeire(counts, ctx, s);
    counts[k]++;
    let score = -s * 1000 + u * 4 - (simple ? 0 : tileValue(k, counts, ctx, lean));
    if (ctx.danger && ctx.dangerWeight) score -= ctx.danger(k) * ctx.dangerWeight;
    if (!best || score > best.score) best = { tile: t, score, shanten: s };
  }
  return best!;
}

/** 看起來可能聽牌的對手：鳴牌兩組以上，或已經打了 9 張以上 */
function threats(hand: Hand, seat: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < hand.n; s++) {
    if (s !== seat && (hand.melds[s].length >= 2 || hand.discards[s].length >= 9)) out.push(s);
  }
  return out;
}

function dangerFn(hand: Hand, against: number[], visible: number[]): (k: TileKind) => number {
  return (k) => {
    let worst = 0;
    for (const o of against) {
      const river = new Set(hand.discards[o].map((d) => kindOf(d.tile)));
      if (river.has(k)) continue; // 現物
      let d: number;
      if (isHonor(k)) d = visible[k] >= 3 ? 0.1 : visible[k] === 2 ? 0.4 : 0.8;
      else {
        const n = k % 9;
        d = isTerminal(k) ? 0.6 : n === 1 || n === 7 ? 0.8 : 1;
        // 筋：對手打過同花色差 3 的牌
        if ((n >= 3 && river.has(k - 3)) || (n <= 5 && river.has(k + 3))) d *= 0.5;
      }
      worst = Math.max(worst, d);
    }
    return worst;
  };
}

export function decideAction(hand: Hand, seat: number, level: AILevel = hand.settings.aiLevel): GameAction {
  const avail = hand.pending.get(seat);
  if (!avail) throw new Error('no pending action');
  const advanced = hand.settings.advanced;
  const ctx: Ctx = {
    hand,
    seat,
    advanced,
    meldCount: hand.melds[seat].length,
    visible: visibleCounts(hand, seat),
    seatWind: hand.seatWind(seat),
    level,
  };
  const tiles = hand.hands[seat];

  if (level === 'beginner' || level === 'easy') {
    if (avail.kind === 'passThree') {
      // 一半機率隨便換 3 張，讓換三張在只有弱 AI 的桌上也換得起來
      if (Math.random() < 0.5) return { type: 'passThree', tiles: null };
      const pool = [...tiles];
      const out = Array.from({ length: 3 }, () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return { type: 'passThree', tiles: out };
    }
    if (avail.kind === 'turn') {
      if (avail.tsumo) return { type: 'tsumo' };
      if (Math.random() < (level === 'beginner' ? 0.7 : 0.3)) return { type: 'discard', tile: tiles[Math.floor(Math.random() * tiles.length)] };
      return { type: 'discard', tile: bestDiscard(tiles, ctx).tile };
    }
    return { type: avail.ron ? 'ron' : 'pass' };
  }

  if (level === 'hard' && avail.kind === 'turn') {
    const against = threats(hand, seat);
    if (against.length) {
      const s = shanten(countsOf(tiles), ctx.meldCount, advanced);
      ctx.danger = dangerFn(hand, against, ctx.visible);
      // 離聽牌越遠越傾向棄和
      ctx.dangerWeight = s >= 3 ? 1500 : s === 2 ? 700 : s === 1 ? 250 : 80;
    }
  }

  if (avail.kind === 'passThree') {
    const rest = [...tiles];
    const out: TileId[] = [];
    for (let i = 0; i < 3; i++) {
      const { tile } = bestDiscard(rest, { ...ctx, meldCount: 0 });
      out.push(tile);
      rest.splice(rest.indexOf(tile), 1);
    }
    return { type: 'passThree', tiles: out };
  }

  if (avail.kind === 'turn') {
    if (avail.tsumo) return { type: 'tsumo' };
    const counts = countsOf(tiles);
    const current = shanten(counts, ctx.meldCount, advanced);
    for (const k of avail.ankan ?? []) {
      const c = [...counts];
      c[k] = 0;
      if (shanten(c, ctx.meldCount + 1, advanced) <= current) return { type: 'ankan', kind: k };
    }
    for (const k of avail.kakan ?? []) {
      const c = [...counts];
      c[k]--;
      if (shanten(c, ctx.meldCount, advanced) <= current) return { type: 'kakan', kind: k };
    }
    return { type: 'discard', tile: bestDiscard(tiles, ctx).tile };
  }

  // 鳴牌／搶槓
  if (avail.ron) return { type: 'ron' };
  if (avail.kind === 'chankan') return { type: 'pass' };
  const discard = hand.lastDiscard?.tile;
  if (discard === undefined) return { type: 'pass' };
  const k = kindOf(discard);
  const counts = countsOf(tiles);
  const current = shanten(counts, ctx.meldCount, advanced);
  const lean = flushLean(counts);
  const yakuhai = isDragon(k) || k === ctx.seatWind;
  const leaningFlush = lean.ratio >= 0.75 && (isHonor(k) || suitOf(k) === lean.suit);

  const afterCall = (remove: TileId[]) => {
    const rest = tiles.filter((t) => !remove.includes(t));
    if (!rest.length) return 99;
    return bestDiscard(rest, { ...ctx, meldCount: ctx.meldCount + 1 }).shanten;
  };
  const worthCalling = (s: number) => s < current && (!advanced || yakuhai || leaningFlush);

  if (avail.minkan) {
    const c = [...counts];
    c[k] = 0;
    if (shanten(c, ctx.meldCount + 1, advanced) <= current) return { type: 'minkan' };
  }
  if (avail.pon) {
    const pair = tiles.filter((t) => kindOf(t) === k).slice(0, 2);
    if (worthCalling(afterCall(pair)) || (yakuhai && current <= 3)) return { type: 'pon' };
  }
  if (avail.chi) {
    for (const option of avail.chi) {
      if (worthCalling(afterCall(option)) && (!advanced || leaningFlush)) return { type: 'chi', tiles: option };
    }
  }
  return { type: 'pass' };
}

/**
 * 自動摸打：不換牌、不鳴牌、摸什麼打什麼；可以和就和（onlyMax 時只和這副聽牌的最高分）。
 * 能槓（暗槓、加槓、明槓）時回傳 null：交給玩家自己決定要不要槓。
 */
export function autoAction(hand: Hand, seat: number, onlyMax: boolean): GameAction | null {
  const avail = hand.pending.get(seat);
  if (!avail) throw new Error('no pending action');
  const preview = avail.tsumo || avail.ron ? hand.winPreview(seat) : null;
  const takeWin = !!preview && (!onlyMax || preview.score.total >= preview.best);
  if (avail.kind === 'passThree') return { type: 'passThree', tiles: null };
  if (takeWin) return { type: avail.kind === 'turn' ? 'tsumo' : 'ron' };
  if (avail.ankan?.length || avail.kakan?.length || avail.minkan) return null;
  return avail.kind === 'turn' ? hand.defaultAction(seat) : { type: 'pass' };
}
