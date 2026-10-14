// Client <-> Server 訊息格式（WebSocket，JSON）
import type { AILevel, Meld, RuleSettings } from './rules.js';
import type { HandScore } from './scoring.js';
import type { SettlementLine } from './settlement.js';
import type { TileId, TileKind } from './tiles.js';

/**
 * 前後端協定版本。改動這個檔案的訊息或快照格式時一定要加一，
 * 伺服器與網頁版本不同時會在連線時提示（避免舊伺服器配新網頁而畫面壞掉）。
 * test/shared/protocol.test.ts 會在本檔的程式（註解除外）變動但版本沒改時失敗。
 */
export const PROTOCOL_VERSION = 16;

// ---- 遊戲行動 ----

export type GameAction =
  | { type: 'discard'; tile: TileId }
  | { type: 'tsumo' }
  | { type: 'ankan'; kind: TileKind }
  | { type: 'kakan'; kind: TileKind }
  | { type: 'ron' }
  | { type: 'pon' }
  | { type: 'minkan' }
  | { type: 'chi'; tiles: [TileId, TileId] }
  | { type: 'pass' }
  /** 換三張；tiles 為 null 表示不換 */
  | { type: 'passThree'; tiles: TileId[] | null };

export interface AvailableActions {
  kind: 'turn' | 'claim' | 'chankan' | 'passThree';
  discard?: TileId[];
  tsumo?: boolean;
  ankan?: TileKind[];
  kakan?: TileKind[];
  ron?: boolean;
  pon?: boolean;
  minkan?: boolean;
  chi?: [TileId, TileId][];
  /** 聽牌時，打出各張牌後所聽的牌（提示用） */
  tenpaiHints?: Record<number, TileKind[]>;
  /** 可以自摸／和（含搶槓）時，現在和的分數與牌型（含偶然類），顯示在按鈕上 */
  winScore?: WinScoreView;
}

export interface WinScoreView {
  total: number;
  yaku: { name: string; count: number }[];
}

// ---- 狀態快照 ----

export interface DiscardView {
  tile: TileId;
  /** 被他人鳴走 */
  called: boolean;
}

export interface PlayerView {
  seat: number;
  nickname: string | null;
  userId: string | null;
  isAI: boolean;
  /** 由 AI 代打中（真人斷線後由房主決定） */
  aiControlled: boolean;
  /** 開啟自動摸打 */
  autoPlay: boolean;
  connected: boolean;
  /** 牌局中途離開的座位 */
  left: boolean;
  ready: boolean;
  score: number;
  wind: TileKind | null;
  handCount: number;
  hasDrawn: boolean;
  /** 他人的暗槓一律以 -1 遮蔽（局結束後也是） */
  melds: Meld[];
  discards: DiscardView[];
}

export interface WinnerView {
  seat: number;
  tsumo: boolean;
  from?: number;
  tile: TileId;
  score: HandScore;
}

export interface HandResultView {
  kind: 'win' | 'draw';
  winners: WinnerView[];
  /** 聽牌者；best 是得分最高的和法（和哪張、自摸或銃和、牌型），聽牌得分依它計算 */
  tenpai: { seat: number; maxScore: number; waits: TileKind[]; best: { tile: TileKind; tsumo: boolean; score: HandScore } }[];
  deltas: number[];
  lines: SettlementLine[];
  /** 只含看得到的手牌：自己、和牌者、聽牌者、主動展示者；其他座位為空陣列 */
  hands: TileId[][];
  melds: Meld[][];
  /** 主動展示手牌的座位 */
  shown: number[];
  /** 已按下「下一局」的座位 */
  acknowledged: number[];
}

export interface HandHistoryEntry {
  handNo: number;
  startSeat: number;
  kind: 'win' | 'draw';
  winners: { seat: number; total: number; tsumo: boolean; from?: number; yaku: string[] }[];
  deltas: number[];
}

/** 牌局結束後重看某一局的結果 */
export interface HandReplayView {
  handNo: number;
  result: HandResultView;
}

export interface GameView {
  handNo: number; // 1-based
  totalHands: number;
  startSeat: number;
  phase: 'passThree' | 'passReveal' | 'turn' | 'claim' | 'chankan' | 'result';
  currentSeat: number;
  wallRemaining: number;
  deadWall: number;
  myHand: TileId[];
  myDrawn: TileId | null;
  lastDiscard: { seat: number; tile: TileId } | null;
  /** 最近一張還在河裡的捨牌（顯示在牌桌中央，直到下一張捨牌或被鳴走） */
  recentDiscard: { seat: number; tile: TileId } | null;
  kakanTile: { seat: number; tile: TileId } | null;
  pending: AvailableActions | null;
  /** 正在等待哪些座位做決定 */
  waitingSeats: number[];
  deadline: number | null;
  passThreeDone: boolean[];
  /** 換三張：自己換出與收到的牌（沒有交換為 null），整局都會保留 */
  passSent: TileId[] | null;
  passReceived: TileId[] | null;
  /** 自己聽牌時所聽的牌與剩餘張數（只計自己看得到的牌） */
  myWaits: { kind: TileKind; left: number }[];
  /** 聽牌時預計的和牌分數範圍（不含偶然類）；聽牌但都未達和牌最低分數時為 null */
  myWaitScore: { min: number; max: number } | null;
  /** 這一局還能按「長考」延長打牌時限（每局一次） */
  thinkAvailable: boolean;
  /** 自己的自動設定：on = 自動摸打、win = 自動和牌（兩者下一局都會自動關閉）、noCall = 不鳴牌（持續有效） */
  auto: { on: boolean; win: boolean; noCall: boolean };
  result: HandResultView | null;
  /** 小牌限制：本輪是否還能和小牌 */
  smallHandAvailable: boolean[];
  /** 一個真人對上其餘全是 AI：操作不限時、局結束公開 AI 手牌、可以交給 AI 快速打完這一局 */
  solo: boolean;
  /** 這一局已經交給 AI 快速打完（下一局恢復自己打） */
  fastFinish: boolean;
}

export interface PauseView {
  disconnectedSeats: number[];
  deciderSeat: number | null;
}

export interface RoomView {
  id: string;
  hostSeat: number;
  status: 'waiting' | 'playing' | 'finished';
  settings: RuleSettings;
  players: PlayerView[];
  mySeat: number | null;
  paused: PauseView | null;
  history: HandHistoryEntry[];
  /** 牌局被解散（提前結束） */
  dissolved: boolean;
  /** 觀戰者（不佔座位） */
  spectators: { userId: string; nickname: string }[];
  /** 牌局結束後才有：每一局的結果（加圈的話也包含之前的局），手牌一樣只公開看得到的 */
  replays: HandReplayView[];
}

/** 大廳的房間列表：等待中有空位（可加入），或允許觀戰的房間 */
export interface RoomSummary {
  id: string;
  hostName: string;
  status: 'waiting' | 'playing' | 'finished';
  /** 等待中且有空位 */
  joinable: boolean;
  /** 允許觀戰 */
  spectatable: boolean;
  spectators: number;
  /** 已入座人數（含 AI）／總人數 */
  seated: number;
  playerCount: number;
  advanced: boolean;
  scoring: 'additive' | 'zeroSum';
}

// ---- 語音（WebRTC P2P mesh，伺服器只轉送 signaling）----

export type RtcSignal =
  /** 通知對方「我在線上、請與我建立連線」；sid 是這個網頁分頁的工作階段，重新整理後會變 */
  | { k: 'hello'; sid: string; mic: boolean }
  /** 麥克風開關（顯示用） */
  | { k: 'status'; sid: string; mic: boolean }
  | { k: 'offer' | 'answer'; sid: string; sdp: string }
  | { k: 'ice'; sid: string; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

// ---- 訊息 ----

export type ClientMessage =
  | { t: 'auth'; alg: 'Ed25519' | 'ECDSA-P256'; publicKey: JsonWebKey; signature: string; protocol: number }
  | { t: 'setNickname'; name: string }
  | { t: 'createRoom'; settings?: Partial<RuleSettings> }
  | { t: 'joinRoom'; roomId: string }
  /** 觀戰：只看公開資訊；等待中有空位時可以再用 joinRoom 入座 */
  | { t: 'spectate'; roomId: string }
  | { t: 'leaveRoom' }
  | { t: 'updateSettings'; settings: Partial<RuleSettings> }
  | { t: 'addAI' }
  | { t: 'removeSeat'; seat: number }
  | { t: 'ready'; ready: boolean }
  /** 房主開始牌局 */
  | { t: 'start' }
  /** 自動摸打、自動和牌（下一局都會自動關閉；都只在和牌達到這副聽牌的最高分時自動和）；noCall = 不鳴牌（不吃碰槓，持續有效） */
  | { t: 'setAuto'; on: boolean; win: boolean; noCall?: boolean }
  /** 房主調整電腦難度（等待中或牌局中皆可，立即生效） */
  | { t: 'setAILevel'; level: AILevel }
  /** 局結束時展示自己的手牌 */
  | { t: 'showHand' }
  /** 長考：自己的回合延長打牌時限 60 秒（每局一次） */
  | { t: 'think' }
  /** 單人對 AI：自己的座位也交給 AI，快速打完這一局 */
  | { t: 'fastFinish' }
  /** 取得等待中的房間列表 */
  | { t: 'listRooms' }
  | { t: 'action'; handNo: number; action: GameAction }
  | { t: 'nextHand' }
  | { t: 'decide'; choice: 'ai' | 'dissolve' }
  | { t: 'extend' }
  | { t: 'restart' }
  /** 語音 signaling：只會轉給同房間的真人 */
  | { t: 'rtc'; to: string; data: RtcSignal }
  | { t: 'ping' };

/** 需要等回覆的請求帶 rid：伺服器處理完（錯誤訊息、狀態推送都送出後）回 { t: 'done', rid }，網頁端據此顯示等待中 */
export type ClientRequest = ClientMessage & { rid?: number };

export type ServerMessage =
  | { t: 'challenge'; nonce: string; protocol: number }
  | { t: 'authOk'; userId: string; nickname: string | null }
  | { t: 'nicknameOk'; nickname: string }
  | { t: 'state'; room: RoomView | null; game: GameView | null; now: number }
  | { t: 'error'; code: string; message: string }
  | { t: 'kicked'; reason: string }
  | { t: 'roomList'; rooms: RoomSummary[] }
  | { t: 'rtc'; from: string; data: RtcSignal }
  | { t: 'pong' }
  | { t: 'done'; rid: number };

export const AUTH_PREFIX = 'origin-mahjong-auth:';
