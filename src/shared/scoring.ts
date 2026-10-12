import {
  KIND_COUNT,
  countKinds,
  isDragon,
  isHonor,
  isTerminal,
  isWind,
  isYaochu,
  kindOf,
  numOf,
  suitOf,
  type TileKind,
} from './tiles.js';
import { isKanMeld, isOpenMeld, type Meld } from './rules.js';

// ---------------------------------------------------------------------------
// 和牌形拆解
// ---------------------------------------------------------------------------

export type GroupType = 'seq' | 'tri' | 'pair';

export interface Group {
  type: GroupType;
  /** 順子為最小的那張；刻子／對子為該牌種 */
  kind: TileKind;
  /** 明面子（吃／碰／明槓，或銃和時由捨牌完成的刻子） */
  open: boolean;
  /** 槓子（同時視為刻子） */
  kan: boolean;
}

/** 列出 counts 能拆成「若干面子 + 1 對子」的所有方式（皆為暗面子）。 */
export function decomposeStandard(counts: number[]): Group[][] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total % 3 !== 2) return [];
  const results: Group[][] = [];
  const c = [...counts];
  for (let p = 0; p < KIND_COUNT; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    const sets: Group[] = [];
    const dfs = () => {
      let i = 0;
      while (i < KIND_COUNT && c[i] === 0) i++;
      if (i === KIND_COUNT) {
        results.push([...sets, { type: 'pair', kind: p, open: false, kan: false }]);
        return;
      }
      if (c[i] >= 3) {
        c[i] -= 3;
        sets.push({ type: 'tri', kind: i, open: false, kan: false });
        dfs();
        sets.pop();
        c[i] += 3;
      }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--, c[i + 1]--, c[i + 2]--;
        sets.push({ type: 'seq', kind: i, open: false, kan: false });
        dfs();
        sets.pop();
        c[i]++, c[i + 1]++, c[i + 2]++;
      }
    };
    dfs();
    c[p] += 2;
  }
  return results;
}

export function isSevenPairs(counts: number[]): boolean {
  let pairs = 0;
  let total = 0;
  for (const n of counts) {
    total += n;
    if (n === 2) pairs += 1;
    else if (n === 4) pairs += 2; // 規則書牌例：四張同種可當兩組對子
    else if (n !== 0) return false;
  }
  return total === 14 && pairs === 7;
}

const YAOCHU_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function isThirteenOrphans(counts: number[]): boolean {
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    total += counts[k];
    if (counts[k] > 0 && !isYaochu(k)) return false;
  }
  return total === 14 && YAOCHU_KINDS.every((k) => counts[k] >= 1);
}

/**
 * 十三不搭（牌型擴充包）：十三種牌、其中一種成對；沒有面子也沒有搭子
 * （同花色數牌的數字至少差 3），數牌的數字彼此不同且為連續 9 種（1〜9）或連續 6 種。
 */
export function isThirteenUnrelated(counts: number[]): boolean {
  let total = 0;
  let pairs = 0;
  const digits: number[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    const n = counts[k];
    total += n;
    if (n > 2) return false;
    if (n === 2) pairs++;
    if (n && k < 27) digits.push((k % 9) + 1);
  }
  if (total !== 14 || pairs !== 1) return false;
  for (let s = 0; s < 3; s++) {
    let last = -9;
    for (let i = 0; i < 9; i++) {
      if (!counts[s * 9 + i]) continue;
      if (i - last < 3) return false; // 相鄰或隔一張：成為搭子
      last = i;
    }
  }
  const sorted = [...digits].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) return false;
  if (sorted.length !== 9 && sorted.length !== 6) return false;
  return sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
}

function meldToGroup(m: Meld): Group {
  const k = kindOf(m.tiles[0]);
  if (m.type === 'chi') {
    return { type: 'seq', kind: Math.min(...m.tiles.map(kindOf)), open: true, kan: false };
  }
  return { type: 'tri', kind: k, open: isOpenMeld(m), kan: isKanMeld(m) };
}

// ---------------------------------------------------------------------------
// 牌型表
// ---------------------------------------------------------------------------

export interface YakuDef {
  id: string;
  name: string;
  points: number;
  /** 同系列只取最高分 */
  series: string;
  category: number;
  /** 進階規則才有的牌型 */
  advanced?: boolean;
  /** 牌型擴充包的牌型 */
  expansion?: boolean;
  /** 每組加計（分數為每組的分數） */
  perGroup?: boolean;
}

export const YAKU: Record<string, YakuDef> = {};
function def(id: string, name: string, points: number, opts: boolean | { advanced?: boolean; expansion?: boolean; perGroup?: boolean } = false) {
  const parts = id.split('.');
  const o = typeof opts === 'boolean' ? { advanced: opts } : opts;
  YAKU[id] = { id, name, points, series: parts.slice(0, 2).join('.'), category: Number(parts[0]), ...o };
}

export const CATEGORY_NAMES: Record<number, string> = {
  1: '鳴牌類', 2: '么九類', 3: '花色類', 4: '刻槓類', 5: '字牌類', 6: '偶然類',
  7: '數字類', 8: '連續類', 9: '三色類', 10: '重複類', 11: '特殊類', 13: '對稱類',
};
// 1. 鳴牌類
def('1.0', '不求人', 5);
def('1.1', '全求人', 10);
// 2. 么九類
def('2.0', '斷么九', 5);
def('2.1', '全帶么九', 40);
def('2.2.1', '四清么', 10);
def('2.2.2', '六清么', 20);
def('2.2.3', '八清么', 40);
def('2.2.4', '十清么', 80);
def('2.2.5', '十二清么', 160);
def('2.2.6', '十四清么', 320);
// 3. 花色類
def('3.0', '五門齊', 20);
def('3.1.1', '缺一色', 5);
def('3.1.2', '混一色', 40);
def('3.1.3', '清一色', 80);
def('3.1.4', '字一色', 160);
// 4. 刻槓類
def('4.0', '平和', 5);
def('4.1', '碰碰和', 40);
def('4.2.1', '一暗刻', 5);
def('4.2.2', '二暗刻', 10);
def('4.2.3', '三暗刻', 40);
def('4.2.4', '四暗刻', 160);
def('4.3.1', '一槓子', 10);
def('4.3.2', '二槓子', 20);
def('4.3.3', '三槓子', 80);
def('4.3.4', '四槓子', 320);
// 5. 字牌類
def('5.1', '番牌', 10, { perGroup: true });
def('5.2.1', '小三元', 40);
def('5.2.2', '大三元', 160);
def('5.3.1', '小三風', 40);
def('5.3.2', '大三風', 80);
def('5.3.3', '小四喜', 160);
def('5.3.4', '大四喜', 320);
// 6. 偶然類
def('6.1.1', '搶槓', 10);
def('6.1.2', '嶺上開花', 10);
def('6.2.1', '河底撈魚', 10);
def('6.2.2', '海底撈月', 10);
def('6.3.1', '地和', 160);
def('6.3.2', '天和', 160);
// 7. 數字類
def('7.1.1', '五數鄰', 10, true);
def('7.1.2', '四數鄰', 40, true);
def('7.1.3', '三數鄰', 80, true);
def('7.1.4', '二數鄰', 160, true);
// 8. 連續類
def('8.1', '一氣通貫', 40, true);
def('8.2.1', '三連刻', 80, true);
def('8.2.2', '四連刻', 160, true);
def('8.3', '九蓮寶燈', 320, true);
// 9. 三色類
def('9.1', '三色通貫', 20, true);
def('9.2', '三色同順', 40, true);
def('9.3', '三色連刻', 40, true);
def('9.4', '三色同刻', 80, true);
// 10. 重複類
def('10.1.1', '一般高', 10, true);
def('10.1.2', '二般高', 80, true);
def('10.1.3', '三同順', 80, true);
def('10.1.4', '四同順', 320, true);
// 11. 特殊類
def('11.1', '七對子', 40, true);
def('11.2', '十三么九', 160, true);
// 牌型擴充包（規則書補頁草稿）。系列以編號前兩段判斷：例如小二元 5.2.0.1 與小三元 5.2.1 同一系列
const EXP = { expansion: true };
def('5.2.0.1', '小二元', 5, EXP);
def('5.2.0.2', '大二元', 10, EXP);
def('5.3.0.1', '小二風', 5, EXP);
def('5.3.0.2', '大二風', 10, EXP);
def('8.4.1', '連面子', 5, { expansion: true, perGroup: true });
def('8.4.2', '二龍戲', 40, EXP);
def('8.5.1', '三連環', 20, EXP);
def('8.5.2', '四連環', 80, EXP);
def('8.6.1', '三連跳', 40, EXP);
def('8.6.2', '四連跳', 160, EXP);
def('9.5.1', '鏡面子', 5, { expansion: true, perGroup: true });
def('9.5.2', '鏡同和', 40, EXP);
def('9.6', '三色連環', 10, EXP);
def('9.7', '三色連跳', 20, EXP);
def('10.2.1', '四歸一', 5, EXP);
def('10.2.2', '八歸一', 40, EXP);
def('10.2.3', '十二歸一', 320, EXP);
def('11.3', '十三不搭', 40, EXP);
def('13.1', '線對稱', 40, EXP);
def('13.2', '點對稱', 40, EXP);

export const LIMIT = 160; // 滿貫

export interface YakuHit {
  id: string;
  name: string;
  /** 此項合計分數（每組加計者為 單項分數 × count） */
  points: number;
  count: number;
}

export interface WinFlags {
  chankan?: boolean; // 搶槓
  rinshan?: boolean; // 嶺上開花
  houtei?: boolean; // 河底撈魚
  haitei?: boolean; // 海底撈月
  chiihou?: boolean; // 地和
  tenhou?: boolean; // 天和
}

export interface WinInput {
  /** 手牌（不含鳴牌），包含和牌的那張 */
  concealed: TileKind[];
  melds: Meld[];
  winTile: TileKind;
  tsumo: boolean;
  seatWind: TileKind;
  advanced: boolean;
  baseScore: number;
  flags?: WinFlags;
  /** 牌型擴充包 */
  expansion?: boolean;
}

export type WinForm = 'standard' | 'sevenPairs' | 'thirteenOrphans' | 'thirteenUnrelated';

export interface HandScore {
  form: WinForm;
  groups: Group[];
  yaku: YakuHit[];
  /** 牌型分數（已套用滿貫） */
  yakuPoints: number;
  /** 是否滿貫（累計達上限或單項 160 以上） */
  limit: boolean;
  baseScore: number;
  /** 和牌分數 = 底分 + 牌型分數 */
  total: number;
}

function hit(id: string, count = 1): YakuHit {
  const d = YAKU[id];
  return { id, name: d.name, points: d.points * count, count };
}

/** 根據牌型分數、套用「同系列取最高」與滿貫規則 */
function finalize(hits: YakuHit[], form: WinForm, groups: Group[], baseScore: number): HandScore {
  const bySeries = new Map<string, YakuHit>();
  for (const h of hits) {
    const s = YAKU[h.id].series;
    const prev = bySeries.get(s);
    if (!prev || h.points > prev.points) bySeries.set(s, h);
  }
  let yaku = [...bySeries.values()];
  const maxSingle = yaku.reduce((m, h) => Math.max(m, YAKU[h.id].points), 0);
  let yakuPoints: number;
  let limit = false;
  if (maxSingle >= LIMIT) {
    // 滿貫牌型：只取最高分的單項
    const top = yaku.filter((h) => YAKU[h.id].points >= LIMIT).sort((a, b) => b.points - a.points)[0];
    yaku = [top];
    yakuPoints = YAKU[top.id].points;
    limit = true;
  } else {
    const sum = yaku.reduce((a, h) => a + h.points, 0);
    yakuPoints = Math.min(sum, LIMIT);
    limit = sum >= LIMIT;
  }
  yaku.sort((a, b) => (YAKU[a.id].category - YAKU[b.id].category) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { form, groups, yaku, yakuPoints, limit, baseScore, total: baseScore + yakuPoints };
}

/** 與和牌形（面子拆法）無關、只看全部牌的牌型 */
function tileYaku(all: TileKind[], input: WinInput, hits: YakuHit[]) {
  const c = countKinds(all);
  // 2.0 斷么九
  if (all.every((k) => !isYaochu(k))) hits.push(hit('2.0'));
  // 2.2 清么（1、9 張數）
  const t = all.filter(isTerminal).length;
  const tiers: [number, string][] = [[14, '2.2.6'], [12, '2.2.5'], [10, '2.2.4'], [8, '2.2.3'], [6, '2.2.2'], [4, '2.2.1']];
  const tier = tiers.find(([n]) => t >= n);
  if (tier) hits.push(hit(tier[1]));
  const suits = new Set(all.filter((k) => !isHonor(k)).map(suitOf));
  const hasWind = all.some(isWind);
  const hasDragon = all.some(isDragon);
  // 3.1 花色
  const hasHonor = hasWind || hasDragon;
  if (suits.size === 0) hits.push(hit('3.1.4'));
  else if (suits.size === 1 && !hasHonor) hits.push(hit('3.1.3'));
  else if (suits.size === 1 && hasHonor) hits.push(hit('3.1.2'));
  // 缺一色不含字牌（規則書聽牌得分例：大三風手牌未計缺一色）
  else if (suits.size === 2 && !hasHonor) hits.push(hit('3.1.1'));
  // 1. 鳴牌類
  const openMelds = input.melds.filter(isOpenMeld).length;
  if (openMelds === 0) hits.push(hit('1.0'));
  if (openMelds === 4) hits.push(hit('1.1'));
  if (input.advanced) {
    // 7.1 數鄰：只有 N 個連續數字的數牌（不含字牌），而且範圍內每個數字都要出現（例如 7、9 沒有 8 不算三數鄰）
    if (!hasHonor) {
      const nums = new Set(all.map(numOf));
      const span = Math.max(...nums) - Math.min(...nums) + 1;
      const t7: Record<number, string> = { 2: '7.1.4', 3: '7.1.3', 4: '7.1.2', 5: '7.1.1' };
      if (nums.size === span && t7[span]) hits.push(hit(t7[span]));
    }
    // 8.3 九蓮寶燈：不鳴牌、清一色、含 1～9、1 與 9 各三張以上
    if (input.melds.length === 0 && suits.size === 1 && !hasHonor) {
      const s = [...suits][0] * 9;
      if (c[s] >= 3 && c[s + 8] >= 3 && [1, 2, 3, 4, 5, 6, 7].every((i) => c[s + i] >= 1)) hits.push(hit('8.3'));
    }
  }
  // 10.2 四歸一系列（擴充）：不是槓子的同種四張
  if (input.expansion) {
    const nonKan = countKinds([...input.concealed, ...input.melds.filter((m) => !isKanMeld(m)).flatMap((m) => m.tiles.map(kindOf))]);
    const fours = nonKan.filter((n) => n === 4).length;
    if (fours >= 3) hits.push(hit('10.2.3'));
    else if (fours === 2) hits.push(hit('10.2.2'));
    else if (fours === 1) hits.push(hit('10.2.1'));
  }
  // 6. 偶然類
  const f = input.flags ?? {};
  if (f.chankan) hits.push(hit('6.1.1'));
  if (f.rinshan) hits.push(hit('6.1.2'));
  if (f.houtei) hits.push(hit('6.2.1'));
  if (f.haitei) hits.push(hit('6.2.2'));
  if (f.chiihou) hits.push(hit('6.3.1'));
  if (f.tenhou) hits.push(hit('6.3.2'));
}

const containsYaochu = (g: Group) => (g.type === 'seq' ? numOf(g.kind) === 1 || numOf(g.kind) === 7 : isYaochu(g.kind));

/** 與面子拆法相關的牌型 */
function groupYaku(groups: Group[], input: WinInput, hits: YakuHit[]) {
  const sets = groups.filter((g) => g.type !== 'pair');
  const pair = groups.find((g) => g.type === 'pair')!;
  const seqs = sets.filter((g) => g.type === 'seq');
  const tris = sets.filter((g) => g.type === 'tri');

  // 2.1 全帶么九
  if (groups.every(containsYaochu)) hits.push(hit('2.1'));
  // 3.0 五門齊：四面子一雀頭，含三種數牌、風牌與三元牌（七對子、十三么九不計）
  const all = allTilesOf(input);
  if (new Set(all.filter((k) => !isHonor(k)).map(suitOf)).size === 3 && all.some(isWind) && all.some(isDragon)) hits.push(hit('3.0'));
  // 4.0 平和／4.1 碰碰和
  if (seqs.length === 4) hits.push(hit('4.0'));
  if (tris.length === 4) hits.push(hit('4.1'));
  // 4.2 暗刻（暗槓亦為暗刻）
  const concealedTris = tris.filter((g) => !g.open).length;
  const t42 = ['', '4.2.1', '4.2.2', '4.2.3', '4.2.4'][concealedTris];
  if (t42) hits.push(hit(t42));
  // 4.3 槓子
  const kans = tris.filter((g) => g.kan).length;
  const t43 = ['', '4.3.1', '4.3.2', '4.3.3', '4.3.4'][kans];
  if (t43) hits.push(hit(t43));
  // 5.1 番牌：門風或三元牌的刻子，每組加計
  const yakuhai = tris.filter((g) => g.kind === input.seatWind || isDragon(g.kind)).length;
  if (yakuhai) hits.push(hit('5.1', yakuhai));
  // 5.2 三元
  const dragonTris = tris.filter((g) => isDragon(g.kind)).length;
  if (dragonTris === 3) hits.push(hit('5.2.2'));
  else if (dragonTris === 2 && isDragon(pair.kind)) hits.push(hit('5.2.1'));
  // 5.3 風牌
  const windTris = tris.filter((g) => isWind(g.kind)).length;
  const windPair = isWind(pair.kind);
  if (windTris === 4) hits.push(hit('5.3.4'));
  else if (windTris === 3 && windPair) hits.push(hit('5.3.3'));
  else if (windTris === 3) hits.push(hit('5.3.2'));
  else if (windTris === 2 && windPair) hits.push(hit('5.3.1'));
  if (input.expansion) {
    // 二元、二風：與三元、風牌同系列，只取最高分
    if (dragonTris >= 2) hits.push(hit('5.2.0.2'));
    if (dragonTris >= 1 && isDragon(pair.kind)) hits.push(hit('5.2.0.1'));
    if (windTris >= 2) hits.push(hit('5.3.0.2'));
    if (windTris >= 1 && windPair) hits.push(hit('5.3.0.1'));
    expansionGroupYaku(groups, input, hits);
  }

  if (!input.advanced) return;

  const seqKeys = seqs.map((g) => g.kind);
  const numTris = tris.filter((g) => !isHonor(g.kind)).map((g) => g.kind);
  // 8.1 一氣通貫
  for (let s = 0; s < 3; s++) {
    if ([0, 3, 6].every((o) => seqKeys.includes(s * 9 + o))) hits.push(hit('8.1'));
  }
  // 8.2 連刻（同花色）
  const sortedTris = [...new Set(numTris)].sort((a, b) => a - b);
  let bestRun = 0;
  for (let i = 0; i < sortedTris.length; i++) {
    let run = 1;
    while (
      i + run < sortedTris.length &&
      sortedTris[i + run] === sortedTris[i] + run &&
      suitOf(sortedTris[i + run]) === suitOf(sortedTris[i])
    ) run++;
    bestRun = Math.max(bestRun, run);
  }
  if (bestRun >= 4) hits.push(hit('8.2.2'));
  else if (bestRun === 3) hits.push(hit('8.2.1'));
  // 9. 三色類
  const has3Suits = (items: TileKind[], nums: number[]) => {
    // 是否存在三種相異花色，分別擁有 nums[0]、nums[1]、nums[2]（數字順序可任意配對花色）
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    return perms.some((p) => nums.every((n, i) => items.includes(p[i] * 9 + n - 1)));
  };
  if (has3Suits(seqKeys, [1, 4, 7])) hits.push(hit('9.1'));
  for (let n = 1; n <= 7; n++) if (has3Suits(seqKeys, [n, n, n])) { hits.push(hit('9.2')); break; }
  for (let n = 1; n <= 7; n++) if (has3Suits(numTris, [n, n + 1, n + 2])) { hits.push(hit('9.3')); break; }
  for (let n = 1; n <= 9; n++) if (has3Suits(numTris, [n, n, n])) { hits.push(hit('9.4')); break; }
  // 10.1 重複類
  const seqCount = new Map<number, number>();
  for (const k of seqKeys) seqCount.set(k, (seqCount.get(k) ?? 0) + 1);
  const mult = [...seqCount.values()].sort((a, b) => b - a);
  if (mult[0] === 4) hits.push(hit('10.1.4'));
  else if (mult[0] === 3) hits.push(hit('10.1.3'));
  else if (mult[0] === 2 && mult[1] === 2) hits.push(hit('10.1.2'));
  else if (mult[0] === 2) hits.push(hit('10.1.1'));
}

/** 由小到大配對（每組只用一次）：a 與 a + step 配成一對；同花色的鏈狀關係用貪婪法即為最多對數 */
function countChainPairs(kinds: TileKind[], step: number): number {
  const c = new Map<TileKind, number>();
  for (const k of kinds) c.set(k, (c.get(k) ?? 0) + 1);
  let pairs = 0;
  for (const k of [...c.keys()].sort((a, b) => a - b)) {
    const n = k % 9 + step <= 8 ? Math.min(c.get(k) ?? 0, c.get(k + step) ?? 0) : 0;
    if (n > 0) {
      pairs += n;
      c.set(k, (c.get(k) ?? 0) - n);
      c.set(k + step, (c.get(k + step) ?? 0) - n);
    }
  }
  return pairs;
}

/** 花色相異、數字相同的配對數：同一數字的面子依花色配對（同花色不能互配） */
function countMirrorPairs(kinds: TileKind[]): number {
  let pairs = 0;
  for (let n = 0; n < 9; n++) {
    const suits = kinds.filter((k) => k % 9 === n).map(suitOf);
    if (suits.length < 2) continue;
    const maxSame = Math.max(...[0, 1, 2].map((s) => suits.filter((x) => x === s).length));
    pairs += Math.min(Math.floor(suits.length / 2), suits.length - maxSame);
  }
  return pairs;
}

/** 同花色、數字成等差（公差 d）的最長鏈長度 */
function longestArithmetic(kinds: TileKind[], d: number): number {
  const set = new Set(kinds);
  let best = 0;
  for (const k of set) {
    let len = 1;
    while (set.has(k + len * d) && suitOf(k + len * d) === suitOf(k) && (k % 9) + len * d <= 8) len++;
    best = Math.max(best, len);
  }
  return best;
}

/** 牌型擴充包中與面子拆法有關的牌型（連續類、三色類、對稱類） */
function expansionGroupYaku(groups: Group[], input: WinInput, hits: YakuHit[]) {
  const sets = groups.filter((g) => g.type !== 'pair');
  const pair = groups.find((g) => g.type === 'pair')!;
  let seqs = sets.filter((g) => g.type === 'seq').map((g) => g.kind);
  let numTris = sets.filter((g) => g.type === 'tri' && !isHonor(g.kind)).map((g) => g.kind);
  const allSeqs = [...seqs];
  const allTris = [...numTris];
  const remove = (arr: TileKind[], k: TileKind) => {
    const i = arr.indexOf(k);
    if (i >= 0) arr.splice(i, 1);
  };

  // 8.4 連面子／二龍戲：已計一氣通貫、三連刻（進階）的面子不再拆出連面子
  if (input.advanced) {
    for (let s = 0; s < 3; s++) {
      if ([0, 3, 6].every((o) => seqs.includes(s * 9 + o))) for (const o of [0, 3, 6]) remove(seqs, s * 9 + o);
    }
    const run = [...new Set(numTris)].sort((a, b) => a - b);
    for (let i = 0; i < run.length; i++) {
      let len = 1;
      while (run[i + len] === run[i] + len && suitOf(run[i + len]) === suitOf(run[i])) len++;
      if (len >= 3) for (let j = 0; j < len; j++) remove(numTris, run[i] + j);
    }
  }
  const seqPairs = countChainPairs(seqs, 3);
  const triPairs = countChainPairs(numTris, 1);
  if (seqPairs >= 2 || triPairs >= 2) hits.push(hit('8.4.2'));
  if (seqPairs + triPairs > 0) hits.push(hit('8.4.1', seqPairs + triPairs));
  // 8.5 三連環／四連環：同花色、起始數字各差一或各差二的順子
  const ring = Math.max(longestArithmetic(allSeqs, 1), longestArithmetic(allSeqs, 2));
  if (ring >= 4) hits.push(hit('8.5.2'));
  else if (ring === 3) hits.push(hit('8.5.1'));
  // 8.6 三連跳／四連跳：同花色、數字各差二到四的刻子（四連跳限各差二）
  if (longestArithmetic(allTris, 2) >= 4) hits.push(hit('8.6.2'));
  else if ([2, 3, 4].some((d) => longestArithmetic(allTris, d) >= 3)) hits.push(hit('8.6.1'));

  // 9.5 鏡面子／鏡同和：已計三色同順、三色同刻（進階）的那三組不再拆出鏡面子
  seqs = [...allSeqs];
  numTris = [...allTris];
  if (input.advanced) {
    for (let n = 0; n < 7; n++) if ([0, 1, 2].every((s) => seqs.includes(s * 9 + n))) for (const s of [0, 1, 2]) remove(seqs, s * 9 + n);
    for (let n = 0; n < 9; n++) if ([0, 1, 2].every((s) => numTris.includes(s * 9 + n))) for (const s of [0, 1, 2]) remove(numTris, s * 9 + n);
  }
  const mirrors = countMirrorPairs(seqs) + countMirrorPairs(numTris);
  const all = allTilesOf(input);
  // 鏡同和：兩組鏡面子是同樣的兩種花色（四組面子都是數牌、只用兩種花色）；雀頭不限，什麼牌都可以
  const setSuits = new Set(sets.map((g) => (isHonor(g.kind) ? -1 : suitOf(g.kind))));
  if (!setSuits.has(-1) && setSuits.size === 2 && mirrors >= 2) hits.push(hit('9.5.2'));
  if (mirrors > 0) hits.push(hit('9.5.1', mirrors));
  // 9.6 三色連環、9.7 三色連跳（花色相異、公差一致）
  const has3 = (items: TileKind[], nums: number[]) =>
    [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].some((p) => nums.every((n, i) => items.includes(p[i] * 9 + n - 1)));
  if ([1, 2].some((d) => [1, 2, 3, 4, 5, 6, 7].some((n) => n + 2 * d <= 7 && has3(allSeqs, [n, n + d, n + 2 * d])))) hits.push(hit('9.6'));
  if ([2, 3, 4].some((d) => [1, 2, 3, 4, 5, 6, 7, 8, 9].some((n) => n + 2 * d <= 9 && has3(allTris, [n, n + d, n + 2 * d])))) hits.push(hit('9.7'));

  // 13. 對稱類：只有數牌；以對子為軸（線對稱）或對稱點（點對稱）
  if (!all.some(isHonor) && !isHonor(pair.kind)) {
    const grid = [0, 1, 2].map((s) => Array.from({ length: 9 }, (_, i) => all.filter((k) => k === s * 9 + i).length));
    const axis = pair.kind % 9;
    const line = grid.every((row) => {
      for (let d = 1; d <= 8; d++) {
        const l = axis - d >= 0 ? row[axis - d] : 0;
        const r = axis + d <= 8 ? row[axis + d] : 0;
        if (l !== r) return false;
      }
      return true;
    });
    if (line) hits.push(hit('13.1'));
    const ps = suitOf(pair.kind);
    const point = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].some((order) => {
      // order[row] = 花色；對稱中心是對子所在的格子
      const pr = order.indexOf(ps);
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 9; i++) {
          const n = grid[order[row]][i];
          if (!n) continue;
          const mr = 2 * pr - row;
          const mi = 2 * axis - i;
          if (mr < 0 || mr > 2 || mi < 0 || mi > 8 || grid[order[mr]][mi] !== n) return false;
        }
      }
      return true;
    });
    if (point) hits.push(hit('13.2'));
  }
}

/** 全部牌（含槓子的第 4 張）的牌種 */
function allTilesOf(input: WinInput): TileKind[] {
  return [...input.concealed, ...input.melds.flatMap((m) => m.tiles.map(kindOf))];
}

/**
 * 計算和牌分數。無法成為和牌形時回傳 null。
 * 若有多種拆法，回傳最高分者。
 */
export function evaluateWin(input: WinInput): HandScore | null {
  const counts = countKinds(input.concealed);
  const expected = 14 - input.melds.length * 3;
  if (input.concealed.length !== expected) return null;
  const all = allTilesOf(input);
  const meldGroups = input.melds.map(meldToGroup);
  let best: HandScore | null = null;
  const consider = (s: HandScore) => {
    if (!best || s.total > best.total || (s.total === best.total && s.yaku.length > best.yaku.length)) best = s;
  };

  for (const decomp of decomposeStandard(counts)) {
    // 銃和時，和牌的那張可能落在任一包含它的面子中；若落在刻子，該刻子作明刻計
    const variants: Group[][] = [];
    if (input.tsumo) variants.push(decomp);
    else {
      const seen = new Set<string>();
      decomp.forEach((g, idx) => {
        const contains =
          g.type === 'seq' ? input.winTile >= g.kind && input.winTile <= g.kind + 2 : g.kind === input.winTile;
        if (!contains) return;
        const v = decomp.map((x, j) => (j === idx && x.type === 'tri' ? { ...x, open: true } : x));
        const key = JSON.stringify(v);
        if (!seen.has(key)) seen.add(key), variants.push(v);
      });
    }
    for (const v of variants) {
      const groups = [...v, ...meldGroups];
      const hits: YakuHit[] = [];
      tileYaku(all, input, hits);
      groupYaku(groups, input, hits);
      consider(finalize(hits, 'standard', groups, input.baseScore));
    }
  }

  if (input.advanced && input.melds.length === 0) {
    if (isSevenPairs(counts)) {
      const groups: Group[] = [];
      for (let k = 0; k < KIND_COUNT; k++) {
        for (let n = 0; n < counts[k] / 2; n++) groups.push({ type: 'pair', kind: k, open: false, kan: false });
      }
      const hits: YakuHit[] = [hit('11.1')];
      tileYaku(all, input, hits);
      if (groups.every(containsYaochu)) hits.push(hit('2.1'));
      consider(finalize(hits, 'sevenPairs', groups, input.baseScore));
    }
    if (isThirteenOrphans(counts)) {
      const hits: YakuHit[] = [hit('11.2')];
      tileYaku(all, input, hits);
      consider(finalize(hits, 'thirteenOrphans', [], input.baseScore));
    }
  }
  // 十三不搭（擴充）：比照七對子，可以再加計不求人等與拆法無關的牌型
  if (input.expansion && input.melds.length === 0 && isThirteenUnrelated(counts)) {
    const hits: YakuHit[] = [hit('11.3')];
    tileYaku(all, input, hits);
    consider(finalize(hits, 'thirteenUnrelated', [], input.baseScore));
  }
  return best;
}

/** 是否能構成和牌形（不論分數） */
export function isWinningShape(concealed: TileKind[], meldCount: number, advanced: boolean, expansion = false): boolean {
  if (concealed.length !== 14 - meldCount * 3) return false;
  const counts = countKinds(concealed);
  if (decomposeStandard(counts).length > 0) return true;
  if (advanced && meldCount === 0 && (isSevenPairs(counts) || isThirteenOrphans(counts))) return true;
  if (expansion && meldCount === 0 && isThirteenUnrelated(counts)) return true;
  return false;
}

/**
 * 聽的牌（13 - 3n 張手牌時）。已在自己手牌與鳴牌中用盡 4 張的牌不算。
 */
export function waitingKinds(concealed: TileKind[], melds: Meld[], advanced: boolean, expansion = false): TileKind[] {
  if (concealed.length !== 13 - melds.length * 3) return [];
  const used = countKinds([...concealed, ...melds.flatMap((m) => m.tiles.map(kindOf))]);
  const out: TileKind[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    if (used[k] >= 4) continue;
    if (isWinningShape([...concealed, k], melds.length, advanced, expansion)) out.push(k);
  }
  return out;
}

/** 聽牌時「可能的最高和牌分數」（不含偶然類），未聽牌回傳 null */
export function bestTenpaiScore(
  concealed: TileKind[],
  melds: Meld[],
  seatWind: TileKind,
  advanced: boolean,
  baseScore: number,
  expansion = false,
): { score: HandScore; waits: TileKind[]; tile: TileKind; tsumo: boolean } | null {
  const waits = waitingKinds(concealed, melds, advanced, expansion);
  if (!waits.length) return null;
  let best: { score: HandScore; tile: TileKind; tsumo: boolean } | null = null;
  for (const w of waits) {
    for (const tsumo of [true, false]) {
      const s = evaluateWin({ concealed: [...concealed, w], melds, winTile: w, tsumo, seatWind, advanced, baseScore, expansion });
      if (s && (!best || s.total > best.score.total)) best = { score: s, tile: w, tsumo };
    }
  }
  return best ? { ...best, waits } : null;
}
