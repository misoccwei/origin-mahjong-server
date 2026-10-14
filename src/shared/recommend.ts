import type { Meld } from './rules.js';
import { YAKU } from './scoring.js';
import { shantenSevenPairs, shantenStandard, shantenThirteenOrphans } from './shanten.js';
import { KIND_COUNT, countKinds, isDragon, isHonor, isWind, isYaochu, kindOf, suitOf, type TileKind } from './tiles.js';

// 推薦牌型：以「牌效率」與「期望值」評估各牌型。
// 每個牌型有一個評估函式：給定手牌計數，回傳朝這個牌型做牌的向聽數（不可能時為 Infinity）。
// 再算有效牌（還沒看到的牌中，摸到能讓這個牌型向聽數下降的張數）；
// 輪到自己（手上多一張）時，替每個牌型找出打哪張最好（向聽數最小、和牌率最高）。
// 和牌率分兩種算法：
// - 一般（清一色、混一色、斷么九、全帶么九等只限定牌種的牌型）：依向聽數與有效牌，越接近和牌有效牌越少（以模擬擬合）；
// - 一定要拿到某幾張特定牌的牌型（番牌、三元、一氣通貫、三色同順、三暗刻、七對子、碰碰和、四暗刻、十三么九、五門齊）：
//   算這些特定牌在剩下的巡數內拿得到的機率（剩幾張、能不能碰／吃），再乘上其餘部分的一般和牌率。
//   這類牌型的有效牌多半是「其餘部分」的牌，只看有效牌會嚴重高估（例如只有一張中，番牌卻有幾十張有效牌）。
// 可吃碰的牌型另外計入他家打出的機會，門清牌型（七對子、暗刻類、十三么九）只能自己摸進來，只有最後聽牌時能銃和。
// 期望值 = 和牌率 ×（牌型分數＋底分）；未達和牌最低分數的牌型不推薦。
// 同一牌型有多種做法時（例如三種花色的清一色、各種牌的番牌、各個數字的三色同順）分開評估，只列出最好的一種。

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
  /** 有效牌的種類（打掉 discard 後，摸到會讓向聽數下降、還有剩的牌） */
  wanted: TileKind[];
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

/** 估計和牌率需要的局面資訊 */
export interface Odds {
  /** 自己還能摸幾次 */
  draws: number;
  /** 還沒看到的牌總張數 */
  unseen: number;
  /** 人數 */
  players: number;
}

/** 依特定牌估計的和牌率（手牌為 13 張減去鳴牌、已經打掉多的那張） */
type Chance = (counts: number[], odds: Odds) => number;

export interface Target {
  id: string;
  evaluate: Evaluator;
  /** 可以靠吃碰做牌 */
  callable: boolean;
  /** 一定要拿到某幾張特定牌的牌型：依這些牌拿得到的機率估計和牌率；沒有時用一般模型 */
  chance?: Chance;
  /** 一般模型：聽牌時大約剩幾張有效牌（未指定時用 TENPAI_UKEIRE） */
  tenpai?: number;
}

/** 只能門清（自己摸進來）的牌型 */
const CONCEALED_ONLY = new Set(['11.1', '11.2', '4.2.3', '4.2.4']);

/** 他家打出一張牌、自己能鳴到的折扣（他家會留牌，也不一定輪得到） */
const CALL_RATE = 0.3;
/** 每巡每位他家先和牌的機率 */
const OTHER_WIN_RATE = 0.03;
/** 一般模型：聽牌時大約剩幾張有效牌、從目前的有效牌遞減到聽牌時的曲線（以模擬自摸打牌擬合） */
const TENPAI_UKEIRE = 9.5;
const UKEIRE_DECAY = 2.3;
/** 只限定牌種的牌型（清一色、混一色、斷么九、字一色）：不合的牌打掉就好，實際進展比一般手牌快，聽牌時的有效牌也較多（模擬擬合） */
const RESTRICTED_TENPAI_UKEIRE = 12.5;

/**
 * 一般和牌率：還差 shanten + 1 步。每巡自己摸一次，摸到有效牌的機率 p = 有效牌 ÷ 未見牌；
 * 越接近和牌有效牌越少：第一步用目前的有效牌，最後一步（聽牌）大約剩 TENPAI_UKEIRE 張，中間依曲線遞減。
 * 可吃碰的牌型（或已聽牌、可以銃和時）每巡另外有他家打出有效牌的機會（打 CALL_RATE 折）；
 * 每巡也有一定機率被他家先和走。
 */
export function winProbability(shanten: number, ukeire: number, unseen: number, draws: number, callable: boolean, players = 4, tenpaiUkeire = TENPAI_UKEIRE): number {
  if (shanten < 0) return 1;
  if (ukeire <= 0 || unseen <= 0 || draws <= 0) return 0;
  const steps = shanten + 1;
  const tail = Math.min(ukeire, tenpaiUkeire);
  // r = 還差幾步
  return chain(steps, (r) => (steps === 1 ? ukeire : tail + (ukeire - tail) * ((r - 1) / (steps - 1)) ** UKEIRE_DECAY) / unseen, draws, callable, players);
}

/**
 * 一步一步前進的和牌率：還差 steps 步，還差 r 步時每巡自己摸到有效牌的機率為 pOf(r)。
 * 可吃碰（或已聽牌、可以銃和時）每巡另外有他家打出有效牌的機會（打 CALL_RATE 折）；每巡也有一定機率被他家先和走。
 */
function chain(steps: number, pOf: (r: number) => number, draws: number, callable: boolean, players: number): number {
  const others = Math.max(0, players - 1);
  const survive = 1 - OTHER_WIN_RATE * others;
  let dp = new Array(steps + 1).fill(0);
  dp[steps] = 1;
  for (let t = 0; t < draws; t++) {
    const next = new Array(steps + 1).fill(0);
    next[0] = dp[0];
    for (let r = 1; r <= steps; r++) {
      if (!dp[r]) continue;
      const m0 = dp[r] * survive;
      const p = Math.min(1, pOf(r));
      // 自己摸牌
      for (const [state, m] of [[r - 1, m0 * p], [r, m0 * (1 - p)]] as const) {
        // 他家打出的牌：吃碰（或聽牌時銃和）
        if (state > 0 && (callable || state === 1)) {
          const q = 1 - (1 - Math.min(1, pOf(state)) * CALL_RATE) ** others;
          next[state - 1] += m * q;
          next[state] += m * (1 - q);
        } else next[state] += m;
      }
    }
    dp = next;
  }
  return dp[0];
}

/** 某張還沒看到的牌，在剩下的巡數內被自己摸到的機率 */
const drawChance = (o: Odds) => Math.min(1, o.draws / Math.max(1, o.unseen));
/** 同上，再加上他家打出來可以鳴到（碰：任何一家；吃：只有上家） */
const callChance = (o: Odds, from: number) => {
  const others = Math.min(from, Math.max(0, o.players - 1));
  return 1 - (1 - drawChance(o)) * (1 - Math.min(1, (CALL_RATE * o.draws * others) / Math.max(1, o.unseen)));
};
/** 這段時間沒有被他家先和走的機率（大約在剩下巡數的一半時和牌） */
const survival = (o: Odds) => (1 - OTHER_WIN_RATE * Math.max(0, o.players - 1)) ** (o.draws / 2);

/** left 張中至少拿到 n 張（每張各自以機率 p 拿到） */
function atLeast(left: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (left < n) return 0;
  let below = 0;
  let comb = 1;
  for (let j = 0; j < n; j++) {
    below += comb * p ** j * (1 - p) ** (left - j);
    comb = (comb * (left - j)) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

/**
 * 湊成刻子還缺 need 張、能不能碰時，拿得到的機率：
 * 手上已有一對（只缺一張）時他家打出也能碰；缺兩張時第一張要自己摸，第二張才能碰，取兩者的平均。
 */
function tripletChance(left: number, need: number, o: Odds, pon: boolean) {
  const self = drawChance(o);
  const call = pon ? callChance(o, Math.max(0, o.players - 1)) : self;
  return atLeast(left, need, need <= 1 ? call : (self + call) / 2);
}

interface Efficiency {
  shanten: number;
  ukeire: number;
  discard?: TileKind;
  /** 打完牌後（13 張減去鳴牌）的手牌計數 */
  after?: number[];
}

/** 某個評估函式的有效牌：還沒看到的牌中，摸到後向聽數下降的張數 */
/** 有效牌的種類（只在最後列出推薦時算，不放在評估迴圈裡） */
function wantedKinds(c: number[] | undefined, s: number, evaluate: Evaluator, visible: number[]): TileKind[] {
  if (!c || !Number.isFinite(s) || s < 0) return [];
  const out: TileKind[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    if (4 - visible[k] <= 0) continue;
    c[k]++;
    if (evaluate(c) < s) out.push(k);
    c[k]--;
  }
  return out;
}

function ukeireOf(c: number[], s: number, evaluate: Evaluator, visible: number[]) {
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    const left = 4 - visible[k];
    if (left <= 0) continue;
    c[k]++;
    if (evaluate(c) < s) total += left;
    c[k]--;
  }
  return total;
}

/**
 * 對某個評估函式：目前（或打掉最佳的一張後）的向聽數、有效牌、建議打的牌。
 * 打哪張：向聽數最小，再比 better（例如和牌率），最後比有效牌。
 */
function efficiency(counts: number[], evaluate: Evaluator, visible: number[], drawn: boolean, better?: (c: number[], s: number, u: number) => number): Efficiency {
  if (!drawn) {
    const s = evaluate(counts);
    return { shanten: s, ukeire: Number.isFinite(s) ? ukeireOf(counts, s, evaluate, visible) : 0, after: counts };
  }
  // 已和牌形（-1）時不需要打牌
  if (evaluate(counts) < 0) return { shanten: -1, ukeire: 0 };
  let best: (Efficiency & { score: number }) | null = null;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (!counts[k]) continue;
    counts[k]--;
    const s = evaluate(counts);
    if (Number.isFinite(s) && (!best || s <= best.shanten)) {
      const u = ukeireOf(counts, s, evaluate, visible);
      const score = better ? better(counts, s, u) : 0;
      if (!best || s < best.shanten || score > best.score || (score === best.score && u > best.ukeire)) {
        best = { shanten: s, ukeire: u, discard: k, after: [...counts], score };
      }
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
 * 同一牌型有多種做法時（花色、哪一種番牌、三色同順的數字…）各列一個目標，id 相同。
 */
export function buildTargets(input: RecommendInput): Target[] {
  const { concealed, melds, seatWind, advanced } = input;
  const meldKinds = melds.map((m) => m.tiles.map(kindOf));
  const mc = melds.length;
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
  /** 湊得到 n 張以上的牌種數 */
  const kindsReaching = (c: number[], n: number) => {
    let total = 0;
    for (let k = 0; k < KIND_COUNT; k++) if (reach(c, k) >= n) total++;
    return total;
  };

  const targets: Target[] = [];
  const add = (id: string, evaluate: Evaluator | null, chance?: Chance, tenpai?: number) =>
    evaluate && targets.push({ id, evaluate, callable: !CONCEALED_ONLY.has(id), chance, tenpai });
  const addRestricted = (id: string, ok: (k: TileKind) => boolean) => add(id, restricted(ok), undefined, RESTRICTED_TENPAI_UKEIRE);

  // 花色類
  for (let s = 0; s < 3; s++) {
    addRestricted('3.1.3', (k) => !isHonor(k) && suitOf(k) === s);
    addRestricted('3.1.2', (k) => isHonor(k) || suitOf(k) === s);
  }
  addRestricted('3.1.4', isHonor);
  // 么九類
  addRestricted('2.0', (k) => !isYaochu(k));
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
  /** 和牌率：手上的對子、孤張各自湊成刻子（或只湊成對子）的機率，要湊滿刻子並留一組雀頭 */
  const tripletsChance = (pon: boolean): Chance => (c, o) => {
    const need = 4 - mc;
    let tri = 0;
    for (let k = 0; k < KIND_COUNT; k++) if (c[k] >= 3) tri++;
    // dp[t * 2 + p]：湊成 t 組刻子（最多 need）、p = 有沒有雀頭
    let dp = new Array((need + 1) * 2).fill(0);
    dp[Math.min(tri, need) * 2 + (tri > need ? 1 : 0)] = 1;
    // 手牌張數有限，同時只能留住幾組候選：取湊成刻子機率最高的（還缺的刻子＋雀頭＋一組備用）
    const cands: { p3: number; p2: number }[] = [];
    for (let k = 0; k < KIND_COUNT; k++) {
      if (c[k] !== 1 && c[k] !== 2) continue;
      const p3 = tripletChance(unseen[k], 3 - c[k], o, pon);
      cands.push({ p3, p2: c[k] === 2 ? 1 - p3 : Math.max(0, atLeast(unseen[k], 1, drawChance(o)) - p3) });
    }
    cands.sort((a, b) => b.p3 - a.p3 || b.p2 - a.p2);
    for (const { p3, p2 } of cands.slice(0, Math.max(0, need - Math.min(tri, need)) + 2)) {
      const next = new Array(dp.length).fill(0);
      for (let t = 0; t <= need; t++) {
        for (let p = 0; p < 2; p++) {
          const m = dp[t * 2 + p];
          if (!m) continue;
          // 多出來的刻子可以拆成雀頭
          next[(t < need ? (t + 1) * 2 + p : t * 2 + 1)] += m * p3;
          next[t * 2 + 1] += m * p2;
          next[t * 2 + p] += m * (1 - p3 - p2);
        }
      }
      dp = next;
    }
    return dp[need * 2 + 1] * survival(o);
  };
  if (melds.every((m) => m.type !== 'chi')) add('4.1', triplets, tripletsChance(true));
  // 七對子：四張同種可以當兩組對子。和牌率：還缺的對子由手上的單張各自摸到第二張
  if (advanced && mc === 0) {
    add(
      '11.1',
      (c) => {
        let pairs = 0;
        for (let k = 0; k < KIND_COUNT; k++) pairs += Math.floor(reach(c, k) / 2);
        return pairs < 7 ? Infinity : shantenSevenPairs(c);
      },
      // 和牌率：手牌只有 13 張，每湊成一對就要打掉另一張單張，還差 r 對時手上只剩 2r − 1 張單張可以等
      // （留剩最多張的），每巡摸到其中之一的機率 = 這些單張剩下的張數 ÷ 未見牌
      (c, o) => {
        let pairs = 0;
        const lefts: number[] = [];
        for (let k = 0; k < KIND_COUNT; k++) {
          pairs += Math.floor(c[k] / 2);
          if (c[k] % 2 && unseen[k] > 0) lefts.push(unseen[k]);
        }
        const steps = 7 - Math.min(7, pairs);
        if (!steps) return 1;
        lefts.sort((a, b) => b - a);
        // 單張不夠時，從還沒有的牌種湊（要摸兩張，算一半）
        const waitOf = (r: number) => {
          let total = 0;
          for (let i = 0; i < 2 * r - 1; i++) total += i < lefts.length ? lefts[i] : 1;
          return total / o.unseen;
        };
        return chain(steps, waitOf, o.draws, false, o.players);
      },
    );
  }
  // ---- 指定面子類：一定要有某幾組面子（或雀頭），其餘照一般形 ----
  // 向聽數 = 指定的面子還缺幾張 ＋ 其餘部分（扣掉指定面子用到的牌後）湊成剩下面子與雀頭的向聽數。
  // 兩者分開取最大值會低估（例如三組刻子都有了、剩下的牌還差很遠時也會算成聽牌），所以要相加。
  // 和牌率 = 指定的牌都拿得到的機率（刻子可以碰、順子可以吃上家）× 其餘部分的一般和牌率。
  interface Need {
    kinds: TileKind[];
    pair?: boolean;
    /** 哪種鳴牌可以直接當作這組面子 */
    byMeld?: (m: Meld) => boolean;
  }
  /** selfOnly：門清牌型（三暗刻），指定的牌都要自己摸 */
  const required = (id: string, needs: Need[], selfOnly = false) => {
    const free = [...melds];
    const open: Need[] = [];
    for (const n of needs) {
      const i = n.pair || !n.byMeld ? -1 : free.findIndex(n.byMeld);
      if (i >= 0) free.splice(i, 1);
      else open.push(n);
    }
    const setNeeds = needs.filter((n) => !n.pair).length;
    if (free.length > 4 - setNeeds) return;
    const demand = countKinds(open.flatMap((n) => n.kinds));
    /** 每種指定的牌屬於哪一組（拿牌的方式：雀頭自己摸、刻子可以碰、順子可以吃） */
    const groupOf: (Need | undefined)[] = new Array(KIND_COUNT);
    for (const n of open) for (const k of n.kinds) groupOf[k] = n;
    const hasPair = needs.some((n) => n.pair);
    const restMelds = setNeeds + free.length;
    const buf = new Array(KIND_COUNT).fill(0);
    /** 扣掉指定面子用到的牌，回傳還缺的張數（不可能時 Infinity）；其餘的牌留在 buf */
    const split = (c: number[]) => {
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
      return missing;
    };
    add(
      id,
      (c) => {
        const missing = split(c);
        return Number.isFinite(missing) ? missing + shantenStandard(buf, restMelds, hasPair) : Infinity;
      },
      (c, o) => {
        if (!Number.isFinite(split(c))) return 0;
        let p = 1;
        for (let k = 0; k < KIND_COUNT; k++) {
          const miss = demand[k] - Math.min(c[k], demand[k]);
          if (miss <= 0) continue;
          const g = groupOf[k]!;
          if (selfOnly || g.pair) p *= atLeast(unseen[k], miss, drawChance(o));
          else if (g.kinds[0] === g.kinds[2]) p *= tripletChance(unseen[k], miss, o, true);
          else {
            // 順子只缺這一張時上家打出可以吃；缺兩張以上時先要自己摸一張，取平均
            const seqMiss = g.kinds.filter((x) => c[x] === 0).length;
            const chi = callChance(o, 1);
            p *= atLeast(unseen[k], 1, seqMiss <= 1 ? chi : (drawChance(o) + chi) / 2);
          }
        }
        if (!p) return 0;
        const sR = shantenStandard(buf, restMelds, hasPair);
        if (sR < 0) return p * survival(o);
        // 其餘部分的有效牌：指定的面子還缺的牌已經算在上面，不重複算（例如一氣通貫的其餘部分也是萬子時）
        let uR = 0;
        for (let k = 0; k < KIND_COUNT; k++) {
          const avail = unseen[k] - Math.max(0, demand[k] - c[k]);
          if (avail <= 0) continue;
          buf[k]++;
          if (shantenStandard(buf, restMelds, hasPair) < sR) uR += avail;
          buf[k]--;
        }
        return p * winProbability(sR, uR, o.unseen, o.draws, !selfOnly, o.players);
      },
    );
  };
  const triplet = (k: TileKind, byMeld: (m: Meld) => boolean = (m) => m.type !== 'chi' && kindOf(m.tiles[0]) === k): Need => ({ kinds: [k, k, k], byMeld });
  const pairOf = (k: TileKind): Need => ({ kinds: [k, k], pair: true });
  const chiStart = (m: Meld) => Math.min(...m.tiles.map(kindOf));
  const sequence = (b: TileKind): Need => ({ kinds: [b, b + 1, b + 2], byMeld: (m) => m.type === 'chi' && chiStart(m) === b });

  // 番牌（門風、三元牌的刻子）
  for (const k of new Set([seatWind, 31, 32, 33])) required('5.1', [triplet(k)]);
  // 三元：大三元三組刻子；小三元兩組刻子＋一組雀頭
  const dragons = [31, 32, 33];
  required('5.2.2', dragons.map((k) => triplet(k)));
  for (const p of dragons) required('5.2.1', dragons.map((k) => (k === p ? pairOf(k) : triplet(k))));
  if (advanced) {
    // 一氣通貫／三色同順：固定的三組順子
    for (let s = 0; s < 3; s++) required('8.1', [sequence(s * 9), sequence(s * 9 + 3), sequence(s * 9 + 6)]);
    for (let n = 0; n < 7; n++) required('9.2', [sequence(n), sequence(9 + n), sequence(18 + n)]);
  }
  // 三暗刻：三組暗刻（暗槓也算，碰的不算）。候選是手上最多的幾種牌（湊得到 3 張的），每三種一個目標
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
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        for (let l = j + 1; l < cands.length; l++) required('4.2.3', [cands[i], cands[j], cands[l]].map((k) => triplet(k, isAnkan(k))), true);
      }
    }
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
      const setP = new Array(5).fill(0);
      const pairP = new Array(5).fill(0);
      add(
        '3.0',
        (c) => {
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
        },
        // 和牌率：每類湊成一組面子（或雀頭）的機率（各種湊法任一成功），其中一類當雀頭
        (c, o) => {
          const self = drawChance(o);
          const chi = callChance(o, 1);
          for (let cat = 0; cat < 5; cat++) {
            if (covered[cat]) {
              setP[cat] = 1;
              pairP[cat] = 0;
              continue;
            }
            // 各種湊法彼此重疊（例如 234、345 共用牌），手牌也留不了那麼多：只取最好的兩種，視為任一成功即可
            let s1 = 0;
            let s2 = 0;
            let p1 = 0;
            let p2 = 0;
            const set = (p: number) => (p > s1 ? ((s2 = s1), (s1 = p)) : p > s2 && (s2 = p));
            for (const k of cats[cat]) {
              if (c[k] + unseen[k] >= 3) set(tripletChance(unseen[k], 3 - Math.min(3, c[k]), o, true));
              if (c[k] + unseen[k] >= 2) {
                const p = atLeast(unseen[k], 2 - Math.min(2, c[k]), self);
                if (p > p1) (p2 = p1), (p1 = p);
                else if (p > p2) p2 = p;
              }
              if (cat < 3 && k % 9 <= 6 && Number.isFinite(seqCost(c, k))) {
                const miss = seqCost(c, k);
                let p = 1;
                for (let x = k; x < k + 3; x++) if (!c[x]) p *= atLeast(unseen[x], 1, miss <= 1 ? chi : (self + chi) / 2);
                set(p);
              }
            }
            setP[cat] = 1 - (1 - s1) * (1 - s2);
            pairP[cat] = 1 - (1 - p1) * (1 - p2);
          }
          let best = 0;
          for (let p = 0; p < 5; p++) {
            let prod = pairP[p];
            for (let cat = 0; cat < 5; cat++) if (cat !== p) prod *= setP[cat];
            best = Math.max(best, prod);
          }
          return best * survival(o);
        },
      );
    }
  }

  if (melds.every((m) => m.type === 'ankan')) add('4.2.4', triplets, tripletsChance(false));
  // 十三么九：每種么九牌都要有，其中一種成對
  if (advanced && mc === 0) {
    const yaochu = Array.from({ length: KIND_COUNT }, (_, k) => k).filter(isYaochu);
    add(
      '11.2',
      (c) => (yaochu.some((k) => reach(c, k) < 1) || !yaochu.some((k) => reach(c, k) >= 2) ? Infinity : shantenThirteenOrphans(c)),
      (c, o) => {
        const self = drawChance(o);
        let p = 1;
        let pair = false;
        let noPair = 1;
        for (const k of yaochu) {
          if (!c[k]) p *= atLeast(unseen[k], 1, self);
          else {
            if (c[k] >= 2) pair = true;
            noPair *= (1 - self) ** unseen[k];
          }
        }
        return p * (pair ? 1 : 1 - noPair) * survival(o);
      },
    );
  }
  return targets;
}

interface Ranked {
  target: Target;
  rec: Omit<Recommendation, 'wanted'>;
  /** 打完牌後的手牌計數與看得到的牌（算有效牌種類用） */
  after?: number[];
  visible: number[];
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

  const odds: Odds = { draws, unseen, players: input.playerCount ?? 4 };

  const out: Ranked[] = [];
  for (const t of buildTargets(input)) {
    const def = YAKU[t.id];
    if (minWin > 0 && def.points + baseScore < minWin) continue;
    const chance = t.chance;
    const e = efficiency([...counts], t.evaluate, visible, drawn, chance && ((c) => chance(c, odds)));
    if (!Number.isFinite(e.shanten) || e.shanten > base + 3) continue;
    const winRate =
      e.shanten < 0 ? 1 : chance ? chance(e.after!, odds) : winProbability(e.shanten, e.ukeire, unseen, draws, t.callable, odds.players, t.tenpai);
    out.push({
      target: t,
      after: e.after,
      visible,
      rec: {
        id: t.id,
        name: def.name,
        points: def.points,
        shanten: e.shanten,
        ukeire: e.ukeire,
        discard: e.discard,
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
  for (const { rec, target, after, visible } of rankTargets(input)) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push({ ...rec, wanted: wantedKinds(after && [...after], rec.shanten, target.evaluate, visible) });
    if (out.length >= limit) break;
  }
  return out;
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
  const out: TileKind[] = [];
  for (let i = 0; i < count; i++) {
    let best: { k: TileKind; key: number[] } | null = null;
    for (let k = 0; k < KIND_COUNT; k++) {
      if (!counts[k]) continue;
      counts[k]--;
      const g = goal(counts);
      const key = [g, -ukeireOf(counts, g, goal, visible), std(counts)];
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
export function fastestWin(input: RecommendInput): { shanten: number; ukeire: number; discard?: TileKind; wanted: TileKind[] } {
  const counts = countKinds(input.concealed);
  const meldKinds = input.melds.map((m) => m.tiles.map(kindOf));
  const visible = input.visible ?? countKinds([...input.concealed, ...meldKinds.flat()]);
  const mc = input.melds.length;
  const evaluate: Evaluator = (c) => {
    let s = shantenStandard(c, mc);
    if (input.advanced && mc === 0) s = Math.min(s, shantenSevenPairs(c));
    return s;
  };
  const { shanten, ukeire, discard, after } = efficiency(counts, evaluate, visible, input.concealed.length % 3 === 2);
  return { shanten, ukeire, discard, wanted: wantedKinds(after && [...after], shanten, evaluate, visible) };
}
