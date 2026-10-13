import type { RecommendInput } from './recommend.js';
import { scoreByWait } from './scoring.js';
import { shanten } from './shanten.js';
import { KIND_COUNT, countKinds, kindOf, type TileKind } from './tiles.js';

// 推薦牌型（進階型）：結果導向。
// 不是一次只看一個牌型，而是往下模擬「摸哪張 → 打哪張」直到聽牌，用最後和牌的分數（自摸或銃和取高、不含偶然類）比較，
// 再把第一張摸牌依「最後能和成什麼」分組，例如：再進一筒、四筒可以混一色＋碰碰和；進二筒、三筒只是混一色。
// 每個方向取最好的情況（之後的摸牌都摸到最好的）；已經看不到剩的牌不算，未達和牌最低分數的和法不算。
// 計算量隨向聽數暴增，只算到 2 向聽。

export const OUTCOME_MAX_SHANTEN = 2;

export interface OutcomeGroup {
  /** 摸到這些牌（已聽牌時是和這些牌） */
  draws: TileKind[];
  /** 這些牌還沒看到的張數 */
  left: number;
  /** 最後和牌的分數與牌型（最好的情況） */
  total: number;
  yaku: string[];
}

export interface OutcomePlan {
  /** 手上多一張時：先打這張 */
  discard?: TileKind;
  /** 打完（或 13 張時）的向聽數；0 = 已聽牌，groups 的 draws 是和的牌 */
  shanten: number;
  groups: OutcomeGroup[];
}

export interface OutcomeResult {
  /** 目前的向聽數（手上多一張時為打掉最好的一張後） */
  shanten: number;
  plans: OutcomePlan[];
  /** 向聽數太多，沒有計算 */
  tooFar: boolean;
}

interface Final {
  total: number;
  yaku: string[];
}

export function outcomeRecommend(input: RecommendInput, maxPlans = 3): OutcomeResult {
  const { melds, seatWind, advanced } = input;
  const mc = melds.length;
  const base = input.baseScore ?? 0;
  const minWin = input.minWinScore ?? 0;
  const expansion = !!input.expansion;
  const counts = countKinds(input.concealed);
  const meldTiles = countKinds(melds.flatMap((m) => m.tiles.map(kindOf)));
  const visible = input.visible ?? counts.map((n, k) => n + meldTiles[k]);
  // 手牌以外看得到的牌；模擬摸打時手牌改變，剩下的張數跟著算
  const outside = visible.map((v, k) => Math.max(0, v - counts[k]));
  const left = (c: number[], k: TileKind) => 4 - outside[k] - c[k];
  const sh = (c: number[]) => shanten(c, mc, advanced);
  const kindsOf = (c: number[]) => c.flatMap((n, k) => new Array<TileKind>(n).fill(k));
  const better = (a: Final | null, b: Final | null) => !!a && (!b || a.total > b.total || (a.total === b.total && a.yaku.length > b.yaku.length));

  /** 聽牌時每張聽的牌（還有剩、達到最低分數）的最後和牌 */
  const waits = (c: number[]) =>
    scoreByWait(kindsOf(c), melds, seatWind, advanced, base, expansion)
      .filter((w) => left(c, w.tile) > 0 && w.score.total >= minWin)
      .map((w) => ({ tile: w.tile, final: { total: w.score.total, yaku: w.score.yaku.map((y) => (y.count > 1 ? `${y.name}×${y.count}` : y.name)) } }));

  /** 摸一張、打一張後向聽數減一的所有下一手（依摸的牌分開） */
  const advances = (c: number[], s: number) => {
    const out: { draw: TileKind; next: number[] }[] = [];
    for (let k = 0; k < KIND_COUNT; k++) {
      if (left(c, k) <= 0) continue;
      c[k]++;
      if (sh(c) < s) {
        for (let d = 0; d < KIND_COUNT; d++) {
          if (!c[d] || d === k) continue;
          c[d]--;
          if (sh(c) === s - 1) out.push({ draw: k, next: [...c] });
          c[d]++;
        }
      }
      c[k]--;
    }
    return out;
  };

  const memo = new Map<string, Final | null>();
  /** 13 張（向聽 s）時，之後都摸到最好的牌能和成的最高分 */
  const value = (c: number[], s: number): Final | null => {
    const key = c.join('');
    if (memo.has(key)) return memo.get(key)!;
    let best: Final | null = null;
    if (s === 0) {
      for (const w of waits(c)) if (better(w.final, best)) best = w.final;
    } else {
      for (const { next } of advances(c, s)) {
        const v = value(next, s - 1);
        if (better(v, best)) best = v;
      }
    }
    memo.set(key, best);
    return best;
  };

  /** 13 張時的各個方向：第一張摸牌（或聽牌時和的牌）依最後的和法分組 */
  const plan = (c: number[], s: number): OutcomeGroup[] => {
    const byDraw = new Map<TileKind, Final>();
    if (s === 0) {
      for (const w of waits(c)) byDraw.set(w.tile, w.final);
    } else {
      for (const { draw, next } of advances(c, s)) {
        const v = value(next, s - 1);
        if (v && better(v, byDraw.get(draw) ?? null)) byDraw.set(draw, v);
      }
    }
    const groups = new Map<string, OutcomeGroup>();
    for (const [draw, f] of byDraw) {
      const key = `${f.total}|${f.yaku.join('・')}`;
      const g = groups.get(key) ?? { draws: [], left: 0, total: f.total, yaku: f.yaku };
      g.draws.push(draw);
      g.left += left(c, draw);
      groups.set(key, g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, draws: g.draws.sort((a, b) => a - b) }))
      .sort((a, b) => b.total - a.total || b.left - a.left);
  };

  const c = [...counts];
  if (input.concealed.length % 3 === 2) {
    // 手上多一張：每個不會讓向聽數變差的打法分別算
    const s14 = sh(c);
    if (s14 < 0) return { shanten: -1, plans: [], tooFar: false };
    if (s14 > OUTCOME_MAX_SHANTEN) return { shanten: s14, plans: [], tooFar: true };
    const plans: OutcomePlan[] = [];
    for (let d = 0; d < KIND_COUNT; d++) {
      if (!c[d]) continue;
      c[d]--;
      if (sh(c) === s14) plans.push({ discard: d, shanten: s14, groups: plan(c, s14) });
      c[d]++;
    }
    const best = (p: OutcomePlan) => p.groups[0]?.total ?? -1;
    const sorted = plans.filter((p) => p.groups.length).sort((a, b) => best(b) - best(a) || sumLeft(b) - sumLeft(a));
    return { shanten: s14, plans: sorted.slice(0, maxPlans), tooFar: false };
  }
  const s = sh(c);
  if (s > OUTCOME_MAX_SHANTEN) return { shanten: s, plans: [], tooFar: true };
  const groups = plan(c, s);
  return { shanten: s, plans: groups.length ? [{ shanten: s, groups }] : [], tooFar: false };
}

const sumLeft = (p: OutcomePlan) => p.groups.reduce((a, g) => a + g.left, 0);
