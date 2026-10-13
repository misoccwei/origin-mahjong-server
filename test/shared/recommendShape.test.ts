import { describe, expect, it } from 'vitest';
import { buildTargets } from '../../src/shared/recommend.js';
import type { Meld } from '../../src/shared/rules.js';
import { YAKU, evaluateWin } from '../../src/shared/scoring.js';
import { EAST, KIND_COUNT, countKinds, kindOf, parseUnicodeTiles, type TileKind } from '../../src/shared/tiles.js';
import { YAKU_INFO } from '../../src/shared/yakuInfo.js';
import { seededRng } from '../support/hand.js';
import { meld } from '../support/tiles.js';

// 推薦牌型的向聽數必須同時符合「和牌形」與「牌型條件」：
// - 可靠：評估為聽牌（0）時，一定有某張牌和下來真的成立這個牌型（或同系列更高的牌型）；
// - 完整：牌型表的牌例拿掉和的那張，評估一定是聽牌（不會把做得到的牌型算遠）。

const series = (id: string) => YAKU[id].series;

/**
 * 和了之後是否成立這個牌型。計分只取最高分的拆法，而且有滿貫牌型時只計最高的單項，
 * 所以同系列更高的牌型、或總分不低於這個牌型的分數也算（例如碰碰和聽單騎，自摸成四暗刻）。
 */
function winsWith(concealed: TileKind[], melds: Meld[], w: TileKind, id: string) {
  for (const tsumo of [true, false]) {
    const s = evaluateWin({ concealed: [...concealed, w], melds, winTile: w, tsumo, seatWind: EAST, advanced: true, baseScore: 0, expansion: false });
    if (!s) continue;
    if (s.yaku.some((y) => y.id === id || (series(y.id) === series(id) && y.points >= YAKU[id].points))) return true;
    if (s.limit && s.total >= YAKU[id].points) return true;
    if (id === '11.1' && s.total >= YAKU[id].points) return true;
  }
  return false;
}

/** 這個牌型的向聽數（同一牌型有多個目標時取最小） */
function shantenFor(concealed: TileKind[], melds: Meld[], id: string) {
  const counts = countKinds(concealed);
  const ts = buildTargets({ concealed, melds, seatWind: EAST, advanced: true }).filter((t) => t.id === id);
  return ts.length ? Math.min(...ts.map((t) => t.evaluate([...counts]))) : Infinity;
}

const TARGET_IDS = [...new Set(buildTargets({ concealed: [], melds: [], seatWind: EAST, advanced: true }).map((t) => t.id))];

/** 隨機的完整和牌形（四組面子＋雀頭，不鳴牌），偏向少數花色，比較容易出現各種牌型 */
function randomWinningHand(rng: (n: number) => number): TileKind[] {
  const suits = [rng(3), rng(3)];
  const c = new Array(KIND_COUNT).fill(0);
  const out: TileKind[] = [];
  const put = (ks: TileKind[]) => {
    if (ks.some((k) => c[k] >= 4 || ks.filter((x) => x === k).length + c[k] > 4)) return false;
    ks.forEach((k) => (c[k]++, out.push(k)));
    return true;
  };
  while (out.length < 12) {
    const r = rng(10);
    if (r < 5) {
      const s = suits[rng(2)];
      const n = rng(7);
      put([s * 9 + n, s * 9 + n + 1, s * 9 + n + 2]);
    } else if (r < 8) {
      const k = rng(2) ? suits[rng(2)] * 9 + rng(9) : 27 + rng(7);
      put([k, k, k]);
    } else {
      const k = rng(3) * 9 + rng(9);
      put([k, k, k]);
    }
  }
  for (;;) {
    const k = rng(2) ? suits[rng(2)] * 9 + rng(9) : 27 + rng(7);
    if (put([k, k])) return out;
  }
}

describe('推薦牌型的向聽數符合和牌形', () => {
  it('可靠：評估為聽牌時，一定有牌可以和出這個牌型', () => {
    const rng = seededRng(2024);
    const wrong: string[] = [];
    let checked = 0;
    for (let n = 0; n < 1000; n++) {
      const win = randomWinningHand(rng);
      const hand = [...win];
      hand.splice(rng(hand.length), 1);
      for (const id of TARGET_IDS) {
        if (shantenFor(hand, [], id) !== 0) continue;
        checked++;
        const ok = Array.from({ length: KIND_COUNT }, (_, k) => k).some((w) => countKinds(hand)[w] < 4 && winsWith(hand, [], w, id));
        if (!ok) wrong.push(`${YAKU[id].name}: ${hand.join(',')}`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect([...new Set(wrong)].slice(0, 10)).toEqual([]);
  });

  it('完整：牌型表的牌例少和的那張時，評估為聽牌', () => {
    const wrong: string[] = [];
    for (const id of TARGET_IDS) {
      const ex = YAKU_INFO[id]?.example;
      if (!ex?.win) continue;
      const melds = (ex.melds ?? []).map((m) => meld(m, !(ex.melds!.length === 0)));
      const hand = parseUnicodeTiles(ex.hand);
      const s = shantenFor(hand, melds, id);
      if (s !== 0) wrong.push(`${YAKU[id].name} 評估 ${s}`);
    }
    expect(wrong).toEqual([]);
  });

  it('完整：隨機的和牌，拿掉和的那張後，和出來的每個牌型都評估為聽牌', () => {
    const rng = seededRng(77);
    const wrong: string[] = [];
    let checked = 0;
    for (let n = 0; n < 600; n++) {
      const win = randomWinningHand(rng);
      const i = rng(win.length);
      const w = win[i];
      const hand = win.filter((_, j) => j !== i);
      const s = evaluateWin({ concealed: win, melds: [], winTile: w, tsumo: true, seatWind: EAST, advanced: true, baseScore: 0, expansion: false });
      for (const y of s?.yaku ?? []) {
        if (!TARGET_IDS.includes(y.id)) continue;
        const sh = shantenFor(hand, [], y.id);
        checked++;
        if (sh > 0) wrong.push(`${y.name} 評估 ${sh}: ${hand.join(',')} 和 ${w}`);
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect([...new Set(wrong)].slice(0, 10)).toEqual([]);
  });

  it('每一步都能前進：評估為 N 向聽（N ≥ 1）時，摸一張、打一張可以變成 N − 1 向聽', () => {
    const rng = seededRng(99);
    const wrong: string[] = [];
    let checked = 0;
    for (let n = 0; n < 60; n++) {
      // 從和牌形隨機換掉兩張，得到離和牌不遠的手牌
      const hand = randomWinningHand(rng);
      hand.splice(rng(hand.length), 1);
      for (let r = 0; r < 2; r++) hand[rng(hand.length)] = rng(KIND_COUNT);
      const counts = countKinds(hand);
      if (counts.some((x) => x > 4)) continue;
      for (const t of buildTargets({ concealed: hand, melds: [], seatWind: EAST, advanced: true })) {
        const sh = t.evaluate([...counts]);
        if (!Number.isFinite(sh) || sh < 1 || sh > 3) continue;
        checked++;
        let ok = false;
        for (let k = 0; k < KIND_COUNT && !ok; k++) {
          if (counts[k] >= 4) continue;
          counts[k]++;
          for (let d = 0; d < KIND_COUNT && !ok; d++) {
            if (!counts[d]) continue;
            counts[d]--;
            if (t.evaluate([...counts]) <= sh - 1) ok = true;
            counts[d]++;
          }
          counts[k]--;
        }
        if (!ok) wrong.push(`${YAKU[t.id].name} 評估 ${sh}: ${hand.join(',')}`);
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect([...new Set(wrong)].slice(0, 10)).toEqual([]);
  });
});

