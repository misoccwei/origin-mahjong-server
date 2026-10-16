import { useEffect, useState } from 'react';
import type { RoomView } from '../../shared/protocol.js';
import type { RuleSettings } from '../../shared/rules.js';
import { fetchReplay, request, send, toast } from '../net.js';
import { anonymizeReplay } from '../../shared/replay.js';
import type { ReplayFile } from '../../shared/replaySchema.js';
import { ReqButton } from './Busy.js';
import { aiLevelLabel, AILevelSelect } from './Inputs.js';
import { LangSelect, SettingsForm } from './Lobby.js';
import { playerName, t, tn } from '../i18n/index.js';
import { VoicePanel } from './Voice.js';
import { ExportButton } from './ExportButton.js';
import { renderFinal, renderHandResult, saveFile } from '../exportImage.js';
import { openReplay } from './Replay.js';
import { ResultBody } from './Table.js';

function rulesSummary(s: RuleSettings) {
  return [
    t('{n} 人', { n: s.playerCount }),
    t('{rounds} 圈（{hands} 局）', { rounds: s.rounds, hands: s.rounds * s.playerCount }),
    s.advanced ? t('進階規則') : t('基本規則'),
    s.expansion && t('牌型擴充包'),
    s.scoring === 'zeroSum' ? t('零和式') : t('加分式'),
    s.minWinScore > 0 && t('最低 {n} 分', { n: s.minWinScore }),
    t('電腦{level}', { level: aiLevelLabel(s.aiLevel) }),
    s.passThree && t('換三張'),
    s.randomSeats && t('隨機座位'),
    s.smallHandLimit && t('小牌限制'),
  ]
    .filter(Boolean)
    .join(t('・'));
}

/** 觀戰者名單 */
function SpectatorList({ room }: { room: RoomView }) {
  if (!room.spectators.length) return null;
  return (
    <p className="muted small">
      {t('觀戰中（{n}）：', { n: room.spectators.length })}
      {room.spectators.map((s) => s.nickname).join(t('、'))}
    </p>
  );
}

export function WaitingRoom({ room }: { room: RoomView }) {
  const me = room.mySeat;
  const spectating = me === null;
  const isHost = me === room.hostSeat;
  const [draft, setDraft] = useState(room.settings);
  useEffect(() => setDraft(room.settings), [room.settings]);
  const myReady = me !== null && room.players[me]?.ready;
  const full = room.players.every((p) => p.nickname);
  const othersReady = room.players.every((p) => p.seat === room.hostSeat || p.isAI || (p.ready && p.connected));

  return (
    <div className="lobby">
      <div className="panel">
        <h2>
          {tn('房號 {id}', { id: <span className="room-code">{room.id}</span> })}
          <button
            className="link"
            onClick={() => {
              navigator.clipboard?.writeText(room.id).then(() => toast(t('已複製房號')));
            }}
          >
            {t('複製')}
          </button>
        </h2>
        <p className="muted">{rulesSummary(room.settings)}</p>
        {spectating && <p className="spectating-note">{full ? t('你正在觀戰') : t('你正在觀戰，有空位時可以按「入座」加入牌局')}</p>}
        <ul className="seats">
          {room.players.map((p) => (
            <li key={p.seat} className={p.nickname ? '' : 'empty'}>
              <span className="seat-no">{p.seat + 1}</span>
              {p.nickname ? (
                <>
                  <span className="name">
                    {playerName(p)}
                    {p.seat === room.hostSeat && <span className="badge">{t('房主')}</span>}
                    {p.isAI && <span className="badge ai">AI</span>}
                    {!p.connected && <span className="badge warn">{t('離線')}</span>}
                  </span>
                  {p.seat !== room.hostSeat && <span className={p.ready ? 'ready yes' : 'ready'}>{p.ready ? t('已準備') : t('未準備')}</span>}
                  {isHost && p.seat !== me && (
                    <ReqButton className="link" run={() => request({ t: 'removeSeat', seat: p.seat })}>
                      {t('移除')}
                    </ReqButton>
                  )}
                </>
              ) : (
                <span className="muted">{t('等待玩家加入…')}</span>
              )}
            </li>
          ))}
        </ul>
        {/* 固定兩欄的格子：某顆按鈕停用時位置不變，其他按鈕不會跟著移動 */}
        {spectating ? (
          <div className="room-actions">
            <ReqButton className="primary" disabled={full} run={() => request({ t: 'joinRoom', roomId: room.id })} title={full ? t('座位已滿') : undefined}>
              {t('入座')}
            </ReqButton>
            <ReqButton run={() => request({ t: 'leaveRoom' })}>{t('離開觀戰')}</ReqButton>
          </div>
        ) : (
          <div className="room-actions">
            <ReqButton disabled={!isHost || full} run={() => request({ t: 'addAI' })} title={full ? t('座位已滿') : undefined}>
              {t('加入 AI')}
            </ReqButton>
            <label className="inline-field">
              {t('電腦')}
              <AILevelSelect value={room.settings.aiLevel} disabled={!isHost} onChange={(level) => send({ t: 'setAILevel', level })} />
            </label>
            {isHost ? (
              <ReqButton className="primary" disabled={!full || !othersReady} run={() => request({ t: 'start' })}>
                {t('開始')}
              </ReqButton>
            ) : (
              <ReqButton className={myReady ? '' : 'primary'} run={() => request({ t: 'ready', ready: !myReady })}>
                {myReady ? t('取消準備') : t('準備')}
              </ReqButton>
            )}
            <ReqButton run={() => request({ t: 'leaveRoom' })}>{t('離開房間')}</ReqButton>
          </div>
        )}
        <SpectatorList room={room} />
        <VoicePanel room={room} />
        <LangSelect />
        {!spectating && <p className="muted small">{isHost ? t('人數到齊、其他玩家都準備後即可開始。') : t('請按「準備」，由房主開始牌局。')}</p>}
      </div>
      <div className="panel">
        <h2>
          {t('規則設定')}
          {!isHost && <span className="muted small">{t('（僅房主可修改）')}</span>}
        </h2>
        <SettingsForm value={draft} onChange={setDraft} disabled={!isHost} seatNames={room.players.map((p) => (p.nickname ? playerName(p) : null))} showAILevel={false} />
        {isHost && (
          <ReqButton className="primary" disabled={JSON.stringify(draft) === JSON.stringify(room.settings)} run={() => request({ t: 'updateSettings', settings: draft })}>
            {t('套用設定')}
          </ReqButton>
        )}
      </div>
    </div>
  );
}

export function FinalScreen({ room }: { room: RoomView }) {
  const me = room.mySeat;
  const isHost = me === room.hostSeat;
  const ranking = [...room.players].sort((a, b) => b.score - a.score);
  const hasLeft = room.players.some((p) => p.left);
  return (
    <div className="lobby">
      <div className="panel">
        <h2>{room.dissolved ? t('牌局已解散') : t('最終結算')}</h2>
        <ol className="ranking">
          {ranking.map((p, i) => (
            <li key={p.seat} className={p.seat === me ? 'me' : ''}>
              <span className="rank">{i + 1}</span>
              <span className="name">{playerName(p)}</span>
              <span className="score">{p.score}</span>
            </li>
          ))}
        </ol>
        <VoicePanel room={room} />
        <div className="row">
          {isHost && !room.dissolved && <ReqButton className="primary" run={() => request({ t: 'extend' })}>{t('加一圈')}</ReqButton>}
          {isHost && hasLeft && <ReqButton run={() => request({ t: 'addAI' })}>{t('以 AI 補上空位')}</ReqButton>}
          {isHost && <ReqButton run={() => request({ t: 'restart' })}>{t('回到房間重新開始')}</ReqButton>}
          <ExportButton render={() => renderFinal(room)} filename={`mahjong-${room.id}-final.png`} />
          <ReqButton run={() => request({ t: 'leaveRoom' })}>{me === null ? t('離開觀戰') : t('離開房間')}</ReqButton>
        </div>
        <SpectatorList room={room} />
      </div>
      {room.replays.length > 0 && <SaveReplay room={room} />}
      <div className="panel">
        <h2>{t('各局紀錄')}</h2>
        {room.replays.length > 0 && <p className="muted small">{t('點一局可以重看那一局的結果。')}</p>}
        <HistoryTable room={room} />
      </div>
    </div>
  );
}

/** 儲存整場的回放檔（可選匿名），或直接在這裡打開回放頁面 */
function SaveReplay({ room }: { room: RoomView }) {
  const [anonymous, setAnonymous] = useState(false);
  const get = async (): Promise<ReplayFile | null> => {
    const f = await fetchReplay();
    return f && anonymous ? anonymizeReplay(f) : f;
  };
  return (
    <div className="panel">
      <h2>{t('牌局回放')}</h2>
      <p className="muted small">{t('儲存整場牌局的回放檔（包含每一家的手牌），傳給別人後可以在「開啟回放檔」一步一步重看。')}</p>
      <label className="check">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
        {t('匿名（真人玩家的名字改成「玩家 N」）')}
      </label>
      <div className="row">
        <ReqButton
          className="primary"
          run={async () => {
            const f = await get();
            if (!f) return;
            const d = new Date(f.savedAt);
            const pad = (x: number) => String(x).padStart(2, '0');
            const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
            const file = new File([JSON.stringify(f)], `mahjong-replay-${room.id}-${stamp}.json`, { type: 'application/json' });
            try {
              await saveFile(file);
            } catch {
              toast(t('無法儲存回放檔'));
            }
          }}
        >
          {t('儲存回放檔')}
        </ReqButton>
        <ReqButton
          run={async () => {
            const f = await get();
            if (f) openReplay(f);
          }}
        >
          {t('在這裡看回放')}
        </ReqButton>
      </div>
    </div>
  );
}

/** 牌局結束後重看某一局：可以切換上一局／下一局、匯出圖片 */
function ReplayModal({ room, handNo, setHandNo }: { room: RoomView; handNo: number; setHandNo: (n: number | null) => void }) {
  const idx = room.replays.findIndex((x) => x.handNo === handNo);
  const replay = room.replays[idx];
  if (!replay) return null;
  // 這一局結束後的累計分數
  const totals = room.players.map((p) =>
    room.history.filter((h) => h.handNo <= handNo).reduce((a, h) => a + h.deltas[p.seat], 0),
  );
  const total = room.history.length;
  const prev = room.replays[idx - 1];
  const next = room.replays[idx + 1];
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setHandNo(null)}>
      <div className="modal result">
        <div className="reco-head">
          <strong>
            {t('第 {n} / {total} 局', { n: handNo, total })}
          </strong>
          <button className="link" onClick={() => setHandNo(null)} aria-label={t('關閉')}>✕</button>
        </div>
        <ResultBody room={room} r={replay.result} totals={totals} live={false} />
        <div className="result-actions">
          <button disabled={!prev} onClick={() => prev && setHandNo(prev.handNo)}>
            {t('上一局')}
          </button>
          <button disabled={!next} onClick={() => next && setHandNo(next.handNo)}>
            {t('下一局')}
          </button>
          <ExportButton
            render={() => renderHandResult(room, { handNo, totalHands: total, result: replay.result, totals })}
            filename={`mahjong-${room.id}-hand${handNo}.png`}
          />
        </div>
      </div>
    </div>
  );
}

export function HistoryTable({ room }: { room: RoomView }) {
  const names = room.players.map((p) => (p.nickname ? playerName(p) : '-'));
  const [viewing, setViewing] = useState<number | null>(null);
  const canReplay = (handNo: number) => room.replays.some((x) => x.handNo === handNo);
  return (
    <div className="table-scroll">
      {viewing !== null && <ReplayModal room={room} handNo={viewing} setHandNo={setViewing} />}
      <table className="history">
        <thead>
          <tr>
            <th>{t('局')}</th>
            <th>{t('結果')}</th>
            {names.map((n, i) => (
              <th key={i}>{n}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {room.history.map((h) => (
            <tr
              key={h.handNo}
              className={canReplay(h.handNo) ? 'replayable' : ''}
              onClick={canReplay(h.handNo) ? () => setViewing(h.handNo) : undefined}
              title={canReplay(h.handNo) ? t('重看這一局') : undefined}
            >
              <td>{h.handNo}</td>
              <td className="left">
                {h.kind === 'draw'
                  ? t('流局')
                  : h.winners
                      .map((w) =>
                        t(w.tsumo ? '{name} 自摸 {total}分 {yaku}' : '{name} 銃和（{from}） {total}分 {yaku}', {
                          name: names[w.seat],
                          from: names[w.from!] ?? '',
                          total: w.total,
                          yaku: w.yaku.map((y) => t(y)).join(t('・')),
                        }),
                      )
                      .join(' / ')}
              </td>
              {h.deltas.map((d, i) => (
                <td key={i} className={d > 0 ? 'pos' : d < 0 ? 'neg' : ''}>
                  {d > 0 ? `+${d}` : d}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>{t('合計')}</td>
            {room.players.map((p) => (
              <td key={p.seat}>{p.score}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
