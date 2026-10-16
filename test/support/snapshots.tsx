import { renderToString } from 'react-dom/server';
import { TableScreen } from '../../src/client/components/Table.js';
import type { AppState } from '../../src/client/net.js';
import type { GameView, PlayerView, RoomView } from '../../src/shared/protocol.js';
import { defaultSettings } from '../../src/shared/rules.js';

// 畫面測試用的快照：伺服器會送來的 RoomView／GameView，預設是 4 人、輪到自己（座位 0）打牌。

/** 牌種 → 實體牌 id（同種第 copy 張） */
export const tid = (kind: number, copy = 0) => kind * 4 + copy;

/** 看得到的文字：去掉標籤與 React 伺服器渲染插入的 <!-- --> 分隔，連續空白壓成一個 */
export const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

export function player(seat: number, patch: Partial<PlayerView> = {}): PlayerView {
  return {
    seat,
    nickname: seat === 0 ? '我' : `電腦 ${seat}`,
    userId: seat === 0 ? 'me' : null,
    isAI: seat !== 0,
    aiControlled: false,
    autoPlay: false,
    connected: true,
    left: false,
    ready: true,
    score: 0,
    wind: 27 + seat,
    handCount: 13,
    hasDrawn: false,
    melds: [],
    discards: [],
    ...patch,
  };
}

export function room(patch: Partial<RoomView> = {}): RoomView {
  return {
    id: '1234',
    hostSeat: 0,
    status: 'playing',
    settings: defaultSettings(4),
    players: [0, 1, 2, 3].map((s) => player(s)),
    mySeat: 0,
    paused: null,
    history: [],
    dissolved: false,
    spectators: [],
    replays: [],
    ...patch,
  };
}

/** 自己的手牌：123456m 123p 123s 東 */
export const HAND = [0, 1, 2, 3, 4, 5, 9, 10, 11, 18, 19, 20, 27].map((k) => tid(k));

export function game(patch: Partial<GameView> = {}): GameView {
  return {
    handNo: 1,
    totalHands: 4,
    startSeat: 0,
    phase: 'turn',
    currentSeat: 0,
    wallRemaining: 70,
    deadWall: 12,
    myHand: HAND,
    myDrawn: null,
    lastDiscard: null,
    recentDiscard: null,
    kakanTile: null,
    pending: null,
    waitingSeats: [],
    deadline: null,
    passThreeDone: [false, false, false, false],
    passSent: null,
    passReceived: null,
    myWaits: [],
    myWaitScore: null,
    auto: { on: false, win: false, noCall: false },
    thinkAvailable: false,
    result: null,
    smallHandAvailable: [true, true, true, true],
    solo: false,
    fastFinish: false,
    aiPlay: false,
    ...patch,
  };
}

export function render(r: RoomView, g: GameView | null) {
  return renderToString(<TableScreen state={appState({ room: r, game: g })} />);
}

export function appState(patch: Partial<AppState> = {}): AppState {
  return { conn: 'open', authed: true, userId: 'me', nickname: '我', room: null, game: null, clockOffset: 0, toast: null, fatal: null, roomList: [], pending: [], ...patch };
}
