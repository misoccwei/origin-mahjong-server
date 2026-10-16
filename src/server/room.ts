import { PROTOCOL_VERSION, type GameAction, type GameView, type HandResultView, type PlayerView, type RoomSummary, type RoomView } from '../shared/protocol.js';
import { REPLAY_FORMAT, REPLAY_SCHEMA_VERSION, type ReplayFile, type ReplayHand } from '../shared/replaySchema.js';
import { sanitizeSettings, type AILevel, type Meld, type RuleSettings } from '../shared/rules.js';
import { autoAction, decideAction } from './engine/ai.js';
import type { HandResult, Rng } from './engine/hand.js';
import { Match } from './engine/match.js';
import { replayHandOf } from './replay.js';

export interface Seat {
  /** 真人座位的使用者代碼；AI 為 null */
  userId: string | null;
  nickname: string;
  isAI: boolean;
  /** 真人斷線／離開後，由房主決定交給 AI 代打 */
  aiControlled: boolean;
  ready: boolean;
  /** 牌局中途離開 */
  left: boolean;
  /** 自動摸打（只在這一局有效，下一局自動關閉） */
  autoPlay?: boolean;
  /** 自動和牌（持續有效） */
  autoWin?: boolean;
  /** 不鳴牌：別人打牌時不吃碰槓（自動略過；能和時仍由玩家決定），持續有效 */
  noCall?: boolean;
  /** 等待中斷線的時間（用於等待房間的清理） */
  offlineSince: number | null;
}

export interface RoomDeps {
  isOnline(userId: string): boolean;
  /** 推送最新狀態給這些使用者 */
  notify(userIds: string[]): void;
  /** 使用者被移出房間（例如等待中斷線過久） */
  onUserRemoved(userId: string): void;
  onDestroy(room: Room): void;
  aiDelayMs: number;
  /** 一局結束後顯示結果的最長時間；未指定時依規則設定的 resultSeconds（測試用來縮短） */
  resultMs?: number;
  /** 換三張後亮出收到的牌多久 */
  passRevealMs: number;
  /** 等待中的房間，真人斷線多久後移出座位 */
  waitingOfflineMs: number;
  rng?: Rng;
}

export type RoomResult = { ok: true } | { ok: false; error: string };
const ok: RoomResult = { ok: true };
const fail = (error: string): RoomResult => ({ ok: false, error });
/** 他人的暗槓：牌以 -1 遮蔽 */
const maskAnkan = (melds: Meld[]): Meld[] => melds.map((m) => (m.type === 'ankan' ? { ...m, tiles: m.tiles.map(() => -1) } : m));
/** 交給 AI 快速打完一局時，每一步之間的間隔 */
const FAST_FINISH_MS = 20;

export class Room {
  readonly id: string;
  settings: RuleSettings;
  status: 'waiting' | 'playing' | 'finished' = 'waiting';
  seats: (Seat | null)[];
  hostSeat = 0;
  match: Match | null = null;
  paused: { disconnectedSeats: number[]; deciderSeat: number | null } | null = null;
  dissolved = false;
  destroyed = false;
  private acks = new Set<number>();
  /** 局結束時主動展示手牌的座位 */
  private shown = new Set<number>();
  /** 這一局已經用過「長考」的座位 */
  private thought = new Set<number>();
  /** 單人對 AI：這一局交給 AI 快速打完（下一局恢復） */
  private fastFinish = false;
  private timers: NodeJS.Timeout[] = [];
  private windowId = '';
  private deadline: number | null = null;
  private aiCounter = 0;
  /** 這場牌局每一局的結果、當時主動展示手牌的座位與回放紀錄（加圈時保留，重新開始時清空；只在記憶體裡） */
  private replays: { handNo: number; result: HandResult; shown: number[]; replay: ReplayHand }[] = [];
  /** 觀戰者：userId → 暱稱與斷線時間 */
  spectators = new Map<string, { nickname: string; offlineSince: number | null }>();

  constructor(id: string, settings: RuleSettings, private deps: RoomDeps) {
    this.id = id;
    this.settings = settings;
    this.seats = new Array(settings.playerCount).fill(null);
  }

  // ------------------------------------------------------------------
  // 座位與成員
  // ------------------------------------------------------------------

  seatOf(userId: string): number {
    return this.seats.findIndex((s) => s?.userId === userId);
  }

  humanUserIds(): string[] {
    return this.seats.filter((s): s is Seat => !!s && !!s.userId && !s.left).map((s) => s.userId!);
  }

  /** 收狀態推送的人：在座的真人與觀戰者 */
  private audienceIds(): string[] {
    return [...this.humanUserIds(), ...this.spectators.keys()];
  }

  isSpectator(userId: string): boolean {
    return this.spectators.has(userId);
  }

  private isOnlineSeat(i: number): boolean {
    const s = this.seats[i];
    if (!s) return false;
    if (s.isAI) return true;
    return !!s.userId && !s.left && this.deps.isOnline(s.userId);
  }

  private isAISeat(i: number): boolean {
    const s = this.seats[i];
    return !!s && (s.isAI || s.aiControlled);
  }

  /** 一個真人對上其餘全是 AI：操作不限時、局結束公開 AI 手牌、可以交給 AI 快速打完一局 */
  isSolo(): boolean {
    return this.seats.every((s) => s !== null) && this.seats.filter((s) => !s!.isAI).length === 1;
  }

  /** 由 AI 決定的座位：AI、交給 AI 代打的真人，以及單人對 AI 時交給 AI 快速打完的自己 */
  private decidedByAI(i: number): boolean {
    return this.isAISeat(i) || (this.fastFinish && !this.seats[i]?.isAI);
  }

  private isHumanActive(i: number): boolean {
    const s = this.seats[i];
    return !!s && !s.isAI && !s.left && !!s.userId;
  }

  join(userId: string, nickname: string): RoomResult {
    const existing = this.seatOf(userId);
    if (existing >= 0) {
      const s = this.seats[existing]!;
      s.nickname = nickname;
      s.left = false;
      s.offlineSince = null;
      // 回到牌局：拿回控制權
      if (!s.isAI) s.aiControlled = false;
      this.afterChange();
      return ok;
    }
    if (this.status !== 'waiting') return fail('牌局已經開始，無法加入');
    const free = this.seats.findIndex((s) => s === null);
    if (free < 0) return fail('房間已滿');
    this.spectators.delete(userId);
    this.seats[free] = { userId, nickname, isAI: false, aiControlled: false, ready: false, left: false, offlineSince: null };
    if (!this.seats.some((s, i) => i !== free && s && !s.isAI)) this.hostSeat = free;
    this.afterChange();
    return ok;
  }

  /** 觀戰：不佔座位，只看公開資訊 */
  spectate(userId: string, nickname: string): RoomResult {
    if (this.seatOf(userId) >= 0) return fail('你已經在這個房間的座位上');
    if (!this.settings.allowSpectators) return fail('這個房間不開放觀戰');
    this.spectators.set(userId, { nickname, offlineSince: null });
    this.afterChange();
    return ok;
  }

  /** 觀戰者改暱稱 */
  renameSpectator(userId: string, nickname: string) {
    const s = this.spectators.get(userId);
    if (!s) return;
    s.nickname = nickname;
    this.afterChange();
  }

  private removeSpectator(userId: string) {
    if (!this.spectators.delete(userId)) return;
    this.deps.onUserRemoved(userId);
  }

  leave(userId: string): RoomResult {
    if (this.spectators.has(userId)) {
      this.removeSpectator(userId);
      this.afterChange();
      return ok;
    }
    const seat = this.seatOf(userId);
    if (seat < 0) return fail('不在房間中');
    if (this.status === 'waiting') {
      this.seats[seat] = null;
    } else {
      const s = this.seats[seat]!;
      s.left = true;
      s.ready = false;
    }
    this.deps.onUserRemoved(userId);
    if (seat === this.hostSeat) this.transferHost();
    if (!this.seats.some((s, i) => s && this.isHumanActive(i))) {
      this.destroy();
      return ok;
    }
    this.afterChange();
    return ok;
  }

  private transferHost() {
    const n = this.seats.length;
    const candidates = [...Array(n - 1).keys()].map((i) => (this.hostSeat + 1 + i) % n).filter((i) => this.isHumanActive(i));
    const online = candidates.find((i) => this.isOnlineSeat(i));
    const next = online ?? candidates[0];
    if (next !== undefined) this.hostSeat = next;
  }

  /** 連線狀態改變時由伺服器呼叫 */
  connectionChanged(userId: string) {
    const spec = this.spectators.get(userId);
    if (spec) {
      spec.offlineSince = this.deps.isOnline(userId) ? null : Date.now();
      this.afterChange();
      return;
    }
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat]!;
    const online = this.deps.isOnline(userId);
    s.offlineSince = online ? null : Date.now();
    if (online && !s.left) s.aiControlled = false;
    this.afterChange();
  }

  /** 定期呼叫：等待中的房間移除斷線過久的玩家 */
  sweep(now = Date.now()) {
    let changed = false;
    // 觀戰者斷線過久就移出（不論牌局狀態）
    for (const [id, s] of [...this.spectators]) {
      if (s.offlineSince !== null && now - s.offlineSince >= this.deps.waitingOfflineMs) {
        this.removeSpectator(id);
        changed = true;
      }
    }
    if (this.status !== 'waiting') {
      if (changed) this.afterChange();
      return;
    }
    this.seats.forEach((s, i) => {
      if (s && !s.isAI && s.offlineSince !== null && now - s.offlineSince >= this.deps.waitingOfflineMs) {
        this.seats[i] = null;
        this.deps.onUserRemoved(s.userId!);
        changed = true;
        if (i === this.hostSeat) this.transferHost();
      }
    });
    if (!changed) return;
    if (!this.seats.some((s, i) => s && this.isHumanActive(i))) this.destroy();
    else this.afterChange();
  }

  // ------------------------------------------------------------------
  // 房主操作
  // ------------------------------------------------------------------

  private isHost(userId: string) {
    return this.seatOf(userId) === this.hostSeat;
  }

  updateSettings(userId: string, input: Partial<RuleSettings>): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以修改設定');
    if (this.status !== 'waiting') return fail('牌局進行中無法修改設定');
    const next = sanitizeSettings(input, this.settings);
    const occupied = this.seats.filter(Boolean) as Seat[];
    if (occupied.length > next.playerCount) return fail('目前人數超過新的人數設定，請先移除座位');
    if (next.playerCount !== this.settings.playerCount) {
      const hostUser = this.seats[this.hostSeat]?.userId;
      this.seats = [...occupied, ...new Array(next.playerCount - occupied.length).fill(null)];
      this.hostSeat = Math.max(0, this.seats.findIndex((s) => s?.userId === hostUser));
      next.handicaps = {};
    }
    this.settings = next;
    if (!next.allowSpectators) for (const id of [...this.spectators.keys()]) this.removeSpectator(id);
    // 設定變更後重新確認準備
    this.seats.forEach((s) => s && !s.isAI && (s.ready = false));
    this.afterChange();
    return ok;
  }

  addAI(userId: string): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以加入 AI');
    if (this.status === 'playing') return fail('牌局進行中無法加入 AI');
    if (this.status === 'waiting') {
      const free = this.seats.findIndex((s) => s === null);
      if (free < 0) return fail('房間已滿');
      this.seats[free] = this.makeAI();
    } else {
      // 牌局結束後：以 AI 補上已離開的座位
      const leftSeat = this.seats.findIndex((s) => s?.left);
      if (leftSeat < 0) return fail('沒有空出的座位');
      this.seats[leftSeat] = this.makeAI();
    }
    this.afterChange();
    return ok;
  }

  private makeAI(): Seat {
    this.aiCounter++;
    return { userId: null, nickname: `電腦 ${this.aiCounter}`, isAI: true, aiControlled: false, ready: true, left: false, offlineSince: null };
  }

  removeSeat(userId: string, seat: number): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以移除座位');
    if (this.status !== 'waiting') return fail('牌局進行中無法移除座位');
    const s = this.seats[seat];
    if (!s) return fail('座位是空的');
    if (seat === this.hostSeat) return fail('不能移除自己');
    this.seats[seat] = null;
    if (s.userId) this.deps.onUserRemoved(s.userId);
    this.afterChange();
    return ok;
  }

  setReady(userId: string, ready: boolean): RoomResult {
    const seat = this.seatOf(userId);
    if (seat < 0) return fail('不在房間中');
    if (this.status !== 'waiting') return fail('牌局已經開始');
    this.seats[seat]!.ready = ready;
    this.afterChange();
    return ok;
  }

  /** 房主按「開始」：座位坐滿、其他真人都已準備 */
  start(userId: string): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以開始牌局');
    if (this.status !== 'waiting') return fail('牌局已經開始');
    if (!this.seats.every((s) => s !== null)) return fail('座位還沒坐滿');
    const allReady = this.seats.every((s, i) => s && (s.isAI || i === this.hostSeat || (s.ready && this.isOnlineSeat(i))));
    if (!allReady) return fail('還有玩家沒有準備');
    if (this.settings.randomSeats) this.shuffleSeats();
    this.status = 'playing';
    this.dissolved = false;
    this.replays = [];
    this.match = new Match(this.settings, { rng: this.deps.rng });
    this.match.startHand();
    this.acks.clear();
    this.thought.clear();
    this.fastFinish = false;
    this.afterChange();
    return ok;
  }

  /** 隨機座位：打亂座位順序，房主與讓分設定跟著人走 */
  private shuffleSeats() {
    const rng = this.deps.rng ?? ((n: number) => Math.floor(Math.random() * n));
    const order = this.seats.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const handicaps: RuleSettings['handicaps'] = {};
    order.forEach((from, to) => {
      if (this.settings.handicaps[from]) handicaps[to] = this.settings.handicaps[from];
    });
    this.hostSeat = order.indexOf(this.hostSeat);
    this.seats = order.map((from) => this.seats[from]);
    this.settings = { ...this.settings, handicaps };
  }

  /** 牌局結束後加一圈 */
  extend(userId: string): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以加圈');
    if (this.status !== 'finished' || !this.match || this.dissolved) return fail('目前無法加圈');
    if (this.seats.some((s) => !s || s.left)) return fail('有玩家已離開，請先以 AI 補位');
    this.match.extend(1);
    this.status = 'playing';
    this.acks.clear();
    this.match.startHand();
    this.afterChange();
    return ok;
  }

  /** 回到等待房間（重新開始新的一場） */
  restart(userId: string): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以重新開始');
    if (this.status !== 'finished') return fail('牌局尚未結束');
    this.status = 'waiting';
    this.match = null;
    this.replays = [];
    this.dissolved = false;
    this.seats = this.seats.map((s) => (s && !s.left ? { ...s, ready: s.isAI, aiControlled: false, autoPlay: false } : null));
    this.afterChange();
    return ok;
  }

  /** 斷線暫停時由決定者選擇：交給 AI 代打或解散 */
  decide(userId: string, choice: 'ai' | 'dissolve'): RoomResult {
    if (!this.paused) return fail('目前不需要決定');
    if (this.seatOf(userId) !== this.paused.deciderSeat) return fail('目前由其他玩家決定');
    if (choice === 'ai') {
      for (const i of this.paused.disconnectedSeats) this.seats[i]!.aiControlled = true;
    } else if (choice === 'dissolve') {
      this.status = 'finished';
      this.dissolved = true;
      if (this.match) this.match.hand = null;
    } else {
      return fail('無效的選擇');
    }
    this.paused = null;
    this.afterChange();
    return ok;
  }

  // ------------------------------------------------------------------
  // 遊戲進行
  // ------------------------------------------------------------------

  action(userId: string, handNo: number, action: GameAction): RoomResult {
    const seat = this.seatOf(userId);
    const hand = this.match?.hand;
    if (seat < 0 || this.status !== 'playing' || !hand) return fail('目前沒有進行中的牌局');
    if (this.paused) return fail('牌局暫停中');
    if (handNo !== this.match!.handIndex + 1) return fail('局數不符');
    if (this.seats[seat]!.aiControlled) return fail('目前由 AI 代打');
    if (this.fastFinish) return fail('這一局已經交給 AI 打完');
    const err = hand.act(seat, action);
    if (err) return fail(err);
    this.afterChange();
    return ok;
  }

  setAuto(userId: string, on: boolean, win: boolean, noCall = false): RoomResult {
    const seat = this.seatOf(userId);
    if (seat < 0) return fail('不在房間中');
    const s = this.seats[seat]!;
    s.autoPlay = on;
    s.autoWin = win;
    s.noCall = noCall;
    this.afterChange();
    return ok;
  }

  setAILevel(userId: string, level: AILevel): RoomResult {
    if (!this.isHost(userId)) return fail('只有房主可以調整電腦難度');
    if (!['beginner', 'easy', 'normal', 'hard'].includes(level)) return fail('不明的難度');
    // 牌局與這一局共用同一個設定物件，直接修改即可立即生效；不重設準備狀態
    this.settings.aiLevel = level;
    this.afterChange();
    return ok;
  }

  /** 長考：自己的回合把打牌時限延長 60 秒，每局一次 */
  think(userId: string): RoomResult {
    const seat = this.seatOf(userId);
    const hand = this.match?.hand;
    if (seat < 0 || !hand || this.status !== 'playing' || this.paused) return fail('目前不能長考');
    if (hand.pending.get(seat)?.kind !== 'turn' || this.deadline === null) return fail('只有自己打牌、而且有時限時才能長考');
    if (this.thought.has(seat)) return fail('這一局已經長考過了');
    this.thought.add(seat);
    this.deadline += 60_000;
    this.afterChange();
    return ok;
  }

  /** 單人對 AI：自己的座位也交給 AI，快速打完這一局（下一局恢復自己打） */
  finishHandByAI(userId: string): RoomResult {
    const seat = this.seatOf(userId);
    const hand = this.match?.hand;
    if (seat < 0 || !hand || this.status !== 'playing' || hand.phase === 'ended') return fail('目前沒有進行中的牌局');
    if (!this.isSolo()) return fail('只有一個人對電腦時才能交給 AI 打完');
    if (this.paused) return fail('牌局暫停中');
    this.fastFinish = true;
    this.afterChange();
    return ok;
  }

  /** 大廳列表用：還在等待、有空位的房間 */
  summary(): RoomSummary | null {
    if (this.destroyed) return null;
    const seated = this.seats.filter(Boolean).length;
    const joinable = this.status === 'waiting' && seated < this.seats.length;
    const spectatable = this.settings.allowSpectators;
    if (!joinable && !spectatable) return null;
    return {
      id: this.id,
      hostName: this.seats[this.hostSeat]?.nickname ?? '',
      status: this.status,
      joinable,
      spectatable,
      spectators: this.spectators.size,
      seated,
      playerCount: this.settings.playerCount,
      advanced: this.settings.advanced,
      scoring: this.settings.scoring,
    };
  }

  showHand(userId: string): RoomResult {
    const seat = this.seatOf(userId);
    if (seat < 0 || this.match?.hand?.phase !== 'ended') return fail('目前不能展示手牌');
    this.shown.add(seat);
    this.afterChange();
    return ok;
  }

  /** 牌局結束後的回放檔（在座的玩家與觀戰者都可以拿；匿名在網頁端處理） */
  replayFile(userId: string): { ok: true; replay: ReplayFile } | { ok: false; error: string } {
    if (this.seatOf(userId) < 0 && !this.spectators.has(userId)) return { ok: false, error: '不在房間中' };
    if (this.status !== 'finished' || !this.match) return { ok: false, error: '牌局結束後才能儲存回放' };
    if (!this.replays.length) return { ok: false, error: '還沒有打完的局，無法儲存回放' };
    return {
      ok: true,
      replay: {
        format: REPLAY_FORMAT,
        schema: REPLAY_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        appProtocol: PROTOCOL_VERSION,
        roomId: this.id,
        anonymous: false,
        dissolved: this.dissolved,
        settings: structuredClone(this.settings) as unknown as Record<string, unknown>,
        players: this.seats.map((s, i) => ({ seat: i, name: s?.nickname ?? '', isAI: !!s?.isAI })),
        hands: this.replays.map((x) => x.replay),
        finalScores: [...this.match.scores],
      },
    };
  }

  nextHand(userId: string): RoomResult {
    const seat = this.seatOf(userId);
    if (seat < 0 || this.match?.hand?.phase !== 'ended') return fail('目前不能進入下一局');
    this.acks.add(seat);
    this.afterChange();
    return ok;
  }

  private advanceHand() {
    const m = this.match;
    if (!m?.hand || m.hand.phase !== 'ended') return;
    const handNo = m.handIndex + 1;
    this.replays.push({ handNo, result: m.hand.result!, shown: [...this.shown], replay: replayHandOf(m.hand, handNo, m.scores) });
    m.completeHand();
    this.acks.clear();
    this.shown.clear();
    if (m.finished) this.status = 'finished';
    else {
      // 自動摸打與自動和牌只維持一局
      for (const s of this.seats) if (s) (s.autoPlay = false), (s.autoWin = false);
      this.thought.clear();
      this.fastFinish = false;
      m.startHand();
    }
    this.afterChange();
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, Math.max(0, ms)));
  }

  private updatePause() {
    if (this.status !== 'playing') {
      this.paused = null;
      return;
    }
    const offline = this.seats.map((_, i) => i).filter((i) => !this.isAISeat(i) && !this.isOnlineSeat(i));
    if (!offline.length) {
      this.paused = null;
      return;
    }
    const n = this.seats.length;
    let decider: number | null = this.isOnlineSeat(this.hostSeat) && !this.seats[this.hostSeat]!.isAI ? this.hostSeat : null;
    if (decider === null) {
      // 房主不在時由房主的下家（依座位順序第一位在線真人）決定
      for (let k = 1; k < n; k++) {
        const i = (this.hostSeat + k) % n;
        if (this.isHumanActive(i) && this.isOnlineSeat(i)) {
          decider = i;
          break;
        }
      }
    }
    this.paused = { disconnectedSeats: offline, deciderSeat: decider };
  }

  private afterChange() {
    if (this.destroyed) return;
    // 牌局中已經沒有真人在打（都離開了，或都交給 AI 代打）：只剩 AI 互打沒有意義，直接結束牌局。
    // 斷線但還沒交給 AI 的真人不算離開（牌局會暫停等他回來）。
    if (this.status === 'playing' && !this.seats.some((s) => s && !s.isAI && !s.left && !s.aiControlled)) {
      this.status = 'finished';
      this.dissolved = true;
      if (this.match) this.match.hand = null;
    }
    this.schedule();
    this.deps.notify(this.audienceIds());
  }

  private schedule() {
    this.clearTimers();
    this.updatePause();
    const m = this.match;
    if (this.status !== 'playing' || this.paused || !m?.hand) {
      this.deadline = null;
      return;
    }
    const hand = m.hand;
    if (hand.phase === 'ended') {
      const wid = `result:${m.handIndex}`;
      if (wid !== this.windowId) {
        this.windowId = wid;
        const ms = this.deps.resultMs ?? this.settings.resultSeconds * 1000;
        // 單人對 AI：結算不倒數，等玩家按下一局
        this.deadline = ms > 0 && !this.isSolo() ? Date.now() + ms : null;
      }
      const needAck = this.seats.map((_, i) => i).filter((i) => !this.isAISeat(i));
      if (needAck.every((i) => this.acks.has(i))) this.later(0, () => this.advanceHand());
      else if (this.deadline !== null) this.later(this.deadline - Date.now(), () => this.advanceHand());
      return;
    }
    if (hand.phase === 'passReveal') {
      const wid = `${m.handIndex}:passReveal`;
      if (wid !== this.windowId) {
        this.windowId = wid;
        this.deadline = Date.now() + (this.fastFinish ? 0 : this.deps.passRevealMs);
      }
      this.later(this.deadline! - Date.now(), () => {
        if (this.windowId !== wid || this.paused) return;
        hand.completePassReveal();
        this.afterChange();
      });
      return;
    }
    const pendingSeats = [...hand.pending.keys()];
    const wid = `${m.handIndex}:${hand.phase}:${hand.discardLog.length}:${hand.wallRemaining}:${hand.melds.flat().length}`;
    if (wid !== this.windowId) {
      this.windowId = wid;
      // 單人對 AI：操作不限時
      const secs = this.isSolo()
        ? 0
        : hand.phase === 'passThree'
          ? this.settings.turnSeconds * 2
          : hand.phase === 'turn'
            ? this.settings.turnSeconds
            : this.settings.claimSeconds;
      this.deadline = secs > 0 ? Date.now() + secs * 1000 : null;
    }
    let humanPending = false;
    const aiDelay = this.fastFinish ? Math.min(this.deps.aiDelayMs, FAST_FINISH_MS) : this.deps.aiDelayMs;
    for (const seat of pendingSeats) {
      if (this.decidedByAI(seat)) {
        this.later(aiDelay, () => this.runAI(seat, wid));
      } else if (autoAction(hand, seat, this.autoOpts(seat))) {
        this.later(Math.min(this.deps.aiDelayMs, 500), () => this.runAuto(seat, wid));
      } else humanPending = true; // 包含自動摸打遇到能槓、要問玩家的情況
    }
    if (humanPending && this.deadline !== null) {
      this.later(this.deadline - Date.now(), () => this.onTimeout(wid));
    }
  }

  private runAI(seat: number, wid: string) {
    const hand = this.match?.hand;
    if (!hand || wid !== this.windowId || !hand.pending.has(seat) || this.paused) return;
    const err = hand.act(seat, decideAction(hand, seat));
    if (err) hand.act(seat, hand.defaultAction(seat));
    this.afterChange();
  }

  private autoOpts(seat: number) {
    const s = this.seats[seat];
    return { play: !!s?.autoPlay, win: !!s?.autoWin, noCall: !!s?.noCall };
  }

  private runAuto(seat: number, wid: string) {
    const hand = this.match?.hand;
    const s = this.seats[seat];
    if (!hand || !s || wid !== this.windowId || !hand.pending.has(seat) || this.paused) return;
    const action = autoAction(hand, seat, this.autoOpts(seat));
    if (!action) return;
    const err = hand.act(seat, action);
    if (err) hand.act(seat, hand.defaultAction(seat));
    this.afterChange();
  }

  private onTimeout(wid: string) {
    const hand = this.match?.hand;
    if (!hand || wid !== this.windowId || this.paused) return;
    for (const seat of [...hand.pending.keys()]) {
      if (this.isAISeat(seat) || !hand.pending.has(seat)) continue;
      hand.act(seat, hand.defaultAction(seat));
      if (this.windowId !== wid) break;
    }
    this.afterChange();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    for (const s of this.seats) if (s?.userId && !s.left) this.deps.onUserRemoved(s.userId);
    for (const id of [...this.spectators.keys()]) this.removeSpectator(id);
    this.deps.onDestroy(this);
  }

  // ------------------------------------------------------------------
  // 狀態快照
  // ------------------------------------------------------------------

  roomView(userId: string): RoomView {
    const mySeat = this.seatOf(userId);
    const hand = this.match?.hand;
    const players: PlayerView[] = this.seats.map((s, i) => ({
      seat: i,
      nickname: s?.nickname ?? null,
      userId: s?.userId ?? null,
      isAI: !!s?.isAI,
      aiControlled: !!s?.aiControlled,
      autoPlay: !!s?.autoPlay,
      connected: this.isOnlineSeat(i),
      left: !!s?.left,
      ready: !!s?.ready,
      score: this.match?.scores[i] ?? 0,
      wind: hand ? hand.seatWind(i) : null,
      handCount: hand ? hand.hands[i].length : 0,
      hasDrawn: !!hand && hand.phase === 'turn' && hand.current === i && hand.drawn !== null,
      melds: hand ? (i === mySeat ? hand.melds[i] : maskAnkan(hand.melds[i])) : [],
      discards: hand ? hand.discards[i].map((d) => ({ tile: d.tile, called: d.called })) : [],
    }));
    return {
      id: this.id,
      hostSeat: this.hostSeat,
      status: this.status,
      settings: this.settings,
      players,
      mySeat: mySeat >= 0 ? mySeat : null,
      paused: this.paused,
      history: this.match?.history ?? [],
      dissolved: this.dissolved,
      spectators: [...this.spectators].map(([id, s]) => ({ userId: id, nickname: s.nickname })),
      replays: this.status === 'finished' ? this.replays.map((x) => ({ handNo: x.handNo, result: this.resultView(x.result, x.shown, mySeat, []) })) : [],
    };
  }

  /** 局結果：只公開看得到的手牌（自己、和牌者、聽牌者、主動展示者），連同暗槓一起；其他座位遮蔽 */
  private resultView(r: HandResult, shown: number[], seat: number, acknowledged: number[]): HandResultView {
    // 單人對 AI：AI 的手牌也公開
    const solo = this.isSolo();
    const revealed = (i: number) =>
      i === seat || shown.includes(i) || r.winners.some((w) => w.seat === i) || r.tenpai.some((t) => t.seat === i) || (solo && !!this.seats[i]?.isAI);
    return {
      kind: r.kind,
      winners: r.winners,
      tenpai: r.tenpai,
      deltas: r.deltas,
      lines: r.lines,
      hands: r.hands.map((h, i) => (revealed(i) ? h : [])),
      melds: r.melds.map((ms, i) => (revealed(i) ? ms : maskAnkan(ms))),
      shown,
      acknowledged,
    };
  }

  gameView(userId: string): GameView | null {
    const m = this.match;
    const hand = m?.hand;
    const seat = this.seatOf(userId);
    if (!m || !hand) return null;
    if (seat < 0 && !this.spectators.has(userId)) return null;
    // 觀戰者（seat = -1）：只有公開資訊，沒有手牌與操作
    const mine = seat >= 0;
    const phase = hand.phase === 'ended' ? 'result' : hand.phase;
    const r = hand.result;
    return {
      handNo: m.handIndex + 1,
      totalHands: m.totalHands,
      startSeat: hand.startSeat,
      phase,
      currentSeat: hand.current,
      wallRemaining: hand.wallRemaining,
      deadWall: hand.deadWall,
      myHand: mine ? [...hand.hands[seat]] : [],
      myDrawn: mine && hand.current === seat && hand.phase === 'turn' ? hand.drawn : null,
      lastDiscard: hand.phase === 'claim' && hand.lastDiscard ? { seat: hand.lastDiscard.seat, tile: hand.lastDiscard.tile } : null,
      kakanTile: hand.kakanPending,
      recentDiscard: (() => {
        const d = hand.discardLog[hand.discardLog.length - 1];
        return d && !d.called && hand.phase !== 'ended' ? { seat: d.seat, tile: d.tile } : null;
      })(),
      pending: !mine || this.seats[seat]!.aiControlled || this.fastFinish ? null : hand.pending.get(seat) ?? null,
      waitingSeats: [...hand.pending.keys()],
      deadline: this.deadline,
      passThreeDone: this.seats.map((_, i) => hand.phase === 'passThree' && !hand.pending.has(i)),
      passSent: mine ? hand.passSent[seat] : null,
      passReceived: mine ? hand.passReceived[seat] : null,
      myWaits: mine ? hand.waitsFor(seat) : [],
      myWaitScore: mine ? hand.waitScore(seat) : null,
      auto: mine
        ? { on: !!this.seats[seat]!.autoPlay, win: !!this.seats[seat]!.autoWin, noCall: !!this.seats[seat]!.noCall }
        : { on: false, win: false, noCall: false },
      thinkAvailable:
        mine &&
        !this.thought.has(seat) && this.deadline !== null && hand.phase === 'turn' && hand.pending.get(seat)?.kind === 'turn' && !this.seats[seat]!.aiControlled,
      result: r ? this.resultView(r, [...this.shown], seat, [...this.acks]) : null,
      smallHandAvailable: m.smallHandAvailable(),
      solo: this.isSolo(),
      fastFinish: this.fastFinish,
    };
  }
}
