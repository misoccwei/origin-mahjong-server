import { useEffect, useState } from 'react';
import type { RoomView } from '../../shared/protocol.js';
import type { RuleSettings } from '../../shared/rules.js';
import { send, toast } from '../net.js';
import { AI_LEVEL_LABEL, AILevelSelect } from './Inputs.js';
import { SettingsForm } from './Lobby.js';
import { VoicePanel } from './Voice.js';
import { ExportButton } from './ExportButton.js';
import { renderFinal, renderHandResult } from '../exportImage.js';
import { ResultBody } from './Table.js';

function rulesSummary(s: RuleSettings) {
  return [
    `${s.playerCount} 人`,
    `${s.rounds} 圈（${s.rounds * s.playerCount} 局）`,
    s.advanced ? '進階規則' : '基本規則',
    s.expansion && '牌型擴充包',
    s.scoring === 'zeroSum' ? '零和式' : '加分式',
    s.minWinScore > 0 && `最低 ${s.minWinScore} 分`,
    `電腦${AI_LEVEL_LABEL[s.aiLevel]}`,
    s.passThree && '換三張',
    s.randomSeats && '隨機座位',
    s.smallHandLimit && '小牌限制',
  ]
    .filter(Boolean)
    .join('・');
}

/** 觀戰者名單 */
function SpectatorList({ room }: { room: RoomView }) {
  if (!room.spectators.length) return null;
  return (
    <p className="muted small">
      觀戰中（{room.spectators.length}）：{room.spectators.map((s) => s.nickname).join('、')}
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
          房號 <span className="room-code">{room.id}</span>
          <button
            className="link"
            onClick={() => {
              navigator.clipboard?.writeText(room.id).then(() => toast('已複製房號'));
            }}
          >
            複製
          </button>
        </h2>
        <p className="muted">{rulesSummary(room.settings)}</p>
        {spectating && <p className="spectating-note">你正在觀戰{full ? '' : '，有空位時可以按「入座」加入牌局'}</p>}
        <ul className="seats">
          {room.players.map((p) => (
            <li key={p.seat} className={p.nickname ? '' : 'empty'}>
              <span className="seat-no">{p.seat + 1}</span>
              {p.nickname ? (
                <>
                  <span className="name">
                    {p.nickname}
                    {p.seat === room.hostSeat && <span className="badge">房主</span>}
                    {p.isAI && <span className="badge ai">AI</span>}
                    {!p.connected && <span className="badge warn">離線</span>}
                  </span>
                  {p.seat !== room.hostSeat && <span className={p.ready ? 'ready yes' : 'ready'}>{p.ready ? '已準備' : '未準備'}</span>}
                  {isHost && p.seat !== me && (
                    <button className="link" onClick={() => send({ t: 'removeSeat', seat: p.seat })}>
                      移除
                    </button>
                  )}
                </>
              ) : (
                <span className="muted">等待玩家加入…</span>
              )}
            </li>
          ))}
        </ul>
        {/* 固定兩欄的格子：某顆按鈕停用時位置不變，其他按鈕不會跟著移動 */}
        {spectating ? (
          <div className="room-actions">
            <button className="primary" disabled={full} onClick={() => send({ t: 'joinRoom', roomId: room.id })} title={full ? '座位已滿' : undefined}>
              入座
            </button>
            <button onClick={() => send({ t: 'leaveRoom' })}>離開觀戰</button>
          </div>
        ) : (
          <div className="room-actions">
            <button disabled={!isHost || full} onClick={() => send({ t: 'addAI' })} title={full ? '座位已滿' : undefined}>
              加入 AI
            </button>
            <label className="inline-field">
              電腦
              <AILevelSelect value={room.settings.aiLevel} disabled={!isHost} onChange={(level) => send({ t: 'setAILevel', level })} />
            </label>
            {isHost ? (
              <button className="primary" disabled={!full || !othersReady} onClick={() => send({ t: 'start' })}>
                開始
              </button>
            ) : (
              <button className={myReady ? '' : 'primary'} onClick={() => send({ t: 'ready', ready: !myReady })}>
                {myReady ? '取消準備' : '準備'}
              </button>
            )}
            <button onClick={() => send({ t: 'leaveRoom' })}>離開房間</button>
          </div>
        )}
        <SpectatorList room={room} />
        <VoicePanel room={room} />
        {!spectating && <p className="muted small">{isHost ? '人數到齊、其他玩家都準備後即可開始。' : '請按「準備」，由房主開始牌局。'}</p>}
      </div>
      <div className="panel">
        <h2>規則設定{!isHost && <span className="muted small">（僅房主可修改）</span>}</h2>
        <SettingsForm value={draft} onChange={setDraft} disabled={!isHost} seatNames={room.players.map((p) => p.nickname)} showAILevel={false} />
        {isHost && (
          <button className="primary" disabled={JSON.stringify(draft) === JSON.stringify(room.settings)} onClick={() => send({ t: 'updateSettings', settings: draft })}>
            套用設定
          </button>
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
        <h2>{room.dissolved ? '牌局已解散' : '最終結算'}</h2>
        <ol className="ranking">
          {ranking.map((p, i) => (
            <li key={p.seat} className={p.seat === me ? 'me' : ''}>
              <span className="rank">{i + 1}</span>
              <span className="name">{p.nickname}</span>
              <span className="score">{p.score}</span>
            </li>
          ))}
        </ol>
        <VoicePanel room={room} />
        <div className="row">
          {isHost && !room.dissolved && <button className="primary" onClick={() => send({ t: 'extend' })}>加一圈</button>}
          {isHost && hasLeft && <button onClick={() => send({ t: 'addAI' })}>以 AI 補上空位</button>}
          {isHost && <button onClick={() => send({ t: 'restart' })}>回到房間重新開始</button>}
          <ExportButton render={() => renderFinal(room)} filename={`原點麻將-${room.id}-結算.png`} />
          <button onClick={() => send({ t: 'leaveRoom' })}>{me === null ? '離開觀戰' : '離開房間'}</button>
        </div>
        <SpectatorList room={room} />
      </div>
      <div className="panel">
        <h2>各局紀錄</h2>
        {room.replays.length > 0 && <p className="muted small">點一局可以重看那一局的結果。</p>}
        <HistoryTable room={room} />
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
            第 {handNo} / {total} 局
          </strong>
          <button className="link" onClick={() => setHandNo(null)} aria-label="關閉">✕</button>
        </div>
        <ResultBody room={room} r={replay.result} totals={totals} live={false} />
        <div className="result-actions">
          <button disabled={!prev} onClick={() => prev && setHandNo(prev.handNo)}>
            上一局
          </button>
          <button disabled={!next} onClick={() => next && setHandNo(next.handNo)}>
            下一局
          </button>
          <ExportButton
            render={() => renderHandResult(room, { handNo, totalHands: total, result: replay.result, totals })}
            filename={`原點麻將-${room.id}-第${handNo}局.png`}
          />
        </div>
      </div>
    </div>
  );
}

export function HistoryTable({ room }: { room: RoomView }) {
  const names = room.players.map((p) => p.nickname ?? '-');
  const [viewing, setViewing] = useState<number | null>(null);
  const canReplay = (handNo: number) => room.replays.some((x) => x.handNo === handNo);
  return (
    <div className="table-scroll">
      {viewing !== null && <ReplayModal room={room} handNo={viewing} setHandNo={setViewing} />}
      <table className="history">
        <thead>
          <tr>
            <th>局</th>
            <th>結果</th>
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
              title={canReplay(h.handNo) ? '重看這一局' : undefined}
            >
              <td>{h.handNo}</td>
              <td className="left">
                {h.kind === 'draw'
                  ? '流局'
                  : h.winners
                      .map((w) => `${names[w.seat]} ${w.tsumo ? '自摸' : `銃和（${names[w.from!]}）`} ${w.total}分 ${w.yaku.join('・')}`)
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
            <td colSpan={2}>合計</td>
            {room.players.map((p) => (
              <td key={p.seat}>{p.score}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
