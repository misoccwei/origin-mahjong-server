import type { Meld } from './rules.js';
import { YAKU } from './scoring.js';
import { shantenSevenPairs, shantenStandard, shantenThirteenOrphans } from './shanten.js';
import { KIND_COUNT, countKinds, isDragon, isHonor, isWind, isYaochu, kindOf, suitOf, type TileKind } from './tiles.js';

// 推薦牌型：以「牌效率」與「期望值」評估各牌型。
// 每個牌型有一個評估函式：給定手牌計數，回傳朝這個牌型做牌的向聽數（不可能時為 Infinity）。
// 再算有效牌（還沒看到的牌中，摸到能讓這個牌型向聽數下降的張數）；
// 輪到自己（手上多一張）時，替每個牌型找出打哪張最好（向聽數最小、有效牌最多）。
// 和牌率：依剩餘摸牌次數、有效牌占未見牌的比例估計每巡前進一步的機率；
// 可吃碰的牌型另外計入他家打出有效牌的機會，門清牌型（七對子、暗刻類、十三么九）只能自己摸進來，只有最後聽牌時能銃和。
// 期望值 = 和牌率 ×（牌型分數＋底分）；未達和牌最低分數的牌型不推薦。
// 部分牌型（五門齊、一氣通貫、三色同順、番牌、三元、暗刻）的向聽數是近似值，僅供參考。

export interface Recommendation {
  id: string;
  name: string;
  points: number;
  /** 向聽數（0 = 聽牌、-1 = 已成形） */
  shanten: number;
  /** 有效牌張數（扣掉看得到的牌） */
  ukeire: number;
  /** 手上多一張時：朝這個牌型建議打出的牌 */
  discard?: TileKind;
  /** 可以靠吃碰做牌；false = 門清牌型，只能自己摸進來 */
  callable: boolean;
  /** 估計的和牌率（0～1） */
  winRate: number;
  /** 期望值：和牌率 ×（牌型分數＋底分） */
  ev: number;
}

export interface RecommendInput {
  /** 手牌（不含鳴牌），13 或 14 張減去鳴牌 */
  concealed: TileKind[];
  melds: Meld[];
  seatWind: TileKind;
  advanced: boolean;
  /** 看得到的牌的張數（自己的手牌、鳴牌、所有捨牌、他人明鳴牌）；未提供時只扣自己的手牌與鳴牌 */
  visible?: number[];
  /** 自己還能摸幾次牌（未提供時以 12 估計） */
  drawsLeft?: number;
  /** 人數（他家打出有效牌的機會），預設 4 */
  playerCount?: number;
  /** 和牌底分（讓分），預設 0 */
  baseScore?: number;
  /** 和牌最低分數：牌型分數＋底分未達此分數的牌型不推薦 */
  minWinScore?: number;
}

type Evaluator = (counts: number[]) => number;

export interface Target {
  id: string;
  evaluate: Evaluator;
  /** 可以靠吃碰做牌 */
  callable: boolean;
}

/** 只能門清（自己摸進來）的牌型 */
const CONCEALED_ONLY = new Set(['11.1', '11.2', '4.2.3', '4.2.4']);

/**
 * 和牌率：還差 shanten + 1 步。每巡自己摸一次，摸到有效牌的機率 p = 有效牌 ÷ 未見牌；
 * 越接近和牌有效牌通常越少，所以之後每一步的機率再打七折。
 * 可吃碰的牌型（或已聽牌、可以銃和時）每巡另外有他家打出有效牌的機會（他家會留牌，也不一定能吃，打三折）；
 * 每巡也有一定機率被他家先和走（每位他家 3%）。
 */
export function winProbability(shanten: number, ukeire: number, unseen: number, draws: number, callable: boolean, players = 4): number {
  if (shanten < 0) return 1;
  if (ukeire <= 0 || unseen <= 0 || draws <= 0) return 0;
  const steps = shanten + 1;
  const others = Math.max(0, players - 1);
  const p0 = Math.min(1, ukeire / unseen);
  // r = 還差幾步；第一步用目前的有效牌，之後每步打七折
  const pOf = (r: number) => p0 * 0.7 ** (steps - r);
  const qOf = (r: number) => 1 - (1 - pOf(r) * 0.3) ** others;
  const survive = 1 - 0.03 * others;
  let dp = new Array(steps + 1).fill(0);
  dp[steps] = 1;
  for (let t = 0; t < draws; t++) {
    const next = new Array(steps + 1).fill(0);
    next[0] = dp[0];
    for (let r = 1; r <= steps; r++) {
      if (!dp[r]) continue;
      const m0 = dp[r] * survive;
      const p = pOf(r);
      // 自己摸牌
      for (const [state, m] of [[r - 1, m0 * p], [r, m0 * (1 - p)]] as const) {
        // 他家打出的牌：吃碰（或聽牌時銃和）
        if (state > 0 && (callable || state === 1)) {
          const q = qOf(state);
          next[state - 1] += m * q;
          next[state] += m * (1 - q);
        } else next[state] += m;
      }
    }
    dp = next;
  }
  return dp[0];
}

/** 對某個評估函式：目前（或打掉最佳的一張後）的向聽數、有效牌、建議打的牌 */
function efficiency(counts: number[], evaluate: Evaluator, visible: number[], drawn: boolean) {
  const ukeireOf = (c: number[], s: number) => {
    let total = 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      const left = 4 - visible[k];
      if (left <= 0) continue;
      c[k]++;
      if (evaluate(c) < s) total += left;
      c[k]--;
    }
    return total;
  };
  if (!drawn) {
    const s = evaluate(counts);
    return { shanten: s, ukeire: Number.isFinite(s) ? ukeireOf(counts, s) : 0 };
  }
  // 已和牌形（-1）時不需要打牌
  if (evaluate(counts) < 0) return { shanten: -1, ukeire: 0 };
  let best: { shanten: number; ukeire: number; discard: TileKind } | null = null;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (!counts[k]) continue;
    counts[k]--;
    const s = evaluate(counts);
    if (Number.isFinite(s) && (!best || s <= best.shanten)) {
      const u = ukeireOf(counts, s);
      if (!best || s < best.shanten || u > best.ukeire) best = { shanten: s, ukeire: u, discard: k };
    }
    counts[k]++;
  }
  return best ?? { shanten: Infinity, ukeire: 0 };
}

/** 全帶么九：每組面子與雀頭都要含么九牌。以只允許這類組合的拆解計算向聽數 */
const chantaCache = new Map<string, number>();
function chantaShanten(counts: number[], meldCount: number): number {
  const key = counts.join('') + ':' + meldCount;
  const cached = chantaCache.get(key);
  if (cached !== undefined) return cached;
  const c = [...counts];
  const need = 4 - meldCount;
  let best = 8;
  const dfs = (i: number, sets: number, taatsu: number, pair: number) => {
    while (i < KIND_COUNT && c[i] === 0) i++;
    if (i >= KIND_COUNT) {
      const s = Math.min(sets, need);
      const t = Math.min(taatsu, need - s);
      best = Math.min(best, 8 - 2 * (s + meldCount) - t - pair);
      return;
    }
    const n = i % 9;
    const num = i < 27;
    // 刻子、對子（只限么九牌）
    if (isYaochu(i)) {
      if (c[i] >= 3) {
        c[i] -= 3;
        dfs(i, sets + 1, taatsu, pair);
        c[i] += 3;
      }
      if (c[i] >= 2) {
        c[i] -= 2;
        if (!pair) dfs(i, sets, taatsu, 1);
        dfs(i, sets, taatsu + 1, pair);
        c[i] += 2;
      }
    }
    // 順子只能是 123 或 789；搭子必須是它們的一部分
    if (num && (n === 0 || n === 6) && c[i + 1] && c[i + 2]) {
      c[i]--, c[i + 1]--, c[i + 2]--;
      dfs(i, sets + 1, taatsu, pair);
      c[i]++, c[i + 1]++, c[i + 2]++;
    }
    const partners: number[] = num ? ({ 0: [1, 2], 1: [1], 6: [1, 2], 7: [1] } as Record<number, number[]>)[n] ?? [] : [];
    for (const d of partners) {
      if (!c[i + d]) continue;
      c[i]--, c[i + d]--;
      dfs(i, sets, taatsu + 1, pair);
      c[i]++, c[i + d]++;
    }
    c[i]--;
    dfs(i, sets, taatsu, pair);
    c[i]++;
  };
  dfs(0, 0, 0, 0);
  chantaCache.set(key, best);
  return best;
}

/** 依手牌與鳴牌列出可以做的牌型與各自的評估函式（推薦與 AI 換三張共用） */
export function buildTargets(input: RecommendInput): Target[] {
  const { melds, seatWind, advanced } = input;
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const mc = melds.length;
  const std: Evaluator = (c) => shantenStandard(c, mc);
  const meldsAll = (ok: (k: TileKind) => boolean) => meldKinds.every((ks) => ks.every(ok));
  // 評估會被呼叫上千次：遮罩先算好、重複使用同一個陣列，避免每次配置記憶體
  const restricted = (ok: (k: TileKind) => boolean): Evaluator | null => {
    if (!meldsAll(ok)) return null;
    const mask = Array.from({ length: KIND_COUNT }, (_, k) => ok(k));
    const buf = new Array(KIND_COUNT).fill(0);
    return (c) => {
      for (let k = 0; k < KIND_COUNT; k++) buf[k] = mask[k] ? c[k] : 0;
      return shantenStandard(buf, mc);
    };
  };
  const atLeast = (base: Evaluator, missing: (c: number[]) => number): Evaluator => (c) => Math.max(base(c), missing(c));
  const meldCount = countKinds(meldKinds.flat());
  const allBuf = new Array(KIND_COUNT).fill(0);
  /** 手牌＋鳴牌的計數（共用同一個陣列，呼叫端不可保留） */
  const all = (c: number[]) => {
    for (let k = 0; k < KIND_COUNT; k++) allBuf[k] = c[k] + meldCount[k];
    return allBuf;
  };

  const targets: Target[] = [];
  const add = (id: string, evaluate: Evaluator | null) => evaluate && targets.push({ id, evaluate, callable: !CONCEALED_ONLY.has(id) });

  // 花色類
  for (let s = 0; s < 3; s++) {
    add('3.1.3', restricted((k) => !isHonor(k) && suitOf(k) === s));
    add('3.1.2', restricted((k) => isHonor(k) || suitOf(k) === s));
  }
  add('3.1.4', restricted(isHonor));
  // 么九類
  add('2.0', restricted((k) => !isYaochu(k)));
  if (melds.every((m) => m.type === 'chi' ? [0, 6].includes(Math.min(...m.tiles.map(kindOf)) % 9) : isYaochu(kindOf(m.tiles[0])))) {
    add('2.1', (c) => chantaShanten(c, mc));
  }
  // 碰碰和
  if (melds.every((m) => m.type !== 'chi')) {
    add('4.1', (c) => {
      let tri = 0;
      let pair = 0;
      for (let k = 0; k < KIND_COUNT; k++) {
        if (c[k] >= 3) tri++;
        else if (c[k] === 2) pair++;
      }
      const need = 4 - mc;
      const sets = Math.min(tri, need);
      return pair > 0 ? 8 - 2 * (sets + mc) - Math.min(pair - 1, need - sets) - 1 : 8 - 2 * (sets + mc);
    });
  }
  // 七對子
  if (advanced && mc === 0) add('11.1', shantenSevenPairs);
  // 五門齊：缺幾類就至少還要幾步
  // 五類：萬、筒、索、風、三元（位元遮罩）
  const catBit = Array.from({ length: KIND_COUNT }, (_, k) => 1 << (isWind(k) ? 3 : isDragon(k) ? 4 : suitOf(k)));
  add('3.0', atLeast(std, (c) => {
    const a = all(c);
    let bits = 0;
    for (let k = 0; k < KIND_COUNT; k++) if (a[k]) bits |= catBit[k];
    let have = 0;
    for (; bits; bits &= bits - 1) have++;
    return 5 - have;
  }));
  // 番牌（門風、三元牌的刻子）
  const yakuhai = [seatWind, 31, 32, 33];
  add('5.1', atLeast(std, (c) => {
    const a = all(c);
    return Math.min(...yakuhai.map((k) => Math.max(0, 3 - a[k])));
  }));
  // 三元
  const dragonNeed = (c: number[], need: number[]) => {
    const a = all(c);
    const d = [31, 32, 33].map((k) => Math.min(3, a[k])).sort((x, y) => y - x);
    return d.reduce((a, x, i) => a + Math.max(0, need[i] - x), 0);
  };
  add('5.2.1', atLeast(std, (c) => dragonNeed(c, [3, 3, 2])));
  add('5.2.2', atLeast(std, (c) => dragonNeed(c, [3, 3, 3])));
  if (advanced) {
    const missing = (a: number[], kinds: number[]) => kinds.filter((k) => !a[k]).length;
    const ittsuKinds = [0, 1, 2].map((s) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => s * 9 + i));
    const sanshokuKinds = [0, 1, 2, 3, 4, 5, 6].map((n) => [0, 1, 2].flatMap((s) => [s * 9 + n, s * 9 + n + 1, s * 9 + n + 2]));
    add('8.1', atLeast(std, (c) => {
      const a = all(c);
      return Math.min(...ittsuKinds.map((ks) => missing(a, ks)));
    }));
    add('9.2', atLeast(std, (c) => {
      const a = all(c);
      return Math.min(...sanshokuKinds.map((ks) => missing(a, ks)));
    }));
  }

  // 三暗刻：三組暗刻（暗槓也算）＋其他任意；四暗刻：只有暗刻（鳴牌只能是暗槓）
  const ankan = melds.filter((m) => m.type === 'ankan').length;
  const triNeed = (c: number[], need: number) => {
    const top = c.map((n) => Math.min(3, n)).sort((a, b) => b - a).slice(0, Math.max(0, need - ankan));
    return top.reduce((a, x) => a + 3 - x, 0);
  };
  add('4.2.3', atLeast(std, (c) => triNeed(c, 3)));
  if (melds.every((m) => m.type === 'ankan')) {
    add('4.2.4', (c) => {
      let tri = 0;
      let pair = 0;
      for (let k = 0; k < KIND_COUNT; k++) {
        if (c[k] >= 3) tri++;
        else if (c[k] === 2) pair++;
      }
      const need = 4 - mc;
      const sets = Math.min(tri, need);
      return pair > 0 ? 8 - 2 * (sets + mc) - Math.min(pair - 1, need - sets) - 1 : 8 - 2 * (sets + mc);
    });
  }
  // 十三么九
  if (advanced && mc === 0) add('11.2', shantenThirteenOrphans);
  return targets;
}

export function recommendYaku(input: RecommendInput, limit = 5): Recommendation[] {
  const { concealed, melds } = input;
  const counts = countKinds(concealed);
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...concealed, ...meldKinds.flat()]);
  const drawn = concealed.length % 3 === 2;
  const unseen = visible.reduce((a, v) => a + Math.max(0, 4 - v), 0);
  const draws = input.drawsLeft ?? 12;
  const baseScore = input.baseScore ?? 0;
  const minWin = input.minWinScore ?? 0;

  const results = new Map<string, Recommendation>();
  for (const t of buildTargets(input)) {
    const def = YAKU[t.id];
    if (minWin > 0 && def.points + baseScore < minWin) continue;
    const e = efficiency([...counts], t.evaluate, visible, drawn);
    if (!Number.isFinite(e.shanten)) continue;
    const winRate = winProbability(e.shanten, e.ukeire, unseen, draws, t.callable, input.playerCount);
    const r: Recommendation = {
      id: t.id,
      name: def.name,
      points: def.points,
      shanten: e.shanten,
      ukeire: e.ukeire,
      discard: 'discard' in e ? e.discard : undefined,
      callable: t.callable,
      winRate,
      ev: winRate * (def.points + baseScore),
    };
    // 同一牌型（例如三種花色的清一色）只留期望值最高的
    const prev = results.get(t.id);
    if (!prev || r.ev > prev.ev || (r.ev === prev.ev && (r.shanten < prev.shanten || (r.shanten === prev.shanten && r.ukeire > prev.ukeire)))) results.set(t.id, r);
  }

  // 排序：期望值。期望值相同（例如都幾乎不可能）時看向聽數、有效牌與分數
  const std: Evaluator = (c) => shantenStandard(c, melds.length);
  const base = efficiency([...counts], std, visible, drawn).shanten;
  return [...results.values()]
    .filter((r) => r.shanten <= base + 3)
    .sort((a, b) => b.ev - a.ev || a.shanten - b.shanten || b.ukeire - a.ukeire || b.points - a.points)
    .slice(0, limit);
}

/** 純牌效率（不看牌型）：最快和牌的向聽數、有效牌與建議打的牌 */
export function fastestWin(input: RecommendInput): { shanten: number; ukeire: number; discard?: TileKind } {
  const counts = countKinds(input.concealed);
  const meldKinds = input.melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...input.concealed, ...meldKinds.flat()]);
  const mc = input.melds.length;
  const evaluate: Evaluator = (c) => {
    let s = shantenStandard(c, mc);
    if (input.advanced && mc === 0) s = Math.min(s, shantenSevenPairs(c));
    return s;
  };
  return efficiency(counts, evaluate, visible, input.concealed.length % 3 === 2);
}
