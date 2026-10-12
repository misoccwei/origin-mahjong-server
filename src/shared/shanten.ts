import { KIND_COUNT, isYaochu } from './tiles.js';

// 向聽數：距離聽牌還差幾步。-1 = 已和牌形、0 = 聽牌。
// 一般形依花色分段計算並快取，以支援 AI 大量評估。

interface Part {
  sets: number;
  taatsu: number; // 搭子（含當搭子用的對子）
  pair: number; // 0/1，作為雀頭的對子
}

const cache = new Map<string, Part[]>();

function partsFor(c: number[], allowSeq: boolean): Part[] {
  const key = (allowSeq ? 's' : 'h') + c.join('');
  const hitPart = cache.get(key);
  if (hitPart) return hitPart;
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
  cache.set(key, parts);
  return parts;
}

export function shantenStandard(counts: number[], meldCount: number): number {
  const groups = [
    partsFor(counts.slice(0, 9), true),
    partsFor(counts.slice(9, 18), true),
    partsFor(counts.slice(18, 27), true),
    partsFor(counts.slice(27, 34), false),
  ];
  let best = 8;
  const need = 4 - meldCount;
  const rec = (g: number, sets: number, taatsu: number, pair: number) => {
    if (g === 4) {
      const s = Math.min(sets, need);
      const t = Math.min(taatsu, need - s);
      best = Math.min(best, 8 - 2 * (s + meldCount) - t - pair);
      return;
    }
    for (const p of groups[g]) {
      if (pair + p.pair > 1) continue;
      rec(g + 1, sets + p.sets, taatsu + p.taatsu, pair + p.pair);
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
