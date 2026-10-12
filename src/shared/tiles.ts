// 牌的編碼：
//   TileKind（牌種）0..33：0-8 萬子、9-17 筒子、18-26 索子、27-30 東南西北、31-33 中發白
//   TileId（實體牌）0..135：kind = id >> 2，每種 4 張

export type TileKind = number;
export type TileId = number;

export const KIND_COUNT = 34;
export const TILE_COUNT = 136;

export const EAST = 27;
export const SOUTH = 28;
export const WEST = 29;
export const NORTH = 30;
export const RED = 31; // 紅中
export const GREEN = 32; // 青發
export const WHITE = 33; // 白板

export const kindOf = (id: TileId): TileKind => id >> 2;
export const isHonor = (k: TileKind) => k >= 27;
export const isWind = (k: TileKind) => k >= 27 && k <= 30;
export const isDragon = (k: TileKind) => k >= 31;
/** 0 萬、1 筒、2 索；字牌為 -1 */
export const suitOf = (k: TileKind) => (k < 27 ? Math.floor(k / 9) : -1);
/** 數牌的數字 1..9；字牌為 0 */
export const numOf = (k: TileKind) => (k < 27 ? (k % 9) + 1 : 0);
/** 數牌的 1、9 */
export const isTerminal = (k: TileKind) => k < 27 && (k % 9 === 0 || k % 9 === 8);
/** 1、9、字牌 */
export const isYaochu = (k: TileKind) => isHonor(k) || isTerminal(k);

const SUIT_NAMES = ['萬', '筒', '索'];
const NUM_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONOR_NAMES = ['東', '南', '西', '北', '中', '發', '白'];

export function tileName(k: TileKind): string {
  if (k < 27) return NUM_NAMES[k % 9] + SUIT_NAMES[suitOf(k)];
  return HONOR_NAMES[k - 27];
}

export function windName(k: TileKind): string {
  return HONOR_NAMES[k - 27] + '風';
}

/**
 * 解析簡寫：例如 "123m456p789s11z"。z 的 1-7 依序為 東南西北中發白。
 * 回傳 TileKind 陣列（主要供測試與除錯使用）。
 */
export function parseKinds(s: string): TileKind[] {
  const out: TileKind[] = [];
  let digits: number[] = [];
  for (const ch of s.replace(/\s+/g, '')) {
    if (ch >= '0' && ch <= '9') {
      digits.push(Number(ch));
      continue;
    }
    const base = { m: 0, p: 9, s: 18, z: 27 }[ch];
    if (base === undefined) throw new Error(`無法解析的牌：${ch}`);
    for (const d of digits) {
      if (ch === 'z' ? d < 1 || d > 7 : d < 1 || d > 9) throw new Error(`無效數字 ${d}${ch}`);
      out.push(base + d - 1);
    }
    digits = [];
  }
  if (digits.length) throw new Error('結尾缺少花色字母');
  return out;
}

export function kindsToString(kinds: TileKind[]): string {
  const groups: Record<string, number[]> = { m: [], p: [], s: [], z: [] };
  for (const k of [...kinds].sort((a, b) => a - b)) {
    if (k < 9) groups.m.push(k + 1);
    else if (k < 18) groups.p.push(k - 8);
    else if (k < 27) groups.s.push(k - 17);
    else groups.z.push(k - 26);
  }
  return (['m', 'p', 's', 'z'] as const)
    .filter((g) => groups[g].length)
    .map((g) => groups[g].join('') + g)
    .join('');
}

/** 將 Unicode 麻將字元（🀀〜🀡）轉為牌種，用於牌例顯示 */
export function parseUnicodeTiles(s: string): TileKind[] {
  const out: TileKind[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f000 && cp <= 0x1f003) out.push(27 + cp - 0x1f000); // 東南西北
    else if (cp >= 0x1f004 && cp <= 0x1f006) out.push(31 + cp - 0x1f004); // 中發白
    else if (cp >= 0x1f007 && cp <= 0x1f00f) out.push(cp - 0x1f007); // 萬
    else if (cp >= 0x1f010 && cp <= 0x1f018) out.push(18 + cp - 0x1f010); // 索
    else if (cp >= 0x1f019 && cp <= 0x1f021) out.push(9 + cp - 0x1f019); // 筒
  }
  return out;
}

export function countKinds(kinds: Iterable<TileKind>): number[] {
  const c = new Array(KIND_COUNT).fill(0);
  for (const k of kinds) c[k]++;
  return c;
}

export function sortTiles(ids: TileId[]): TileId[] {
  return [...ids].sort((a, b) => a - b);
}
