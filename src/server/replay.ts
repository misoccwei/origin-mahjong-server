// 把引擎的一局轉成回放檔的格式（只複製純資料，不帶引擎內部的型別）
import type { HandScore } from '../shared/scoring.js';
import type { ReplayHand, ReplayResult, ReplayScore } from '../shared/replaySchema.js';
import type { Hand } from './engine/hand.js';

const scoreOf = (s: HandScore): ReplayScore => ({
  total: s.total,
  baseScore: s.baseScore,
  yakuPoints: s.yakuPoints,
  limit: s.limit,
  yaku: s.yaku.map((y) => ({ id: y.id, name: y.name, points: y.points, count: y.count })),
});

/** 一局結束後呼叫：handNo 為 1 起算，scoresBefore 為這一局開始前的累計分數 */
export function replayHandOf(hand: Hand, handNo: number, scoresBefore: number[]): ReplayHand {
  const r = hand.result!;
  const result: ReplayResult = {
    kind: r.kind,
    winners: r.winners.map((w) => ({ seat: w.seat, tsumo: w.tsumo, ...(w.from !== undefined ? { from: w.from } : {}), tile: w.tile, score: scoreOf(w.score) })),
    tenpai: r.tenpai.map((x) => ({ seat: x.seat, maxScore: x.maxScore, waits: [...x.waits], best: { tile: x.best.tile, tsumo: x.best.tsumo, score: scoreOf(x.best.score) } })),
    deltas: [...r.deltas],
    lines: r.lines.map((l) => ({ seat: l.seat, delta: l.delta, reason: l.reason })),
    hands: r.hands.map((h) => [...h]),
    melds: r.melds.map((ms) =>
      ms.map((m) => ({
        type: m.type,
        tiles: [...m.tiles],
        ...(m.calledTile !== undefined ? { called: m.calledTile } : {}),
        ...(m.from !== undefined ? { from: m.from } : {}),
      })),
    ),
  };
  return {
    handNo,
    startSeat: hand.startSeat,
    winds: Array.from({ length: hand.n }, (_, i) => hand.seatWind(i)),
    scoresBefore: [...scoresBefore],
    deal: hand.deal.map((h) => [...h]),
    wallAfterDeal: hand.wallAfterDeal,
    deadWall: hand.deadWall,
    events: structuredClone(hand.replayLog),
    result,
  };
}
