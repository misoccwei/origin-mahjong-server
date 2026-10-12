import type { Meld } from '../src/shared/rules.js';
import type { TileKind } from '../src/shared/tiles.js';

/** 將 Unicode 麻將字元（🀀-🀡）轉為 TileKind */
export function uni(s: string): TileKind[] {
  const out: TileKind[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f000 && cp <= 0x1f003) out.push(27 + cp - 0x1f000); // 東南西北
    else if (cp >= 0x1f004 && cp <= 0x1f006) out.push(31 + cp - 0x1f004); // 中發白
    else if (cp >= 0x1f007 && cp <= 0x1f00f) out.push(cp - 0x1f007); // 萬
    else if (cp >= 0x1f010 && cp <= 0x1f018) out.push(18 + cp - 0x1f010); // 索
    else if (cp >= 0x1f019 && cp <= 0x1f021) out.push(9 + cp - 0x1f019); // 筒
    else if (ch.trim()) throw new Error('unknown tile ' + ch);
  }
  return out;
}

let nextId = 0;
/** 由牌種產生鳴牌（實體牌 id 只需不重複於同種內即可） */
export function meld(s: string, open = true): Meld {
  const kinds = uni(s);
  const tiles = kinds.map((k) => k * 4 + (nextId++ % 4));
  const isSeq = kinds[0] !== kinds[1];
  const type = isSeq ? 'chi' : kinds.length === 4 ? (open ? 'minkan' : 'ankan') : 'pon';
  return { type, tiles, calledTile: open ? tiles[0] : undefined, from: open ? 1 : undefined };
}
