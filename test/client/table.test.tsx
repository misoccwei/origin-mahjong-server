import { describe, expect, it } from 'vitest';
import { HAND, game, player, render, room, text, tid } from '../support/snapshots.js';

// 畫面回歸測試：用伺服器會送來的快照直接渲染牌桌，確認各階段都不會丟例外、關鍵內容有出現。
// （曾發生過結算畫面整個掛掉、換三張顯示錯誤的情況）

describe('牌桌畫面', () => {
  it('觀戰：沒有手牌與操作，下方玩家也以牌背顯示，可以切換視角與離開觀戰', () => {
    const r = room({ mySeat: null, players: [0, 1, 2, 3].map((s) => player(s, { userId: s === 0 ? 'p0' : null })) });
    const html = render(r, game({ myHand: [] }));
    expect(html).toContain('觀戰中');
    expect(html).toContain('離開觀戰');
    expect(html).toContain('視角：');
    expect(html).not.toContain('推薦牌型');
    expect(html).not.toContain('自動打');
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

  it('工具列：推薦、自動和、自動打、不鳴牌（開啟時高亮）；⚙ 選單在右上與局數放在一起', () => {
    const html = render(room(), game({ auto: { on: true, win: false, noCall: false } }));
    expect(html).toMatch(/class="chip-btn on" aria-pressed="true"[^>]*>自動打/);
    expect(html).toMatch(/class="chip-btn " aria-pressed="false"[^>]*>自動和</);
    expect(html).toMatch(/class="chip-btn " aria-pressed="false"[^>]*>不鳴牌</);
    expect(html).toMatch(/<header class="top-bar">.*第 1 \/ 4 局.*aria-label="更多設定".*<\/header>/);
    expect(html.match(/<div class="my-tools">.*?<\/div>/)![0]).not.toContain('更多設定');
  });

  it('手牌與鳴牌是分開的區塊；沒有摸牌時保留摸牌位置（摸牌不會讓手牌移動）', () => {
    const r = room({ players: [0, 1, 2, 3].map((s) => player(s, s === 0 ? { melds: [{ type: 'pon', tiles: [tid(27, 0), tid(27, 1), tid(27, 2)], calledTile: tid(27, 2), from: 1 }] } : {})) });
    const html = render(r, game({ myHand: HAND.slice(0, 10) }));
    expect(html).toMatch(/class="hand-tiles"/);
    expect(html).toMatch(/class="meld-area"/);
    expect(html).toMatch(/class="tile-slot placeholder"/);
    // 鳴牌一組：牌的大小以 13 − 3 + 1.5 張計算，與有沒有摸牌無關
    expect(html).toContain('--n:11.5');
    const drawn = tid(5, 3);
    expect(render(r, game({ myHand: [...HAND.slice(0, 10), drawn], myDrawn: drawn }))).toContain('--n:11.5');
  });

  it('鳴牌轉橫的那張朝向來源：上家（右）在最右、下家（左）在最左', () => {
    const sideways = (from: number) => {
      const meld = { type: 'pon' as const, tiles: [tid(27, 0), tid(27, 1), tid(27, 2)], calledTile: tid(27, 0), from };
      const r = room({ players: [0, 1, 2, 3].map((s) => player(s, s === 0 ? { melds: [meld] } : {})) });
      const area = render(r, game()).match(/class="meld-area">(.*?)<\/div>/)![1];
      return [...area.matchAll(/class="tile([^"]*)"/g)].map((m) => m[1].includes('sideways'));
    };
    expect(sideways(3)).toEqual([false, false, true]);
    expect(sideways(2)).toEqual([false, true, false]);
    expect(sideways(1)).toEqual([true, false, false]);
  });

  it('單人對 AI：上方有「交給 AI 打完」，交給 AI 後改顯示 AI 打完中；兩個真人時沒有', () => {
    const top = (g: ReturnType<typeof game>) => text(render(room(), g).match(/<header class="top-bar">.*?<\/header>/)![0]);
    expect(top(game({ solo: true }))).toContain('交給 AI 打完');
    expect(top(game({ solo: true, fastFinish: true }))).toContain('AI 打完中…');
    expect(top(game())).not.toContain('AI');
  });

  it('電腦代打中：工具列只剩標示與「改回自己打」，沒有自動功能', () => {
    const html = text(render(room(), game({ solo: true, aiPlay: true, pending: null })));
    expect(html).toContain('電腦代打中');
    expect(html).toContain('改回自己打');
    expect(html).not.toContain('自動打');
    expect(text(render(room(), game({ solo: true })))).toContain('自動打');
  });

  it('長考：可以用時顯示按鈕', () => {
    expect(render(room(), game({ thinkAvailable: true }))).toContain('長考 +60 秒');
    expect(render(room(), game())).not.toContain('長考');
  });

  it('直式：上方是倒數與局數，門風與分數在四角名牌（輪到的人亮起），中央只有餘牌與剛打出的牌', () => {
    const html = render(room(), game({ currentSeat: 1, deadline: Date.now() + 9500 }));
    expect(text(html.match(/<header class="top-bar">.*?<\/header>/)![0]).replace(/\s+/g, ' ').trim()).toBe('⏱ 10 第 1 / 4 局');
    expect(html).toMatch(/class="nameplate at-left active"><div class="plate-score"><b>南<\/b><span>0<\/span>/);
    expect(text(html.match(/<div class="center-info">.*?<\/div><\/div>/)![0]).trim()).toMatch(/^餘 \d+ 張$/);
    expect(html).not.toContain('side-plate');
    expect(html).toMatch(/class="info-card"/);
    expect(html).toContain('輪到 電腦 1 打牌');
    // 沒有換三張紀錄時不顯示該分頁；推薦牌型不再疊在牌桌上
    expect(html).not.toMatch(/role="tab"[^>]*>換三張/);
    expect(html).not.toContain('reco-panel overlay');
  });

  it('直式：有換三張紀錄時多一個分頁，牌桌上不再顯示換三張紀錄', () => {
    const html = render(room(), game({ passSent: HAND.slice(0, 3), passReceived: [tid(30), tid(31), tid(32)] }));
    expect(html).toMatch(/role="tab"[^>]*>換三張/);
    expect(html).not.toContain('swap-mini');
  });

  it('牌桌固定佔滿畫面：直式用 portrait 版面（伺服器渲染沒有視窗時）', () => {
    expect(render(room(), game())).toMatch(/class="table portrait players-4"/);
  });

  it('換三張亮牌：有交換時顯示換出與收到的牌與倒數，不會顯示「沒有換到牌」', () => {
    const html = render(
      room(),
      game({ phase: 'passReveal', myHand: HAND.slice(3), passSent: HAND.slice(0, 3), passReceived: [tid(30), tid(31), tid(32)], deadline: Date.now() + 2500 }),
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
    const r = room({ players: [0, 1, 2, 3].map((s) => player(s, s === 1 ? { discards: [{ tile: tid(22), called: false }] } : {})) });
    const html = render(r, game({ phase: 'claim', currentSeat: 1, lastDiscard: { seat: 1, tile: tid(22) }, recentDiscard: { seat: 1, tile: tid(22) }, pending: { kind: 'claim', pon: true } }));
    expect(html).toMatch(/class="recent claiming"/);
    expect(text(html)).toContain('電腦 1 打出');
    expect(html).toContain('碰');
    // 吃碰槓和是疊在牌桌上的大按鈕
    expect(html).toMatch(/class="call-overlay"/);
    expect(html).toMatch(/class="call pon"/);
  });

  it('可以和牌時顯示醒目的和牌按鈕', () => {
    const html = render(room(), game({ phase: 'claim', currentSeat: 1, recentDiscard: { seat: 1, tile: tid(27) }, pending: { kind: 'claim', ron: true, pon: true } }));
    expect(html).toMatch(/class="call win"[^>]*>和</);
  });

  it('自動摸打遇到能槓時，問玩家要不要槓（有「不槓（摸切）」）', () => {
    const drawn = tid(0, 3);
    const g = game({ myHand: [...HAND, drawn], myDrawn: drawn, auto: { on: true, win: false, noCall: false }, pending: { kind: 'turn', discard: [...HAND, drawn], ankan: [0] } });
    const html = render(room(), g);
    expect(html).toContain('暗槓');
    expect(html).toContain('不槓（摸切）');
    // 沒開自動摸打時不需要這顆按鈕（直接打牌就是不槓）
    expect(render(room(), { ...g, auto: { on: false, win: false, noCall: false } })).not.toContain('不槓');
  });

  it('聽牌時在手牌上方顯示聽的牌、剩餘張數與預計得分（同分只寫一個）', () => {
    const html = render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: { min: 20, max: 45 } }));
    expect(html).toContain('聽牌：');
    expect(text(html)).toContain('×3');
    expect(html).toContain('預計 20～45 分');
    expect(render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: { min: 40, max: 40 } }))).toContain('預計 40 分');
    expect(render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: null }))).toContain('未達和牌最低分數');
  });

  it('聽牌時列出每張聽的牌和了幾分與牌型', () => {
    // 123456m 123p 123s 東：單騎東
    const out = text(render(room(), game({ myWaits: [{ kind: 27, left: 3 }], myWaitScore: { min: 55, max: 55 } })));
    expect(out).toMatch(/×3 \d+ 分 [^ ]*平和/);
  });

  it('聽牌列表依分數高到低排列：九筒（一氣通貫）排在三、六筒前面', () => {
    // 12345678p 東東東 白白
    const myHand = [9, 10, 11, 12, 13, 14, 15, 16, 27, 27, 27, 33, 33].map((k, i) => tid(k, k >= 27 ? i % 3 : 0));
    const html = render(room(), game({ myHand, myWaits: [11, 14, 17].map((kind) => ({ kind, left: 3 })), myWaitScore: { min: 20, max: 80 } }));
    const list = html.slice(html.indexOf('聽牌：'));
    const at = (n: number) => list.indexOf(`/tiles/Pin${n}.svg`);
    expect(at(9)).toBeGreaterThan(0);
    expect(at(9)).toBeLessThan(at(3));
    expect(at(9)).toBeLessThan(at(6));
  });

  it('和牌、自摸按鈕上顯示現在和的分數與牌型', () => {
    const winScore = { total: 45, yaku: [{ name: '混一色', count: 1 }, { name: '番牌', count: 2 }] };
    const ron = text(render(room(), game({ phase: 'claim', currentSeat: 1, recentDiscard: { seat: 1, tile: tid(27) }, pending: { kind: 'claim', ron: true, winScore } })));
    expect(ron).toContain('和 45 分 混一色・番牌×2');
    const tsumo = text(render(room(), game({ pending: { kind: 'turn', discard: HAND, tsumo: true, winScore } })));
    expect(tsumo).toContain('自摸 45 分 混一色・番牌×2');
  });

});
