import type { RuleSettings } from './rules.js';
import { baseScoreFor } from './rules.js';
import type { HandScore } from './scoring.js';

export interface WinnerInfo {
  seat: number;
  score: HandScore;
  tsumo: boolean;
  /** 銃和時的放銃者（零和式下可能因「同巡跟打免責」轉移） */
  from?: number;
}

export interface TenpaiInfo {
  seat: number;
  /** 可能的最高和牌分數 */
  maxScore: number;
}

export interface SettlementLine {
  seat: number;
  delta: number;
  reason: string;
}

/**
 * 計算一局的分數變動。
 * - 加分式基本規則：和牌者得「和牌分數」
 * - 加分式進階規則：和牌者得「和牌分數×2」；聽牌者得「最高和牌分數」，但不超過在場和牌者的和牌分數（不乘 2；流局則不設限）
 * - 零和式：和牌者得「和牌分數×對手人數」，依自摸／銃和分配支付
 */
export function settle(
  settings: RuleSettings,
  winners: WinnerInfo[],
  tenpai: TenpaiInfo[],
): { deltas: number[]; lines: SettlementLine[] } {
  const n = settings.playerCount;
  const deltas = new Array(n).fill(0);
  const lines: SettlementLine[] = [];
  const add = (seat: number, delta: number, reason: string) => {
    if (delta === 0) return;
    deltas[seat] += delta;
    lines.push({ seat, delta, reason });
  };

  // 和牌分數為 0 的和牌（進階規則）不進行結算
  const scoring = winners.filter((w) => w.score.total > 0);

  if (settings.scoring === 'additive') {
    const mult = settings.advanced ? 2 : 1;
    for (const w of scoring) add(w.seat, w.score.total * mult, settings.advanced ? '和牌得分（和牌分數×2）' : '和牌得分');
    const nobodyScored = winners.length > 0 && scoring.length === 0;
    if (settings.advanced && !nobodyScored) {
      const cap = scoring.length ? Math.max(...scoring.map((w) => w.score.total)) : Infinity;
      const winnerSeats = new Set(winners.map((w) => w.seat));
      for (const t of tenpai) {
        if (winnerSeats.has(t.seat)) continue;
        add(t.seat, Math.min(t.maxScore, cap), '聽牌得分');
      }
    }
    return { deltas, lines };
  }

  // 零和式
  const opp = n - 1;
  for (const w of scoring) {
    const total = w.score.total;
    const gain = total * opp;
    add(w.seat, gain, w.tsumo ? '自摸' : '銃和');
    const others = [...Array(n).keys()].filter((s) => s !== w.seat);
    if (w.tsumo || w.from === undefined || w.score.yakuPoints <= 20) {
      for (const s of others) add(s, -total, w.tsumo ? '支付自摸' : '支付和牌');
    } else {
      const share = baseScoreFor(settings, w.seat) + 20;
      for (const s of others) {
        if (s === w.from) add(s, -(gain - share * (opp - 1)), '放銃');
        else add(s, -share, '支付和牌');
      }
    }
  }
  return { deltas, lines };
}
