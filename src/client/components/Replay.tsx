import { useEffect, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { GameView, HandResultView, PlayerView, RoomView } from '../../shared/protocol.js';
import { ReplayError, parseReplay, replayFrame, type ReplayFrame } from '../../shared/replay.js';
import type { ReplayEvent, ReplayFile, ReplayHand, ReplayMeld, ReplayScore } from '../../shared/replaySchema.js';
import { sanitizeSettings, type Meld, type RuleSettings } from '../../shared/rules.js';
import type { HandScore } from '../../shared/scoring.js';
import { playerName, t } from '../i18n/index.js';
import { Board, ResultBody, useLandscape } from './Table.js';

// 牌局回放頁面（網址 #replay）：選擇回放檔，或從最終結算畫面直接打開，一步一步重看整場牌局。
// 不需要連線，也不經過伺服器。

// ------------------------------------------------------------------
// 路由：網址的 #replay 與目前載入的回放檔
// ------------------------------------------------------------------

interface ReplayRoute {
  active: boolean;
  file: ReplayFile | null;
}

let loaded: ReplayFile | null = null;
const isReplayHash = () => typeof location !== 'undefined' && location.hash.startsWith('#replay');
let route: ReplayRoute = { active: isReplayHash(), file: null };
const routeListeners = new Set<() => void>();

function updateRoute() {
  const active = isReplayHash();
  if (!active) loaded = null;
  if (route.active !== active || route.file !== loaded) route = { active, file: loaded };
  routeListeners.forEach((l) => l());
}

if (typeof window !== 'undefined') window.addEventListener('hashchange', updateRoute);

/** 打開回放頁面；file 為 null 時顯示選擇檔案的畫面 */
export function openReplay(file: ReplayFile | null) {
  loaded = file;
  if (!isReplayHash()) location.hash = 'replay';
  updateRoute();
}

export function closeReplay() {
  loaded = null;
  history.pushState(null, '', location.pathname + location.search);
  updateRoute();
}

export function useReplayRoute(): ReplayRoute {
  return useSyncExternalStore(
    (l) => (routeListeners.add(l), () => routeListeners.delete(l)),
    () => route,
    () => route,
  );
}

export function ReplayScreen({ file }: { file: ReplayFile | null }) {
  return file ? <ReplayViewer key={file.savedAt} file={file} /> : <ReplayPicker />;
}

// ------------------------------------------------------------------
// 選擇回放檔
// ------------------------------------------------------------------

function ReplayPicker() {
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const load = async (f: File | undefined) => {
    if (!f) return;
    try {
      openReplay(parseReplay(await f.text()));
    } catch (e) {
      setError(e instanceof ReplayError ? e.message : '回放檔已損毀，無法讀取');
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    load(e.dataTransfer.files[0]);
  };
  return (
    <div className="lobby">
      <div className="panel narrow">
        <h2>{t('牌局回放')}</h2>
        <p className="muted small">{t('選擇別人分享給你的回放檔（.json），就能一步一步重看整場牌局。')}</p>
        <label
          className={`drop-zone ${drag ? 'on' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          {/* 不限制 accept：從 LINE 存下來的檔案，類型不一定是 application/json */}
          <input type="file" onChange={(e) => load(e.target.files?.[0])} />
          <span>{t('選擇回放檔，或拖曳到這裡')}</span>
        </label>
        {error && <p className="error">{t(error)}</p>}
        <div className="row">
          <button onClick={closeReplay}>{t('返回')}</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// 播放
// ------------------------------------------------------------------

const SPEEDS = [0.5, 1, 2, 4];
/** 一倍速時每一步的間隔；摸牌快一點、鳴牌與和牌停久一點 */
const STEP_MS = 900;
const stepMs = (e: ReplayEvent | undefined) => STEP_MS * (e?.t === 'draw' ? 0.5 : e?.t === 'discard' ? 1 : 1.5);

/** 顯示用名字：匿名的真人為「玩家 N」，電腦為「電腦 N」 */
function displayName(file: ReplayFile, seat: number): string {
  const p = file.players[seat];
  if (p.isAI) return playerName({ nickname: p.name, isAI: true });
  return file.anonymous || !p.name ? t('玩家 {n}', { n: seat + 1 }) : p.name;
}

function ReplayViewer({ file }: { file: ReplayFile }) {
  const landscape = useLandscape();
  const [hi, setHi] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const [showFinal, setShowFinal] = useState(false);
  const hand = file.hands[hi];
  const max = hand.events.length;
  const n = file.players.length;
  const frame = replayFrame(hand, step);
  const ended = step >= max;

  useEffect(() => {
    document.body.classList.add('in-game');
    return () => document.body.classList.remove('in-game');
  }, []);
  // 自動播放：播到最後停下來看結果
  useEffect(() => {
    if (!playing) return;
    if (ended) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), stepMs(hand.events[step]) / speed);
    return () => clearTimeout(id);
  }, [playing, step, speed, hand, ended]);
  useEffect(() => {
    if (ended) setShowResult(true);
  }, [ended]);

  const goHand = (i: number) => {
    setHi(Math.max(0, Math.min(file.hands.length - 1, i)));
    setStep(0);
    setShowResult(false);
  };
  const goStep = (s: number) => {
    setStep(Math.max(0, Math.min(max, s)));
    if (s < max) setShowResult(false);
  };
  // 鍵盤：← → 一步、空白鍵播放／暫停
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft') (setPlaying(false), goStep(step - 1));
      else if (e.key === 'ArrowRight') (setPlaying(false), goStep(step + 1));
      else if (e.key === ' ') (e.preventDefault(), setPlaying((p) => !p));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const room = roomViewOf(file, hand, frame, ended);
  const game = gameViewOf(file, hand, frame);
  const faceUp = frame.hands.map((h, s) => ({ hand: h, drawn: frame.drawn[s] }));
  const board = <Board room={room} game={game} now={0} pointKind={null} overlay={null} swapMini={false} view={view} faceUp={faceUp} />;
  const after = hand.scoresBefore.map((x, s) => x + hand.result.deltas[s]);

  const top = (
    <header className="top-bar">
      {file.anonymous && <span className="badge">{t('匿名')}</span>}
      <span className="round">{t('第 {n} / {total} 局', { n: hand.handNo, total: file.hands.length })}</span>
    </header>
  );
  const controls = (
    <div className="my-tools replay-controls">
      <div className="replay-caption">
        <span>{eventText(file, frame.event)}</span>
        <span className="muted small">{t('第 {n} / {total} 步', { n: step, total: max })}</span>
      </div>
      <input className="replay-seek" type="range" min={0} max={max} value={step} onChange={(e) => (setPlaying(false), goStep(Number(e.target.value)))} aria-label={t('進度')} />
      <div className="replay-row">
        <button className="chip-btn" disabled={hi === 0} onClick={() => goHand(hi - 1)} title={t('上一局')} aria-label={t('上一局')}>⏮</button>
        <button className="chip-btn" disabled={step === 0} onClick={() => (setPlaying(false), goStep(step - 1))} title={t('上一步')} aria-label={t('上一步')}>◀</button>
        <button className="chip-btn primary" onClick={() => (ended ? (goStep(0), setPlaying(true)) : setPlaying((p) => !p))}>
          {playing ? t('暫停') : t('播放')}
        </button>
        <button className="chip-btn" disabled={ended} onClick={() => (setPlaying(false), goStep(step + 1))} title={t('下一步')} aria-label={t('下一步')}>▶</button>
        <button className="chip-btn" disabled={hi === file.hands.length - 1} onClick={() => goHand(hi + 1)} title={t('下一局')} aria-label={t('下一局')}>⏭</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={t('速度')}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>
      <div className="replay-row">
        <select value={hi} onChange={(e) => goHand(Number(e.target.value))} aria-label={t('局')}>
          {file.hands.map((h, i) => (
            <option key={i} value={i}>
              {t('第 {n} / {total} 局', { n: h.handNo, total: file.hands.length })}
            </option>
          ))}
        </select>
        <button className="chip-btn" onClick={() => setView((v) => (v + 1) % n)} title={t('切換坐在下方的玩家')}>
          {t('視角：{name}', { name: displayName(file, view) })}
        </button>
        <button className="chip-btn" onClick={() => (ended ? setShowResult(true) : goStep(max))}>{t('結果')}</button>
        <button className="chip-btn" onClick={closeReplay}>{t('關閉回放')}</button>
      </div>
    </div>
  );
  const modals = (
    <>
      {showResult && ended && !showFinal && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setShowResult(false)}>
          <div className="modal result">
            <div className="reco-head">
              <strong>{t('第 {n} / {total} 局', { n: hand.handNo, total: file.hands.length })}</strong>
              <button className="link" onClick={() => setShowResult(false)} aria-label={t('關閉')}>✕</button>
            </div>
            <ResultBody room={room} r={resultViewOf(hand)} totals={after} live={false} />
            <div className="result-actions">
              <button onClick={() => goStep(0)}>{t('重看這一局')}</button>
              {hi < file.hands.length - 1 ? (
                <button className="primary" onClick={() => goHand(hi + 1)}>{t('下一局')}</button>
              ) : (
                <button className="primary" onClick={() => setShowFinal(true)}>{t('最終結算')}</button>
              )}
            </div>
          </div>
        </div>
      )}
      {showFinal && <FinalModal file={file} onClose={() => setShowFinal(false)} />}
    </>
  );
  if (landscape) {
    return (
      <div className={`table landscape spectator replay players-${n}`}>
        <div className="stage">
          <div className="gutter left">{controls}</div>
          {board}
          <div className="gutter right">{top}</div>
        </div>
        {modals}
      </div>
    );
  }
  return (
    <div className={`table portrait spectator replay players-${n}`}>
      {top}
      <div className="stage">{board}</div>
      {controls}
      {modals}
    </div>
  );
}

function FinalModal({ file, onClose }: { file: ReplayFile; onClose: () => void }) {
  const ranking = file.players.map((p) => p.seat).sort((a, b) => file.finalScores[b] - file.finalScores[a]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal result">
        <div className="reco-head">
          <strong>{file.dissolved ? t('牌局已解散') : t('最終結算')}</strong>
          <button className="link" onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
        <ol className="ranking">
          {ranking.map((s, i) => (
            <li key={s}>
              <span className="rank">{i + 1}</span>
              <span className="name">{displayName(file, s)}</span>
              <span className="score">{file.finalScores[s]}</span>
            </li>
          ))}
        </ol>
        <div className="result-actions">
          <button onClick={onClose}>{t('關閉')}</button>
          <button onClick={closeReplay}>{t('關閉回放')}</button>
        </div>
      </div>
    </div>
  );
}

function eventText(file: ReplayFile, e: ReplayEvent | null): string {
  if (!e) return t('配牌');
  if (e.t === 'pass') return t('換三張');
  const name = displayName(file, e.s);
  switch (e.t) {
    case 'draw':
      return e.rinshan ? t('{name} 補嶺上牌', { name }) : t('{name} 摸牌', { name });
    case 'discard':
      return t('{name} 打出', { name });
    case 'chi':
      return t('{name} 吃', { name });
    case 'pon':
      return t('{name} 碰', { name });
    case 'minkan':
      return t('{name} 槓', { name });
    case 'ankan':
      return t('{name} 暗槓', { name });
    case 'kakan':
      return t('{name} 加槓', { name });
    case 'win':
      return e.from === undefined ? t('{name} 自摸', { name }) : t('{name} 和牌', { name });
  }
}

// ------------------------------------------------------------------
// 轉成牌桌元件用的快照（以觀戰者的身分顯示，手牌另外以 faceUp 正面朝上）
// ------------------------------------------------------------------

const meldOf = (m: ReplayMeld): Meld => ({
  type: m.type,
  tiles: [...m.tiles],
  ...(m.called !== undefined ? { calledTile: m.called } : {}),
  ...(m.from !== undefined ? { from: m.from } : {}),
});

function settingsOf(file: ReplayFile): RuleSettings {
  return sanitizeSettings({ ...(file.settings as Partial<RuleSettings>), playerCount: file.players.length as RuleSettings['playerCount'] });
}

function roomViewOf(file: ReplayFile, hand: ReplayHand, f: ReplayFrame, ended: boolean): RoomView {
  const players: PlayerView[] = file.players.map((p, s) => ({
    seat: s,
    nickname: displayName(file, s),
    userId: null,
    isAI: p.isAI,
    aiControlled: false,
    autoPlay: false,
    connected: true,
    left: false,
    ready: true,
    score: hand.scoresBefore[s] + (ended ? hand.result.deltas[s] : 0),
    wind: hand.winds[s],
    handCount: f.hands[s].length + (f.drawn[s] !== null ? 1 : 0),
    hasDrawn: f.drawn[s] !== null,
    melds: f.melds[s].map(meldOf),
    discards: f.discards[s],
  }));
  return {
    id: file.roomId,
    hostSeat: -1,
    status: 'playing',
    settings: settingsOf(file),
    players,
    mySeat: null,
    paused: null,
    history: [],
    dissolved: file.dissolved,
    spectators: [],
    replays: [],
  };
}

function gameViewOf(file: ReplayFile, hand: ReplayHand, f: ReplayFrame): GameView {
  const n = file.players.length;
  return {
    handNo: hand.handNo,
    totalHands: file.hands.length,
    startSeat: hand.startSeat,
    phase: f.lastDiscard || f.kakan ? 'claim' : 'turn',
    currentSeat: f.current,
    wallRemaining: f.wallRemaining,
    deadWall: hand.deadWall,
    myHand: [],
    myDrawn: null,
    lastDiscard: f.lastDiscard,
    recentDiscard: f.kakan ? null : f.recentDiscard,
    kakanTile: f.kakan,
    pending: null,
    waitingSeats: [],
    deadline: null,
    passThreeDone: new Array(n).fill(false),
    passSent: null,
    passReceived: null,
    myWaits: [],
    myWaitScore: null,
    thinkAvailable: false,
    auto: { on: false, win: false, noCall: false },
    result: null,
    smallHandAvailable: new Array(n).fill(true),
    solo: false,
    fastFinish: false,
    aiPlay: false,
  };
}

/** 回放檔只存顯示需要的分數欄位；結果畫面不會用到和牌形與面子拆法 */
const scoreOf = (s: ReplayScore): HandScore => ({ form: 'standard', groups: [], yaku: s.yaku, yakuPoints: s.yakuPoints, limit: s.limit, baseScore: s.baseScore, total: s.total });

function resultViewOf(hand: ReplayHand): HandResultView {
  const r = hand.result;
  return {
    kind: r.kind,
    winners: r.winners.map((w) => ({ ...w, score: scoreOf(w.score) })),
    tenpai: r.tenpai.map((x) => ({ ...x, best: { ...x.best, score: scoreOf(x.best.score) } })),
    deltas: r.deltas,
    lines: r.lines,
    hands: r.hands,
    melds: r.melds.map((ms) => ms.map(meldOf)),
    shown: [],
    acknowledged: [],
  };
}
