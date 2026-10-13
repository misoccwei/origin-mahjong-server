import type { TileId, TileKind } from './tiles.js';

export type MeldType = 'chi' | 'pon' | 'minkan' | 'kakan' | 'ankan';

export interface Meld {
  type: MeldType;
  /** 組成此鳴牌的實體牌（chi 由小到大；槓為 4 張） */
  tiles: TileId[];
  /** 從他家取得的那張牌（ankan 沒有） */
  calledTile?: TileId;
  /** 取得捨牌的來源座位 */
  from?: number;
}

/** 明鳴牌：吃、碰、明槓 */
export const isOpenMeld = (m: Meld) => m.type !== 'ankan';
export const isKanMeld = (m: Meld) => m.type === 'minkan' || m.type === 'kakan' || m.type === 'ankan';

/**
 * 鳴牌由左到右的排列：被鳴的那張放在來源方向（原點麻將順時針，下家在左、對家在上、上家在右），
 * 下家→最左、對家→第二張、上家→最右；其餘牌維持由小到大。seat 是鳴牌者、n 是人數
 */
export function meldTileOrder(m: Meld, seat: number, n: number): TileId[] {
  if (m.calledTile === undefined || m.from === undefined) return m.tiles;
  const rest = m.tiles.filter((t) => t !== m.calledTile);
  const rel = (m.from - seat + n) % n;
  const at = n > 2 && rel === 1 ? 0 : n > 2 && rel === n - 1 ? rest.length : 1;
  rest.splice(at, 0, m.calledTile);
  return rest;
}

export type ScoringMode = 'additive' | 'zeroSum';
export type AILevel = 'beginner' | 'easy' | 'normal' | 'hard';

export interface SeatHandicap {
  /** 此座位的和牌底分（讓分）；未設定時基本規則為 20、進階規則為 0 */
  baseScore?: number;
  /** 解除此座位的小牌限制 */
  exemptSmallHand?: boolean;
}

export interface RuleSettings {
  playerCount: 2 | 3 | 4;
  /** 圈數；一圈 = 人數 局 */
  rounds: number;
  /** 進階規則（和牌×2＋聽牌得分、進階牌型） */
  advanced: boolean;
  /** 牌型擴充包（規則書補頁）：二元／二風、連面子、鏡面子、四歸一、十三不搭、對稱類等 20 個牌型 */
  expansion: boolean;
  /** 和牌最低分數：和牌分數（底分＋牌型分數）未達此分數時不能和牌，0 = 不限 */
  minWinScore: number;
  /** 電腦難度（AI 座位與 AI 代打共用） */
  aiLevel: AILevel;
  /** 換三張：配牌後可選擇把 3 張牌換給下家（預設開啟） */
  passThree: boolean;
  scoring: ScoringMode;
  /** 小牌限制 */
  smallHandLimit: boolean;
  /** 允許觀戰（觀戰者只看得到公開資訊，不能參與語音） */
  allowSpectators: boolean;
  /** 隨機座位：開始牌局時打亂座位順序 */
  randomSeats: boolean;
  /** 依座位的讓分設定 */
  handicaps: Record<number, SeatHandicap>;
  /** 打牌時限（秒），0 = 不限 */
  turnSeconds: number;
  /** 鳴牌／和牌宣告時限（秒），0 = 不限 */
  claimSeconds: number;
  /** 一局結束後結算畫面的倒數（秒），時間到自動進入下一局；0 = 等所有人按「下一局」 */
  resultSeconds: number;
}

export const DEFAULT_ROUNDS: Record<2 | 3 | 4, number> = { 2: 2, 3: 2, 4: 1 };

export function defaultSettings(playerCount: 2 | 3 | 4 = 4): RuleSettings {
  return {
    playerCount,
    rounds: DEFAULT_ROUNDS[playerCount],
    advanced: true,
    minWinScore: 20,
    expansion: true,
    aiLevel: 'easy',
    passThree: true,
    scoring: 'additive',
    smallHandLimit: false,
    allowSpectators: true,
    randomSeats: true,
    handicaps: {},
    turnSeconds: 20,
    claimSeconds: 15,
    resultSeconds: 20,
  };
}

/** 王牌張數：4／3／2 人分別為 12／34／56 張 */
export const DEAD_WALL: Record<2 | 3 | 4, number> = { 2: 56, 3: 34, 4: 12 };

export function baseScoreFor(settings: RuleSettings, seat: number): number {
  const h = settings.handicaps[seat];
  if (h?.baseScore !== undefined) return h.baseScore;
  return settings.advanced ? 0 : 20;
}

export function sanitizeSettings(input: Partial<RuleSettings> | undefined, prev?: RuleSettings): RuleSettings {
  const pc = [2, 3, 4].includes(Number(input?.playerCount)) ? (Number(input!.playerCount) as 2 | 3 | 4) : prev?.playerCount ?? 4;
  const base = prev && prev.playerCount === pc ? prev : defaultSettings(pc);
  const int = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  const handicaps: Record<number, SeatHandicap> = {};
  const rawH = input?.handicaps ?? base.handicaps;
  if (rawH && typeof rawH === 'object') {
    for (const [k, v] of Object.entries(rawH)) {
      const seat = Number(k);
      if (!Number.isInteger(seat) || seat < 0 || seat >= pc || !v || typeof v !== 'object') continue;
      const h: SeatHandicap = {};
      if (v.baseScore !== undefined && v.baseScore !== null && (v.baseScore as unknown) !== '') {
        h.baseScore = int(v.baseScore, 0, 160, 0);
      }
      if (v.exemptSmallHand) h.exemptSmallHand = true;
      if (h.baseScore !== undefined || h.exemptSmallHand) handicaps[seat] = h;
    }
  }
  const advanced = input?.advanced !== undefined ? !!input.advanced : base.advanced;
  return {
    playerCount: pc,
    rounds: int(input?.rounds, 1, 16, base.rounds),
    advanced,
    minWinScore: int(input?.minWinScore, 0, 320, base.minWinScore),
    expansion: input?.expansion !== undefined ? !!input.expansion : base.expansion,
    aiLevel: (['beginner', 'easy', 'normal', 'hard'] as const).find((l) => l === input?.aiLevel) ?? base.aiLevel,
    passThree: input?.passThree !== undefined ? !!input.passThree : base.passThree,
    scoring: input?.scoring === 'zeroSum' || input?.scoring === 'additive' ? input.scoring : base.scoring,
    smallHandLimit: input?.smallHandLimit !== undefined ? !!input.smallHandLimit : base.smallHandLimit,
    allowSpectators: input?.allowSpectators !== undefined ? !!input.allowSpectators : base.allowSpectators,
    randomSeats: input?.randomSeats !== undefined ? !!input.randomSeats : base.randomSeats,
    handicaps,
    turnSeconds: int(input?.turnSeconds, 0, 300, base.turnSeconds),
    claimSeconds: int(input?.claimSeconds, 0, 120, base.claimSeconds),
    resultSeconds: int(input?.resultSeconds, 0, 300, base.resultSeconds),
  };
}

export function seatWindOf(seat: number, startSeat: number, playerCount: number): TileKind {
  const rel = (seat - startSeat + playerCount) % playerCount;
  if (playerCount === 2) return rel === 0 ? 27 : 29; // 東、西
  return 27 + rel;
}
