import { randomInt } from 'node:crypto';
import type { AvailableActions, GameAction } from '../../shared/protocol.js';
import { DEAD_WALL, baseScoreFor, seatWindOf, type Meld, type RuleSettings } from '../../shared/rules.js';
import { bestTenpaiScore, evaluateWin, isWinningShape, waitingKinds, type HandScore, type WinFlags } from '../../shared/scoring.js';
import { settle, type SettlementLine } from '../../shared/settlement.js';
import { TILE_COUNT, kindOf, suitOf, type TileId, type TileKind } from '../../shared/tiles.js';

export type Rng = (maxExclusive: number) => number;
export const cryptoRng: Rng = (max) => randomInt(max);

export type HandPhase = 'passThree' | 'passReveal' | 'turn' | 'claim' | 'chankan' | 'ended';

interface DiscardEntry {
  seat: number;
  tile: TileId;
  called: boolean;
  /** 牌山只剩王牌時打出（河底牌） */
  houtei: boolean;
}

export interface Winner {
  seat: number;
  tsumo: boolean;
  from?: number;
  tile: TileId;
  score: HandScore;
}

/** 聽牌者：所聽的牌，以及得分最高的那種和法（聽牌得分就是用它計算） */
export interface TenpaiResult {
  seat: number;
  maxScore: number;
  waits: TileKind[];
  best: { tile: TileKind; tsumo: boolean; score: HandScore };
}

export interface HandResult {
  kind: 'win' | 'draw';
  winners: Winner[];
  tenpai: TenpaiResult[];
  deltas: number[];
  lines: SettlementLine[];
  hands: TileId[][];
  melds: Meld[][];
}

export interface HandOptions {
  settings: RuleSettings;
  startSeat: number;
  /** 小牌限制：各座位本輪是否仍可和小牌（未滿 20 分） */
  smallHandAvailable: boolean[];
  rng?: Rng;
  /** 測試用：指定牌山（從前端摸牌、從尾端補嶺上牌） */
  wall?: TileId[];
}

export class Hand {
  readonly settings: RuleSettings;
  readonly n: number;
  readonly startSeat: number;
  readonly deadWall: number;
  wall: TileId[];
  hands: TileId[][];
  melds: Meld[][];
  discards: DiscardEntry[][];
  /** 依時間順序的所有捨牌 */
  discardLog: DiscardEntry[] = [];
  phase: HandPhase = 'turn';
  current: number;
  drawn: TileId | null = null;
  drawCount: number[];
  /** 本回合的牌是嶺上補牌 */
  private rinshanDraw = false;
  /** 本回合是否摸過牌（鳴牌後的回合為 false） */
  private drewThisTurn = false;
  lastDiscard: DiscardEntry | null = null;
  kakanPending: { seat: number; tile: TileId } | null = null;
  pending = new Map<number, AvailableActions>();
  private responses = new Map<number, GameAction>();
  private passSelections = new Map<number, TileId[] | null>();
  /** 換三張：各座位換出與收到的牌（沒有交換為 null）；收到的牌在 passReveal 階段結束後才放進手牌 */
  passSent: (TileId[] | null)[];
  passReceived: (TileId[] | null)[];
  result: HandResult | null = null;
  private smallHandAvailable: boolean[];

  constructor(opts: HandOptions) {
    this.settings = opts.settings;
    this.n = opts.settings.playerCount;
    this.startSeat = opts.startSeat;
    this.deadWall = DEAD_WALL[opts.settings.playerCount];
    this.smallHandAvailable = opts.smallHandAvailable;
    this.current = opts.startSeat;
    this.hands = Array.from({ length: this.n }, () => []);
    this.melds = Array.from({ length: this.n }, () => []);
    this.discards = Array.from({ length: this.n }, () => []);
    this.drawCount = new Array(this.n).fill(0);
    this.passSent = new Array(this.n).fill(null);
    this.passReceived = new Array(this.n).fill(null);
    if (opts.wall) {
      this.wall = [...opts.wall];
    } else {
      const rng = opts.rng ?? cryptoRng;
      this.wall = Array.from({ length: TILE_COUNT }, (_, i) => i);
      for (let i = this.wall.length - 1; i > 0; i--) {
        const j = rng(i + 1);
        [this.wall[i], this.wall[j]] = [this.wall[j], this.wall[i]];
      }
    }
  }

  start() {
    // 配牌：自起始玩家依序每人 13 張
    for (let r = 0; r < 13; r++) {
      for (let i = 0; i < this.n; i++) this.hands[(this.startSeat + i) % this.n].push(this.wall.shift()!);
    }
    this.hands.forEach((h) => h.sort((a, b) => a - b));
    if (this.settings.passThree) {
      this.phase = 'passThree';
      for (let s = 0; s < this.n; s++) this.pending.set(s, { kind: 'passThree' });
    } else {
      this.beginTurn(this.startSeat, 'normal');
    }
  }

  seatWind(seat: number) {
    return seatWindOf(seat, this.startSeat, this.n);
  }

  get wallRemaining() {
    return this.wall.length;
  }

  private get canDraw() {
    return this.wall.length > this.deadWall;
  }

  // ------------------------------------------------------------------
  // 行動
  // ------------------------------------------------------------------

  /** 執行玩家行動；不合法時回傳錯誤訊息 */
  act(seat: number, action: GameAction): string | null {
    const avail = this.pending.get(seat);
    if (!avail) return '現在不是你的行動時機';
    switch (avail.kind) {
      case 'passThree':
        return this.actPassThree(seat, action);
      case 'turn':
        return this.actTurn(seat, avail, action);
      case 'claim':
      case 'chankan':
        return this.actClaim(seat, avail, action);
    }
  }

  /** 逾時或代打時的預設行動 */
  defaultAction(seat: number): GameAction {
    const avail = this.pending.get(seat)!;
    if (avail.kind === 'passThree') return { type: 'passThree', tiles: null };
    if (avail.kind === 'turn') {
      const tile = this.drawn !== null && this.hands[seat].includes(this.drawn) ? this.drawn : this.hands[seat][this.hands[seat].length - 1];
      return { type: 'discard', tile };
    }
    return { type: 'pass' };
  }

  private actPassThree(seat: number, action: GameAction): string | null {
    if (action.type !== 'passThree') return '請選擇要換的牌或不換';
    if (action.tiles !== null) {
      const set = new Set(action.tiles);
      if (action.tiles.length !== 3 || set.size !== 3 || !action.tiles.every((t) => this.hands[seat].includes(t))) {
        return '必須選擇手中的 3 張牌';
      }
    }
    this.passSelections.set(seat, action.tiles ? [...action.tiles] : null);
    this.pending.delete(seat);
    if (this.pending.size === 0) this.resolvePassThree();
    return null;
  }

  private resolvePassThree() {
    // 換三張：選擇換牌的玩家依座位順序構成循環，同時交換；不換的玩家手牌不變，
    // 上家的牌直接越過他交給下一位換牌者，因此其他人無從得知誰沒有換
    const order = [...Array(this.n).keys()].map((i) => (this.startSeat + i) % this.n);
    const passers = order.filter((s) => this.passSelections.get(s));
    if (passers.length >= 2) {
      const outgoing = new Map(passers.map((s) => [s, this.passSelections.get(s)!]));
      for (const s of passers) {
        this.hands[s] = this.hands[s].filter((t) => !outgoing.get(s)!.includes(t));
        this.passSent[s] = [...outgoing.get(s)!].sort((a, b) => a - b);
      }
      passers.forEach((s, i) => {
        const to = passers[(i + 1) % passers.length];
        this.passReceived[to] = [...outgoing.get(s)!].sort((a, b) => a - b);
      });
    }
    this.passSelections.clear();
    // 不論有沒有人換，都經過亮牌階段，避免從等待時間看出誰沒換
    this.phase = 'passReveal';
  }

  /** 亮牌階段結束：把收到的牌放進手牌，開始第一回合 */
  completePassReveal() {
    if (this.phase !== 'passReveal') return;
    this.passReceived.forEach((tiles, s) => {
      if (tiles) this.hands[s].push(...tiles);
    });
    this.hands.forEach((h) => h.sort((a, b) => a - b));
    this.beginTurn(this.startSeat, 'normal');
  }

  private actTurn(seat: number, avail: AvailableActions, action: GameAction): string | null {
    const hand = this.hands[seat];
    switch (action.type) {
      case 'discard': {
        if (!hand.includes(action.tile)) return '手中沒有這張牌';
        this.pending.clear();
        hand.splice(hand.indexOf(action.tile), 1);
        hand.sort((a, b) => a - b);
        const entry: DiscardEntry = { seat, tile: action.tile, called: false, houtei: !this.canDraw };
        this.discards[seat].push(entry);
        this.discardLog.push(entry);
        this.lastDiscard = entry;
        this.drawn = null;
        this.openClaimWindow(seat, action.tile);
        return null;
      }
      case 'tsumo': {
        if (!avail.tsumo) return '無法自摸';
        const score = this.evaluateTsumo(seat)!;
        this.endWithWinners([{ seat, tsumo: true, tile: this.drawn ?? hand[hand.length - 1], score }]);
        return null;
      }
      case 'ankan': {
        if (!avail.ankan?.includes(action.kind)) return '無法暗槓';
        const tiles = hand.filter((t) => kindOf(t) === action.kind);
        this.hands[seat] = hand.filter((t) => kindOf(t) !== action.kind);
        this.melds[seat].push({ type: 'ankan', tiles });
        this.pending.clear();
        this.beginTurn(seat, 'rinshan');
        return null;
      }
      case 'kakan': {
        if (!avail.kakan?.includes(action.kind)) return '無法加槓';
        const tile = hand.find((t) => kindOf(t) === action.kind)!;
        this.pending.clear();
        this.hands[seat] = hand.filter((t) => t !== tile);
        this.kakanPending = { seat, tile };
        this.openChankanWindow(seat, tile);
        return null;
      }
      default:
        return '現在請打牌';
    }
  }

  private actClaim(seat: number, avail: AvailableActions, action: GameAction): string | null {
    switch (action.type) {
      case 'pass':
        break;
      case 'ron':
        if (!avail.ron) return '無法和牌';
        break;
      case 'pon':
        if (!avail.pon) return '無法碰牌';
        break;
      case 'minkan':
        if (!avail.minkan) return '無法槓牌';
        break;
      case 'chi':
        if (!avail.chi?.some((c) => sameSet(c, action.tiles))) return '無法以這組牌吃牌';
        break;
      default:
        return '請選擇鳴牌或略過';
    }
    this.responses.set(seat, action);
    this.pending.delete(seat);
    if (this.pending.size === 0) {
      if (avail.kind === 'chankan') this.resolveChankan();
      else this.resolveClaims();
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 回合流程
  // ------------------------------------------------------------------

  private beginTurn(seat: number, draw: 'normal' | 'rinshan' | 'none') {
    this.current = seat;
    this.phase = 'turn';
    this.lastDiscard = null;
    this.kakanPending = null;
    this.rinshanDraw = draw === 'rinshan';
    this.drewThisTurn = draw !== 'none';
    if (draw !== 'none') {
      if (!this.canDraw) {
        this.endExhausted();
        return;
      }
      const tile = draw === 'normal' ? this.wall.shift()! : this.wall.pop()!;
      if (draw === 'normal') this.drawCount[seat]++;
      this.hands[seat].push(tile);
      this.drawn = tile;
    } else {
      this.drawn = null;
    }
    const hand = this.hands[seat];
    const counts = countOf(hand);
    const avail: AvailableActions = { kind: 'turn', discard: [...hand] };
    if (this.drewThisTurn && this.evaluateTsumo(seat)) avail.tsumo = true;
    if (this.canDraw) {
      const ankan = [...counts.entries()].filter(([, c]) => c === 4).map(([k]) => k);
      if (ankan.length) avail.ankan = ankan;
      const kakan = this.melds[seat].filter((m) => m.type === 'pon' && counts.get(kindOf(m.tiles[0]))).map((m) => kindOf(m.tiles[0]));
      if (kakan.length) avail.kakan = kakan;
    }
    avail.tenpaiHints = this.tenpaiHints(seat);
    this.pending.clear();
    this.pending.set(seat, avail);
  }

  private tenpaiHints(seat: number): Record<number, TileKind[]> {
    const hints: Record<number, TileKind[]> = {};
    const hand = this.hands[seat].map(kindOf);
    const tried = new Set<TileKind>();
    for (let i = 0; i < hand.length; i++) {
      if (tried.has(hand[i])) continue;
      tried.add(hand[i]);
      const rest = [...hand.slice(0, i), ...hand.slice(i + 1)];
      const w = waitingKinds(rest, this.melds[seat], this.settings.advanced);
      if (w.length) hints[hand[i]] = w;
    }
    return hints;
  }

  /**
   * 聽的牌與每種還剩幾張。只扣掉該座位看得到的牌：自己的手牌、捨牌、鳴牌（他人的暗槓不算）。
   * 換三張階段、局結束或手牌張數不是聽牌的張數時回傳空陣列。
   */
  waitsFor(seat: number): { kind: TileKind; left: number }[] {
    if (this.phase === 'passThree' || this.phase === 'passReveal' || this.phase === 'ended') return [];
    const kinds = this.hands[seat].map(kindOf);
    const waits = waitingKinds(kinds, this.melds[seat], this.settings.advanced);
    if (!waits.length) return [];
    const seen = countOf(this.hands[seat]);
    const see = (t: TileId) => seen.set(kindOf(t), (seen.get(kindOf(t)) ?? 0) + 1);
    this.discards.forEach((ds) => ds.forEach((d) => !d.called && see(d.tile)));
    this.melds.forEach((ms, i) => ms.forEach((m) => (m.type !== 'ankan' || i === seat) && m.tiles.forEach(see)));
    return waits.map((kind) => ({ kind, left: Math.max(0, 4 - (seen.get(kind) ?? 0)) }));
  }

  /** 自動模式用：目前可和的分數，以及這副聽牌可能的最高分（不含偶然類） */
  winPreview(seat: number): { score: HandScore; best: number } | null {
    const avail = this.pending.get(seat);
    if (!avail) return null;
    let score: HandScore | null;
    let waiting: TileId[];
    if (avail.kind === 'turn' && avail.tsumo) {
      score = this.evaluateTsumo(seat);
      const hand = this.hands[seat];
      const win = this.drawn ?? hand[hand.length - 1];
      waiting = hand.filter((t) => t !== win);
    } else if (avail.ron) {
      const chankan = avail.kind === 'chankan';
      const tile = chankan ? this.kakanPending!.tile : this.lastDiscard!.tile;
      score = this.evaluateRon(seat, tile, chankan ? { chankan: true } : { houtei: this.lastDiscard!.houtei });
      waiting = this.hands[seat];
    } else return null;
    if (!score) return null;
    const best = bestTenpaiScore(waiting.map(kindOf), this.melds[seat], this.seatWind(seat), this.settings.advanced, baseScoreFor(this.settings, seat));
    return { score, best: best?.score.total ?? score.total };
  }

  private winFlagsTsumo(seat: number): WinFlags {
    return {
      rinshan: this.rinshanDraw,
      haitei: !this.canDraw,
      tenhou: !this.rinshanDraw && this.drawCount[seat] === 1 && this.melds[seat].length === 0 && this.discards[seat].length === 0,
    };
  }

  private evaluate(seat: number, concealed: TileId[], winTile: TileId, tsumo: boolean, flags: WinFlags): HandScore | null {
    const kinds = concealed.map(kindOf);
    if (!isWinningShape(kinds, this.melds[seat].length, this.settings.advanced)) return null;
    const score = evaluateWin({
      concealed: kinds,
      melds: this.melds[seat],
      winTile: kindOf(winTile),
      tsumo,
      seatWind: this.seatWind(seat),
      advanced: this.settings.advanced,
      baseScore: baseScoreFor(this.settings, seat),
      flags,
    });
    if (!score) return null;
    // 和牌最低分數
    if (score.total < this.settings.minWinScore) return null;
    // 小牌限制
    if (this.settings.smallHandLimit && score.total < 20 && !this.smallHandAvailable[seat] && !this.settings.handicaps[seat]?.exemptSmallHand) {
      return null;
    }
    return score;
  }

  private evaluateTsumo(seat: number): HandScore | null {
    const hand = this.hands[seat];
    const winTile = this.drawn ?? hand[hand.length - 1];
    return this.evaluate(seat, hand, winTile, true, this.winFlagsTsumo(seat));
  }

  private evaluateRon(seat: number, tile: TileId, extra: WinFlags): HandScore | null {
    const flags: WinFlags = {
      ...extra,
      chiihou: this.drawCount[seat] === 0 && this.melds[seat].length === 0,
    };
    return this.evaluate(seat, [...this.hands[seat], tile], tile, false, flags);
  }

  private openClaimWindow(discarder: number, tile: TileId) {
    this.phase = 'claim';
    this.responses.clear();
    const k = kindOf(tile);
    const houtei = !this.canDraw;
    for (let i = 1; i < this.n; i++) {
      const seat = (discarder + i) % this.n;
      const hand = this.hands[seat];
      const same = hand.filter((t) => kindOf(t) === k);
      const avail: AvailableActions = { kind: 'claim' };
      let any = false;
      if (this.evaluateRon(seat, tile, { houtei })) (avail.ron = true), (any = true);
      if (same.length >= 2) (avail.pon = true), (any = true);
      if (same.length >= 3 && this.canDraw) (avail.minkan = true), (any = true);
      if (i === 1) {
        const chi = chiOptions(hand, tile);
        if (chi.length) (avail.chi = chi), (any = true);
      }
      if (any) this.pending.set(seat, avail);
    }
    if (this.pending.size === 0) this.advanceAfterDiscard(discarder);
  }

  private advanceAfterDiscard(discarder: number) {
    this.beginTurn((discarder + 1) % this.n, 'normal');
  }

  private resolveClaims() {
    const discard = this.lastDiscard!;
    const discarder = discard.seat;
    const order = [...Array(this.n - 1).keys()].map((i) => (discarder + 1 + i) % this.n);
    const rons = order.filter((s) => this.responses.get(s)?.type === 'ron');
    if (rons.length) {
      const houtei = discard.houtei;
      this.endWithWinners(
        rons.map((seat) => ({
          seat,
          tsumo: false,
          from: discarder,
          tile: discard.tile,
          score: this.evaluateRon(seat, discard.tile, { houtei })!,
        })),
      );
      return;
    }
    const ponKan = order.find((s) => ['pon', 'minkan'].includes(this.responses.get(s)?.type ?? ''));
    const chiSeat = order.find((s) => this.responses.get(s)?.type === 'chi');
    const claimer = ponKan ?? chiSeat;
    if (claimer === undefined) {
      this.responses.clear();
      this.advanceAfterDiscard(discarder);
      return;
    }
    const action = this.responses.get(claimer)!;
    this.responses.clear();
    discard.called = true;
    const k = kindOf(discard.tile);
    const hand = this.hands[claimer];
    let used: TileId[];
    let type: Meld['type'];
    if (action.type === 'chi') {
      used = [...action.tiles];
      type = 'chi';
    } else {
      used = hand.filter((t) => kindOf(t) === k).slice(0, action.type === 'pon' ? 2 : 3);
      type = action.type === 'pon' ? 'pon' : 'minkan';
    }
    this.hands[claimer] = hand.filter((t) => !used.includes(t));
    const tiles = [...used, discard.tile].sort((a, b) => a - b);
    this.melds[claimer].push({ type, tiles, calledTile: discard.tile, from: discarder });
    this.beginTurn(claimer, type === 'minkan' ? 'rinshan' : 'none');
  }

  private openChankanWindow(kakanSeat: number, tile: TileId) {
    this.phase = 'chankan';
    this.responses.clear();
    for (let i = 1; i < this.n; i++) {
      const seat = (kakanSeat + i) % this.n;
      if (this.evaluateRon(seat, tile, { chankan: true })) this.pending.set(seat, { kind: 'chankan', ron: true });
    }
    if (this.pending.size === 0) this.completeKakan();
  }

  private resolveChankan() {
    const { seat: kakanSeat, tile } = this.kakanPending!;
    const order = [...Array(this.n - 1).keys()].map((i) => (kakanSeat + 1 + i) % this.n);
    const rons = order.filter((s) => this.responses.get(s)?.type === 'ron');
    this.responses.clear();
    if (rons.length) {
      this.endWithWinners(
        rons.map((seat) => ({ seat, tsumo: false, from: kakanSeat, tile, score: this.evaluateRon(seat, tile, { chankan: true })! })),
      );
      return;
    }
    this.completeKakan();
  }

  private completeKakan() {
    const { seat, tile } = this.kakanPending!;
    const meld = this.melds[seat].find((m) => m.type === 'pon' && kindOf(m.tiles[0]) === kindOf(tile))!;
    meld.type = 'kakan';
    meld.tiles = [...meld.tiles, tile].sort((a, b) => a - b);
    this.kakanPending = null;
    this.beginTurn(seat, 'rinshan');
  }

  // ------------------------------------------------------------------
  // 結束
  // ------------------------------------------------------------------

  private endWithWinners(winners: Winner[]) {
    if (this.settings.scoring === 'zeroSum') winners = winners.map((w) => this.applySameTurnExemption(w));
    this.finish('win', winners);
  }

  /**
   * 零和式「同巡跟打免責」：和牌者上一回合打牌（含）起，若有與放銃牌相同的捨牌，
   * 視為最先打出者放銃；若最先打出者為和牌者本人，視為自摸。
   */
  private applySameTurnExemption(w: Winner): Winner {
    if (w.tsumo || w.score.yaku.some((y) => y.id === '6.1.1')) return w;
    let start = -1;
    for (let i = this.discardLog.length - 1; i >= 0; i--) {
      if (this.discardLog[i].seat === w.seat) {
        start = i;
        break;
      }
    }
    if (start < 0) return w;
    const k = kindOf(w.tile);
    const first = this.discardLog.slice(start).find((d) => kindOf(d.tile) === k);
    if (!first || first === this.discardLog[this.discardLog.length - 1]) return w;
    if (first.seat === w.seat) {
      const concealed = [...this.hands[w.seat], w.tile];
      const score = this.evaluate(w.seat, concealed, w.tile, true, {}) ?? w.score;
      return { ...w, tsumo: true, from: undefined, score };
    }
    const score = this.evaluateRon(w.seat, w.tile, { houtei: first.houtei }) ?? w.score;
    return { ...w, from: first.seat, score };
  }

  private endExhausted() {
    this.drawn = null;
    this.finish('draw', []);
  }

  private finish(kind: 'win' | 'draw', winners: Winner[]) {
    this.phase = 'ended';
    this.pending.clear();
    const winnerSeats = new Set(winners.map((w) => w.seat));
    const tenpai: HandResult['tenpai'] = [];
    for (let s = 0; s < this.n; s++) {
      if (winnerSeats.has(s)) continue;
      const kinds = this.hands[s].map(kindOf);
      const r = bestTenpaiScore(kinds, this.melds[s], this.seatWind(s), this.settings.advanced, baseScoreFor(this.settings, s));
      if (r) tenpai.push({ seat: s, maxScore: r.score.total, waits: r.waits, best: { tile: r.tile, tsumo: r.tsumo, score: r.score } });
    }
    const useTenpai = this.settings.scoring === 'additive' && this.settings.advanced;
    const { deltas, lines } = settle(this.settings, winners, useTenpai ? tenpai : []);
    this.result = {
      kind,
      winners,
      tenpai,
      deltas,
      lines,
      hands: this.hands.map((h) => [...h]),
      melds: this.melds.map((m) => m.map((x) => ({ ...x, tiles: [...x.tiles] }))),
    };
  }
}

function countOf(hand: TileId[]): Map<TileKind, number> {
  const m = new Map<TileKind, number>();
  for (const t of hand) m.set(kindOf(t), (m.get(kindOf(t)) ?? 0) + 1);
  return m;
}

function sameSet(a: TileId[], b: TileId[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** 吃牌的搭子選擇（每種組合只列一次，取最小 id 的實體牌） */
export function chiOptions(hand: TileId[], tile: TileId): [TileId, TileId][] {
  const k = kindOf(tile);
  if (k >= 27) return [];
  const find = (kind: TileKind) => (kind >= 0 && kind < 27 && suitOf(kind) === suitOf(k) ? hand.find((t) => kindOf(t) === kind) : undefined);
  const out: [TileId, TileId][] = [];
  for (const [a, b] of [[k - 2, k - 1], [k - 1, k + 1], [k + 1, k + 2]]) {
    const ta = find(a);
    const tb = find(b);
    if (ta !== undefined && tb !== undefined) out.push([ta, tb]);
  }
  return out;
}
