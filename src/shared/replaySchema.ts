// 牌局回放檔的格式（儲存成 .json 檔分享，網頁的回放頁面讀取）
//
// 回放檔記錄「發生了什麼」（配牌、每一次摸打鳴槓和、每局結果），播放時只照著事件擺牌，不重跑規則，
// 因此規則、AI、協定怎麼改都不會影響舊的回放檔；只有這個檔案的格式改了才算回放格式變更。
//
// 規則：
// - 這個檔案只放型別與版本號，不 import 任何東西（其他型別常常改，引用了會讓格式在不知不覺中變動）。
// - test/shared/replaySchema.test.ts 會在本檔的程式（註解除外）變動但版本沒改時失敗：
//   請把 REPLAY_SCHEMA_VERSION 加一，並在 src/shared/replay.ts 的 MIGRATIONS 補上舊版 → 新版的轉換，
//   再把新版的範例檔放進 test/fixtures/（舊版的範例檔保留，測試會確認轉換後仍能播完）。

export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_FORMAT = 'origin-mahjong-replay';

export interface ReplayFile {
  format: 'origin-mahjong-replay';
  /** REPLAY_SCHEMA_VERSION */
  schema: number;
  /** 儲存時間（ISO 8601） */
  savedAt: string;
  /** 儲存時的協定版本（只供參考，讀取時不檢查） */
  appProtocol: number;
  roomId: string;
  /** 匿名：真人的名字已清空，顯示為「玩家 N」 */
  anonymous: boolean;
  /** 牌局被解散（提前結束），只含已經打完的局 */
  dissolved: boolean;
  /** 規則設定（顯示用；欄位可能隨版本增減，讀取時補上預設值） */
  settings: Record<string, unknown>;
  players: ReplayPlayer[];
  hands: ReplayHand[];
  /** 最後的累計分數 */
  finalScores: number[];
}

export interface ReplayPlayer {
  seat: number;
  /** 真人的暱稱（匿名時為空字串）；電腦為「電腦 N」 */
  name: string;
  isAI: boolean;
}

/** 一局；牌以 TileId（0–135，kind = id >> 2）表示，牌種以 TileKind（0–33）表示 */
export interface ReplayHand {
  /** 第幾局（1 起算） */
  handNo: number;
  startSeat: number;
  /** 各座位的門風（TileKind） */
  winds: number[];
  /** 這一局開始前的累計分數 */
  scoresBefore: number[];
  /** 各座位的配牌（換三張之前） */
  deal: number[][];
  /** 配牌後牌山剩下的張數（含王牌） */
  wallAfterDeal: number;
  /** 王牌張數（餘牌 = 牌山 − 王牌） */
  deadWall: number;
  events: ReplayEvent[];
  result: ReplayResult;
}

export type ReplayEvent =
  /** 換三張：各座位換出與收到的牌（沒有交換為 null） */
  | { t: 'pass'; sent: (number[] | null)[]; received: (number[] | null)[] }
  /** 摸牌；rinshan = 槓後補嶺上牌 */
  | { t: 'draw'; s: number; tile: number; rinshan?: boolean }
  | { t: 'discard'; s: number; tile: number }
  /** 吃、碰、明槓：tiles 是整組（含鳴到的牌），called 是從 from 打出的那張 */
  | { t: 'chi' | 'pon' | 'minkan'; s: number; from: number; tiles: number[]; called: number }
  | { t: 'ankan'; s: number; tiles: number[] }
  /** 加槓：被搶槓時這張牌不會加進鳴牌 */
  | { t: 'kakan'; s: number; tile: number }
  /** 宣告和牌（自摸沒有 from；一炮多響時連續好幾個） */
  | { t: 'win'; s: number; from?: number; tile: number };

export interface ReplayMeld {
  type: 'chi' | 'pon' | 'minkan' | 'ankan' | 'kakan';
  tiles: number[];
  called?: number;
  from?: number;
}

export interface ReplayYaku {
  id: string;
  /** 牌型名稱（繁體中文，顯示時翻譯；翻不到就顯示原文） */
  name: string;
  points: number;
  count: number;
}

export interface ReplayScore {
  total: number;
  baseScore: number;
  yakuPoints: number;
  limit: boolean;
  yaku: ReplayYaku[];
}

export interface ReplayResult {
  kind: 'win' | 'draw';
  /** 結算時的和牌者（零和式同巡跟打免責時，from 可能與宣告和牌時不同） */
  winners: { seat: number; tsumo: boolean; from?: number; tile: number; score: ReplayScore }[];
  tenpai: { seat: number; maxScore: number; waits: number[]; best: { tile: number; tsumo: boolean; score: ReplayScore } }[];
  deltas: number[];
  lines: { seat: number; delta: number; reason: string }[];
  /** 局結束時各座位的手牌（全公開） */
  hands: number[][];
  melds: ReplayMeld[][];
}
