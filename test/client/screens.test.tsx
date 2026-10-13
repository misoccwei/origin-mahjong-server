import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LobbyScreen } from '../../src/client/components/Lobby.js';
import { FinalScreen, WaitingRoom } from '../../src/client/components/RoomScreens.js';
import type { HandResultView } from '../../src/shared/protocol.js';
import { HAND, appState, player, room, text } from '../support/snapshots.js';

// 牌桌以外的畫面：大廳、等待房間、最終結算（含重看各局）。

const drawResult: HandResultView = {
  kind: 'draw',
  winners: [],
  tenpai: [],
  deltas: [0, 0, 0, 0],
  lines: [],
  hands: [HAND, [], [], []],
  melds: [[], [], [], []],
  shown: [],
  acknowledged: [],
};

const finished = (patch = {}) =>
  room({
    status: 'finished',
    history: [
      { handNo: 1, startSeat: 0, kind: 'draw', winners: [], deltas: [0, 0, 0, 0] },
      { handNo: 2, startSeat: 1, kind: 'win', winners: [{ seat: 1, total: 40, tsumo: false, from: 0, yaku: ['混一色'] }], deltas: [-40, 40, 0, 0] },
    ],
    replays: [
      { handNo: 1, result: drawResult },
      { handNo: 2, result: drawResult },
    ],
    ...patch,
  });

describe('大廳', () => {
  it('可以加入、觀戰、建立房間，並列出房間列表', () => {
    const html = text(
      renderToString(
        <LobbyScreen
          state={appState({
            roomList: [{ id: '4321', hostName: 'Alice', status: 'waiting', joinable: true, spectatable: true, spectators: 1, seated: 2, playerCount: 4, advanced: true, scoring: 'additive' }],
          })}
        />,
      ),
    );
    expect(html).toContain('加入房間');
    expect(html).toContain('建立房間');
    expect(html).toContain('Alice 的房間');
    expect(html).toContain('2 / 4 人');
    expect(html).toContain('1 人觀戰');
  });
});

describe('等待房間', () => {
  it('房主看得到加入 AI、開始；規則摘要包含新設定', () => {
    const r = room({ status: 'waiting', settings: { ...room().settings, randomSeats: true } });
    const html = text(renderToString(<WaitingRoom room={r} />));
    expect(html).toContain('房號 1234');
    expect(html).toContain('隨機座位');
    expect(html).toContain('加入 AI');
    expect(html).toContain('開始');
  });

  it('觀戰者看到「入座」與「離開觀戰」，沒有準備按鈕', () => {
    const r = room({ status: 'waiting', mySeat: null, players: [0, 1, 2, 3].map((s) => player(s, s === 3 ? { nickname: null, isAI: false } : {})) });
    const html = text(renderToString(<WaitingRoom room={r} />));
    expect(html).toContain('入座');
    expect(html).toContain('離開觀戰');
    expect(html).not.toContain('取消準備');
  });
});

describe('最終結算', () => {
  it('排名、各局紀錄；有重看資料的局可以點', () => {
    const html = renderToString(<FinalScreen room={finished()} />);
    expect(text(html)).toContain('最終結算');
    expect(text(html)).toContain('電腦 1 銃和（我） 40分 混一色');
    expect(html.match(/class="replayable"/g)).toHaveLength(2);
    expect(text(html)).toContain('點一局可以重看那一局的結果');
  });

  it('沒有重看資料（例如解散）時各局不能點', () => {
    const html = renderToString(<FinalScreen room={finished({ replays: [], dissolved: true })} />);
    expect(text(html)).toContain('牌局已解散');
    expect(html).not.toContain('replayable');
  });
});
