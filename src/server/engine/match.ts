import type { HandHistoryEntry } from '../../shared/protocol.js';
import type { RuleSettings } from '../../shared/rules.js';
import { Hand, cryptoRng, type Rng } from './hand.js';

/** 一場牌局（多局），負責局數、起始玩家輪替、累計分數與小牌限制 */
export class Match {
  settings: RuleSettings;
  readonly n: number;
  totalHands: number;
  /** 0-based 目前局數 */
  handIndex = 0;
  readonly firstStart: number;
  scores: number[];
  history: HandHistoryEntry[] = [];
  hand: Hand | null = null;
  /** 小牌限制：本輪（起始玩家輪一圈）中是否已用掉和小牌的機會 */
  private smallUsed: boolean[];
  private rng: Rng;

  constructor(settings: RuleSettings, opts: { rng?: Rng; firstStart?: number } = {}) {
    this.settings = settings;
    this.n = settings.playerCount;
    this.totalHands = settings.rounds * this.n;
    this.rng = opts.rng ?? cryptoRng;
    this.firstStart = opts.firstStart ?? this.rng(this.n);
    this.scores = new Array(this.n).fill(0);
    this.smallUsed = new Array(this.n).fill(false);
  }

  get startSeat() {
    return (this.firstStart + this.handIndex) % this.n;
  }

  get finished() {
    return this.handIndex >= this.totalHands;
  }

  smallHandAvailable(): boolean[] {
    return this.smallUsed.map((u) => !u);
  }

  startHand(wall?: number[]): Hand {
    if (this.handIndex % this.n === 0) this.smallUsed.fill(false);
    this.hand = new Hand({
      settings: this.settings,
      startSeat: this.startSeat,
      smallHandAvailable: this.smallHandAvailable(),
      rng: this.rng,
      wall,
    });
    this.hand.start();
    return this.hand;
  }

  /** 局結束後呼叫：累計分數並推進局數 */
  completeHand() {
    const hand = this.hand;
    if (!hand?.result) throw new Error('hand not finished');
    const r = hand.result;
    r.deltas.forEach((d, i) => (this.scores[i] += d));
    for (const w of r.winners) {
      if (w.score.total < 20) this.smallUsed[w.seat] = true;
    }
    this.history.push({
      handNo: this.handIndex + 1,
      startSeat: hand.startSeat,
      kind: r.kind,
      winners: r.winners.map((w) => ({ seat: w.seat, total: w.score.total, tsumo: w.tsumo, from: w.from, yaku: w.score.yaku.map((y) => y.name) })),
      deltas: r.deltas,
    });
    this.handIndex++;
    this.hand = null;
  }

  /** 加一圈 */
  extend(rounds = 1) {
    this.totalHands += rounds * this.n;
  }
}
