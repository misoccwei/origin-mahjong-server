import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ClientRequest, type ServerMessage } from '../shared/protocol.js';
import { sanitizeSettings } from '../shared/rules.js';
import { newNonce, verifyAuth } from './identity.js';
import type { Rng } from './engine/hand.js';
import { Room, type RoomResult } from './room.js';
import { UserRegistry } from './users.js';

export interface ServerOptions {
  port: number;
  host?: string;
  /** 前端靜態檔目錄（存在時才提供） */
  staticDir?: string;
  aiDelayMs?: number;
  /** 語音用的 ICE servers（STUN／TURN），預設為公用 STUN */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** 結算畫面的倒數；未指定時依房間設定（resultSeconds） */
  resultMs?: number;
  /** 換三張後亮出收到的牌多久 */
  passRevealMs?: number;
  /** 離線使用者保留暱稱的時間 */
  offlineTtlMs?: number;
  /** 等待中的房間，斷線玩家保留座位的時間 */
  waitingOfflineMs?: number;
  sweepIntervalMs?: number;
  rng?: Rng;
  log?: (msg: string) => void;
}

interface Conn {
  ws: WebSocket;
  nonce: string;
  userId: string | null;
  alive: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export interface RunningServer {
  port: number;
  http: Server;
  close(): Promise<void>;
  stats(): { users: number; rooms: number; connections: number };
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const users = new UserRegistry(opts.offlineTtlMs ?? 10 * 60_000);
  const rooms = new Map<string, Room>();
  const conns = new Map<string, Conn>(); // userId -> 目前連線
  const allConns = new Set<Conn>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const pushState = (userId: string) => {
    const c = conns.get(userId);
    if (!c) return;
    const u = users.get(userId);
    const room = u?.roomId ? rooms.get(u.roomId) : undefined;
    send(c.ws, {
      t: 'state',
      room: room ? room.roomView(userId) : null,
      game: room ? room.gameView(userId) : null,
      now: Date.now(),
    });
  };

  const roomDeps = {
    isOnline: (userId: string) => !!users.get(userId)?.connected,
    notify: (ids: string[]) => ids.forEach(pushState),
    onUserRemoved: (userId: string) => {
      const u = users.get(userId);
      if (u) u.roomId = null;
      pushState(userId);
    },
    onDestroy: (room: Room) => {
      rooms.delete(room.id);
      log(`room ${room.id} closed`);
    },
    aiDelayMs: opts.aiDelayMs ?? 700,
    resultMs: opts.resultMs,
    passRevealMs: opts.passRevealMs ?? 3000,
    waitingOfflineMs: opts.waitingOfflineMs ?? 60_000,
    rng: opts.rng,
  };

  const newRoomId = () => {
    for (;;) {
      const id = String(randomInt(1000, 10000));
      if (!rooms.has(id)) return id;
    }
  };

  const reply = (c: Conn, r: RoomResult) => {
    if (!r.ok) send(c.ws, { t: 'error', code: 'room', message: r.error });
  };

  async function handle(c: Conn, msg: ClientMessage) {
    if (msg.t === 'ping') return send(c.ws, { t: 'pong' });
    if (msg.t === 'auth') {
      if (c.userId) return;
      if (msg.protocol !== PROTOCOL_VERSION) {
        send(c.ws, { t: 'kicked', reason: '網頁版本與伺服器不一致，請重新整理頁面（Ctrl／Cmd + Shift + R）' });
        c.ws.close(4003, 'protocol mismatch');
        return;
      }
      const alg = msg.alg === 'Ed25519' || msg.alg === 'ECDSA-P256' ? msg.alg : null;
      const userId = alg && msg.publicKey && typeof msg.publicKey === 'object' ? await verifyAuth(c.nonce, alg, msg.publicKey, msg.signature) : null;
      if (!userId) {
        send(c.ws, { t: 'error', code: 'auth', message: '身分驗證失敗' });
        c.ws.close(4001, 'auth failed');
        return;
      }
      // 同一使用者的舊連線（例如另一個分頁）踢掉
      const old = conns.get(userId);
      if (old && old !== c) {
        send(old.ws, { t: 'kicked', reason: '你在其他地方登入了' });
        old.userId = null;
        old.ws.close(4002, 'replaced');
      }
      c.userId = userId;
      conns.set(userId, c);
      const u = users.connect(userId);
      send(c.ws, { t: 'authOk', userId, nickname: u.nickname });
      const room = u.roomId ? rooms.get(u.roomId) : undefined;
      if (room) room.connectionChanged(userId);
      else u.roomId = null;
      pushState(userId);
      return;
    }

    const userId = c.userId;
    if (!userId) return send(c.ws, { t: 'error', code: 'auth', message: '尚未驗證身分' });
    const u = users.get(userId)!;

    if (msg.t === 'setNickname') {
      const r = users.setNickname(userId, msg.name);
      if (!r.ok) return send(c.ws, { t: 'error', code: 'nickname', message: r.error });
      send(c.ws, { t: 'nicknameOk', nickname: r.nickname });
      const room = u.roomId ? rooms.get(u.roomId) : undefined;
      if (room?.isSpectator(userId)) room.renameSpectator(userId, r.nickname);
      else if (room) room.join(userId, r.nickname); // 更新座位上的暱稱
      else pushState(userId);
      return;
    }
    if (!u.nickname) return send(c.ws, { t: 'error', code: 'nickname', message: '請先設定暱稱' });

    const room = u.roomId ? rooms.get(u.roomId) : undefined;
    switch (msg.t) {
      case 'listRooms': {
        const list = [...rooms.values()].map((r) => r.summary()).filter((x): x is NonNullable<typeof x> => !!x);
        return send(c.ws, { t: 'roomList', rooms: list });
      }
      case 'createRoom': {
        if (room) return send(c.ws, { t: 'error', code: 'room', message: '你已經在房間中' });
        const id = newRoomId();
        const r = new Room(id, sanitizeSettings(msg.settings), roomDeps);
        rooms.set(id, r);
        u.roomId = id;
        log(`room ${id} created by ${u.nickname}`);
        return reply(c, r.join(userId, u.nickname));
      }
      case 'joinRoom': {
        const target = rooms.get(String(msg.roomId ?? '').trim());
        if (!target) return send(c.ws, { t: 'error', code: 'room', message: '找不到這個房號' });
        if (room && room !== target) return send(c.ws, { t: 'error', code: 'room', message: '請先離開目前的房間' });
        // 先標記所屬房間，join 觸發的狀態推送才會包含房間內容
        u.roomId = target.id;
        const r = target.join(userId, u.nickname);
        if (!r.ok) u.roomId = room?.id ?? null;
        return reply(c, r);
      }
      case 'spectate': {
        const target = rooms.get(String(msg.roomId ?? '').trim());
        if (!target) return send(c.ws, { t: 'error', code: 'room', message: '找不到這個房號' });
        if (room) return send(c.ws, { t: 'error', code: 'room', message: '請先離開目前的房間' });
        u.roomId = target.id;
        const r = target.spectate(userId, u.nickname);
        if (!r.ok) u.roomId = null;
        return reply(c, r);
      }
      default:
        break;
    }
    if (!room) return send(c.ws, { t: 'error', code: 'room', message: '你不在任何房間中' });
    switch (msg.t) {
      case 'leaveRoom':
        return reply(c, room.leave(userId));
      case 'updateSettings':
        return reply(c, room.updateSettings(userId, msg.settings ?? {}));
      case 'addAI':
        return reply(c, room.addAI(userId));
      case 'removeSeat':
        return reply(c, room.removeSeat(userId, Number(msg.seat)));
      case 'ready':
        return reply(c, room.setReady(userId, !!msg.ready));
      case 'start':
        return reply(c, room.start(userId));
      case 'setAILevel':
        return reply(c, room.setAILevel(userId, msg.level));
      case 'showHand':
        return reply(c, room.showHand(userId));
      case 'think':
        return reply(c, room.think(userId));
      case 'setAuto':
        return reply(c, room.setAuto(userId, !!msg.on, !!msg.win, !!msg.noCall));
      case 'action':
        if (!msg.action || typeof msg.action !== 'object') return;
        return reply(c, room.action(userId, Number(msg.handNo), msg.action));
      case 'nextHand':
        return reply(c, room.nextHand(userId));
      case 'decide':
        return reply(c, room.decide(userId, msg.choice));
      case 'extend':
        return reply(c, room.extend(userId));
      case 'restart':
        return reply(c, room.restart(userId));
      case 'rtc': {
        // 只轉給同房間的其他真人；內容不解讀
        const to = String(msg.to ?? '');
        const ids = room.humanUserIds();
        // 觀戰者不能參與語音
        if (to === userId || !ids.includes(userId) || !ids.includes(to) || !msg.data || typeof msg.data !== 'object') return;
        const target = conns.get(to);
        if (target) send(target.ws, { t: 'rtc', from: userId, data: msg.data });
        return;
      }
      default:
        send(c.ws, { t: 'error', code: 'unknown', message: '未知的訊息' });
    }
  }

  // ---- HTTP（靜態檔）----
  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, users: users.size, rooms: rooms.size }));
      return;
    }
    if (url.pathname === '/ice-servers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(opts.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }]));
      return;
    }
    if (!staticDir) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('前端尚未建置，請執行 npm run build 或使用 npm run dev:client');
      return;
    }
    let file = normalize(join(staticDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(staticDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${join(staticDir, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  });

  // ---- WebSocket ----
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 32 * 1024 });
  wss.on('connection', (ws) => {
    const c: Conn = { ws, nonce: newNonce(), userId: null, alive: true };
    allConns.add(c);
    send(ws, { t: 'challenge', nonce: c.nonce, protocol: PROTOCOL_VERSION });
    const authTimer = setTimeout(() => !c.userId && ws.close(4001, 'auth timeout'), 15_000);
    let queue = Promise.resolve();
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data) => {
      let msg: ClientRequest;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { t: 'error', code: 'parse', message: '訊息格式錯誤' });
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      // 依序處理同一連線的訊息
      queue = queue
        .then(() => handle(c, msg))
        .catch((e) => log(`handler error: ${e?.stack ?? e}`))
        .then(() => {
          if (typeof msg.rid === 'number') send(ws, { t: 'done', rid: msg.rid });
        });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      allConns.delete(c);
      const userId = c.userId;
      if (!userId || conns.get(userId) !== c) return;
      conns.delete(userId);
      users.disconnect(userId);
      const u = users.get(userId);
      const room = u?.roomId ? rooms.get(u.roomId) : undefined;
      room?.connectionChanged(userId);
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of allConns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 20_000);

  const sweeper = setInterval(() => {
    for (const r of [...rooms.values()]) {
      r.sweep();
      // 所有真人都離線很久的房間也關閉
      const ids = r.humanUserIds();
      const allGone = ids.every((id) => {
        const u = users.get(id);
        return !u?.connected && u?.offlineSince !== null && Date.now() - (u?.offlineSince ?? 0) > (opts.offlineTtlMs ?? 10 * 60_000);
      });
      if (allGone) r.destroy();
    }
    users.sweep();
  }, opts.sweepIntervalMs ?? 10_000);

  return new Promise((resolvePromise) => {
    http.listen(opts.port, opts.host, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolvePromise({
        port,
        http,
        stats: () => ({ users: users.size, rooms: rooms.size, connections: allConns.size }),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            clearInterval(sweeper);
            for (const r of rooms.values()) r.destroy();
            for (const c of allConns) c.ws.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}
