import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TableScreen } from '../src/client/components/Table.js';
import { YakuTable } from '../src/client/components/YakuTable.js';
import type { AppState } from '../src/client/net.js';
import type { GameView, HandResultView, PlayerView, RoomView } from '../src/shared/protocol.js';
import { defaultSettings } from '../src/shared/rules.js';

// 畫面回歸測試：用伺服器會送來的快照直接渲染牌桌，確認各階段都不會丟例外、關鍵內容有出現。
// （曾發生過結算畫面整個掛掉、換三張顯示錯誤的情況）

const t = (kind: number, copy = 0) => kind * 4 + copy;

function player(seat: number, patch: Partial<PlayerView> = {}): PlayerView {
  return {
    seat,
    nickname: seat === 0 ? '我' : `電腦 ${seat}`,
    userId: seat === 0 ? 'me' : null,
    isAI: seat !== 0,
    aiControlled: false,
    autoPlay: false,
    connected: true,
    left: false,
    ready: true,
    score: 0,
    wind: 27 + seat,
    handCount: 13,
    hasDrawn: false,
    melds: [],
    discards: [],
    ...patch,
  };
}

function room(patch: Partial<RoomView> = {}): RoomView {
  return {
    id: '123456',
    hostSeat: 0,
    status: 'playing',
    settings: defaultSettings(4),
    players: [0, 1, 2, 3].map((s) => player(s)),
    mySeat: 0,
    paused: null,
    history: [],
    dissolved: false,
    spectators: [],
    replays: [],
    ...patch,
  };
}

const HAND = [0, 1, 2, 3, 4, 5, 9, 10, 11, 18, 19, 20, 27].map((k) => t(k));

function game(patch: Partial<GameView> = {}): GameView {
  return {
    handNo: 1,
    totalHands: 4,
    startSeat: 0,
    phase: 'turn',
    currentSeat: 0,
    wallRemaining: 70,
    deadWall: 12,
    myHand: HAND,
    myDrawn: null,
    lastDiscard: null,
    recentDiscard: null,
    kakanTile: null,
    pending: null,
    waitingSeats: [],
    deadline: null,
    passThreeDone: [false, false, false, false],
    passSent: null,
    passReceived: null,
    myWaits: [],
    myWaitScore: null,
    auto: { on: false, win: false, onlyMax: true, noCall: false },
    thinkAvailable: false,
    result: null,
    smallHandAvailable: [true, true, true, true],
    ...patch,
  };
}

function render(r: RoomView, g: GameView | null) {
  const state: AppState = { conn: 'open', authed: true, userId: 'me', nickname: '我', room: r, game: g, clockOffset: 0, toast: null, fatal: null, roomList: [] };
  return renderToString(<TableScreen state={state} />);
}

describe('牌桌畫面', () => {
  it('觀戰：沒有手牌與操作，下方玩家也以牌背顯示，可以切換視角與離開觀戰', () => {
    const r = room({ mySeat: null, players: [0, 1, 2, 3].map((s) => player(s, { userId: s === 0 ? 'p0' : null })) });
    const html = render(r, game({ myHand: [] }));
    expect(html).toContain('觀戰中');
    expect(html).toContain('離開觀戰');
    expect(html).toContain('視角：');
    expect(html).not.toContain('推薦牌型');
    expect(html).not.toContain('自動摸打');
    // 四家都顯示牌背（下方也是）
    expect((html.match(/class="side-hand"/g) ?? []).length).toBe(4);
  });

  it('換三張選牌階段：牌桌上有 3 個候選格與換出／不換', () => {
    const html = render(room(), game({ phase: 'passThree', pending: { kind: 'passThree' }, waitingSeats: [0] }));
    expect(html).toMatch(/class="pass-overlay"/);
    expect((html.match(/class="pass-slot"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<button class="call pon" disabled="">換出<\/button>/);
    expect(html).toContain('不換');
  });

  it('工具列：推薦牌型、自動和牌、自動摸打（開啟時高亮）與 ⚙ 選單', () => {
    const html = render(room(), game({ auto: { on: true, win: false, onlyMax: false, noCall: false } }));
    expect(html).toMatch(/class="chip-btn on" aria-pressed="true"[^>]*>自動摸打/);
    expect(html).toMatch(/class="chip-btn " aria-pressed="false"[^>]*>自動和牌/);
    expect(html).toContain('aria-label="更多設定"');
  });

  it('手牌與鳴牌是分開的區塊；沒有摸牌時保留摸牌位置（摸牌不會讓手牌移動）', () => {
    const r = room({ players: [0, 1, 2, 3].map((s) => player(s, s === 0 ? { melds: [{ type: 'pon', tiles: [t(27, 0), t(27, 1), t(27, 2)], calledTile: t(27, 2), from: 1 }] } : {})) });
    const html = render(r, game({ myHand: HAND.slice(0, 10) }));
    expect(html).toMatch(/class="hand-tiles"/);
    expect(html).toMatch(/class="meld-area"/);
    expect(html).toMatch(/class="tile-slot placeholder"/);
    // 鳴牌一組：牌的大小以 13 − 3 + 1.5 張計算，與有沒有摸牌無關
    expect(html).toContain('--n:11.5');
    const drawn = t(5, 3);
    expect(render(r, game({ myHand: [...HAND.slice(0, 10), drawn], myDrawn: drawn }))).toContain('--n:11.5');
  });

  it('長考：可以用時顯示按鈕', () => {
    expect(render(room(), game({ thinkAvailable: true }))).toContain('長考 +60 秒');
    expect(render(room(), game())).not.toContain('長考');
  });

  it('直式：上方狀態列（局數、四家分數，輪到的人亮起）與資訊卡分頁', () => {
    const html = render(room(), game({ currentSeat: 1, deadline: Date.now() + 9500 }));
    expect(html).toMatch(/class="status-bar"/);
    expect(html).toContain('第 <!-- -->1<!-- --> / <!-- -->4<!-- --> 局');
    expect(html).toMatch(/class="score-chip active "[^>]*><b>南<\/b><span class="nm">電腦 1<\/span>/);
    expect(html).toMatch(/class="info-card"/);
    expect(html).toContain('輪到 電腦 1 打牌');
    // 沒有換三張紀錄時不顯示該分頁；推薦牌型不再疊在牌桌上
    expect(html).not.toMatch(/role="tab"[^>]*>換三張/);
    expect(html).not.toContain('reco-panel overlay');
  });

  it('直式：有換三張紀錄時多一個分頁，牌桌上不再顯示換三張紀錄', () => {
    const html = render(room(), game({ passSent: HAND.slice(0, 3), passReceived: [t(30), t(31), t(32)] }));
    expect(html).toMatch(/role="tab"[^>]*>換三張/);
    expect(html).not.toContain('swap-mini');
  });

  it('牌桌固定佔滿畫面：直式用 portrait 版面（伺服器渲染沒有視窗時）', () => {
    expect(render(room(), game())).toMatch(/class="table portrait players-4"/);
  });

  it('換三張亮牌：有交換時顯示換出與收到的牌與倒數，不會顯示「沒有換到牌」', () => {
    const html = render(
      room(),
      game({ phase: 'passReveal', myHand: HAND.slice(3), passSent: HAND.slice(0, 3), passReceived: [t(30), t(31), t(32)], deadline: Date.now() + 2500 }),
    );
    expect(html).toContain('換出');
    expect(html).toContain('收到');
    expect(html).not.toContain('沒有換到牌');
    expect(html).toMatch(/swap-count[^>]*>3</);
  });

  it('換三張亮牌：沒有交換時顯示「沒有換到牌」', () => {
    expect(render(room(), game({ phase: 'passReveal', deadline: Date.now() + 2500 }))).toContain('這次沒有換到牌');
  });



  it('剛打出的牌顯示在中央，鳴牌時加上標記', () => {
    const r = room({ players: [0, 1, 2, 3].map((s) => player(s, s === 1 ? { discards: [{ tile: t(22), called: false }] } : {})) });
    const html = render(r, game({ phase: 'claim', currentSeat: 1, lastDiscard: { seat: 1, tile: t(22) }, recentDiscard: { seat: 1, tile: t(22) }, pending: { kind: 'claim', pon: true } }));
    expect(html).toMatch(/class="recent claiming"/);
    expect(html).toContain('電腦 1<!-- --> 打出');
    expect(html).toContain('碰');
    // 吃碰槓和是疊在牌桌上的大按鈕
    expect(html).toMatch(/class="call-overlay"/);
    expect(html).toMatch(/class="call pon"/);
  });

  it('可以和牌時顯示醒目的和牌按鈕', () => {
    const html = render(room(), game({ phase: 'claim', currentSeat: 1, recentDiscard: { seat: 1, tile: t(27) }, pending: { kind: 'claim', ron: true, pon: true } }));
    expect(html).toMatch(/class="call win"[^>]*>和</);
  });

  it('自動摸打遇到能槓時，問玩家要不要槓（有「不槓（摸切）」）', () => {
    const drawn = t(0, 3);
    const g = game({ myHand: [...HAND, drawn], myDrawn: drawn, auto: { on: true, win: false, onlyMax: false, noCall: false }, pending: { kind: 'turn', discard: [...HAND, drawn], ankan: [0] } });
    const html = render(room(), g);
    expect(html).toContain('暗槓');
    expect(html).toContain('不槓（摸切）');
    // 沒開自動摸打時不需要這顆按鈕（直接打牌就是不槓）
    expect(render(room(), { ...g, auto: { on: false, win: false, onlyMax: false, noCall: false } })).not.toContain('不槓');
  });

  it('聽牌時在手牌上方顯示聽的牌、剩餘張數與預計得分（同分只寫一個）', () => {
    const html = render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: { min: 20, max: 45 } }));
    expect(html).toContain('聽牌：');
    expect(html).toContain('×<!-- -->3');
    expect(html).toContain('預計 20～45 分');
    expect(render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: { min: 40, max: 40 } }))).toContain('預計 40 分');
    expect(render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: null }))).toContain('未達和牌最低分數');
  });


});

describe('結算畫面', () => {
  const winHand = [0, 0, 1, 1, 2, 2, 9, 10, 11, 18, 19, 20, 27, 27].map((k, i) => t(k, i % 2));
  const baseResult: HandResultView = {
    kind: 'win',
    winners: [
      {
        seat: 1,
        tsumo: true,
        tile: winHand[13],
        score: { form: 'standard', groups: [], yaku: [{ id: '1.0', name: '不求人', points: 5, count: 1 }], yakuPoints: 5, limit: false, baseScore: 0, total: 5 },
      },
    ],
    tenpai: [
      {
        seat: 2,
        maxScore: 40,
        waits: [5, 8],
        best: {
          tile: 8,
          tsumo: true,
          score: {
            form: 'standard',
            groups: [],
            yaku: [{ id: '2.2.1', name: '二對清么', points: 10, count: 1 }, { id: '4.2.2', name: '二暗刻', points: 10, count: 1 }, { id: '3.0', name: '五門齊', points: 20, count: 1 }],
            yakuPoints: 40,
            limit: false,
            baseScore: 0,
            total: 40,
          },
        },
      },
    ],
    deltas: [0, 10, 5, 0],
    lines: [],
    hands: [HAND, winHand, HAND, []],
    melds: [[], [], [], []],
    shown: [],
    acknowledged: [],
  };

  it('顯示和牌者、聽牌者的手牌，沒聽牌的自己可以展示手牌', () => {
    const html = render(room(), game({ phase: 'result', result: baseResult, deadline: Date.now() + 30000 }));
    expect(html).toContain('電腦 1 自摸');
    expect(html).toMatch(/class="result-card win"/);
    expect(html).toMatch(/class="result-card tenpai"/);
    expect(html).toContain('展示我的手牌');
  });

  it('聽牌者顯示得分最高的和法與牌型（聽牌得分依此計算）', () => {
    const html = render(room(), game({ phase: 'result', result: baseResult }));
    expect(html).toContain('最高分的和法：<!-- -->自摸<!-- -->「<!-- -->九萬<!-- -->」');
    expect(html).toContain('二暗刻');
    expect(html).toContain('五門齊');
    expect(html).toContain('最高和牌分數');
    // 實得 5 分 < 最高 40 分：說明被和牌者的分數限制
    expect(html).toContain('實得 <!-- -->5<!-- --> 分');
  });

  it('展示過手牌後列在「展示手牌」區', () => {
    const html = render(room(), game({ phase: 'result', result: { ...baseResult, shown: [0] } }));
    expect(html).toContain('展示手牌');
    expect(html).not.toContain('展示我的手牌');
  });

  it('流局也能顯示', () => {
    const html = render(room(), game({ phase: 'result', result: { ...baseResult, kind: 'draw', winners: [], deltas: [0, 0, 0, 0] } }));
    expect(html).toContain('流局');
  });

  it('舊格式（缺少 shown 欄位）不會讓畫面掛掉', () => {
    const { shown: _omit, ...old } = baseResult;
    expect(() => render(room(), game({ phase: 'result', result: old as HandResultView }))).not.toThrow();
  });
});

describe('牌型表', () => {
  it('列出所有牌型（含擴充與改名後的清么），並有種類與分數篩選', () => {
    const html = renderToString(<YakuTable />);
    expect(html).toContain('四清么');
    expect(html).not.toContain('二對清么');
    expect(html).toContain('十三不搭');
    expect(html).toContain('對稱類');
    expect(html).toContain('任何分數');
    expect(html).toMatch(/共 <!-- -->76<!-- --> 個牌型/);
  });

  it('牌局中預設只列出這桌適用的牌型', () => {
    const name = (n: string) => new RegExp(`class="yaku-name">${n}<`);
    expect(renderToString(<YakuTable advanced expansion={false} defaultShowAll={false} />)).not.toMatch(name('十三不搭'));
    expect(renderToString(<YakuTable advanced expansion={false} defaultShowAll={false} />)).toMatch(name('七對子'));
    expect(renderToString(<YakuTable advanced={false} expansion={false} defaultShowAll={false} />)).not.toMatch(name('七對子'));
  });
});
