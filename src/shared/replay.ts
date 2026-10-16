// 回放檔的讀取（版本轉換、檢查）與播放（套用事件算出某一步的牌桌）
import { REPLAY_FORMAT, REPLAY_SCHEMA_VERSION, type ReplayEvent, type ReplayFile, type ReplayHand, type ReplayMeld } from './replaySchema.js';

/**
 * 舊版回放檔 → 下一版的轉換：MIGRATIONS[v] 把第 v 版轉成第 v+1 版。
 * 改了 replaySchema.ts 的格式時一定要補上，舊的回放檔才看得了。
 */
const MIGRATIONS: Record<number, (f: any) => any> = {};

/** 讀取回放檔失敗（訊息是固定的繁中字串，網頁端翻譯） */
export class ReplayError extends Error {}

/** 解析回放檔：檢查格式、把舊版轉成目前的版本；有問題時丟出 ReplayError */
export function parseReplay(raw: unknown): ReplayFile {
  let f = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isObj(f) || f.format !== REPLAY_FORMAT || typeof f.schema !== 'number') throw new ReplayError('這不是原點麻將的回放檔');
  if (f.schema > REPLAY_SCHEMA_VERSION) throw new ReplayError('這個回放檔來自較新的版本，請重新整理網頁後再試');
  for (let v = f.schema; v < REPLAY_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) throw new ReplayError('回放檔已損毀，無法讀取');
    f = { ...migrate(f), schema: v + 1 };
  }
  if (!validFile(f)) throw new ReplayError('回放檔已損毀，無法讀取');
  return f;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isTile = (x: unknown) => isInt(x) && x >= 0 && x < 136;
const tiles = (x: unknown) => Array.isArray(x) && x.every(isTile);

function validFile(f: any): f is ReplayFile {
  if (!Array.isArray(f.players) || !Array.isArray(f.hands) || !Array.isArray(f.finalScores) || !isObj(f.settings)) return false;
  const n = f.players.length;
  if (n < 2 || n > 4 || f.hands.length === 0) return false;
  if (!f.players.every((p: any, i: number) => isObj(p) && p.seat === i && typeof p.name === 'string' && typeof p.isAI === 'boolean')) return false;
  return f.hands.every((h: any) => validHand(h, n));
}

function validHand(h: any, n: number): boolean {
  if (!isObj(h) || !isInt(h.handNo) || !isInt(h.startSeat) || !isInt(h.wallAfterDeal) || !isInt(h.deadWall)) return false;
  if (!Array.isArray(h.deal) || h.deal.length !== n || !h.deal.every(tiles)) return false;
  if (!Array.isArray(h.scoresBefore) || h.scoresBefore.length !== n || !Array.isArray(h.winds) || h.winds.length !== n) return false;
  if (!Array.isArray(h.events) || !h.events.every((e: any) => validEvent(e, n))) return false;
  const r = h.result;
  return isObj(r) && Array.isArray(r.winners) && Array.isArray(r.tenpai) && Array.isArray(r.deltas) && Array.isArray(r.lines) && Array.isArray(r.hands) && Array.isArray(r.melds);
}

function validEvent(e: any, n: number): boolean {
  if (!isObj(e)) return false;
  const seat = (x: unknown) => isInt(x) && x >= 0 && x < n;
  switch (e.t) {
    case 'pass':
      return Array.isArray(e.sent) && Array.isArray(e.received) && [...e.sent, ...e.received].every((x: unknown) => x === null || tiles(x));
    case 'draw':
    case 'discard':
    case 'kakan':
      return seat(e.s) && isTile(e.tile);
    case 'chi':
    case 'pon':
    case 'minkan':
      return seat(e.s) && seat(e.from) && tiles(e.tiles) && isTile(e.called);
    case 'ankan':
      return seat(e.s) && tiles(e.tiles);
    case 'win':
      return seat(e.s) && isTile(e.tile) && (e.from === undefined || seat(e.from));
    default:
      return false;
  }
}

/** 匿名：清空真人的名字（顯示為「玩家 N」），電腦的名字保留 */
export function anonymizeReplay(f: ReplayFile): ReplayFile {
  return { ...f, anonymous: true, players: f.players.map((p) => (p.isAI ? p : { ...p, name: '' })) };
}

// ------------------------------------------------------------------
// 播放
// ------------------------------------------------------------------

/** 播放到某一步時的牌桌 */
export interface ReplayFrame {
  /** 各座位的手牌（不含剛摸到的牌），由小到大 */
  hands: number[][];
  /** 各座位剛摸到、還沒打出的牌 */
  drawn: (number | null)[];
  melds: ReplayMeld[][];
  discards: { tile: number; called: boolean }[][];
  /** 牌山剩下的張數（含王牌） */
  wallRemaining: number;
  /** 輪到誰（最後一個動作的座位） */
  current: number;
  /** 剛打出、還沒被鳴走或輪到下家的牌 */
  lastDiscard: { seat: number; tile: number } | null;
  /** 還在河裡的最近一張捨牌（牌桌中央顯示） */
  recentDiscard: { seat: number; tile: number } | null;
  /** 加槓中（被搶槓時停在這裡） */
  kakan: { seat: number; tile: number } | null;
  passSent: (number[] | null)[];
  passReceived: (number[] | null)[];
  /** 已經宣告和牌的座位 */
  winners: number[];
  /** 最後一步的事件（第 0 步為 null） */
  event: ReplayEvent | null;
}

const sortNum = (a: number, b: number) => a - b;
const kind = (t: number) => t >> 2;

/** 從配牌開始依序套用前 step 個事件（step = 0 為配牌、step = events.length 為局結束） */
export function replayFrame(hand: ReplayHand, step: number): ReplayFrame {
  const n = hand.deal.length;
  const f: ReplayFrame = {
    hands: hand.deal.map((h) => [...h].sort(sortNum)),
    drawn: new Array(n).fill(null),
    melds: Array.from({ length: n }, () => []),
    discards: Array.from({ length: n }, () => []),
    wallRemaining: hand.wallAfterDeal,
    current: hand.startSeat,
    lastDiscard: null,
    recentDiscard: null,
    kakan: null,
    passSent: new Array(n).fill(null),
    passReceived: new Array(n).fill(null),
    winners: [],
    event: null,
  };
  const end = Math.max(0, Math.min(step, hand.events.length));
  for (let i = 0; i < end; i++) apply(f, hand.events[i]);
  return f;
}

/** 摸到的牌收進手牌 */
function settle(f: ReplayFrame, s: number) {
  const d = f.drawn[s];
  if (d !== null) {
    f.hands[s].push(d);
    f.hands[s].sort(sortNum);
    f.drawn[s] = null;
  }
}

const remove = (hand: number[], tiles: number[]) => hand.filter((t) => !tiles.includes(t));

/** 加槓沒被搶：牌加進原本的碰 */
function completeKakan(f: ReplayFrame) {
  if (!f.kakan) return;
  const { seat, tile } = f.kakan;
  const m = f.melds[seat].find((x) => x.type === 'pon' && kind(x.tiles[0]) === kind(tile));
  if (m) {
    m.type = 'kakan';
    m.tiles = [...m.tiles, tile].sort(sortNum);
  }
  f.kakan = null;
}

function apply(f: ReplayFrame, e: ReplayEvent) {
  f.event = e;
  if (e.t !== 'win') completeKakan(f);
  if (e.t !== 'win' && e.t !== 'chi' && e.t !== 'pon' && e.t !== 'minkan') f.lastDiscard = null;
  switch (e.t) {
    case 'pass':
      e.sent.forEach((x, s) => x && (f.hands[s] = remove(f.hands[s], x)));
      e.received.forEach((x, s) => x && (f.hands[s] = [...f.hands[s], ...x].sort(sortNum)));
      f.passSent = e.sent.map((x) => (x ? [...x] : null));
      f.passReceived = e.received.map((x) => (x ? [...x] : null));
      break;
    case 'draw':
      settle(f, e.s);
      f.drawn[e.s] = e.tile;
      f.wallRemaining--;
      f.current = e.s;
      break;
    case 'discard':
      if (f.drawn[e.s] === e.tile) f.drawn[e.s] = null;
      else {
        f.hands[e.s] = remove(f.hands[e.s], [e.tile]);
        settle(f, e.s);
      }
      f.discards[e.s].push({ tile: e.tile, called: false });
      f.lastDiscard = f.recentDiscard = { seat: e.s, tile: e.tile };
      f.current = e.s;
      break;
    case 'chi':
    case 'pon':
    case 'minkan': {
      const river = f.discards[e.from];
      if (river.length && river[river.length - 1].tile === e.called) river[river.length - 1].called = true;
      settle(f, e.s);
      f.hands[e.s] = remove(f.hands[e.s], e.tiles.filter((t) => t !== e.called));
      f.melds[e.s].push({ type: e.t, tiles: [...e.tiles].sort(sortNum), called: e.called, from: e.from });
      f.lastDiscard = f.recentDiscard = null;
      f.current = e.s;
      break;
    }
    case 'ankan':
      settle(f, e.s);
      f.hands[e.s] = remove(f.hands[e.s], e.tiles);
      f.melds[e.s].push({ type: 'ankan', tiles: [...e.tiles].sort(sortNum) });
      f.current = e.s;
      break;
    case 'kakan':
      settle(f, e.s);
      f.hands[e.s] = remove(f.hands[e.s], [e.tile]);
      f.kakan = { seat: e.s, tile: e.tile };
      f.current = e.s;
      break;
    case 'win':
      f.winners.push(e.s);
      break;
  }
}
