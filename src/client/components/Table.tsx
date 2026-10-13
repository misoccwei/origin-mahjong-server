import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { GameView, HandResultView, PlayerView, RoomView } from '../../shared/protocol.js';
import type { HandScore } from '../../shared/scoring.js';
import { fastestWin, recommendYaku } from '../../shared/recommend.js';
import { baseScoreFor, type Meld } from '../../shared/rules.js';
import { kindOf, type TileId, type TileKind } from '../../shared/tiles.js';
import { act, send, type AppState } from '../net.js';
import { AILevelSelect } from './Inputs.js';
import { kindLabel, Tile } from './Tile.js';
import { useVoice } from '../voice.js';
import { VoiceButtons, VoiceMark, VoiceSettings } from './Voice.js';
import { YakuTable } from './YakuTable.js';
import { ExportButton } from './ExportButton.js';
import { renderHandResult } from '../exportImage.js';

const WIND = ['東', '南', '西', '北'];
const windLabel = (k: TileKind | null) => (k === null ? '' : WIND[k - 27]);

/** 目前的伺服器時間。每次渲染都重新計算（計時器只負責觸發重繪），倒數才不會用到舊時間而多顯示一秒 */
function useNow(offset: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, []);
  return Date.now() + offset;
}

type Pos = 'bottom' | 'right' | 'top' | 'left';

/** 相對於自己的位置：0 = 自己、1 = 下家（左）、2 = 對家（上）、3 = 上家（右）；原點麻將為順時針 */
function positionOf(seat: number, me: number, n: number): Pos {
  const rel = (seat - me + n) % n;
  if (n === 2) return rel === 0 ? 'bottom' : 'top';
  if (n === 3) return (['bottom', 'left', 'right'] as const)[rel];
  return (['bottom', 'left', 'top', 'right'] as const)[rel];
}

function MeldView({ meld, small }: { meld: Meld; small?: boolean }) {
  const hidden = meld.tiles[0] === -1;
  return (
    <span className="meld">
      {meld.tiles.map((t, i) => {
        const faceDown = hidden || (meld.type === 'ankan' && (i === 0 || i === 3));
        return <Tile key={i} tile={t} back={faceDown} small={small} sideways={t === meld.calledTile} />;
      })}
    </span>
  );
}

function River({ p, lastDiscard, pointKind }: { p: PlayerView; lastDiscard: GameView['lastDiscard']; pointKind: TileKind | null }) {
  return (
    <div className="river">
      {p.discards.map((d, i) => (
        <Tile
          key={i}
          tile={d.tile}
          dim={d.called}
          match={pointKind !== null && kindOf(d.tile) === pointKind}
          highlight={lastDiscard?.seat === p.seat && lastDiscard.tile === d.tile}
        />
      ))}
    </div>
  );
}

/** 一位玩家在牌桌上的那一側：以「自己在下方」的方向排版，再依位置整層旋轉（門風與分數的小牌子只在直式顯示，橫式放在名牌裡） */
function Side({ p, game, pos, pointKind, showHand }: { p: PlayerView; game: GameView; pos: Pos; pointKind: TileKind | null; showHand: boolean }) {
  const active = game.currentSeat === p.seat && game.phase === 'turn';
  return (
    <div className={`side pos-${pos}`}>
      <div className={`side-plate ${active ? 'active' : ''}`}>
        <span className="wind">{windLabel(p.wind)}</span>
        <span className="score">{p.score}</span>
      </div>
      <River p={p} lastDiscard={game.lastDiscard} pointKind={pointKind} />
      {showHand && (
        <div className="side-hand">
          {Array.from({ length: p.handCount - (p.hasDrawn ? 1 : 0) }, (_, i) => (
            <Tile key={i} back />
          ))}
          {p.hasDrawn && (
            <span className="drawn-gap">
              <Tile back />
            </span>
          )}
          {p.melds.map((m, i) => (
            <MeldView key={i} meld={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function NamePlate({ p, room, game, pos }: { p: PlayerView; room: RoomView; game: GameView; pos: Pos }) {
  const waiting = game.waitingSeats.includes(p.seat);
  const active = game.currentSeat === p.seat && game.phase === 'turn';
  return (
    <div className={`nameplate at-${pos} ${active ? 'active' : ''}`}>
      <div className="plate-score">
        <b>{windLabel(p.wind)}</b>
        <span>{p.score}</span>
      </div>
      <div className="name">
        {p.nickname}
        <VoiceMark userId={p.userId} />
        {waiting && game.phase !== 'turn' && <span className="thinking">…</span>}
      </div>
      <div className="badges">
        {p.seat === room.hostSeat && <span className="badge">房主</span>}
        {p.isAI && <span className="badge ai">AI</span>}
        {p.aiControlled && <span className="badge ai">AI 代打</span>}
        {p.autoPlay && !p.aiControlled && <span className="badge ai">自動</span>}
        {!p.connected && !p.isAI && <span className="badge warn">{p.left ? '已離開' : '離線'}</span>}
        {game.phase === 'passThree' && game.passThreeDone[p.seat] && <span className="badge">已選</span>}
      </div>
    </div>
  );
}

/**
 * 打出、吃碰槓和、自摸、暗槓／加槓：大按鈕疊在牌桌下緣、手牌正上方。
 * 不放正中間：中間顯示著剛打出的牌，碰／吃時需要看得到是哪一張。
 */
function CallOverlay({ game, discardButton }: { game: GameView; discardButton?: ReactElement | null }) {
  const p = game.pending;
  if (!p || p.kind === 'passThree') return null;
  const buttons: ReactElement[] = [];
  if (p.kind === 'turn') {
    if (discardButton) buttons.push(discardButton);
    if (p.tsumo) buttons.push(<button key="tsumo" className="call win" onClick={() => act({ type: 'tsumo' })}>自摸</button>);
    for (const k of p.ankan ?? []) buttons.push(<button key={'an' + k} className="call kan" onClick={() => act({ type: 'ankan', kind: k })}>暗槓 <Tile kind={k} small /></button>);
    for (const k of p.kakan ?? []) buttons.push(<button key={'ka' + k} className="call kan" onClick={() => act({ type: 'kakan', kind: k })}>加槓 <Tile kind={k} small /></button>);
    // 自動摸打遇到能槓時會停下來問：不槓就照常摸切
    if (game.auto.on && buttons.length && game.myDrawn !== null) {
      buttons.push(<button key="nokan" className="call skip" onClick={() => act({ type: 'discard', tile: game.myDrawn! })}>不槓（摸切）</button>);
    }
  } else {
    if (p.ron) buttons.push(<button key="ron" className="call win" onClick={() => act({ type: 'ron' })}>{p.kind === 'chankan' ? '搶槓' : '和'}</button>);
    // 不鳴牌：只剩和與略過
    if (!game.auto.noCall && p.minkan) buttons.push(<button key="kan" className="call kan" onClick={() => act({ type: 'minkan' })}>槓</button>);
    if (!game.auto.noCall && p.pon) buttons.push(<button key="pon" className="call pon" onClick={() => act({ type: 'pon' })}>碰</button>);
    for (const c of game.auto.noCall ? [] : p.chi ?? []) {
      buttons.push(
        <button key={'chi' + c.join()} className="call chi" onClick={() => act({ type: 'chi', tiles: c })}>
          吃 <Tile tile={c[0]} small />
          <Tile tile={c[1]} small />
        </button>,
      );
    }
    buttons.push(<button key="pass" className="call skip" onClick={() => act({ type: 'pass' })}>略過</button>);
  }
  if (!buttons.length) return null;
  return <div className="call-overlay">{buttons}</div>;
}

function Waits({ waits, score }: { waits: GameView['myWaits']; score: GameView['myWaitScore'] | undefined }) {
  return (
    <>
      聽牌：
      {waits.map((w) => (
        <span key={w.kind} className={`wait ${w.left === 0 ? 'none' : ''}`}>
          <Tile kind={w.kind} small />
          <span className="left">×{w.left}</span>
        </span>
      ))}
      {/* 預計和牌分數（所有聽的牌、自摸或銃和；不含偶然類），最高與最低相同時只寫一個 */}
      <span className="wait-score">
        {score ? (score.min === score.max ? `預計 ${score.max} 分` : `預計 ${score.min}～${score.max} 分`) : '未達和牌最低分數，不能和'}
      </span>
    </>
  );
}

/** 牌型表（預設只列出這桌適用的牌型） */
function YakuModal({ room, onClose }: { room: RoomView; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal yaku-modal">
        <div className="reco-head">
          <h2>牌型表</h2>
          <button className="link" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <YakuTable advanced={room.settings.advanced} expansion={room.settings.expansion} defaultShowAll={false} />
      </div>
    </div>
  );
}

/** ⚙ 選單：較少用的設定（只和最高分、電腦難度、全螢幕、離開），收起來讓工具列在手機上一排放得下 */
function ToolsMenu({ room, game, setAuto }: { room: RoomView; game: GameView; setAuto: (patch: Partial<GameView['auto']>) => void }) {
  const [open, setOpen] = useState(false);
  const [showYaku, setShowYaku] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const voice = useVoice();
  const boxRef = useRef<HTMLDivElement>(null);
  // 打開時點選單以外的地方就關起來
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  const [fs, setFs] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  return (
    <div className="tools-menu" ref={boxRef}>
      <button className={`chip-btn ${open ? 'on' : ''}`} aria-expanded={open} aria-label="更多設定" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
          />
        </svg>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button onClick={() => (setShowYaku(true), setOpen(false))}>牌型表</button>
          {voice.active && <button onClick={() => (setShowVoice(true), setOpen(false))}>語音設定</button>}
          <label className="toggle" title="別人打牌時不吃碰槓（自動略過，能和時仍會問你）；持續有效">
            <input type="checkbox" checked={game.auto.noCall} onChange={(e) => setAuto({ noCall: e.target.checked })} />
            不鳴牌（不吃碰槓）
          </label>
          <label className={`toggle ${game.auto.on || game.auto.win ? '' : 'disabled'}`}>
            <input type="checkbox" disabled={!game.auto.on && !game.auto.win} checked={game.auto.onlyMax} onChange={(e) => setAuto({ onlyMax: e.target.checked })} />
            只和最高分
          </label>
          {room.players.some((p) => p.isAI || p.aiControlled) && (
            <label className="toggle">
              電腦
              <AILevelSelect value={room.settings.aiLevel} disabled={room.mySeat !== room.hostSeat} onChange={(level) => send({ t: 'setAILevel', level })} />
            </label>
          )}
          {canFullscreen && (
            <button onClick={() => (fs ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {})}>
              {fs ? '離開全螢幕' : '全螢幕'}
            </button>
          )}
          <button className="danger" onClick={() => confirm('牌局進行中離開，牌局會暫停並由房主決定是否交給 AI。確定離開？') && send({ t: 'leaveRoom' })}>
            離開牌局
          </button>
        </div>
      )}
      {showVoice && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setShowVoice(false)}>
          <div className="modal voice-modal">
            <div className="reco-head">
              <h2>語音設定</h2>
              <button className="link" onClick={() => setShowVoice(false)} aria-label="關閉">✕</button>
            </div>
            <VoiceSettings room={room} />
          </div>
        </div>
      )}
      {showYaku && <YakuModal room={room} onClose={() => setShowYaku(false)} />}
    </div>
  );
}

/**
 * 自己的手牌與操作。回傳幾個區塊，由牌桌依直式／橫式擺放：
 * top = 提示列（聽牌、打出後聽…）、hand = 手牌、tools = 工具列、boardOverlay = 疊在牌桌上的換三張選牌區。
 */
function useMyArea({ room, game, onPoint, showReco, toggleReco, landscape }: {
  room: RoomView;
  game: GameView;
  onPoint: (k: TileKind | null) => void;
  showReco: boolean;
  toggleReco: () => void;
  landscape: boolean;
}) {
  const me = room.players[room.mySeat!];
  const [selected, setSelected] = useState<TileId[]>([]);
  const [hover, setHover] = useState<TileKind | null>(null);
  const p = game.pending;
  useEffect(() => setSelected([]), [game.handNo, p?.kind]);
  const passing = p?.kind === 'passThree';
  // 換三張時，選中的牌會「移出」手牌、放進候選格
  const hand = game.myHand.filter((t) => t !== game.myDrawn && !(passing && selected.includes(t)));
  const hints = p?.tenpaiHints ?? {};
  // 指著的牌：滑鼠移到的牌，或（手機）點選中的那一張
  const pointKind = hover ?? (!passing && selected.length === 1 ? kindOf(selected[0]) : null);
  useEffect(() => onPoint(pointKind), [pointKind, onPoint]);
  const shownHint = pointKind !== null ? hints[pointKind] : undefined;

  const onTile = (t: TileId) => {
    if (!p) return;
    if (passing) {
      // 候選格滿了再點別張：最早選的那張回到手牌
      setSelected((cur) => [...cur, t].slice(-3));
      setHover(null);
      return;
    }
    if (p.kind !== 'turn') return;
    if (selected[0] === t) {
      act({ type: 'discard', tile: t });
      setSelected([]);
    } else setSelected([t]);
  };
  const clickable = !!p && (p.kind === 'turn' || passing);
  const setAuto = (patch: Partial<GameView['auto']>) => send({ t: 'setAuto', ...game.auto, ...patch });
  // 點擊與滑鼠事件放在不會移動的外框上：牌浮起來時不會從游標下滑走而抖動、點不到
  const tileSlot = (t: TileId) => (
    <span
      key={t}
      className={`tile-slot ${clickable ? 'clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      onClick={clickable ? () => onTile(t) : undefined}
      onMouseEnter={() => setHover(kindOf(t))}
      onMouseLeave={() => setHover(null)}
    >
      <Tile tile={t} selected={!passing && selected.includes(t)} highlight={!!hints[kindOf(t)] && p?.kind === 'turn'} />
    </span>
  );

  const top = (
    <div className="my-top">
      <div className="hint-line">
        {shownHint ? (
          <>
            打出後聽：
            {shownHint.map((k) => (
              <Tile key={k} kind={k} small />
            ))}
          </>
        ) : game.phase === 'passReveal' ? (
          game.passReceived ? '收到換來的 3 張牌，倒數結束後放進手牌' : '這次沒有換到牌'
        ) : game.myWaits.length > 0 ? (
          <Waits waits={game.myWaits} score={game.myWaitScore} />
        ) : p?.kind === 'turn' ? (
          '點選一張牌，再按「打出」或再點一次'
        ) : passing ? (
          '點手牌把要換出的牌放進候選格，點候選格可以放回手牌'
        ) : (
          ''
        )}
      </div>
      {game.thinkAvailable && (
        <button className="chip-btn think" onClick={() => send({ t: 'think' })} title="這一局只能用一次">
          長考 +60 秒
        </button>
      )}
    </div>
  );

  // 牌的大小只依「鳴牌組數」決定（手牌 13 − 3×組數，加上摸牌的位置），摸牌時不會變大小或換行
  // 橫式時鳴牌放到右側欄，下方這排只放手牌
  const n = 13 - 3 * me.melds.length + 1.5;
  const meldsEl =
    me.melds.length > 0 ? (
      <div className="meld-area">
        {me.melds.map((m, i) => (
          <MeldView key={i} meld={m} />
        ))}
      </div>
    ) : null;
  const handEl = (
    <div className="my-hand" style={{ '--n': n } as CSSProperties}>
      <div className="hand-tiles">
        {hand.map(tileSlot)}
        {/* 摸牌的位置一直保留（沒有摸牌時是空位），手牌不會因為摸牌而移動 */}
        <span className="drawn-gap">{game.myDrawn !== null ? tileSlot(game.myDrawn) : <span className="tile-slot placeholder" aria-hidden="true" />}</span>
      </div>
      {!landscape && meldsEl}
    </div>
  );

  const tools = (
    <div className="my-tools">
      <button className={`chip-btn ${showReco ? 'on' : ''}`} onClick={toggleReco} aria-pressed={showReco}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2Zm-2 18h4v1a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1Z" />
        </svg>
        推薦牌型
      </button>
      <button className={`chip-btn ${game.auto.win ? 'on' : ''}`} aria-pressed={game.auto.win} onClick={() => setAuto({ win: !game.auto.win })}>
        自動和牌
      </button>
      <button className={`chip-btn ${game.auto.on ? 'on' : ''}`} aria-pressed={game.auto.on} title="只維持這一局，下一局自動關閉" onClick={() => setAuto({ on: !game.auto.on })}>
        自動摸打
      </button>
      <VoiceButtons />
      <ToolsMenu room={room} game={game} setAuto={setAuto} />
    </div>
  );

  // 換三張：候選格疊在牌桌下緣（手牌正上方），點候選格把牌放回手牌
  const boardOverlay = passing ? (
    <div className="pass-overlay">
      <div className="pass-slots">
        {[0, 1, 2].map((i) =>
          selected[i] !== undefined ? (
            <button key={selected[i]} className="pass-slot filled" title="放回手牌" onClick={() => setSelected((cur) => cur.filter((x) => x !== selected[i]))}>
              <Tile tile={selected[i]} />
            </button>
          ) : (
            <span key={'empty' + i} className="pass-slot" />
          ),
        )}
      </div>
      <div className="pass-actions">
        <button className="call pon" disabled={selected.length !== 3} onClick={() => (act({ type: 'passThree', tiles: selected }), setSelected([]))}>
          換出
        </button>
        <button className="call skip" onClick={() => (act({ type: 'passThree', tiles: null }), setSelected([]))}>
          不換
        </button>
      </div>
    </div>
  ) : null;

  // 「打出」固定在牌桌下緣的操作區（和自摸、暗槓同一排），不跟著選中的牌移動
  const toDiscard = p?.kind === 'turn' && selected.length === 1 && game.myHand.includes(selected[0]) ? selected[0] : null;
  const discardButton =
    toDiscard !== null ? (
      <button key="discard" className="call discard" onClick={() => (act({ type: 'discard', tile: toDiscard }), setSelected([]))}>
        打出 <Tile tile={toDiscard} small />
      </button>
    ) : null;

  return { top, hand: handEl, tools, boardOverlay, melds: meldsEl, discardButton };
}

/** 換三張亮牌：蓋在牌桌正中間，收到的牌翻開；沒有交換時也顯示，避免看出誰沒換 */
function SwapReveal({ game, now }: { game: GameView; now: number }) {
  // 真正的倒數：依伺服器給的截止時間顯示 3、2、1，時間到伺服器就把牌放進手牌
  const remain = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  return (
    <div className="swap-reveal">
      {game.passSent && game.passReceived ? (
        <>
          <div className="swap-row">
            <span className="label">換出</span>
            {game.passSent.map((t) => (
              <Tile key={t} tile={t} />
            ))}
          </div>
          <div className="swap-arrow">▼</div>
          <div className="swap-row">
            <span className="label">收到</span>
            {game.passReceived.map((t, i) => (
              <span key={t} className="flip" style={{ animationDelay: `${0.3 + i * 0.25}s` }}>
                <Tile back />
                <Tile tile={t} highlight />
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="label">這次沒有換到牌</div>
      )}
      {remain !== null && (
        <div className="swap-count" key={remain}>
          {remain > 0 ? remain : ''}
        </div>
      )}
    </div>
  );
}

/** 換三張紀錄：亮牌結束後整局顯示在牌桌下緣（自己的河下方） */
function SwapMini({ game }: { game: GameView }) {
  if (!game.passSent || !game.passReceived) return null;
  return (
    <div className="swap-mini">
      <span className="label">換出</span>
      {game.passSent.map((t) => (
        <Tile key={t} tile={t} dim />
      ))}
      <span className="label">收到</span>
      {game.passReceived.map((t) => (
        <Tile key={t} tile={t} />
      ))}
    </div>
  );
}

/** 推薦／牌效率的輸入：自己的手牌與鳴牌，以及看得到的牌（所有人的鳴牌（他人暗槓除外）與還在河裡的捨牌） */
function recommendInput(room: RoomView, game: GameView) {
  const me = room.players[room.mySeat!];
  const visible = new Array(34).fill(0);
  for (const t of game.myHand) visible[kindOf(t)]++;
  for (const p of room.players) {
    for (const m of p.melds) for (const t of m.tiles) if (t >= 0) visible[kindOf(t)]++;
    for (const d of p.discards) if (!d.called) visible[kindOf(d.tile)]++;
  }
  const n = room.players.length;
  return {
    concealed: game.myHand.map(kindOf),
    melds: me.melds,
    seatWind: me.wind ?? 27,
    advanced: room.settings.advanced,
    visible,
    // 自己大約還能摸幾次：牌山剩下的牌平均分給每家
    drawsLeft: Math.floor(Math.max(0, game.wallRemaining - game.deadWall) / n),
    playerCount: n,
    baseScore: baseScoreFor(room.settings, me.seat),
    minWinScore: room.settings.minWinScore,
  };
}

/** 直式資訊卡「提示」分頁的補充：現在輪到誰，以及沒聽牌時的牌效率 */
function HintExtras({ room, game }: { room: RoomView; game: GameView }) {
  const me = room.mySeat!;
  const fast = useMemo(() => fastestWin(recommendInput(room, game)), [game.myHand, room.players, room.settings.advanced]);
  const who = (s: number) => (s === me ? '你' : room.players[s]?.nickname);
  const status =
    game.phase === 'passThree'
      ? '換三張：大家選牌中'
      : game.phase === 'passReveal'
        ? '換三張：亮牌中'
        : game.phase === 'claim' || game.phase === 'chankan'
          ? game.pending
            ? '可以鳴牌：吃、碰、槓或和'
            : `等待 ${game.waitingSeats.map(who).join('、')} 決定是否鳴牌`
          : game.phase === 'turn'
            ? game.currentSeat === me
              ? '輪到你打牌'
              : `輪到 ${who(game.currentSeat)} 打牌`
            : '';
  return (
    <div className="hint-extras">
      {status && <div className="hint-status">{status}</div>}
      {game.myWaits.length === 0 && game.phase !== 'passThree' && game.phase !== 'passReveal' && Number.isFinite(fast.shanten) && (
        <div className="hint-eff">
          牌效率：{shantenText(fast.shanten)}・有效牌 {fast.ukeire} 張
          {fast.discard !== undefined && (
            <>
              ，建議打 <Tile kind={fast.discard} small />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const shantenText = (s: number) => (s < 0 ? '已成形' : s === 0 ? '聽牌' : `向聽 ${s}`);

function RecoPanel({ room, game, mode, onClose }: { room: RoomView; game: GameView; mode: 'beside' | 'card'; onClose: () => void }) {
  const me = room.players[room.mySeat!];
  const { recs, fast } = useMemo(() => {
    const input = recommendInput(room, game);
    return { recs: recommendYaku(input), fast: fastestWin(input) };
  }, [game.myHand, room.players, me.melds, me.wind, room.settings, game.wallRemaining]);
  return (
    <aside className={`reco-panel ${mode}`}>
      {mode === 'beside' && (
        <div className="reco-head">
          <strong>推薦牌型</strong>
          <button className="link" onClick={onClose} aria-label="關閉">✕</button>
        </div>
      )}
      <div className="reco-fast">
        <div className="reco-title">
          <span>最快和牌</span>
          <span className="small muted">
            {shantenText(fast.shanten)}・有效牌 {fast.ukeire} 張
          </span>
        </div>
        {fast.discard !== undefined && (
          <div className="reco-discard">
            <span className="small muted">建議打</span>
            <Tile kind={fast.discard} small />
          </div>
        )}
      </div>
      {recs.length === 0 && <p className="muted small">目前沒有推薦{room.settings.minWinScore > 0 ? '（已排除未達和牌最低分數的牌型）' : ''}</p>}
      {/* 依期望值排序；分成可以吃碰做牌的，以及只能自己摸進來（門清）的 */}
      {([true, false] as const).map((callable) => {
        const group = recs.filter((r) => r.callable === callable);
        if (!group.length) return null;
        return (
          <section key={String(callable)} className="reco-group">
            <div className="reco-group-title small">{callable ? '可吃碰' : '門清（只能自己摸進來）'}</div>
            <ol>
              {group.map((r) => (
                <li key={r.id}>
                  <div className="reco-title">
                    <span>{r.name}</span>
                    <span className="pts">{r.points} 分</span>
                  </div>
                  <div className="small muted">
                    {shantenText(r.shanten)}・有效牌 {r.ukeire} 張
                  </div>
                  <div className="small reco-ev">
                    和牌率 {Math.round(r.winRate * 100)}%・期望 {r.ev.toFixed(1)} 分
                  </div>
                  {r.discard !== undefined && (
                    <div className="reco-discard">
                      <span className="small muted">朝這個牌型打</span>
                      <Tile kind={r.discard} small />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      <p className="small muted">依手牌與河裡看得到的牌估計有效牌、和牌率與期望值（和牌率 × 分數），部分牌型為近似值，僅供參考。</p>
    </aside>
  );
}

function Center({ room, game, now }: { room: RoomView; game: GameView; now: number }) {
  const remain = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  const recent = game.kakanTile ?? game.recentDiscard;
  return (
    <div className="center">
      <div className={`center-info ${recent ? 'has-recent' : ''}`}>
        {/* 橫式：局數、剩幾張、倒數放大，各家的門風與分數放在名牌裡；直式這些都在上方狀態列 */}
        <div className="round">
          第 {game.handNo} / {game.totalHands} 局
        </div>
        <div className="wall-left">
          餘 <b>{Math.max(0, game.wallRemaining - game.deadWall)}</b> 張
        </div>
        {recent && (
          // 剛打出（或加槓）的牌放大顯示，鳴牌時才知道是哪一張
          <div className={`recent ${game.phase === 'claim' || game.phase === 'chankan' ? 'claiming' : ''}`}>
            <span className="small">
              {room.players[recent.seat]?.nickname}
              {game.kakanTile ? ' 加槓' : ' 打出'}
            </span>
            <Tile tile={recent.tile} />
          </div>
        )}
        {remain !== null && game.phase !== 'result' && <div className={`timer ${remain <= 5 ? 'urgent' : ''}`}>{remain}</div>}
      </div>
    </div>
  );
}

/** 手牌一排；extra 是和牌的那張（或聽牌最高分的那張），與手牌隔開並標亮 */
function HandRow({ hand, melds, extra }: { hand: TileId[]; melds: Meld[]; extra?: { tile?: TileId; kind?: TileKind } }) {
  return (
    <div className="win-hand">
      {hand.map((t) => (
        <Tile key={t} tile={t} small />
      ))}
      {extra && (
        <span className="drawn-gap">
          <Tile tile={extra.tile} kind={extra.kind} small highlight />
        </span>
      )}
      {melds.map((m, i) => (
        <MeldView key={i} meld={m} small />
      ))}
    </div>
  );
}

/** 牌型明細：一個牌型一顆小標籤，最後是合計（比表格省高度） */
function YakuChips({ score, totalLabel }: { score: HandScore; totalLabel: string }) {
  return (
    <div className="yaku-chips">
      {score.baseScore > 0 && (
        <span className="chip">
          和牌底分 <b>{score.baseScore}</b>
        </span>
      )}
      {score.yaku.map((y) => (
        <span key={y.id} className="chip">
          {y.name}
          {y.count > 1 ? ` ×${y.count}` : ''} <b>{y.points}</b>
        </span>
      ))}
      <span className="chip total">
        {totalLabel}
        {score.limit ? '（滿貫）' : ''} <b>{score.total}</b>
      </span>
    </div>
  );
}

function Delta({ d }: { d: number }) {
  return <span className={`delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`}>{d > 0 ? `+${d}` : d}</span>;
}

/** 一局結果的卡片（和牌 → 聽牌 → 其他）與分數表；totals = 這一局結束後的累計分數。牌局中與結束後重看共用 */
export function ResultBody({ room, r, totals, live }: { room: RoomView; r: HandResultView; totals: number[]; live: boolean }) {
  const names = room.players.map((p) => p.nickname);
  const me = room.mySeat;
  const shown = r.shown ?? [];
  const winnerOf = (s: number) => r.winners.find((w) => w.seat === s);
  const tenpaiOf = (s: number) => (winnerOf(s) ? undefined : r.tenpai.find((t) => t.seat === s));
  const order = [...room.players.map((p) => p.seat)].sort((a, b) => {
    const rank = (s: number) => (winnerOf(s) ? 0 : tenpaiOf(s) ? 1 : 2);
    return rank(a) - rank(b) || a - b;
  });
  return (
    <>
      <h2>{r.kind === 'draw' ? '流局' : r.winners.map((w) => `${names[w.seat]} ${w.tsumo ? '自摸' : '和牌'}`).join('、')}</h2>
      {order.map((s) => {
        const w = winnerOf(s);
        const t = tenpaiOf(s);
        const d = r.deltas[s];
        if (w) {
          return (
            <section key={s} className="result-card win">
              <header>
                <span className="name">{names[s]}</span>
                <span className="tag win">{w.tsumo ? '自摸' : `銃和・放銃 ${names[w.from!]}`}</span>
                <Delta d={d} />
              </header>
              <HandRow hand={r.hands[s].filter((x) => x !== w.tile)} melds={r.melds[s]} extra={{ tile: w.tile }} />
              <YakuChips score={w.score} totalLabel="和牌分數" />
            </section>
          );
        }
        if (t) {
          const capped = d < t.maxScore && d > 0;
          return (
            <section key={s} className="result-card tenpai">
              <header>
                <span className="name">{names[s]}</span>
                <span className="tag tenpai">聽牌</span>
                <Delta d={d} />
              </header>
              <div className="waits-line small">
                聽
                {t.waits.map((k) => (
                  <Tile key={k} kind={k} small highlight={k === t.best.tile} />
                ))}
              </div>
              <div className="small muted">
                最高分的和法：{t.best.tsumo ? '自摸' : '銃和'}「{kindLabel(t.best.tile)}」（聽牌得分依此計算）
              </div>
              <HandRow hand={r.hands[s]} melds={r.melds[s]} extra={{ kind: t.best.tile }} />
              <YakuChips score={t.best.score} totalLabel="最高和牌分數" />
              {capped && <div className="small muted">聽牌得分不超過和牌者的得分，實得 {d} 分</div>}
            </section>
          );
        }
        // 重看時自己的手牌一律顯示（伺服器本來就會送自己的）
        const visible = shown.includes(s) || (!live && r.hands[s].length > 0);
        return (
          <section key={s} className="result-card other">
            <header>
              <span className="name">{names[s]}</span>
              <span className="tag">{shown.includes(s) ? '展示手牌' : '未聽牌'}</span>
              <Delta d={d} />
            </header>
            {visible ? (
              <HandRow hand={r.hands[s]} melds={r.melds[s]} />
            ) : s === me && live ? (
              <button className="show-hand" onClick={() => send({ t: 'showHand' })}>展示我的手牌</button>
            ) : (
              <div className="small muted">手牌未公開</div>
            )}
          </section>
        );
      })}
      <table className="deltas">
        <tbody>
          {room.players.map((p) => (
            <tr key={p.seat}>
              <td>{p.nickname}</td>
              <td className={r.deltas[p.seat] > 0 ? 'pos' : r.deltas[p.seat] < 0 ? 'neg' : ''}>
                {r.deltas[p.seat] > 0 ? '+' : ''}
                {r.deltas[p.seat]}
              </td>
              <td>{totals[p.seat]}</td>
              {live && <td className="muted small">{r.acknowledged.includes(p.seat) || p.isAI || p.aiControlled ? '✓' : ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 一局的結果（牌局中） */
function ResultModal({ room, game, now }: { room: RoomView; game: GameView; now: number }) {
  const r = game.result as HandResultView;
  const me = room.mySeat;
  const acked = me !== null && r.acknowledged.includes(me);
  const remain = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  const totals = room.players.map((p) => p.score + r.deltas[p.seat]);
  return (
    <div className="modal-backdrop">
      <div className="modal result">
        <ResultBody room={room} r={r} totals={totals} live />
        <div className="result-actions">
          {me === null ? (
            <p className="muted small">觀戰中：等待玩家進入下一局{remain !== null ? `（${remain}）` : ''}</p>
          ) : (
            <button className="primary" disabled={acked} onClick={() => send({ t: 'nextHand' })}>
              {acked ? '等待其他玩家…' : game.handNo >= game.totalHands ? '查看結算' : '下一局'}
              {remain !== null ? `（${remain}）` : ''}
            </button>
          )}
          <ExportButton
            render={() => renderHandResult(room, { handNo: game.handNo, totalHands: game.totalHands, result: r, totals })}
            filename={`原點麻將-${room.id}-第${game.handNo}局.png`}
          />
        </div>
      </div>
    </div>
  );
}

function PauseOverlay({ room }: { room: RoomView }) {
  const paused = room.paused!;
  const names = paused.disconnectedSeats.map((s) => room.players[s].nickname).join('、');
  const iDecide = paused.deciderSeat === room.mySeat;
  return (
    <div className="modal-backdrop">
      <div className="modal narrow">
        <h2>牌局暫停</h2>
        <p>{names} 已斷線或離開。</p>
        {iDecide ? (
          <>
            <p>請決定要等待玩家回來、交給 AI 代打，或解散牌局。</p>
            <div className="row">
              <button className="primary" onClick={() => send({ t: 'decide', choice: 'ai' })}>
                交給 AI 代打
              </button>
              <button onClick={() => send({ t: 'decide', choice: 'dissolve' })}>解散牌局</button>
            </div>
          </>
        ) : (
          <p className="muted">
            等待 {paused.deciderSeat !== null ? room.players[paused.deciderSeat].nickname : '玩家'} 決定（玩家回來後會自動繼續）…
          </p>
        )}
        <button className="link" onClick={() => (room.mySeat === null || confirm('確定要離開牌局嗎？')) && send({ t: 'leaveRoom' })}>
          {room.mySeat === null ? '離開觀戰' : '離開房間'}
        </button>
      </div>
    </div>
  );
}

/** 直式上方的狀態列：局數、餘牌、倒數，以及四家的門風、名字與分數（輪到的人亮起） */
function StatusBar({ room, game, now, view }: { room: RoomView; game: GameView; now: number; view: number }) {
  const remain = game.deadline && game.phase !== 'result' ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  const me = view;
  const n = room.players.length;
  // 從自己開始，依下家、對家、上家的順序
  const order = Array.from({ length: n }, (_, i) => room.players[(me + i) % n]);
  return (
    <header className="status-bar">
      <div className="status-row">
        <span className="round">
          第 {game.handNo} / {game.totalHands} 局・餘 {Math.max(0, game.wallRemaining - game.deadWall)}
        </span>
        {remain !== null && <span className={`status-timer ${remain <= 5 ? 'urgent' : ''}`}>⏱ {remain}</span>}
      </div>
      <div className="score-row">
        {order.map((p) => {
          const active = game.currentSeat === p.seat && (game.phase === 'turn' || game.phase === 'claim');
          return (
            <span key={p.seat} className={`score-chip ${active ? 'active' : ''} ${p.seat === room.mySeat ? 'me' : ''}`}>
              <b>{windLabel(p.wind)}</b>
              <span className="nm">{p.seat === room.mySeat ? '我' : p.nickname}</span>
              <VoiceMark userId={p.userId} />
              <span className="pt">{p.score}</span>
            </span>
          );
        })}
      </div>
    </header>
  );
}

type InfoTab = 'hint' | 'reco' | 'swap';

/** 直式上方的資訊卡：分頁切換提示（聽牌、打出後聽）、推薦牌型、換三張紀錄；高度隨剩餘空間伸縮 */
function InfoCard({ room, game, tab, setTab, hint }: { room: RoomView; game: GameView; tab: InfoTab; setTab: (t: InfoTab) => void; hint: ReactElement }) {
  const hasSwap = !!game.passSent && !!game.passReceived;
  const current = tab === 'swap' && !hasSwap ? 'hint' : tab;
  return (
    <section className="info-card">
      <div className="info-tabs" role="tablist">
        <button role="tab" aria-selected={current === 'hint'} className={current === 'hint' ? 'on' : ''} onClick={() => setTab('hint')}>
          {game.myWaits.length > 0 ? '聽牌' : '提示'}
        </button>
        <button role="tab" aria-selected={current === 'reco'} className={current === 'reco' ? 'on' : ''} onClick={() => setTab('reco')}>
          推薦牌型
        </button>
        {hasSwap && (
          <button role="tab" aria-selected={current === 'swap'} className={current === 'swap' ? 'on' : ''} onClick={() => setTab('swap')}>
            換三張
          </button>
        )}
      </div>
      <div className="info-body">
        {current === 'hint' && (
          <>
            <HintExtras room={room} game={game} />
            {hint}
          </>
        )}
        {current === 'reco' && <RecoPanel room={room} game={game} mode="card" onClose={() => setTab('hint')} />}
        {current === 'swap' && hasSwap && (
          <div className="swap-card">
            <div className="swap-row">
              <span className="small">換出</span>
              {game.passSent!.map((t) => (
                <Tile key={t} tile={t} dim small />
              ))}
            </div>
            <div className="swap-row">
              <span className="small">收到</span>
              {game.passReceived!.map((t) => (
                <Tile key={t} tile={t} small />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 橫式（寬大於高）時，手牌在下、牌桌置中、兩側放工具與面板 */
function useLandscape() {
  const query = '(min-aspect-ratio: 5/4)';
  const [landscape, setLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setLandscape(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return !!landscape;
}

function Board({ room, game, now, pointKind, overlay, discardButton, swapMini = true, view = 0 }: {
  room: RoomView;
  game: GameView;
  now: number;
  pointKind: TileKind | null;
  overlay: ReactElement | null;
  /** 選了手牌後的「打出」按鈕 */
  discardButton?: ReactElement | null;
  /** 觀戰視角：坐在下方的座位 */
  view?: number;
  /** 直式時換三張紀錄改放在上方資訊卡，牌桌上不顯示 */
  swapMini?: boolean;
}) {
  // 觀戰者沒有座位：以 view 為下方的視角，下方玩家的手牌也以牌背顯示
  const spectating = room.mySeat === null;
  const me = room.mySeat ?? view;
  const n = room.players.length;
  return (
    <div className="board">
      <Center room={room} game={game} now={now} />
      <CallOverlay game={game} discardButton={discardButton} />
      {overlay}
      {spectating ? null : game.phase === 'passReveal' ? <SwapReveal game={game} now={now} /> : swapMini && game.phase !== 'passThree' && <SwapMini game={game} />}
      {room.players.map((p) => {
        const pos = positionOf(p.seat, me, n);
        return <Side key={p.seat} p={p} game={game} pos={pos} pointKind={pointKind} showHand={spectating || pos !== 'bottom'} />;
      })}
      {room.players.map((p) => (
        <NamePlate key={p.seat} p={p} room={room} game={game} pos={positionOf(p.seat, me, n)} />
      ))}
    </div>
  );
}

/**
 * 牌桌畫面：固定佔滿整個視窗、不捲動。
 * 直式：牌桌在上（依剩餘空間決定大小），下方是提示列、手牌、工具列；推薦牌型疊在牌桌上。
 * 橫式：手牌在最下面一排，牌桌置中，左側放提示列與工具列，右側放推薦牌型。
 */
export function TableScreen({ state }: { state: AppState }) {
  const room = state.room!;
  const game = state.game;
  const now = useNow(state.clockOffset);
  const [pointKind, setPointKind] = useState<TileKind | null>(null);
  const [showReco, setShowReco] = useState(false);
  const landscape = useLandscape();
  useEffect(() => {
    document.body.classList.add('in-game');
    return () => document.body.classList.remove('in-game');
  }, []);
  if (!game) return <div className="panel narrow">準備下一局…</div>;
  if (room.mySeat === null) return <SpectatorLayout room={room} game={game} now={now} landscape={landscape} />;
  return <TableLayout room={room} game={game} now={now} pointKind={pointKind} setPointKind={setPointKind} showReco={showReco} setShowReco={setShowReco} landscape={landscape} />;
}

function TableLayout({ room, game, now, pointKind, setPointKind, showReco, setShowReco, landscape }: {
  room: RoomView;
  game: GameView;
  now: number;
  pointKind: TileKind | null;
  setPointKind: (k: TileKind | null) => void;
  showReco: boolean;
  setShowReco: (f: (v: boolean) => boolean) => void;
  landscape: boolean;
}) {
  // 直式：上方資訊卡的分頁；「推薦牌型」按鈕切到推薦分頁
  const [tab, setTab] = useState<InfoTab>('hint');
  const recoOn = landscape ? showReco : tab === 'reco';
  const toggleReco = () => (landscape ? setShowReco((v) => !v) : setTab((t) => (t === 'reco' ? 'hint' : 'reco')));
  const my = useMyArea({ room, game, onPoint: setPointKind, showReco: recoOn, toggleReco, landscape });
  const board = <Board room={room} game={game} now={now} pointKind={pointKind} overlay={my.boardOverlay} discardButton={my.discardButton} swapMini={landscape} />;
  const reco = landscape && showReco && <RecoPanel room={room} game={game} mode="beside" onClose={() => setShowReco(() => false)} />;
  const modals = (
    <>
      {game.phase === 'result' && game.result && <ResultModal room={room} game={game} now={now} />}
      {room.paused && <PauseOverlay room={room} />}
    </>
  );
  if (landscape) {
    return (
      <div className={`table landscape players-${room.players.length}`}>
        <div className="stage">
          <div className="gutter left">
            {my.top}
            {my.tools}
          </div>
          {board}
          <div className="gutter right">
            {reco}
            {my.melds && (
              <div className="side-melds">
                <div className="small muted">鳴牌</div>
                {my.melds}
              </div>
            )}
          </div>
        </div>
        {my.hand}
        {modals}
      </div>
    );
  }
  return (
    <div className={`table portrait players-${room.players.length}`}>
      <StatusBar room={room} game={game} now={now} view={room.mySeat!} />
      <InfoCard room={room} game={game} tab={tab} setTab={setTab} hint={my.top} />
      <div className="stage">{board}</div>
      {my.hand}
      {my.tools}
      {modals}
    </div>
  );
}

/** 觀戰：只看公開資訊（河、鳴牌、分數、手牌張數），可以切換坐在下方的視角 */
function SpectatorLayout({ room, game, now, landscape }: { room: RoomView; game: GameView; now: number; landscape: boolean }) {
  const [view, setView] = useState(0);
  const [showYaku, setShowYaku] = useState(false);
  const n = room.players.length;
  const board = <Board room={room} game={game} now={now} pointKind={null} overlay={null} swapMini={false} view={view} />;
  const tools = (
    <div className="my-tools spectator-tools">
      <span className="badge spectating">觀戰中</span>
      <button className="chip-btn" onClick={() => setView((v) => (v + 1) % n)} title="切換坐在下方的玩家">
        視角：{room.players[view]?.nickname}
      </button>
      <button className="chip-btn" onClick={() => setShowYaku(true)}>
        牌型表
      </button>
      <button className="chip-btn" onClick={() => send({ t: 'leaveRoom' })}>
        離開觀戰
      </button>
    </div>
  );
  const modals = (
    <>
      {game.phase === 'result' && game.result && <ResultModal room={room} game={game} now={now} />}
      {room.paused && <PauseOverlay room={room} />}
      {showYaku && <YakuModal room={room} onClose={() => setShowYaku(false)} />}
    </>
  );
  if (landscape) {
    return (
      <div className={`table landscape spectator players-${n}`}>
        <div className="stage">
          <div className="gutter left">{tools}</div>
          {board}
          <div className="gutter right" />
        </div>
        {modals}
      </div>
    );
  }
  return (
    <div className={`table portrait spectator players-${n}`}>
      <StatusBar room={room} game={game} now={now} view={view} />
      <div className="stage">{board}</div>
      {tools}
      {modals}
    </div>
  );
}
