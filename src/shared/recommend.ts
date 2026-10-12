import type { Meld } from './rules.js';
import { YAKU } from './scoring.js';
import { shantenSevenPairs, shantenStandard } from './shanten.js';
import { KIND_COUNT, countKinds, isDragon, isHonor, isWind, isYaochu, kindOf, suitOf, type TileKind } from './tiles.js';

// 推薦牌型：以「牌效率」評估各牌型。
// 每個牌型有一個評估函式：給定手牌計數，回傳朝這個牌型做牌的向聽數（不可能時為 Infinity）。
// 再算有效牌（還沒看到的牌中，摸到能讓這個牌型向聽數下降的張數）；
// 輪到自己（手上多一張）時，替每個牌型找出打哪張最好（向聽數最小、有效牌最多）。
// 部分牌型（五門齊、一氣通貫、三色同順、番牌、三元）的向聽數是近似值，僅供參考。

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
}

export interface RecommendInput {
  /** 手牌（不含鳴牌），13 或 14 張減去鳴牌 */
  concealed: TileKind[];
  melds: Meld[];
  seatWind: TileKind;
  advanced: boolean;
  /** 看得到的牌的張數（自己的手牌、鳴牌、所有捨牌、他人明鳴牌）；未提供時只扣自己的手牌與鳴牌 */
  visible?: number[];
}

type Evaluator = (counts: number[]) => number;

interface Target {
  id: string;
  evaluate: Evaluator;
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

export function recommendYaku(input: RecommendInput, limit = 5): Recommendation[] {
  const { concealed, melds, seatWind, advanced } = input;
  const counts = countKinds(concealed);
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...concealed, ...meldKinds.flat()]);
  const drawn = concealed.length % 3 === 2;
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
  const add = (id: string, evaluate: Evaluator | null) => evaluate && targets.push({ id, evaluate });

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

  const results = new Map<string, Recommendation>();
  for (const t of targets) {
    const e = efficiency([...counts], t.evaluate, visible, drawn);
    if (!Number.isFinite(e.shanten)) continue;
    const r: Recommendation = { id: t.id, name: YAKU[t.id].name, points: YAKU[t.id].points, shanten: e.shanten, ukeire: e.ukeire, discard: 'discard' in e ? e.discard : undefined };
    // 同一牌型（例如三種花色的清一色）只留最有效率的
    const prev = results.get(t.id);
    if (!prev || r.shanten < prev.shanten || (r.shanten === prev.shanten && r.ukeire > prev.ukeire)) results.set(t.id, r);
  }

  // 排序：分數 × 牌效率。向聽數每多一步價值打三折多，有效牌越多越好
  const value = (r: Recommendation) => (r.points / 3 ** Math.max(0, r.shanten)) * (1 + r.ukeire / 30);
  const base = efficiency([...counts], std, visible, drawn).shanten;
  return [...results.values()]
    .filter((r) => r.shanten <= base + 3)
    .sort((a, b) => value(b) - value(a) || a.shanten - b.shanten || b.ukeire - a.ukeire)
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
