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
  /** 牌型擴充包（結果導向計算和牌分數時用） */
  expansion?: boolean;
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

/**
 * 全帶么九：每組面子與雀頭都要含么九牌。以只允許這類組合的拆解計算向聽數。
 * 孤張也要能用：雀頭只能是么九牌、面子只能用 1～3、7～9 與字牌；不夠用的時候要多摸一張。
 */
const chantaCache = new Map<string, number>();
function chantaShanten(counts: number[], meldCount: number): number {
  const key = counts.join('') + ':' + meldCount;
  const cached = chantaCache.get(key);
  if (cached !== undefined) return cached;
  const c = [...counts];
  const need = 4 - meldCount;
  const usable = (k: number) => k >= 27 || [0, 1, 2, 6, 7, 8].includes(k % 9);
  let best = 8;
  /** isoU：能當面子種子的孤張數；isoY：其中是么九（能當雀頭種子）的張數 */
  const dfs = (i: number, sets: number, taatsu: number, pair: number, isoU: number, isoY: number) => {
    while (i < KIND_COUNT && c[i] === 0) i++;
    if (i >= KIND_COUNT) {
      const s = Math.min(sets, need);
      const t = Math.min(taatsu, need - s);
      let u = isoU + Math.max(0, sets - s) * 3 + Math.max(0, taatsu - t) * 2;
      let deficit = 0;
      if (!pair) {
        if (isoY > 0) u--;
        else deficit++;
      }
      deficit += Math.max(0, need - s - t - Math.max(0, u));
      best = Math.min(best, 8 - 2 * (s + meldCount) - t - pair + deficit);
      return;
    }
    const n = i % 9;
    const num = i < 27;
    // 刻子、對子（只限么九牌）
    if (isYaochu(i)) {
      if (c[i] >= 3) {
        c[i] -= 3;
        dfs(i, sets + 1, taatsu, pair, isoU, isoY);
        c[i] += 3;
      }
      if (c[i] >= 2) {
        c[i] -= 2;
        if (!pair) dfs(i, sets, taatsu, 1, isoU, isoY);
        dfs(i, sets, taatsu + 1, pair, isoU, isoY);
        c[i] += 2;
      }
    }
    // 順子只能是 123 或 789；搭子必須是它們的一部分
    if (num && (n === 0 || n === 6) && c[i + 1] && c[i + 2]) {
      c[i]--, c[i + 1]--, c[i + 2]--;
      dfs(i, sets + 1, taatsu, pair, isoU, isoY);
      c[i]++, c[i + 1]++, c[i + 2]++;
    }
    const partners: number[] = num ? ({ 0: [1, 2], 1: [1], 6: [1, 2], 7: [1] } as Record<number, number[]>)[n] ?? [] : [];
    for (const d of partners) {
      if (!c[i + d]) continue;
      c[i]--, c[i + d]--;
      dfs(i, sets, taatsu + 1, pair, isoU, isoY);
      c[i]++, c[i + d]++;
    }
    c[i]--;
    dfs(i, sets, taatsu, pair, isoU + (usable(i) ? 1 : 0), isoY + (isYaochu(i) ? 1 : 0));
    c[i]++;
  };
  dfs(0, 0, 0, 0, 0, 0);
  chantaCache.set(key, best);
  return best;
}

/**
 * 依手牌與鳴牌列出可以做的牌型與各自的評估函式（推薦與 AI 換三張共用）。
 * 會參考已經出現過的牌（河裡、鳴牌、自己的槓子等）：需要的牌已經沒有剩的牌型評估為 Infinity（不可能），
 * 例如四張一萬都在自己的槓子裡時，萬子的一氣通貫就不可能。
 */
export function buildTargets(input: RecommendInput): Target[] {
  const { concealed, melds, seatWind, advanced } = input;
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const mc = melds.length;
  const std: Evaluator = (c) => shantenStandard(c, mc);
  /** 還沒看到的張數（還有機會摸到或吃碰到） */
  const visible = input.visible ?? countKinds([...concealed, ...meldKinds.flat()]);
  const unseen = visible.map((v) => Math.max(0, 4 - v));
  /** 手牌中這種牌最多能湊到幾張 */
  const reach = (c: number[], k: TileKind) => Math.min(4, c[k] + unseen[k]);
  /** 手牌（不含鳴牌）要湊的張數 */
  const slots = 14 - 3 * mc;
  const meldsAll = (ok: (k: TileKind) => boolean) => meldKinds.every((ks) => ks.every(ok));
  // 評估會被呼叫上千次：遮罩先算好、重複使用同一個陣列，避免每次配置記憶體
  const restricted = (ok: (k: TileKind) => boolean): Evaluator | null => {
    if (!meldsAll(ok)) return null;
    const mask = Array.from({ length: KIND_COUNT }, (_, k) => ok(k));
    const buf = new Array(KIND_COUNT).fill(0);
    return (c) => {
      // 這些牌種剩下的（手上＋還沒看到的）湊不滿手牌就不可能
      let room = 0;
      for (let k = 0; k < KIND_COUNT; k++) {
        buf[k] = mask[k] ? c[k] : 0;
        if (mask[k]) room += reach(c, k);
      }
      return room < slots ? Infinity : shantenStandard(buf, mc);
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
  /** 湊得到 n 張以上的牌種數 */
  const kindsReaching = (c: number[], n: number) => {
    let total = 0;
    for (let k = 0; k < KIND_COUNT; k++) if (reach(c, k) >= n) total++;
    return total;
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
    const chantaKind = (k: TileKind) => isHonor(k) || [0, 1, 2, 6, 7, 8].includes(k % 9);
    add('2.1', (c) => {
      let room = 0;
      for (let k = 0; k < KIND_COUNT; k++) if (chantaKind(k)) room += reach(c, k);
      return room < slots ? Infinity : chantaShanten(c, mc);
    });
  }
  // 碰碰和／四暗刻：還要 4 - 鳴牌組 組刻子＋雀頭，湊得到 3 張的牌種要夠
  const triplets = (c: number[]) => {
    const need = 4 - mc;
    if (kindsReaching(c, 3) < need || kindsReaching(c, 2) < need + 1) return Infinity;
    let tri = 0;
    let pair = 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      if (c[k] >= 3) tri++;
      else if (c[k] === 2) pair++;
    }
    const sets = Math.min(tri, need);
    return pair > 0 ? 8 - 2 * (sets + mc) - Math.min(pair - 1, need - sets) - 1 : 8 - 2 * (sets + mc);
  };
  if (melds.every((m) => m.type !== 'chi')) add('4.1', triplets);
  // 七對子：四張同種可以當兩組對子
  if (advanced && mc === 0) {
    add('11.1', (c) => {
      let pairs = 0;
      for (let k = 0; k < KIND_COUNT; k++) pairs += Math.floor(reach(c, k) / 2);
      return pairs < 7 ? Infinity : shantenSevenPairs(c);
    });
  }
  // ---- 指定面子類：一定要有某幾組面子（或雀頭），其餘照一般形 ----
  // 向聽數 = 指定的面子還缺幾張 ＋ 其餘部分（扣掉指定面子用到的牌後）湊成剩下面子與雀頭的向聽數。
  // 兩者分開取最大值會低估（例如三組刻子都有了、剩下的牌還差很遠時也會算成聽牌），所以要相加。
  interface Need {
    kinds: TileKind[];
    pair?: boolean;
    /** 哪種鳴牌可以直接當作這組面子 */
    byMeld?: (m: Meld) => boolean;
  }
  const required = (needs: Need[]): Evaluator | null => {
    const free = [...melds];
    const open: Need[] = [];
    for (const n of needs) {
      const i = n.pair || !n.byMeld ? -1 : free.findIndex(n.byMeld);
      if (i >= 0) free.splice(i, 1);
      else open.push(n);
    }
    const setNeeds = needs.filter((n) => !n.pair).length;
    if (free.length > 4 - setNeeds) return null;
    const demand = countKinds(open.flatMap((n) => n.kinds));
    const hasPair = needs.some((n) => n.pair);
    const restMelds = setNeeds + free.length;
    const buf = new Array(KIND_COUNT).fill(0);
    return (c) => {
      let missing = 0;
      for (let k = 0; k < KIND_COUNT; k++) {
        if (!demand[k]) {
          buf[k] = c[k];
          continue;
        }
        if (c[k] + unseen[k] < demand[k]) return Infinity;
        const use = Math.min(c[k], demand[k]);
        missing += demand[k] - use;
        buf[k] = c[k] - use;
      }
      return missing + shantenStandard(buf, restMelds, hasPair);
    };
  };
  const anyOf = (evals: (Evaluator | null)[]): Evaluator | null => {
    const ok = evals.filter((e): e is Evaluator => !!e);
    if (!ok.length) return null;
    return (c) => {
      let best = Infinity;
      for (const e of ok) best = Math.min(best, e(c));
      return best;
    };
  };
  const triplet = (k: TileKind, byMeld: (m: Meld) => boolean = (m) => m.type !== 'chi' && kindOf(m.tiles[0]) === k): Need => ({ kinds: [k, k, k], byMeld });
  const pairOf = (k: TileKind): Need => ({ kinds: [k, k], pair: true });
  const chiStart = (m: Meld) => Math.min(...m.tiles.map(kindOf));
  const sequence = (b: TileKind): Need => ({ kinds: [b, b + 1, b + 2], byMeld: (m) => m.type === 'chi' && chiStart(m) === b });

  // 番牌（門風、三元牌的刻子）
  add('5.1', anyOf([...new Set([seatWind, 31, 32, 33])].map((k) => required([triplet(k)]))));
  // 三元：大三元三組刻子；小三元兩組刻子＋一組雀頭
  const dragons = [31, 32, 33];
  add('5.2.2', required(dragons.map((k) => triplet(k))));
  add('5.2.1', anyOf(dragons.map((p) => required(dragons.map((k) => (k === p ? pairOf(k) : triplet(k)))))));
  if (advanced) {
    // 一氣通貫／三色同順：固定的三組順子
    add('8.1', anyOf([0, 1, 2].map((s) => required([sequence(s * 9), sequence(s * 9 + 3), sequence(s * 9 + 6)]))));
    add('9.2', anyOf([0, 1, 2, 3, 4, 5, 6].map((n) => required([sequence(n), sequence(9 + n), sequence(18 + n)]))));
  }
  // 三暗刻：三組暗刻（暗槓也算，碰的不算）。候選是手上最多的幾種牌（湊得到 3 張的），取最好的三種組合
  {
    const counts0 = countKinds(concealed);
    const isAnkan = (k: TileKind) => (m: Meld) => m.type === 'ankan' && kindOf(m.tiles[0]) === k;
    const cands = [
      ...new Set([
        ...melds.filter((m) => m.type === 'ankan').map((m) => kindOf(m.tiles[0])),
        ...counts0
          .map((n, k) => ({ n, k }))
          .filter(({ n, k }) => n > 0 && n + unseen[k] >= 3)
          .sort((a, b) => b.n - a.n)
          .slice(0, 5)
          .map(({ k }) => k),
      ]),
    ];
    const combos: TileKind[][] = [];
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) for (let l = j + 1; l < cands.length; l++) combos.push([cands[i], cands[j], cands[l]]);
    add('4.2.3', anyOf(combos.map((ks) => required(ks.map((k) => triplet(k, isAnkan(k)))))));
  }

  // 五門齊：萬、筒、索、風、三元五類都要有，又只有四面子一雀頭，所以剛好每類一組（其中一類是雀頭）。
  // 每類各自算湊成一組面子（或雀頭）還缺幾張，加總就是要摸的張數
  {
    const catOf = (k: TileKind) => (isWind(k) ? 3 : isDragon(k) ? 4 : suitOf(k));
    const kindsOf = (cat: number) => Array.from({ length: KIND_COUNT }, (_, k) => k).filter((k) => catOf(k) === cat);
    const meldCats = melds.map((m) => catOf(kindOf(m.tiles[0])));
    const covered = [0, 1, 2, 3, 4].map((cat) => meldCats.filter((x) => x === cat).length);
    if (covered.every((n) => n <= 1)) {
      // 先算好每類的候選：刻子、順子（數牌）與雀頭的牌種，評估時不配置記憶體
      const cats = [0, 1, 2, 3, 4].map((cat) => kindsOf(cat));
      const triCost = (c: number[], k: TileKind) => (c[k] + unseen[k] < 3 ? Infinity : 3 - Math.min(3, c[k]));
      const pairCostOf = (c: number[], k: TileKind) => (c[k] + unseen[k] < 2 ? Infinity : 2 - Math.min(2, c[k]));
      const seqCost = (c: number[], b: TileKind) => {
        let missing = 0;
        for (let k = b; k < b + 3; k++) {
          if (c[k] > 0) continue;
          if (unseen[k] <= 0) return Infinity;
          missing++;
        }
        return missing;
      };
      const setCost = new Array(5).fill(0);
      const pairCost = new Array(5).fill(0);
      add('3.0', (c) => {
        for (let cat = 0; cat < 5; cat++) {
          if (covered[cat]) {
            setCost[cat] = 0;
            pairCost[cat] = Infinity;
            continue;
          }
          let sc = Infinity;
          let pc = Infinity;
          for (const k of cats[cat]) {
            sc = Math.min(sc, triCost(c, k));
            pc = Math.min(pc, pairCostOf(c, k));
            if (cat < 3 && k % 9 <= 6) sc = Math.min(sc, seqCost(c, k));
          }
          setCost[cat] = sc;
          pairCost[cat] = pc;
        }
        let best = Infinity;
        for (let p = 0; p < 5; p++) {
          let total = pairCost[p];
          for (let cat = 0; cat < 5; cat++) if (cat !== p) total += setCost[cat];
          best = Math.min(best, total);
        }
        // 要摸的張數減一就是向聽數
        return best - 1;
      });
    }
  }

  if (melds.every((m) => m.type === 'ankan')) add('4.2.4', triplets);
  // 十三么九：每種么九牌都要有，其中一種成對
  if (advanced && mc === 0) {
    const yaochu = Array.from({ length: KIND_COUNT }, (_, k) => k).filter(isYaochu);
    add('11.2', (c) => (yaochu.some((k) => reach(c, k) < 1) || !yaochu.some((k) => reach(c, k) >= 2) ? Infinity : shantenThirteenOrphans(c)));
  }
  return targets;
}

interface Ranked {
  target: Target;
  rec: Recommendation;
}

/** 每個牌型（含同一牌型的不同花色）的牌效率與期望值，依期望值排序 */
function rankTargets(input: RecommendInput): Ranked[] {
  const { concealed, melds } = input;
  const counts = countKinds(concealed);
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...concealed, ...meldKinds.flat()]);
  const drawn = concealed.length % 3 === 2;
  const unseen = visible.reduce((a, v) => a + Math.max(0, 4 - v), 0);
  const draws = input.drawsLeft ?? 12;
  const baseScore = input.baseScore ?? 0;
  const minWin = input.minWinScore ?? 0;
  const std: Evaluator = (c) => shantenStandard(c, melds.length);
  const base = efficiency([...counts], std, visible, drawn).shanten;

  const out: Ranked[] = [];
  for (const t of buildTargets(input)) {
    const def = YAKU[t.id];
    if (minWin > 0 && def.points + baseScore < minWin) continue;
    const e = efficiency([...counts], t.evaluate, visible, drawn);
    if (!Number.isFinite(e.shanten) || e.shanten > base + 3) continue;
    const winRate = winProbability(e.shanten, e.ukeire, unseen, draws, t.callable, input.playerCount);
    out.push({
      target: t,
      rec: {
        id: t.id,
        name: def.name,
        points: def.points,
        shanten: e.shanten,
        ukeire: e.ukeire,
        discard: 'discard' in e ? e.discard : undefined,
        callable: t.callable,
        winRate,
        ev: winRate * (def.points + baseScore),
      },
    });
  }
  // 排序：期望值。期望值相同（例如都幾乎不可能）時看向聽數、有效牌與分數
  return out.sort((a, b) => b.rec.ev - a.rec.ev || a.rec.shanten - b.rec.shanten || b.rec.ukeire - a.rec.ukeire || b.rec.points - a.rec.points);
}

export function recommendYaku(input: RecommendInput, limit = 5): Recommendation[] {
  // 同一牌型（例如三種花色的清一色）只留期望值最高的
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const { rec } of rankTargets(input)) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  return out.slice(0, limit);
}

/** 依序比較，第一個不同的值比較小 */
function lexLess(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * 換三張：以期望值最高的牌型為目標，一張一張挑出對它最沒用的牌
 * （拿掉後目標牌型的向聽數最小、有效牌最多；同分時看一般形的向聽數）。
 */
export function suggestPass(input: RecommendInput, count = 3): TileKind[] {
  const counts = countKinds(input.concealed);
  const meldKinds = input.melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...input.concealed, ...meldKinds.flat()]);
  const std: Evaluator = (c) => shantenStandard(c, input.melds.length);
  const goal = rankTargets(input)[0]?.target.evaluate ?? std;
  const ukeireOf = (evaluate: Evaluator, s: number) => {
    let total = 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      const left = 4 - visible[k];
      if (left <= 0) continue;
      counts[k]++;
      if (evaluate(counts) < s) total += left;
      counts[k]--;
    }
    return total;
  };
  const out: TileKind[] = [];
  for (let i = 0; i < count; i++) {
    let best: { k: TileKind; key: number[] } | null = null;
    for (let k = 0; k < KIND_COUNT; k++) {
      if (!counts[k]) continue;
      counts[k]--;
      const g = goal(counts);
      const key = [g, -ukeireOf(goal, g), std(counts)];
      counts[k]++;
      if (!best || lexLess(key, best.key)) best = { k, key };
    }
    if (!best) break;
    out.push(best.k);
    counts[best.k]--;
  }
  return out;
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
