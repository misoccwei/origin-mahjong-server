// 線上使用者與暱稱管理（純記憶體）。暱稱在所有保留中的使用者之間不可重複。

export interface UserRecord {
  userId: string;
  nickname: string | null;
  connected: boolean;
  roomId: string | null;
  /** 最後一次斷線時間（連線中為 null） */
  offlineSince: number | null;
}

export const NICKNAME_MAX = 16;

export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 去除控制字元與前後空白、壓縮連續空白
  const name = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > NICKNAME_MAX) return null;
  return name;
}

const nicknameKey = (n: string) => n.toLocaleLowerCase('en');

export class UserRegistry {
  private users = new Map<string, UserRecord>();
  private byNickname = new Map<string, string>();

  constructor(private readonly offlineTtlMs: number) {}

  get(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  connect(userId: string): UserRecord {
    let u = this.users.get(userId);
    if (!u) {
      u = { userId, nickname: null, connected: true, roomId: null, offlineSince: null };
      this.users.set(userId, u);
    }
    u.connected = true;
    u.offlineSince = null;
    return u;
  }

  disconnect(userId: string, now = Date.now()) {
    const u = this.users.get(userId);
    if (!u) return;
    u.connected = false;
    u.offlineSince = now;
  }

  /** 設定暱稱；重複時回傳錯誤訊息 */
  setNickname(userId: string, raw: unknown): { ok: true; nickname: string } | { ok: false; error: string } {
    const u = this.users.get(userId);
    if (!u) return { ok: false, error: '尚未驗證身分' };
    const name = normalizeNickname(raw);
    if (!name) return { ok: false, error: `暱稱需為 1～${NICKNAME_MAX} 個字` };
    const holder = this.byNickname.get(nicknameKey(name));
    if (holder && holder !== userId) return { ok: false, error: '這個暱稱已經有人使用了' };
    if (u.nickname) this.byNickname.delete(nicknameKey(u.nickname));
    u.nickname = name;
    this.byNickname.set(nicknameKey(name), userId);
    return { ok: true, nickname: name };
  }

  /** 移除離線過久且不在房間內的使用者，釋放暱稱 */
  sweep(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const u of this.users.values()) {
      if (u.connected || u.roomId || u.offlineSince === null) continue;
      if (now - u.offlineSince < this.offlineTtlMs) continue;
      if (u.nickname) this.byNickname.delete(nicknameKey(u.nickname));
      this.users.delete(u.userId);
      removed.push(u.userId);
    }
    return removed;
  }

  get size() {
    return this.users.size;
  }
}
