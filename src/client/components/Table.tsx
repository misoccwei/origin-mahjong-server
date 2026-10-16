import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { GameView, HandResultView, PlayerView, RoomView, WinScoreView } from '../../shared/protocol.js';
import { evaluateWin, type HandScore } from '../../shared/scoring.js';
import { fastestWin, recommendYaku } from '../../shared/recommend.js';
import { OUTCOME_MAX_SHANTEN, outcomeRecommend, type OutcomeGroup, type OutcomePlan, type OutcomeResult } from '../../shared/outcome.js';
import { baseScoreFor, meldTileOrder, type Meld } from '../../shared/rules.js';
import { kindOf, type TileId, type TileKind } from '../../shared/tiles.js';
import { act, request, send, type AppState } from '../net.js';
import { BusyVeil, ReqButton, useRequest } from './Busy.js';
import { AILevelSelect } from './Inputs.js';
import { Tile } from './Tile.js';
import { LangSelect } from './Lobby.js';
import { playerName, t, tileLabel, tn, windShort } from '../i18n/index.js';
import { useVoice } from '../voice.js';
import { VoiceButtons, VoiceMark, VoiceSettings } from './Voice.js';
import { YakuTable } from './YakuTable.js';
import { ExportButton } from './ExportButton.js';
import { renderHandResult } from '../exportImage.js';

const windLabel = (k: TileKind | null) => (k === null ? '' : windShort(k));

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

function MeldView({ meld, seat, n, small, pointKind = null }: { meld: Meld; seat: number; n: number; small?: boolean; pointKind?: TileKind | null }) {
  const hidden = meld.tiles[0] === -1;
  return (
    <span className="meld">
      {meldTileOrder(meld, seat, n).map((t, i) => {
        const faceDown = hidden || (meld.type === 'ankan' && (i === 0 || i === 3));
        return <Tile key={i} tile={t} back={faceDown} small={small} sideways={t === meld.calledTile} match={!faceDown && pointKind !== null && kindOf(t) === pointKind} />;
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

/** 一位玩家在牌桌上的那一側：以「自己在下方」的方向排版，再依位置整層旋轉（門風與分數在四角的名牌裡） */
function Side({ p, n, game, pos, pointKind, showHand, faceUp }: {
  p: PlayerView;
  n: number;
  game: GameView;
  pos: Pos;
  pointKind: TileKind | null;
  showHand: boolean;
  /** 回放：手牌正面朝上 */
  faceUp?: FaceUpHand;
}) {
  return (
    <div className={`side pos-${pos}`}>
      <River p={p} lastDiscard={game.lastDiscard} pointKind={pointKind} />
      {showHand && (
        <div className={faceUp ? 'side-hand face-up' : 'side-hand'}>
          {faceUp
            ? faceUp.hand.map((t) => <Tile key={t} tile={t} />)
            : Array.from({ length: p.handCount - (p.hasDrawn ? 1 : 0) }, (_, i) => <Tile key={i} back />)}
          {faceUp ? (
            faceUp.drawn !== null && (
              <span className="drawn-gap">
                <Tile tile={faceUp.drawn} />
              </span>
            )
          ) : (
            p.hasDrawn && (
              <span className="drawn-gap">
                <Tile back />
              </span>
            )
          )}
          {p.melds.map((m, i) => (
            <MeldView key={i} meld={m} seat={p.seat} n={n} pointKind={pointKind} />
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
        {playerName(p)}
        <VoiceMark userId={p.userId} />
        {waiting && game.phase !== 'turn' && <span className="thinking">…</span>}
      </div>
      <div className="badges">
        {p.seat === room.hostSeat && <span className="badge">{t('房主')}</span>}
        {p.isAI && <span className="badge ai">AI</span>}
        {p.aiControlled && <span className="badge ai">{t('AI 代打')}</span>}
        {p.autoPlay && !p.aiControlled && <span className="badge ai">{t('自動')}</span>}
        {!p.connected && !p.isAI && <span className="badge warn">{p.left ? t('已離開') : t('離線')}</span>}
        {game.phase === 'passThree' && game.passThreeDone[p.seat] && <span className="badge">{t('已選')}</span>}
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
    if (p.tsumo) buttons.push(<ReqButton key="tsumo" className="call win" run={() => act({ type: 'tsumo' })}>{winLabel(t('自摸'), p.winScore)}</ReqButton>);
    for (const k of p.ankan ?? []) buttons.push(<ReqButton key={'an' + k} className="call kan" run={() => act({ type: 'ankan', kind: k })}>{tn('暗槓 {tile}', { tile: <Tile kind={k} small /> })}</ReqButton>);
    for (const k of p.kakan ?? []) buttons.push(<ReqButton key={'ka' + k} className="call kan" run={() => act({ type: 'kakan', kind: k })}>{tn('加槓 {tile}', { tile: <Tile kind={k} small /> })}</ReqButton>);
    // 自動摸打遇到能槓時會停下來問：不槓就照常摸切
    if (game.auto.on && buttons.length && game.myDrawn !== null) {
      buttons.push(<ReqButton key="nokan" className="call skip" run={() => act({ type: 'discard', tile: game.myDrawn! })}>{t('不槓（摸切）')}</ReqButton>);
    }
  } else {
    if (p.ron) buttons.push(<ReqButton key="ron" className="call win" run={() => act({ type: 'ron' })}>{winLabel(p.kind === 'chankan' ? t('搶槓') : t('和'), p.winScore)}</ReqButton>);
    // 不鳴牌：只剩和與略過
    if (!game.auto.noCall && p.minkan) buttons.push(<ReqButton key="kan" className="call kan" run={() => act({ type: 'minkan' })}>{t('槓')}</ReqButton>);
    if (!game.auto.noCall && p.pon) buttons.push(<ReqButton key="pon" className="call pon" run={() => act({ type: 'pon' })}>{t('碰')}</ReqButton>);
    for (const c of game.auto.noCall ? [] : p.chi ?? []) {
      buttons.push(
        <ReqButton key={'chi' + c.join()} className="call chi" run={() => act({ type: 'chi', tiles: c })}>
          {tn('吃 {tiles}', {
            tiles: (
              <>
                <Tile tile={c[0]} small />
                <Tile tile={c[1]} small />
              </>
            ),
          })}
        </ReqButton>,
      );
    }
    buttons.push(<ReqButton key="pass" className="call skip" run={() => act({ type: 'pass' })}>{t('略過')}</ReqButton>);
  }
  if (!buttons.length) return null;
  return <div className="call-overlay">{buttons}</div>;
}

/** 自摸／和按鈕：現在和的分數，下面一行是牌型 */
function winLabel(label: string, score: WinScoreView | undefined) {
  if (!score) return label;
  return (
    <>
      <span className="call-main">
        {label}
        <span className="call-score">{t('{n} 分', { n: score.total })}</span>
      </span>
      {/* 牌型太長時最多兩行（完整的在手牌上方的聽牌列表） */}
      <span className="call-yaku" title={yakuText(score.yaku)}>
        {yakuText(score.yaku)}
      </span>
    </>
  );
}

const yakuText = (yaku: { name: string; count: number }[]) => yaku.map((y) => (y.count > 1 ? `${t(y.name)}×${y.count}` : t(y.name))).join(t('・'));

interface WaitRow {
  kind: TileKind;
  left: number;
  tsumo: HandScore | null;
  ron: HandScore | null;
}

/** 手牌（13 張減鳴牌）聽的每一張牌：自摸與銃和各自的和牌（不含偶然類） */
function waitRows(room: RoomView, game: GameView, concealed: TileKind[], waits: TileKind[]): WaitRow[] {
  const me = room.players[room.mySeat!];
  const { visible } = recommendInput(room, game);
  const score = (w: TileKind, tsumo: boolean) =>
    evaluateWin({
      concealed: [...concealed, w],
      melds: me.melds,
      winTile: w,
      tsumo,
      seatWind: me.wind ?? 27,
      advanced: room.settings.advanced,
      baseScore: baseScoreFor(room.settings, me.seat),
      expansion: room.settings.expansion,
    });
  return waits.map((k) => ({ kind: k, left: Math.max(0, 4 - visible[k]), tsumo: score(k, true), ron: score(k, false) }));
}

/** 聽的每一張牌：剩幾張、和了幾分（自摸與銃和不同時分開寫）、牌型；未達和牌最低分數的標明 */
function WaitList({ rows, min }: { rows: WaitRow[]; min: number }) {
  return (
    <ul>
      {rows.map((r) => {
        const best = r.tsumo && (!r.ron || r.tsumo.total >= r.ron.total) ? r.tsumo : r.ron;
        const ok = (s: HandScore | null) => !!s && s.total >= min;
        return (
          <li key={r.kind} className={r.left === 0 || !ok(best) ? 'none' : ''}>
            <span className="wait">
              <Tile kind={r.kind} small />
              <span className="left">×{r.left}</span>
            </span>
            {best ? (
              <>
                <span className="wait-score">
                  {r.tsumo && r.ron && r.tsumo.total !== r.ron.total
                    ? t('自摸 {a}・銃和 {b} 分', { a: r.tsumo.total, b: r.ron.total })
                    : t('{n} 分', { n: best.total })}
                </span>
                <span className="yaku-names">
                  {yakuText(best.yaku)}
                  {!ok(best) ? t('（未達和牌最低分數，不能和）') : !ok(r.ron) ? t('（銃和未達和牌最低分數，只能自摸）') : ''}
                </span>
              </>
            ) : (
              <span className="yaku-names">{t('不能和')}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 聽牌時：每張聽的牌各自和了幾分（上面一行是全部聽牌的分數範圍） */
function Waits({ room, game }: { room: RoomView; game: GameView }) {
  const me = room.players[room.mySeat!];
  const rows = useMemo(
    () => waitRows(room, game, game.myHand.map(kindOf), game.myWaits.map((w) => w.kind)),
    [game.myHand, game.myWaits, me.melds, me.wind, room.settings, room.players],
  );
  const score = game.myWaitScore;
  return (
    <div className="discard-waits">
      <div>
        {t('聽牌：')}
        {/* 預計和牌分數（所有聽的牌、自摸或銃和；不含偶然類），最高與最低相同時只寫一個 */}
        <span className="wait-score">
          {score ? (score.min === score.max ? t('預計 {n} 分', { n: score.max }) : t('預計 {min}～{max} 分', { min: score.min, max: score.max })) : t('未達和牌最低分數，不能和')}
        </span>
      </div>
      <WaitList rows={rows} min={room.settings.minWinScore} />
    </div>
  );
}

/**
 * 點選（或指著）手牌時：打出這張後聽的每一張牌各自能和成什麼（牌型與和牌分數，自摸或銃和取高、不含偶然類），
 * 例如聽四、七筒，但只有四筒有一氣通貫，就分開列出。剩餘張數只扣自己看得到的牌。
 */
function DiscardWaits({ room, game, discard, waits }: { room: RoomView; game: GameView; discard: TileKind; waits: TileKind[] }) {
  const me = room.players[room.mySeat!];
  const rows = useMemo(() => {
    const concealed = game.myHand.map(kindOf);
    concealed.splice(concealed.indexOf(discard), 1);
    return waitRows(room, game, concealed, waits);
  }, [game.myHand, discard, waits, me.melds, me.wind, room.settings, room.players]);
  return (
    <div className="discard-waits">
      <div>
        {tn('打出 {tile} 後聽：', { tile: <Tile kind={discard} small /> })}
      </div>
      <WaitList rows={rows} min={room.settings.minWinScore} />
    </div>
  );
}

/** 牌型表（預設只列出這桌適用的牌型） */
function YakuModal({ room, onClose }: { room: RoomView; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal yaku-modal">
        <div className="reco-head">
          <h2>{t('牌型表')}</h2>
          <button className="link" onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
        <YakuTable advanced={room.settings.advanced} expansion={room.settings.expansion} defaultShowAll={false} />
      </div>
    </div>
  );
}

/** ⚙ 選單（右上角）：較少用的設定（牌型表、語音設定、電腦難度、語言、全螢幕、離開） */
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
      <button className={`chip-btn ${open ? 'on' : ''}`} aria-expanded={open} aria-label={t('更多設定')} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
          />
        </svg>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {game.solo && !game.aiPlay && game.phase !== 'result' && (
            <ReqButton title={t('自己的座位交給電腦照正常速度打，下一局也繼續，隨時可以改回自己打')} run={() => (setOpen(false), request({ t: 'setAIPlay', on: true }))}>
              {t('電腦代打')}
            </ReqButton>
          )}
          <button onClick={() => (setShowYaku(true), setOpen(false))}>{t('牌型表')}</button>
          {voice.active && <button onClick={() => (setShowVoice(true), setOpen(false))}>{t('語音設定')}</button>}
          {room.players.some((p) => p.isAI || p.aiControlled) && (
            <label className="toggle">
              {t('電腦')}
              <AILevelSelect value={room.settings.aiLevel} disabled={room.mySeat !== room.hostSeat} onChange={(level) => send({ t: 'setAILevel', level })} />
            </label>
          )}
          <LangSelect />
          {canFullscreen && (
            <button onClick={() => (fs ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {})}>
              {fs ? t('離開全螢幕') : t('全螢幕')}
            </button>
          )}
          <ReqButton className="danger" run={() => confirm(t('牌局進行中離開，牌局會暫停並由房主決定是否交給 AI。確定離開？')) && request({ t: 'leaveRoom' })}>
            {t('離開牌局')}
          </ReqButton>
        </div>
      )}
      {showVoice && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setShowVoice(false)}>
          <div className="modal voice-modal">
            <div className="reco-head">
              <h2>{t('語音設定')}</h2>
              <button className="link" onClick={() => setShowVoice(false)} aria-label={t('關閉')}>✕</button>
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
 * top = 提示列（聽牌、打出後聽…）、hand = 手牌、tools = 工具列、menu = ⚙ 選單（放在右上）、boardOverlay = 疊在牌桌上的換三張選牌區。
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
  // 打牌送出後等伺服器回覆：「打出」按鈕轉圈圈，期間點牌沒有作用
  const discarding = useRequest();
  const discard = (tile: TileId) =>
    void discarding.run(async () => {
      await act({ type: 'discard', tile });
      setSelected([]);
    });

  const onTile = (t: TileId) => {
    if (!p || discarding.busy) return;
    if (passing) {
      // 候選格滿了再點別張：最早選的那張回到手牌
      setSelected((cur) => [...cur, t].slice(-3));
      setHover(null);
      return;
    }
    if (p.kind !== 'turn') return;
    if (selected[0] === t) discard(t);
    else setSelected([t]);
  };
  const clickable = !!p && (p.kind === 'turn' || passing);
  const setAuto = (patch: Partial<GameView['auto']>) => request({ t: 'setAuto', ...game.auto, ...patch });
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
        {shownHint && pointKind !== null ? (
          <DiscardWaits room={room} game={game} discard={pointKind} waits={shownHint} />
        ) : game.phase === 'passReveal' ? (
          game.solo ? (
            game.passReceived ? t('收到換來的 3 張牌，按「放進手牌」繼續') : t('這次沒有換到牌')
          ) : game.passReceived ? (
            t('收到換來的 3 張牌，倒數結束後放進手牌')
          ) : (
            t('這次沒有換到牌')
          )
        ) : game.myWaits.length > 0 ? (
          <Waits room={room} game={game} />
        ) : p?.kind === 'turn' ? (
          t('點選一張牌，再按「打出」或再點一次')
        ) : passing ? (
          t('點手牌把要換出的牌放進候選格，點候選格可以放回手牌')
        ) : (
          ''
        )}
      </div>
      {game.thinkAvailable && (
        <ReqButton className="chip-btn think" run={() => request({ t: 'think' })} title={t('這一局只能用一次')}>
          {t('長考 +60 秒')}
        </ReqButton>
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
          <MeldView key={i} meld={m} seat={me.seat} n={room.players.length} pointKind={pointKind} />
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

  // 電腦代打中：自動功能用不到，工具列只留標示、改回自己打與語音
  const tools = game.aiPlay ? (
    <div className="my-tools">
      <span className="badge ai">{t('電腦代打中')}</span>
      <ReqButton className="chip-btn on" run={() => request({ t: 'setAIPlay', on: false })}>
        {t('改回自己打')}
      </ReqButton>
      <VoiceButtons />
    </div>
  ) : (
    <div className="my-tools">
      <button className={`chip-btn ${showReco ? 'on' : ''}`} onClick={toggleReco} aria-pressed={showReco}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2Zm-2 18h4v1a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1Z" />
        </svg>
        {t('推薦')}
      </button>
      <ReqButton className={`chip-btn ${game.auto.win ? 'on' : ''}`} aria-pressed={game.auto.win} run={() => setAuto({ win: !game.auto.win })}>
        {t('自動和')}
      </ReqButton>
      <ReqButton className={`chip-btn ${game.auto.on ? 'on' : ''}`} aria-pressed={game.auto.on} title={t('只維持這一局，下一局自動關閉')} run={() => setAuto({ on: !game.auto.on })}>
        {t('自動打')}
      </ReqButton>
      <ReqButton className={`chip-btn ${game.auto.noCall ? 'on' : ''}`} aria-pressed={game.auto.noCall} title={t('別人打牌時不吃碰槓（自動略過，能和時仍會問你）；持續有效')} run={() => setAuto({ noCall: !game.auto.noCall })}>
        {t('不鳴牌')}
      </ReqButton>
      <VoiceButtons />
    </div>
  );
  const menu = <ToolsMenu room={room} game={game} setAuto={setAuto} />;

  // 換三張：候選格疊在牌桌下緣（手牌正上方），點候選格把牌放回手牌
  const boardOverlay = passing ? (
    <div className="pass-overlay">
      <div className="pass-slots">
        {[0, 1, 2].map((i) =>
          selected[i] !== undefined ? (
            <button key={selected[i]} className="pass-slot filled" title={t('放回手牌')} onClick={() => setSelected((cur) => cur.filter((x) => x !== selected[i]))}>
              <Tile tile={selected[i]} />
            </button>
          ) : (
            <span key={'empty' + i} className="pass-slot" />
          ),
        )}
      </div>
      <div className="pass-actions">
        <ReqButton className="call pon" disabled={selected.length !== 3} run={async () => (await act({ type: 'passThree', tiles: selected }), setSelected([]))}>
          {t('換出')}
        </ReqButton>
        <ReqButton className="call skip" run={async () => (await act({ type: 'passThree', tiles: null }), setSelected([]))}>
          {t('不換')}
        </ReqButton>
      </div>
    </div>
  ) : null;

  // 「打出」固定在牌桌下緣的操作區（和自摸、暗槓同一排），不跟著選中的牌移動
  const toDiscard = p?.kind === 'turn' && selected.length === 1 && game.myHand.includes(selected[0]) ? selected[0] : null;
  const discardButton =
    toDiscard !== null ? (
      <button key="discard" className={`call discard ${discarding.busy ? 'busy' : ''}`} aria-busy={discarding.busy || undefined} onClick={() => discard(toDiscard)}>
        {tn('打出 {tile}', { tile: <Tile tile={toDiscard} small /> })}
        {discarding.busy && <BusyVeil />}
      </button>
    ) : null;

  return { top, hand: handEl, tools, menu, boardOverlay, melds: meldsEl, discardButton };
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
            <span className="label">{t('換出')}</span>
            {game.passSent.map((t) => (
              <Tile key={t} tile={t} />
            ))}
          </div>
          <div className="swap-arrow">▼</div>
          <div className="swap-row">
            <span className="label">{t('收到')}</span>
            {game.passReceived.map((t, i) => (
              <span key={t} className="flip" style={{ animationDelay: `${0.3 + i * 0.25}s` }}>
                <Tile back />
                <Tile tile={t} highlight />
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="label">{t('這次沒有換到牌')}</div>
      )}
      {remain !== null && (
        <div className="swap-count" key={remain}>
          {remain > 0 ? remain : ''}
        </div>
      )}
      {/* 單人對 AI：不倒數，自己按（電腦代打、自動摸打時伺服器會自動繼續） */}
      {game.solo && remain === null && !game.aiPlay && !game.fastFinish && !game.auto.on && (
        <ReqButton className="primary" run={() => request({ t: 'passRevealDone' })}>
          {game.passReceived ? t('放進手牌') : t('繼續')}
        </ReqButton>
      )}
    </div>
  );
}

/** 換三張紀錄：亮牌結束後整局顯示在牌桌下緣（自己的河下方） */
function SwapMini({ game }: { game: GameView }) {
  if (!game.passSent || !game.passReceived) return null;
  return (
    <div className="swap-mini">
      <span className="label">{t('換出')}</span>
      {game.passSent.map((t) => (
        <Tile key={t} tile={t} dim />
      ))}
      <span className="label">{t('收到')}</span>
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
    expansion: room.settings.expansion,
  };
}

/** 直式資訊卡「提示」分頁的補充：現在輪到誰，以及沒聽牌時的牌效率 */
function HintExtras({ room, game }: { room: RoomView; game: GameView }) {
  const me = room.mySeat!;
  const fast = useMemo(() => fastestWin(recommendInput(room, game)), [game.myHand, room.players, room.settings.advanced]);
  const who = (s: number) => (s === me ? t('你') : playerName(room.players[s]));
  const status =
    game.phase === 'passThree'
      ? t('換三張：大家選牌中')
      : game.phase === 'passReveal'
        ? t('換三張：亮牌中')
        : game.phase === 'claim' || game.phase === 'chankan'
          ? game.pending
            ? t('可以鳴牌：吃、碰、槓或和')
            : t('等待 {names} 決定是否鳴牌', { names: game.waitingSeats.map(who).join(t('、')) })
          : game.phase === 'turn'
            ? game.currentSeat === me
              ? t('輪到你打牌')
              : t('輪到 {name} 打牌', { name: who(game.currentSeat) })
            : '';
  return (
    <div className="hint-extras">
      {status && <div className="hint-status">{status}</div>}
      {game.myWaits.length === 0 && game.phase !== 'passThree' && game.phase !== 'passReveal' && Number.isFinite(fast.shanten) && (
        <div className="hint-eff">
          {t('牌效率：{shanten}・有效牌 {n} 張', { shanten: shantenText(fast.shanten), n: fast.ukeire })}
          {fast.discard !== undefined && tn('，建議打 {tile}', { tile: <Tile kind={fast.discard} small /> })}
        </div>
      )}
    </div>
  );
}

const shantenText = (s: number) => (s < 0 ? t('已成形') : s === 0 ? t('聽牌') : t('向聽 {n}', { n: s }));

type RecoMode = 'basic' | 'outcome';
const RECO_MODE_KEY = 'recoMode';

function RecoPanel({ room, game, mode, onClose }: { room: RoomView; game: GameView; mode: 'beside' | 'card'; onClose: () => void }) {
  // 普通型：一次看一個牌型；進階型：結果導向，以最後和牌的分數比較（記在瀏覽器）
  const [recoMode, setRecoMode] = useState<RecoMode>(() => {
    try {
      return localStorage.getItem(RECO_MODE_KEY) === 'outcome' ? 'outcome' : 'basic';
    } catch {
      return 'basic';
    }
  });
  const pick = (m: RecoMode) => {
    setRecoMode(m);
    try {
      localStorage.setItem(RECO_MODE_KEY, m);
    } catch {
      // 無法儲存時只在這次有效
    }
  };
  return (
    <aside className={`reco-panel ${mode}`}>
      {mode === 'beside' && (
        <div className="reco-head">
          <strong>{t('推薦牌型')}</strong>
          <button className="link" onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
      )}
      <div className="reco-mode" role="tablist">
        <button role="tab" aria-selected={recoMode === 'basic'} className={recoMode === 'basic' ? 'on' : ''} onClick={() => pick('basic')}>
          {t('普通型')}
        </button>
        <button role="tab" aria-selected={recoMode === 'outcome'} className={recoMode === 'outcome' ? 'on' : ''} onClick={() => pick('outcome')}>
          {t('進階型')}
        </button>
      </div>
      {recoMode === 'basic' ? <BasicReco room={room} game={game} /> : <OutcomeReco room={room} game={game} />}
    </aside>
  );
}

/** 普通型列出的牌型：和牌率至少要有這麼多 */
const MIN_SHOWN_RATE = 0.01;

/** 怎麼湊：打出的牌（劃掉）→ 要的牌；要的牌太多時只列前幾種 */
function DrawPlan({ discard, wanted, ukeire, max = 9 }: { discard?: TileKind; wanted: TileKind[]; ukeire?: number; max?: number }) {
  if (discard === undefined && !wanted.length) return null;
  return (
    <div className="reco-plan draw-plan">
      {discard !== undefined && (
        <span className="reco-out" title={t('打')}>
          <Tile kind={discard} small />
        </span>
      )}
      {discard !== undefined && wanted.length > 0 && <span className="reco-arrow" aria-hidden="true">→</span>}
      <span className="reco-want" title={ukeire !== undefined ? t('有效牌 {n} 張', { n: ukeire }) : undefined}>
        {wanted.slice(0, max).map((k) => (
          <Tile key={k} kind={k} small />
        ))}
        {wanted.length > max && <span className="reco-more">+{wanted.length - max}</span>}
      </span>
    </div>
  );
}

/** 普通型：各牌型「打什麼 → 要什麼」，加上向聽數、分數與和牌率 */
function BasicReco({ room, game }: { room: RoomView; game: GameView }) {
  const me = room.players[room.mySeat!];
  const { recs, fast } = useMemo(() => {
    const input = recommendInput(room, game);
    // 和牌率太低（還差很遠）的牌型不列出
    return { recs: recommendYaku(input).filter((r) => r.winRate >= MIN_SHOWN_RATE), fast: fastestWin(input) };
  }, [game.myHand, room.players, me.melds, me.wind, room.settings, game.wallRemaining]);
  return (
    <>
      <div className="reco-row reco-fast">
        <div className="reco-title">
          <span>
            {t('最快和牌')}
            <span className="reco-tag">{shantenText(fast.shanten)}</span>
          </span>
        </div>
        <DrawPlan discard={fast.discard} wanted={fast.wanted} ukeire={fast.ukeire} />
      </div>
      {recs.length === 0 && <p className="muted small">{room.settings.minWinScore > 0 ? t('目前沒有推薦（已排除未達和牌最低分數的牌型）') : t('目前沒有推薦')}</p>}
      <ol className="reco-list">
        {recs.map((r) => (
          <li key={r.id} className="reco-row">
            <div className="reco-title">
              <span>
                {t(r.name)}
                <span className="reco-tag">{shantenText(r.shanten)}</span>
                {!r.callable && <span className="reco-tag">{t('門清')}</span>}
              </span>
              <span className="pts">
                {t('{n} 分', { n: r.points })}
                <span className="reco-rate">{percent(r.winRate)}%</span>
              </span>
            </div>
            <DrawPlan discard={r.discard} wanted={r.wanted} ukeire={r.ukeire} />
          </li>
        ))}
      </ol>
      <details className="reco-note">
        <summary>{t('說明')}</summary>
        {t('依手牌與河裡看得到的牌估計有效牌、和牌率與期望值（和牌率 × 分數）。一定要拿到特定牌的牌型（番牌、三元、一氣通貫、三色同順、暗刻、七對子、五門齊等）以那幾張牌拿得到的機率計算；已經沒有剩牌或和牌率不到 1% 的牌型不列出。僅供參考。')}
      </details>
    </>
  );
}

/** 進階型：往下展開摸牌、碰、吃到和牌，比較每種打法的和牌率與期望得分 */
function OutcomeReco({ room, game }: { room: RoomView; game: GameView }) {
  const me = room.players[room.mySeat!];
  // 別人剛打出、自己可以碰／吃的牌：一起比較鳴與不鳴
  const p = game.pending;
  const claim =
    p?.kind === 'claim' && game.recentDiscard && !game.auto.noCall && (p.pon || p.chi?.length)
      ? { tile: kindOf(game.recentDiscard.tile), pon: !!p.pon, chi: (p.chi ?? []).map((pair) => pair.map(kindOf)) }
      : undefined;
  const claimKey = claim ? `${claim.tile}:${claim.pon}:${claim.chi.join('/')}` : '';
  // 計算可能要幾百毫秒：先把畫面畫出來再算，算好之前保留上一次的結果
  const [r, setR] = useState<OutcomeResult | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setR(outcomeRecommend({ ...recommendInput(room, game), claim })), 0);
    return () => clearTimeout(timer);
  }, [game.myHand, room.players, me.melds, me.wind, room.settings, game.wallRemaining, claimKey]);
  if (!r) return <p className="muted small">{t('計算中…')}</p>;
  if (r.tooFar) {
    return <p className="muted small">{t('目前 {n} 向聽。進階型只計算 {max} 向聽以內（再遠變化太多），請先參考普通型。', { n: r.shanten, max: OUTCOME_MAX_SHANTEN })}</p>;
  }
  if (r.shanten < 0) return <p className="muted small">{t('已經是和牌形。')}</p>;
  if (!r.plans.length) return <p className="muted small">{t('照目前的牌，沒有能達到和牌最低分數的和法。')}</p>;
  const viaLabel = (g: OutcomeGroup, plan: OutcomePlan) =>
    g.via === 'win' ? t('聽') : g.via === 'pon' ? t('碰') : g.via === 'chi' ? t('吃') : plan.shanten === 0 ? t('摸到改聽') : t('再進');
  return (
    <>
      {r.plans.map((plan, i) => (
        <section key={i} className="outcome-plan">
          <div className="reco-title">
            <span className="reco-plan">
              {plan.call && (
                <>
                  <span className="reco-tag">{plan.call.type === 'pon' ? t('碰') : t('吃')}</span>
                  {plan.call.kinds.map((k, j) => (
                    <Tile key={j} kind={k} small />
                  ))}
                </>
              )}
              {!plan.call && claim && <span className="reco-tag">{t('不鳴')}</span>}
              {plan.discard !== undefined && (
                <span className="reco-out" title={t('打')}>
                  <Tile kind={plan.discard} small />
                </span>
              )}
              <span className="reco-tag">{shantenText(plan.shanten)}</span>
            </span>
            <span className="pts">
              {t('期望 {ev} 分', { ev: plan.ev.toFixed(1) })}
              <span className="reco-rate">{percent(plan.winRate)}%</span>
            </span>
          </div>
          <ol className="reco-list">
            {plan.groups.slice(0, 6).map((g) => (
              <li key={g.via + g.draws.join()} className="reco-row">
                <div className="reco-title">
                  <span className="reco-plan">
                    <span className="reco-tag">{viaLabel(g, plan)}</span>
                    {g.draws.map((k) => (
                      <Tile key={k} kind={k} small />
                    ))}
                    <span className="reco-more">{t('剩 {n} 張', { n: g.left })}</span>
                  </span>
                  <span className="pts">
                    {t('{n} 分', { n: g.total })}
                    <span className="reco-rate">{percent(g.rate)}%</span>
                  </span>
                </div>
                <div className="reco-yaku">{g.yaku.map((y) => (y.includes('×') ? y.replace(/^(.*)×/, (_, n) => `${t(n)}×`) : t(y))).join(t('・'))}</div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <details className="reco-note">
        <summary>{t('說明')}</summary>
        {t('往下展開摸牌、碰、吃到和牌，依剩下的巡數估計每種打法的和牌率與期望得分（和牌分數 × 機率；自摸、銃和分開計分，不含偶然類），依期望得分排序。每一組是第一張拿到的牌與最可能的和法，百分比是經由這組牌和牌的機率；聽牌時也會考慮摸到某張後改聽。看不到剩的牌與未達和牌最低分數的和法不算。')}
      </details>
    </>
  );
}

/** 機率顯示為百分比：小於 10% 時留一位小數 */
const percent = (p: number) => (p < 0.1 ? (Math.round(p * 1000) / 10).toString() : Math.round(p * 100).toString());

/** 牌桌中央：只放剛打出（或加槓）的牌與餘牌張數；局數與倒數在上方（直式）或右上（橫式） */
function Center({ room, game }: { room: RoomView; game: GameView }) {
  const recent = game.kakanTile ?? game.recentDiscard;
  return (
    <div className="center">
      <div className="center-info">
        <div className="wall-left">
          {tn('餘 {n} 張', { n: <b>{Math.max(0, game.wallRemaining - game.deadWall)}</b> })}
        </div>
        {recent && (
          // 剛打出（或加槓）的牌放大顯示，鳴牌時才知道是哪一張
          <div className={`recent ${game.phase === 'claim' || game.phase === 'chankan' ? 'claiming' : ''}`}>
            <span className="small">
              {t(game.kakanTile ? '{name} 加槓' : '{name} 打出', { name: playerName(room.players[recent.seat]) })}
            </span>
            <Tile tile={recent.tile} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 手牌一排；extra 是和牌的那張（或聽牌最高分的那張），與手牌隔開並標亮 */
function HandRow({ hand, melds, seat, n, extra }: { hand: TileId[]; melds: Meld[]; seat: number; n: number; extra?: { tile?: TileId; kind?: TileKind } }) {
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
        <MeldView key={i} meld={m} seat={seat} n={n} small />
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
          {tn('和牌底分 {n}', { n: <b>{score.baseScore}</b> })}
        </span>
      )}
      {score.yaku.map((y) => (
        <span key={y.id} className="chip">
          {t(y.name)}
          {y.count > 1 ? ` ×${y.count}` : ''} <b>{y.points}</b>
        </span>
      ))}
      <span className="chip total">
        {totalLabel}
        {score.limit ? t('（滿貫）') : ''} <b>{score.total}</b>
      </span>
    </div>
  );
}

function Delta({ d }: { d: number }) {
  return <span className={`delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`}>{d > 0 ? `+${d}` : d}</span>;
}

/** 一局結果的卡片（和牌 → 聽牌 → 其他）與分數表；totals = 這一局結束後的累計分數。牌局中與結束後重看共用 */
export function ResultBody({ room, r, totals, live }: { room: RoomView; r: HandResultView; totals: number[]; live: boolean }) {
  const names = room.players.map((p) => playerName(p));
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
      <h2>{r.kind === 'draw' ? t('流局') : r.winners.map((w) => t(w.tsumo ? '{name} 自摸' : '{name} 和牌', { name: names[w.seat] })).join(t('、'))}</h2>
      {order.map((s) => {
        const w = winnerOf(s);
        const tp = tenpaiOf(s);
        const d = r.deltas[s];
        if (w) {
          return (
            <section key={s} className="result-card win">
              <header>
                <span className="name">{names[s]}</span>
                <span className="tag win">{w.tsumo ? t('自摸') : t('銃和・放銃 {name}', { name: names[w.from!] })}</span>
                <Delta d={d} />
              </header>
              <HandRow hand={r.hands[s].filter((x) => x !== w.tile)} melds={r.melds[s]} seat={s} n={r.melds.length} extra={{ tile: w.tile }} />
              <YakuChips score={w.score} totalLabel={t('和牌分數')} />
            </section>
          );
        }
        if (tp) {
          const capped = d < tp.maxScore && d > 0;
          return (
            <section key={s} className="result-card tenpai">
              <header>
                <span className="name">{names[s]}</span>
                <span className="tag tenpai">{t('聽牌')}</span>
                <Delta d={d} />
              </header>
              <div className="waits-line small">
                {t('聽')}
                {tp.waits.map((k) => (
                  <Tile key={k} kind={k} small highlight={k === tp.best.tile} />
                ))}
              </div>
              <div className="small muted">
                {t(tp.best.tsumo ? '最高分的和法：自摸「{tile}」（聽牌得分依此計算）' : '最高分的和法：銃和「{tile}」（聽牌得分依此計算）', { tile: tileLabel(tp.best.tile) })}
              </div>
              <HandRow hand={r.hands[s]} melds={r.melds[s]} seat={s} n={r.melds.length} extra={{ kind: tp.best.tile }} />
              <YakuChips score={tp.best.score} totalLabel={t('最高和牌分數')} />
              {capped && <div className="small muted">{t('聽牌得分不超過和牌者的得分，實得 {n} 分', { n: d })}</div>}
            </section>
          );
        }
        // 別家的手牌有送來就顯示（單人對 AI 時會公開 AI 的手牌）；自己的手牌在局結束時要按「展示」，重看時一律顯示
        const visible = shown.includes(s) || (r.hands[s].length > 0 && (!live || s !== me));
        return (
          <section key={s} className="result-card other">
            <header>
              <span className="name">{names[s]}</span>
              <span className="tag">{shown.includes(s) ? t('展示手牌') : t('未聽牌')}</span>
              <Delta d={d} />
            </header>
            {visible ? (
              <HandRow hand={r.hands[s]} melds={r.melds[s]} seat={s} n={r.melds.length} />
            ) : s === me && live ? (
              <ReqButton className="show-hand" run={() => request({ t: 'showHand' })}>{t('展示我的手牌')}</ReqButton>
            ) : (
              <div className="small muted">{t('手牌未公開')}</div>
            )}
          </section>
        );
      })}
      <table className="deltas">
        <tbody>
          {room.players.map((p) => (
            <tr key={p.seat}>
              <td>{playerName(p)}</td>
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
            <p className="muted small">
              {t('觀戰中：等待玩家進入下一局')}
              {remain !== null ? `（${remain}）` : ''}
            </p>
          ) : (
            <ReqButton className="primary" disabled={acked} run={() => request({ t: 'nextHand' })}>
              {acked ? t('等待其他玩家…') : game.handNo >= game.totalHands ? t('查看結算') : t('下一局')}
              {remain !== null ? `（${remain}）` : ''}
            </ReqButton>
          )}
          <ExportButton
            render={() => renderHandResult(room, { handNo: game.handNo, totalHands: game.totalHands, result: r, totals })}
            filename={`mahjong-${room.id}-hand${game.handNo}.png`}
          />
        </div>
      </div>
    </div>
  );
}

function PauseOverlay({ room }: { room: RoomView }) {
  const paused = room.paused!;
  const names = paused.disconnectedSeats.map((s) => playerName(room.players[s])).join(t('、'));
  const iDecide = paused.deciderSeat === room.mySeat;
  return (
    <div className="modal-backdrop">
      <div className="modal narrow">
        <h2>{t('牌局暫停')}</h2>
        <p>{t('{names} 已斷線或離開。', { names })}</p>
        {iDecide ? (
          <>
            <p>{t('請決定要等待玩家回來、交給 AI 代打，或解散牌局。')}</p>
            <div className="row">
              <ReqButton className="primary" run={() => request({ t: 'decide', choice: 'ai' })}>
                {t('交給 AI 代打')}
              </ReqButton>
              <ReqButton run={() => request({ t: 'decide', choice: 'dissolve' })}>{t('解散牌局')}</ReqButton>
            </div>
          </>
        ) : (
          <p className="muted">
            {t('等待 {name} 決定（玩家回來後會自動繼續）…', { name: paused.deciderSeat !== null ? playerName(room.players[paused.deciderSeat]) : t('玩家') })}
          </p>
        )}
        <ReqButton className="link" run={() => (room.mySeat === null || confirm(t('確定要離開牌局嗎？'))) && request({ t: 'leaveRoom' })}>
          {room.mySeat === null ? t('離開觀戰') : t('離開房間')}
        </ReqButton>
      </div>
    </div>
  );
}

/** 單人對 AI：把這一局交給 AI 瞬間打完（下一局恢復自己打） */
function FastFinish({ game }: { game: GameView }) {
  if (!game.solo || game.phase === 'result') return null;
  if (game.fastFinish) return <span className="badge ai fast-finish">{t('AI 打完中…')}</span>;
  return (
    <ReqButton className="chip-btn fast-finish" run={() => confirm(t('這一局交給 AI 瞬間打完，直接看結果？下一局恢復自己打。')) && request({ t: 'fastFinish' })}>
      {t('交給 AI 打完')}
    </ReqButton>
  );
}

/** 局數與倒數（以及單人對 AI 的「交給 AI 打完」、⚙ 選單）：直式放在最上面一排，橫式放在右上角 */
function TopBar({ game, now, menu, extra }: { game: GameView; now: number; menu?: ReactElement; extra?: ReactElement }) {
  const remain = game.deadline && game.phase !== 'result' ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  return (
    <header className="top-bar">
      {remain !== null && <span className={`top-timer ${remain <= 5 ? 'urgent' : ''}`}>⏱ {remain}</span>}
      {extra}
      <span className="round">{t('第 {n} / {total} 局', { n: game.handNo, total: game.totalHands })}</span>
      {menu}
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
          {game.myWaits.length > 0 ? t('聽牌') : t('提示')}
        </button>
        <button role="tab" aria-selected={current === 'reco'} className={current === 'reco' ? 'on' : ''} onClick={() => setTab('reco')}>
          {t('推薦牌型')}
        </button>
        {hasSwap && (
          <button role="tab" aria-selected={current === 'swap'} className={current === 'swap' ? 'on' : ''} onClick={() => setTab('swap')}>
            {t('換三張')}
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
              <span className="small">{t('換出')}</span>
              {game.passSent!.map((t) => (
                <Tile key={t} tile={t} dim small />
              ))}
            </div>
            <div className="swap-row">
              <span className="small">{t('收到')}</span>
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
export function useLandscape() {
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

/** 回放時正面朝上的手牌（不含剛摸到的牌）與剛摸到的牌 */
export interface FaceUpHand {
  hand: TileId[];
  drawn: TileId | null;
}

export function Board({ room, game, now, pointKind, overlay, discardButton, swapMini = true, view = 0, faceUp }: {
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
  /** 回放：各座位的手牌正面朝上 */
  faceUp?: FaceUpHand[];
}) {
  // 觀戰者沒有座位：以 view 為下方的視角，下方玩家的手牌也以牌背顯示
  const spectating = room.mySeat === null;
  const me = room.mySeat ?? view;
  const n = room.players.length;
  return (
    <div className="board">
      <Center room={room} game={game} />
      <CallOverlay game={game} discardButton={discardButton} />
      {overlay}
      {spectating ? null : game.phase === 'passReveal' ? <SwapReveal game={game} now={now} /> : swapMini && game.phase !== 'passThree' && <SwapMini game={game} />}
      {room.players.map((p) => {
        const pos = positionOf(p.seat, me, n);
        return <Side key={p.seat} p={p} n={n} game={game} pos={pos} pointKind={pointKind} showHand={spectating || pos !== 'bottom'} faceUp={faceUp?.[p.seat]} />;
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
  if (!game) return <div className="panel narrow">{t('準備下一局…')}</div>;
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
            <TopBar game={game} now={now} menu={my.menu} extra={<FastFinish game={game} />} />
            {reco}
            {my.melds && (
              <div className="side-melds">
                <div className="small muted">{t('鳴牌')}</div>
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
      <TopBar game={game} now={now} menu={my.menu} extra={<FastFinish game={game} />} />
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
      <span className="badge spectating">{t('觀戰中')}</span>
      <button className="chip-btn" onClick={() => setView((v) => (v + 1) % n)} title={t('切換坐在下方的玩家')}>
        {t('視角：{name}', { name: playerName(room.players[view]) })}
      </button>
      <button className="chip-btn" onClick={() => setShowYaku(true)}>
        {t('牌型表')}
      </button>
      <LangSelect />
      <ReqButton className="chip-btn" run={() => request({ t: 'leaveRoom' })}>
        {t('離開觀戰')}
      </ReqButton>
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
          <div className="gutter right">
            <TopBar game={game} now={now} />
          </div>
        </div>
        {modals}
      </div>
    );
  }
  return (
    <div className={`table portrait spectator players-${n}`}>
      <TopBar game={game} now={now} />
      <div className="stage">{board}</div>
      {tools}
      {modals}
    </div>
  );
}
