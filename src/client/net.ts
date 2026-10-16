import { useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION, type ClientMessage, type ClientRequest, type RtcSignal, type GameAction, type GameView, type RoomSummary, type RoomView, type ServerMessage } from '../shared/protocol.js';
import type { ReplayFile } from '../shared/replaySchema.js';
import { signChallenge } from './identity.js';
import { t } from './i18n/index.js';

export interface AppState {
  conn: 'connecting' | 'open' | 'closed';
  authed: boolean;
  userId: string | null;
  nickname: string | null;
  room: RoomView | null;
  game: GameView | null;
  /** 伺服器時間 - 本機時間 */
  clockOffset: number;
  toast: { text: string; id: number } | null;
  fatal: string | null;
  /** 大廳：等待中的房間列表 */
  roomList: RoomSummary[];
  /** 已送出、還在等伺服器回覆的請求（訊息種類） */
  pending: ClientMessage['t'][];
}

let state: AppState = {
  conn: 'connecting',
  authed: false,
  userId: null,
  nickname: null,
  room: null,
  game: null,
  clockOffset: 0,
  toast: null,
  fatal: null,
  roomList: [],
  pending: [],
};
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );
}

/** 語音模組註冊：收到同房間玩家的 signaling 時呼叫 */
export const rtcListeners = new Set<(from: string, data: RtcSignal) => void>();

let ws: WebSocket | null = null;
let retry = 0;
let toastId = 0;
let stopped = false;

export function toast(text: string) {
  const id = ++toastId;
  set({ toast: { text, id } });
  setTimeout(() => state.toast?.id === id && set({ toast: null }), 3500);
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  set({ conn: 'connecting' });
  ws.onopen = () => {
    retry = 0;
    set({ conn: 'open' });
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    switch (msg.t) {
      case 'challenge':
        if (msg.protocol !== PROTOCOL_VERSION) {
          // 舊伺服器配新網頁（或反過來）時格式不合，畫面會壞掉；直接停下來提示
          stopped = true;
          set({ fatal: t('伺服器版本（v{server}）與網頁版本（v{client}）不一致，請重新啟動伺服器後再重新整理頁面。', { server: msg.protocol, client: PROTOCOL_VERSION }) });
          ws?.close();
          return;
        }
        try {
          const auth = await signChallenge(msg.nonce);
          send({ t: 'auth', ...auth, protocol: PROTOCOL_VERSION });
        } catch (e) {
          set({ fatal: (e as Error).message });
        }
        break;
      case 'authOk':
        set({ authed: true, userId: msg.userId, nickname: msg.nickname });
        break;
      case 'nicknameOk':
        set({ nickname: msg.nickname });
        break;
      case 'state':
        set({ room: msg.room, game: msg.game, clockOffset: msg.now - Date.now() });
        break;
      case 'error':
        // 伺服器的錯誤訊息是固定的中文字串，依目前語言翻譯
        toast(t(msg.message));
        break;
      case 'rtc':
        rtcListeners.forEach((l) => l(msg.from, msg.data));
        break;
      case 'roomList':
        set({ roomList: msg.rooms });
        break;
      case 'replay':
        replayWaiter?.(msg.replay);
        break;
      case 'done':
        finish(msg.rid);
        break;
      case 'kicked':
        stopped = true;
        set({ fatal: msg.reason });
        break;
    }
  };
  ws.onclose = () => {
    // 斷線時等待中的請求不會再有回覆
    [...waiting.keys()].forEach(finish);
    set({ conn: 'closed', authed: false });
    if (stopped) return;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

export function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- 等待回覆的請求 ----

/** 伺服器一直沒回覆時（不應發生）最多等這麼久就放開按鈕 */
const REQUEST_TIMEOUT_MS = 15_000;
let nextRid = 0;
const waiting = new Map<number, { t: ClientMessage['t']; resolve: () => void; timer: ReturnType<typeof setTimeout> }>();

function finish(rid: number) {
  const w = waiting.get(rid);
  if (!w) return;
  clearTimeout(w.timer);
  waiting.delete(rid);
  set({ pending: [...waiting.values()].map((x) => x.t) });
  w.resolve();
}

/** 送出需要等伺服器處理的請求；伺服器處理完（含錯誤訊息與狀態推送）時 resolve */
export function request(msg: ClientMessage): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) {
    toast(t('連線中斷，請稍候再試'));
    return Promise.resolve();
  }
  const rid = ++nextRid;
  ws.send(JSON.stringify({ ...msg, rid } satisfies ClientRequest));
  return new Promise((resolve) => {
    waiting.set(rid, { t: msg.t, resolve, timer: setTimeout(() => finish(rid), REQUEST_TIMEOUT_MS) });
    set({ pending: [...waiting.values()].map((x) => x.t) });
  });
}

let replayWaiter: ((f: ReplayFile) => void) | null = null;

/** 牌局結束後向伺服器拿整場的回放檔；拿不到（錯誤訊息已經以 toast 顯示）時為 null */
export async function fetchReplay(): Promise<ReplayFile | null> {
  let got: ReplayFile | null = null;
  replayWaiter = (f) => (got = f);
  await request({ t: 'getReplay' });
  replayWaiter = null;
  return got;
}

export function act(action: GameAction): Promise<void> {
  if (!state.game) return Promise.resolve();
  return request({ t: 'action', handNo: state.game.handNo, action });
}
