import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type { GameView, HandResultView, PlayerView, RoomView } from '../../shared/protocol.js';
import type { HandScore } from '../../shared/scoring.js';
import { fastestWin, recommendYaku } from '../../shared/recommend.js';
import type { Meld } from '../../shared/rules.js';
import { kindOf, type TileId, type TileKind } from '../../shared/tiles.js';
import { act, send, type AppState } from '../net.js';
import { AILevelSelect } from './Inputs.js';
import { kindLabel, Tile } from './Tile.js';

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

/** 相對於自己的位置：0 = 自己、1 = 下家（右）、2 = 對家（上）、3 = 上家（左） */
function positionOf(seat: number, me: number, n: number): Pos {
  const rel = (seat - me + n) % n;
  if (n === 2) return rel === 0 ? 'bottom' : 'top';
  if (n === 3) return (['bottom', 'right', 'left'] as const)[rel];
  return (['bottom', 'right', 'top', 'left'] as const)[rel];
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

/** 一位玩家在牌桌上的那一側：以「自己在下方」的方向排版，再依位置整層旋轉 */
function Side({ p, game, pos, pointKind }: { p: PlayerView; game: GameView; pos: Pos; pointKind: TileKind | null }) {
  const active = game.currentSeat === p.seat && game.phase === 'turn';
  return (
    <div className={`side pos-${pos}`}>
      <div className={`side-plate ${active ? 'active' : ''}`}>
        <span className="wind">{windLabel(p.wind)}</span>
        <span className="score">{p.score}</span>
      </div>
      <River p={p} lastDiscard={game.lastDiscard} pointKind={pointKind} />
      {pos !== 'bottom' && (
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
      <div className="name">
        {p.nickname}
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

/** 換三張的按鈕（放在手牌上方） */
function ActionBar({ game, selected, setSelected }: { game: GameView; selected: TileId[]; setSelected: (s: TileId[]) => void }) {
  const p = game.pending;
  if (p?.kind !== 'passThree') return <div className="action-bar" />;
  return (
    <div className="action-bar">
      <button className="primary" disabled={selected.length !== 3} onClick={() => (act({ type: 'passThree', tiles: selected }), setSelected([]))}>
        換出這 3 張
      </button>
      <button onClick={() => (act({ type: 'passThree', tiles: null }), setSelected([]))}>不換</button>
    </div>
  );
}

/**
 * 吃碰槓和、自摸、暗槓／加槓：大按鈕疊在牌桌下緣、手牌正上方。
 * 不放正中間：中間顯示著剛打出的牌，碰／吃時需要看得到是哪一張。
 */
function CallOverlay({ game }: { game: GameView }) {
  const p = game.pending;
  if (!p || p.kind === 'passThree') return null;
  const buttons: ReactElement[] = [];
  if (p.kind === 'turn') {
    if (p.tsumo) buttons.push(<button key="tsumo" className="call win" onClick={() => act({ type: 'tsumo' })}>自摸</button>);
    for (const k of p.ankan ?? []) buttons.push(<button key={'an' + k} className="call kan" onClick={() => act({ type: 'ankan', kind: k })}>暗槓 <Tile kind={k} small /></button>);
    for (const k of p.kakan ?? []) buttons.push(<button key={'ka' + k} className="call kan" onClick={() => act({ type: 'kakan', kind: k })}>加槓 <Tile kind={k} small /></button>);
    // 自動摸打遇到能槓時會停下來問：不槓就照常摸切
    if (game.auto.on && buttons.length && game.myDrawn !== null) {
      buttons.push(<button key="nokan" className="call skip" onClick={() => act({ type: 'discard', tile: game.myDrawn! })}>不槓（摸切）</button>);
    }
  } else {
    if (p.ron) buttons.push(<button key="ron" className="call win" onClick={() => act({ type: 'ron' })}>{p.kind === 'chankan' ? '搶槓' : '和'}</button>);
    if (p.minkan) buttons.push(<button key="kan" className="call kan" onClick={() => act({ type: 'minkan' })}>槓</button>);
    if (p.pon) buttons.push(<button key="pon" className="call pon" onClick={() => act({ type: 'pon' })}>碰</button>);
    for (const c of p.chi ?? []) {
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

function Waits({ waits }: { waits: GameView['myWaits'] }) {
  return (
    <>
      聽牌：
      {waits.map((w) => (
        <span key={w.kind} className={`wait ${w.left === 0 ? 'none' : ''}`}>
          <Tile kind={w.kind} small />
          <span className="left">×{w.left}</span>
        </span>
      ))}
    </>
  );
}

function MyArea({ room, game, onPoint, showReco, toggleReco }: {
  room: RoomView;
  game: GameView;
  onPoint: (k: TileKind | null) => void;
  showReco: boolean;
  toggleReco: () => void;
}) {
  const me = room.players[room.mySeat!];
  const [selected, setSelected] = useState<TileId[]>([]);
  const [hover, setHover] = useState<TileKind | null>(null);
  const p = game.pending;
  useEffect(() => setSelected([]), [game.handNo, p?.kind]);
  const hand = game.myHand.filter((t) => t !== game.myDrawn);
  const hints = p?.tenpaiHints ?? {};
  // 指著的牌：滑鼠移到的牌，或（手機）點選中的那一張
  const pointKind = hover ?? (selected.length === 1 ? kindOf(selected[0]) : null);
  useEffect(() => onPoint(pointKind), [pointKind, onPoint]);
  const shownHint = pointKind !== null ? hints[pointKind] : undefined;

  const onTile = (t: TileId) => {
    if (!p) return;
    if (p.kind === 'passThree') {
      // 已選 3 張時再點別張：換掉最早選的那張，不用先取消
      setSelected((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].slice(-3)));
      return;
    }
    if (p.kind !== 'turn') return;
    if (selected[0] === t) {
      act({ type: 'discard', tile: t });
      setSelected([]);
    } else setSelected([t]);
  };
  const clickable = !!p && (p.kind === 'turn' || p.kind === 'passThree');
  const tileProps = (t: TileId) => ({
    tile: t,
    selected: selected.includes(t),
    highlight: !!hints[kindOf(t)] && p?.kind === 'turn',
  });
  const setAuto = (on: boolean, onlyMax: boolean) => send({ t: 'setAuto', on, onlyMax });
  // 點選一張牌後，牌的上方出現「打出」按鈕（手機上比再點一次好按）
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
      <Tile {...tileProps(t)} />
      {p?.kind === 'turn' && selected.length === 1 && selected[0] === t && (
        <button className="discard-btn" onClick={(e) => (e.stopPropagation(), act({ type: 'discard', tile: t }), setSelected([]))}>
          打出
        </button>
      )}
    </span>
  );

  return (
    <div className="my-area">
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
            <Waits waits={game.myWaits} />
          ) : p?.kind === 'turn' ? (
            '點選一張牌，再按「打出」或再點一次'
          ) : p?.kind === 'passThree' ? (
            <span className="pass-tray">
              換出：
              {[0, 1, 2].map((i) =>
                selected[i] !== undefined ? (
                  <span key={selected[i]} className="tray-tile" title="點一下取消" onClick={() => setSelected((cur) => cur.filter((x) => x !== selected[i]))}>
                    <Tile tile={selected[i]} small />
                  </span>
                ) : (
                  <span key={'empty' + i} className="tray-empty" />
                ),
              )}
              <span className="muted small">{selected.length < 3 ? `再選 ${3 - selected.length} 張` : '選好了'}</span>
            </span>
          ) : (
            ''
          )}
        </div>
        <ActionBar game={game} selected={selected} setSelected={setSelected} />
      </div>
      <div className="my-hand" style={{ '--n': hand.length + (game.myDrawn !== null ? 1.5 : 0) } as CSSProperties}>
        {hand.map(tileSlot)}
        {game.myDrawn !== null && (
          <span className="drawn-gap">
            {tileSlot(game.myDrawn)}
          </span>
        )}
        <span className="my-melds">
          {me.melds.map((m, i) => (
            <MeldView key={i} meld={m} />
          ))}
        </span>
      </div>
      <div className="my-tools">
        <button className={`icon-btn ${showReco ? 'on' : ''}`} onClick={toggleReco} title="推薦牌型" aria-pressed={showReco}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2Zm-2 18h4v1a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1Z" />
          </svg>
          推薦牌型
        </button>
        <label className="toggle">
          <input type="checkbox" checked={game.auto.on} onChange={(e) => setAuto(e.target.checked, game.auto.onlyMax)} />
          自動摸打
        </label>
        <label className={`toggle ${game.auto.on ? '' : 'disabled'}`}>
          <input type="checkbox" disabled={!game.auto.on} checked={game.auto.onlyMax} onChange={(e) => setAuto(true, e.target.checked)} />
          只和最高分
        </label>
        {room.players.some((p) => p.isAI || p.aiControlled) && (
          <label className="toggle">
            電腦
            <AILevelSelect value={room.settings.aiLevel} disabled={room.mySeat !== room.hostSeat} onChange={(level) => send({ t: 'setAILevel', level })} />
          </label>
        )}
        <button className="leave link" onClick={() => confirm('牌局進行中離開，牌局會暫停並由房主決定是否交給 AI。確定離開？') && send({ t: 'leaveRoom' })}>
          離開
        </button>
      </div>
    </div>
  );
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

const shantenText = (s: number) => (s < 0 ? '已成形' : s === 0 ? '聽牌' : `向聽 ${s}`);

function RecoPanel({ room, game, mode, onClose }: { room: RoomView; game: GameView; mode: 'beside' | 'below'; onClose: () => void }) {
  const me = room.players[room.mySeat!];
  const { recs, fast } = useMemo(() => {
    // 看得到的牌：自己的手牌、所有人的鳴牌（他人暗槓除外）與還在河裡的捨牌，用來算有效牌還剩幾張
    const visible = new Array(34).fill(0);
    for (const t of game.myHand) visible[kindOf(t)]++;
    for (const p of room.players) {
      for (const m of p.melds) for (const t of m.tiles) if (t >= 0) visible[kindOf(t)]++;
      for (const d of p.discards) if (!d.called) visible[kindOf(d.tile)]++;
    }
    const input = { concealed: game.myHand.map(kindOf), melds: me.melds, seatWind: me.wind ?? 27, advanced: room.settings.advanced, visible };
    return { recs: recommendYaku(input), fast: fastestWin(input) };
  }, [game.myHand, room.players, me.melds, me.wind, room.settings.advanced]);
  return (
    <aside className={`reco-panel ${mode}`}>
      <div className="reco-head">
        <strong>推薦牌型</strong>
        <button className="link" onClick={onClose} aria-label="關閉">✕</button>
      </div>
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
      {recs.length === 0 && <p className="muted small">目前沒有推薦</p>}
      <ol>
        {recs.map((r) => (
          <li key={r.id}>
            <div className="reco-title">
              <span>{r.name}</span>
              <span className="pts">{r.points} 分</span>
            </div>
            <div className="small muted">
              {shantenText(r.shanten)}・有效牌 {r.ukeire} 張
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
      <p className="small muted">依牌效率（向聽數與有效牌）估計，部分牌型為近似值，僅供參考。</p>
    </aside>
  );
}

function Center({ room, game, now }: { room: RoomView; game: GameView; now: number }) {
  const remain = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  const recent = game.kakanTile ?? game.recentDiscard;
  return (
    <div className="center">
      <div className="center-info">
        <div className="round">
          第 {game.handNo} / {game.totalHands} 局・餘 {Math.max(0, game.wallRemaining - game.deadWall)}
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
function YakuTable({ score, totalLabel }: { score: HandScore; totalLabel: string }) {
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

/** 一局的結果：每位玩家一張卡片（和牌 → 聽牌 → 其他），最後是分數表 */
function ResultModal({ room, game, now }: { room: RoomView; game: GameView; now: number }) {
  const r = game.result as HandResultView;
  const names = room.players.map((p) => p.nickname);
  const me = room.mySeat!;
  const acked = r.acknowledged.includes(me);
  const shown = r.shown ?? [];
  const remain = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : null;
  const winnerOf = (s: number) => r.winners.find((w) => w.seat === s);
  const tenpaiOf = (s: number) => (winnerOf(s) ? undefined : r.tenpai.find((t) => t.seat === s));
  const order = [...room.players.map((p) => p.seat)].sort((a, b) => {
    const rank = (s: number) => (winnerOf(s) ? 0 : tenpaiOf(s) ? 1 : 2);
    return rank(a) - rank(b) || a - b;
  });
  return (
    <div className="modal-backdrop">
      <div className="modal result">
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
                <YakuTable score={w.score} totalLabel="和牌分數" />
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
                <YakuTable score={t.best.score} totalLabel="最高和牌分數" />
                {capped && <div className="small muted">聽牌得分不超過和牌者的和牌分數，實得 {d} 分</div>}
              </section>
            );
          }
          const visible = shown.includes(s);
          return (
            <section key={s} className="result-card other">
              <header>
                <span className="name">{names[s]}</span>
                <span className="tag">{visible ? '展示手牌' : '未聽牌'}</span>
                <Delta d={d} />
              </header>
              {visible ? (
                <HandRow hand={r.hands[s]} melds={r.melds[s]} />
              ) : s === me ? (
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
                <td>{p.score + r.deltas[p.seat]}</td>
                <td className="muted small">{r.acknowledged.includes(p.seat) || p.isAI || p.aiControlled ? '✓' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="primary" disabled={acked} onClick={() => send({ t: 'nextHand' })}>
          {acked ? '等待其他玩家…' : game.handNo >= game.totalHands ? '查看結算' : '下一局'}
          {remain !== null ? `（${remain}）` : ''}
        </button>
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
        <button className="link" onClick={() => confirm('確定要離開牌局嗎？') && send({ t: 'leaveRoom' })}>
          離開房間
        </button>
      </div>
    </div>
  );
}

export function TableScreen({ state }: { state: AppState }) {
  const room = state.room!;
  const game = state.game;
  const now = useNow(state.clockOffset);
  const me = room.mySeat!;
  const n = room.players.length;
  const [pointKind, setPointKind] = useState<TileKind | null>(null);
  const [showReco, setShowReco] = useState(false);
  const recoMode = useRecoMode(!!game);
  if (!game) return <div className="panel narrow">準備下一局…</div>;
  return (
    <div className={`table players-${n}`}>
      <div className="board">
        <Center room={room} game={game} now={now} />
        <CallOverlay game={game} />
        {game.phase === 'passReveal' ? <SwapReveal game={game} now={now} /> : game.phase !== 'passThree' && <SwapMini game={game} />}
        {room.players.map((p) => (
          <Side key={p.seat} p={p} game={game} pos={positionOf(p.seat, me, n)} pointKind={pointKind} />
        ))}
        {room.players.map((p) => (
          <NamePlate key={p.seat} p={p} room={room} game={game} pos={positionOf(p.seat, me, n)} />
        ))}
      </div>
      {showReco && recoMode === 'beside' && <RecoPanel room={room} game={game} mode="beside" onClose={() => setShowReco(false)} />}
      <MyArea room={room} game={game} onPoint={setPointKind} showReco={showReco} toggleReco={() => setShowReco((v) => !v)} />
      {showReco && recoMode === 'below' && <RecoPanel room={room} game={game} mode="below" onClose={() => setShowReco(false)} />}
      {game.phase === 'result' && game.result && <ResultModal room={room} game={game} now={now} />}
      {room.paused && <PauseOverlay room={room} />}
    </div>
  );
}

/** 牌桌旁邊放得下推薦面板就放旁邊，否則放在操作列下方（都不會蓋到牌桌與操作按鈕） */
function useRecoMode(hasBoard: boolean): 'beside' | 'below' {
  const [mode, setMode] = useState<'beside' | 'below'>('below');
  useLayoutEffect(() => {
    const update = () => {
      const w = document.querySelector('.board')?.getBoundingClientRect().width ?? window.innerWidth;
      setMode((window.innerWidth - w) / 2 >= 280 ? 'beside' : 'below');
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [hasBoard]);
  return mode;
}
