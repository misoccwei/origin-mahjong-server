import { useEffect, useState } from 'react';
import { AILevelSelect, NumInput } from './Inputs.js';
import { YakuTable } from './YakuTable.js';
import { DEFAULT_ROUNDS, defaultSettings, type RuleSettings } from '../../shared/rules.js';
import { send, type AppState } from '../net.js';
import { LANGS, setLang, t, useLang, type Lang } from '../i18n/index.js';

/** 語言切換（記在瀏覽器） */
export function LangSelect() {
  const lang = useLang();
  return (
    <label className="lang-select">
      <span aria-hidden="true">🌐</span>
      <select value={lang} aria-label="Language" onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NicknameScreen({ state }: { state: AppState }) {
  const [name, setName] = useState(state.nickname ?? '');
  return (
    <div className="panel narrow">
      <h1>{t('原點麻將')}</h1>
      <p className="muted">{t('請輸入暱稱（不可與其他線上玩家重複）')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send({ t: 'setNickname', name });
        }}
      >
        <input autoFocus maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('暱稱')} />
        <button type="submit" disabled={!name.trim()}>
          {t('確定')}
        </button>
      </form>
      <p className="muted small">{t('使用者代碼：{id}', { id: state.userId?.slice(0, 8) ?? '' })}</p>
      <LangSelect />
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
        {t('人數')}
        <select
          value={value.playerCount}
          onChange={(e) => {
            const pc = Number(e.target.value) as 2 | 3 | 4;
            up({ playerCount: pc, rounds: DEFAULT_ROUNDS[pc], handicaps: {} });
          }}
        >
          <option value={2}>{t('2 人')}</option>
          <option value={3}>{t('3 人')}</option>
          <option value={4}>{t('4 人')}</option>
        </select>
      </label>
      <label>
        {t('圈數')}
        <NumInput min={1} max={16} value={value.rounds} onChange={(v) => up({ rounds: v ?? 0 })} />
        <span className="muted small">{t('共 {n} 局', { n: value.rounds * value.playerCount })}</span>
      </label>
      <label>
        {t('計分')}
        <select value={value.scoring} onChange={(e) => up({ scoring: e.target.value as RuleSettings['scoring'] })}>
          <option value="additive">{t('加分式')}</option>
          <option value="zeroSum">{t('零和式')}</option>
        </select>
      </label>
      {showAILevel && (
        <label>
          {t('電腦難度')}
          <AILevelSelect value={value.aiLevel} onChange={(aiLevel) => up({ aiLevel })} />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={value.advanced} onChange={(e) => up({ advanced: e.target.checked })} />
        {value.scoring === 'additive' ? t('進階規則（進階牌型、和牌×2＋聽牌得分）') : t('進階規則（進階牌型）')}
      </label>
      <label className="check">
        <input type="checkbox" checked={value.passThree} onChange={(e) => up({ passThree: e.target.checked })} />
        {t('換三張（配牌後可選擇把 3 張牌換給下家）')}
      </label>
      <label className="check">
        <input type="checkbox" checked={value.randomSeats} onChange={(e) => up({ randomSeats: e.target.checked })} />
        {t('隨機座位（開始牌局時打亂座位順序）')}
      </label>
      <label className="check">
        <input type="checkbox" checked={value.allowSpectators} onChange={(e) => up({ allowSpectators: e.target.checked })} />
        {t('允許觀戰（觀戰者只看得到公開資訊，不能參與語音）')}
      </label>
      <label className="check">
        <input type="checkbox" checked={value.expansion} onChange={(e) => up({ expansion: e.target.checked })} />
        {t('牌型擴充包（二元／二風、連面子、鏡面子、四歸一、十三不搭、對稱類等 20 個牌型）')}
      </label>
      <label>
        {t('和牌最低分數')}
        <NumInput min={0} max={320} value={value.minWinScore} onChange={(v) => up({ minWinScore: v ?? 0 })} />
        <span className="muted small">{t('分（未達此分數不能和牌，0 = 不限）')}</span>
      </label>
      <label>
        {t('打牌時限')}
        <NumInput min={0} max={300} value={value.turnSeconds} onChange={(v) => up({ turnSeconds: v ?? 0 })} />
        <span className="muted small">{t('秒（0 = 不限）')}</span>
      </label>
      <label>
        {t('鳴牌時限')}
        <NumInput min={0} max={120} value={value.claimSeconds} onChange={(v) => up({ claimSeconds: v ?? 0 })} />
        <span className="muted small">{t('秒')}</span>
      </label>
      <label>
        {t('結算倒數')}
        <NumInput min={0} max={300} value={value.resultSeconds} onChange={(v) => up({ resultSeconds: v ?? 0 })} />
        <span className="muted small">{t('秒（時間到自動進入下一局，0 = 等所有人按）')}</span>
      </label>
      {seatNames && (
        <details>
          <summary>{t('讓分設定（每人基本底分）')}</summary>
          <p className="muted small">{t('基本底分未填時：基本規則 20、進階規則 0。')}</p>
          {seatNames.map((n, seat) => {
            const h = value.handicaps[seat] ?? {};
            const setH = (patch: object) => up({ handicaps: { ...value.handicaps, [seat]: { ...h, ...patch } } });
            return (
              <div key={seat} className="handicap">
                <span>{n ?? t('座位 {n}', { n: seat + 1 })}</span>
                <label>
                  {t('基本底分')}
                  <NumInput min={0} max={160} placeholder={value.advanced ? '0' : '20'} value={h.baseScore} onChange={(baseScore) => setH({ baseScore })} />
                </label>
              </div>
            );
          })}
        </details>
      )}
    </fieldset>
  );
}

const STATUS_KEY = { waiting: '等待中', playing: '對局中', finished: '已結束' } as const;

/** 房間列表：等待中有空位的可以加入，允許觀戰的可以觀戰；每 3 秒更新一次 */
function RoomList({ state }: { state: AppState }) {
  useEffect(() => {
    const refresh = () => send({ t: 'listRooms' });
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [state.conn]);
  return (
    <div className="room-list">
      <h3>{t('房間列表')}</h3>
      {state.roomList.length === 0 ? (
        <p className="muted small">{t('目前沒有可以加入或觀戰的房間，可以自己建立一個。')}</p>
      ) : (
        <ul>
          {state.roomList.map((r) => (
            <li key={r.id}>
              <div className="room-info">
                <div className="room-host">{t('{name} 的房間', { name: r.hostName })}</div>
                <div className="muted small">
                  {[
                    t(STATUS_KEY[r.status]),
                    t('{seated} / {total} 人', { seated: r.seated, total: r.playerCount }),
                    r.advanced ? t('進階規則') : t('基本規則'),
                    r.scoring === 'zeroSum' ? t('零和式') : t('加分式'),
                    r.spectators > 0 && t('{n} 人觀戰', { n: r.spectators }),
                    r.id,
                  ]
                    .filter(Boolean)
                    .join(t('・'))}
                </div>
              </div>
              <div className="room-btns">
                {r.joinable && (
                  <button className="primary" onClick={() => send({ t: 'joinRoom', roomId: r.id })}>
                    {t('加入')}
                  </button>
                )}
                {r.spectatable && <button onClick={() => send({ t: 'spectate', roomId: r.id })}>{t('觀戰')}</button>}
              </div>
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
        <h2>{t('加入房間')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send({ t: 'joinRoom', roomId: code.trim() });
          }}
        >
          <input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder={t('4 位數房號')} />
          <button type="submit" className="primary" disabled={code.length !== 4}>
            {t('加入')}
          </button>
          <button type="button" disabled={code.length !== 4} onClick={() => send({ t: 'spectate', roomId: code.trim() })}>
            {t('觀戰')}
          </button>
        </form>
        <RoomList state={state} />
      </div>
      <div className="panel">
        <h2>{t('建立房間')}</h2>
        <SettingsForm value={settings} onChange={setSettings} />
        <button className="primary" onClick={() => send({ t: 'createRoom', settings })}>
          {t('建立房間')}
        </button>
      </div>
      <div className="panel wide">
        <h2>{t('牌型表')}</h2>
        <YakuTable />
      </div>
      <p className="muted small">
        {state.nickname}（{state.userId?.slice(0, 8)}）
        <button className="link" onClick={() => send({ t: 'setNickname', name: prompt(t('新的暱稱'), state.nickname ?? '') ?? state.nickname ?? '' })}>
          {t('修改暱稱')}
        </button>
        <LangSelect />
      </p>
    </div>
  );
}
