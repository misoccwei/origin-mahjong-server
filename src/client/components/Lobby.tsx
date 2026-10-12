import { useEffect, useState } from 'react';
import { AILevelSelect, NumInput } from './Inputs.js';
import { DEFAULT_ROUNDS, defaultSettings, type RuleSettings } from '../../shared/rules.js';
import { send, type AppState } from '../net.js';

export function NicknameScreen({ state }: { state: AppState }) {
  const [name, setName] = useState(state.nickname ?? '');
  return (
    <div className="panel narrow">
      <h1>原點麻將</h1>
      <p className="muted">請輸入暱稱（不可與其他線上玩家重複）</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send({ t: 'setNickname', name });
        }}
      >
        <input autoFocus maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder="暱稱" />
        <button type="submit" disabled={!name.trim()}>
          確定
        </button>
      </form>
      <p className="muted small">使用者代碼：{state.userId?.slice(0, 8)}</p>
    </div>
  );
}

export function SettingsForm({
  value,
  onChange,
  disabled,
  seatNames,
  showAILevel = true,
}: {
  value: RuleSettings;
  onChange: (s: RuleSettings) => void;
  disabled?: boolean;
  seatNames?: (string | null)[];
  /** 等待房間裡電腦難度另外調整（立即生效），不放在這裡 */
  showAILevel?: boolean;
}) {
  const up = (patch: Partial<RuleSettings>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="settings" disabled={disabled}>
      <label>
        人數
        <select
          value={value.playerCount}
          onChange={(e) => {
            const pc = Number(e.target.value) as 2 | 3 | 4;
            up({ playerCount: pc, rounds: DEFAULT_ROUNDS[pc], handicaps: {} });
          }}
        >
          <option value={2}>2 人</option>
          <option value={3}>3 人</option>
          <option value={4}>4 人</option>
        </select>
      </label>
      <label>
        圈數
        <NumInput min={1} max={16} value={value.rounds} onChange={(v) => up({ rounds: v ?? 0 })} />
        <span className="muted small">共 {value.rounds * value.playerCount} 局</span>
      </label>
      <label>
        計分
        <select value={value.scoring} onChange={(e) => up({ scoring: e.target.value as RuleSettings['scoring'] })}>
          <option value="additive">加分式</option>
          <option value="zeroSum">零和式</option>
        </select>
      </label>
      {showAILevel && (
        <label>
          電腦難度
          <AILevelSelect value={value.aiLevel} onChange={(aiLevel) => up({ aiLevel })} />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={value.advanced} onChange={(e) => up({ advanced: e.target.checked })} />
        進階規則（進階牌型{value.scoring === 'additive' ? '、和牌×2＋聽牌得分' : ''}）
      </label>
      <label className="check">
        <input type="checkbox" checked={value.passThree} onChange={(e) => up({ passThree: e.target.checked })} />
        換三張（配牌後可選擇把 3 張牌換給下家）
      </label>
      <label className="check">
        <input type="checkbox" checked={value.smallHandLimit} onChange={(e) => up({ smallHandLimit: e.target.checked })} />
        小牌限制（每輪只能和一次未滿 20 分的牌）
      </label>
      <label>
        和牌最低分數
        <NumInput min={0} max={320} value={value.minWinScore} onChange={(v) => up({ minWinScore: v ?? 0 })} />
        <span className="muted small">分（未達此分數不能和牌，0 = 不限）</span>
      </label>
      <label>
        打牌時限
        <NumInput min={0} max={300} value={value.turnSeconds} onChange={(v) => up({ turnSeconds: v ?? 0 })} />
        <span className="muted small">秒（0 = 不限）</span>
      </label>
      <label>
        鳴牌時限
        <NumInput min={0} max={120} value={value.claimSeconds} onChange={(v) => up({ claimSeconds: v ?? 0 })} />
        <span className="muted small">秒</span>
      </label>
      {seatNames && (
        <details>
          <summary>讓分設定（每人基本底分）</summary>
          <p className="muted small">基本底分未填時：基本規則 20、進階規則 0。</p>
          {seatNames.map((n, seat) => {
            const h = value.handicaps[seat] ?? {};
            const setH = (patch: object) => up({ handicaps: { ...value.handicaps, [seat]: { ...h, ...patch } } });
            return (
              <div key={seat} className="handicap">
                <span>{n ?? `座位 ${seat + 1}`}</span>
                <label>
                  基本底分
                  <NumInput min={0} max={160} placeholder={value.advanced ? '0' : '20'} value={h.baseScore} onChange={(baseScore) => setH({ baseScore })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!h.exemptSmallHand} onChange={(e) => setH({ exemptSmallHand: e.target.checked })} />
                  解除小牌限制
                </label>
              </div>
            );
          })}
        </details>
      )}
    </fieldset>
  );
}

/** 等待中的房間：每 3 秒更新一次，點一下就加入 */
function RoomList({ state }: { state: AppState }) {
  useEffect(() => {
    const refresh = () => send({ t: 'listRooms' });
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [state.conn]);
  return (
    <div className="room-list">
      <h3>等待中的房間</h3>
      {state.roomList.length === 0 ? (
        <p className="muted small">目前沒有等待中的房間，可以自己建立一個。</p>
      ) : (
        <ul>
          {state.roomList.map((r) => (
            <li key={r.id}>
              <div className="room-info">
                <div className="room-host">{r.hostName} 的房間</div>
                <div className="muted small">
                  {r.seated} / {r.playerCount} 人・{r.advanced ? '進階規則' : '基本規則'}・{r.scoring === 'zeroSum' ? '零和式' : '加分式'}・{r.id}
                </div>
              </div>
              <button className="primary" onClick={() => send({ t: 'joinRoom', roomId: r.id })}>
                加入
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LobbyScreen({ state }: { state: AppState }) {
  const [settings, setSettings] = useState<RuleSettings>(defaultSettings(4));
  const [code, setCode] = useState('');
  return (
    <div className="lobby">
      <div className="panel">
        <h2>加入房間</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send({ t: 'joinRoom', roomId: code.trim() });
          }}
        >
          <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位數房號" />
          <button type="submit" className="primary" disabled={code.length !== 6}>
            加入
          </button>
        </form>
        <RoomList state={state} />
      </div>
      <div className="panel">
        <h2>建立房間</h2>
        <SettingsForm value={settings} onChange={setSettings} />
        <button className="primary" onClick={() => send({ t: 'createRoom', settings })}>
          建立房間
        </button>
      </div>
      <p className="muted small">
        {state.nickname}（{state.userId?.slice(0, 8)}）
        <button className="link" onClick={() => send({ t: 'setNickname', name: prompt('新的暱稱', state.nickname ?? '') ?? state.nickname ?? '' })}>
          修改暱稱
        </button>
      </p>
    </div>
  );
}
