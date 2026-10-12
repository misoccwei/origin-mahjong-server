import { useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION, type ClientMessage, type GameAction, type GameView, type RoomView, type ServerMessage } from '../shared/protocol.js';
import { signChallenge } from './identity.js';

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
  );
}

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
          set({ fatal: `伺服器版本（v${msg.protocol}）與網頁版本（v${PROTOCOL_VERSION}）不一致，請重新啟動伺服器後再重新整理頁面。` });
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
        toast(msg.message);
        break;
      case 'kicked':
        stopped = true;
        set({ fatal: msg.reason });
        break;
    }
  };
  ws.onclose = () => {
    set({ conn: 'closed', authed: false });
    if (stopped) return;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

export function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function act(action: GameAction) {
  if (!state.game) return;
  send({ t: 'action', handNo: state.game.handNo, action });
}
