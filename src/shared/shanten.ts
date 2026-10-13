import { KIND_COUNT, isYaochu } from './tiles.js';

// 向聽數：距離聽牌還差幾步。-1 = 已和牌形、0 = 聽牌。
// 一般形依花色分段計算並快取，以支援 AI 大量評估。

interface Part {
  sets: number;
  taatsu: number; // 搭子（含當搭子用的對子）
  pair: number; // 0/1，作為雀頭的對子
}

// 每段（一種花色或字牌）的拆法依張數快取；key 用 5 進位整數（每種牌 0～4 張），不用產生字串
const seqCache = new Map<number, Part[]>();
const honorCache = new Map<number, Part[]>();

/** counts[start, start + len) 這一段的拆法 */
function partsAt(counts: number[], start: number, len: number, allowSeq: boolean): Part[] {
  let key = 0;
  for (let i = 0; i < len; i++) key = key * 5 + counts[start + i];
  const cache = allowSeq ? seqCache : honorCache;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = partsFor(counts.slice(start, start + len), allowSeq);
  cache.set(key, parts);
  return parts;
}

function partsFor(c: number[], allowSeq: boolean): Part[] {
  const found = new Map<string, Part>();
  const n = c.length;
  const dfs = (i: number, sets: number, taatsu: number, pair: number) => {
    while (i < n && c[i] === 0) i++;
    if (i >= n) {
      found.set(`${sets},${taatsu},${pair}`, { sets, taatsu, pair });
      return;
    }
    if (c[i] >= 3) {
      c[i] -= 3;
      dfs(i, sets + 1, taatsu, pair);
      c[i] += 3;
    }
    if (allowSeq && i + 2 < n && c[i + 1] && c[i + 2]) {
      c[i]--, c[i + 1]--, c[i + 2]--;
      dfs(i, sets + 1, taatsu, pair);
      c[i]++, c[i + 1]++, c[i + 2]++;
    }
    if (c[i] >= 2) {
      c[i] -= 2;
      if (!pair) dfs(i, sets, taatsu, 1);
      dfs(i, sets, taatsu + 1, pair);
      c[i] += 2;
    }
    if (allowSeq && i + 1 < n && c[i + 1]) {
      c[i]--, c[i + 1]--;
      dfs(i, sets, taatsu + 1, pair);
      c[i]++, c[i + 1]++;
    }
    if (allowSeq && i + 2 < n && c[i + 2]) {
      c[i]--, c[i + 2]--;
      dfs(i, sets, taatsu + 1, pair);
      c[i]++, c[i + 2]++;
    }
    c[i]--;
    dfs(i, sets, taatsu, pair);
    c[i]++;
  };
  dfs(0, 0, 0, 0);
  // 只保留不被支配的組合
  const all = [...found.values()];
  const parts = all.filter(
    (a) => !all.some((b) => b !== a && b.sets >= a.sets && b.taatsu >= a.taatsu && b.pair >= a.pair && (b.sets > a.sets || b.taatsu > a.taatsu || b.pair > a.pair)),
  );
  return parts;
}

/**
 * 一般形（四面子一雀頭）的向聽數。
 * 張數不足 13 張時（例如只看某些牌種）也正確：缺的面子或雀頭沒有孤張可以用時要多摸一張。
 * pairFixed：雀頭已經由別處提供（例如小三元的三元牌對子），這裡只需要湊面子。
 */
export function shantenStandard(counts: number[], meldCount: number, pairFixed = false): number {
  const groups = [partsAt(counts, 0, 9, true), partsAt(counts, 9, 9, true), partsAt(counts, 18, 9, true), partsAt(counts, 27, 7, false)];
  let total = 0;
  for (const n of counts) total += n;
  let best = 8;
  const need = 4 - meldCount;
  const rec = (g: number, sets: number, taatsu: number, pair: number) => {
    if (g === 4) {
      const s = Math.min(sets, need);
      const t = Math.min(taatsu, need - s);
      const p = pairFixed ? 1 : pair;
      // 標準公式假設每個還沒有搭子的面子（和雀頭）都有一張孤張可用；孤張不夠時每缺一張多摸一次
      const isolated = total - 3 * s - 2 * t - (pairFixed ? 0 : 2 * pair);
      const deficit = Math.max(0, need - s - t + (1 - p) - isolated);
      best = Math.min(best, 8 - 2 * (s + meldCount) - t - p + deficit);
      return;
    }
    for (const part of groups[g]) {
      if (pair + part.pair > (pairFixed ? 0 : 1)) continue;
      rec(g + 1, sets + part.sets, taatsu + part.taatsu, pair + part.pair);
    }
  };
  rec(0, 0, 0, 0);
  return best;
}

export function shantenSevenPairs(counts: number[]): number {
  // 本規則中四張同種可當兩組對子，因此只需計算對子數
  let pairs = 0;
  for (let k = 0; k < KIND_COUNT; k++) pairs += Math.floor(counts[k] / 2);
  return 6 - Math.min(pairs, 7);
}

export function shantenThirteenOrphans(counts: number[]): number {
  let kinds = 0;
  let pair = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (!isYaochu(k) || counts[k] === 0) continue;
    kinds++;
    if (counts[k] >= 2) pair = 1;
  }
  return 13 - kinds - pair;
}

export function shanten(counts: number[], meldCount: number, advanced: boolean): number {
  let s = shantenStandard(counts, meldCount);
  if (advanced && meldCount === 0) {
    s = Math.min(s, shantenSevenPairs(counts), shantenThirteenOrphans(counts));
  }
  return s;
}
