import { describe, expect, it } from 'vitest';
import { autoAction, decideAction } from '../../../src/server/engine/ai.js';
import { Hand } from '../../../src/server/engine/hand.js';
import { defaultSettings } from '../../../src/shared/rules.js';
import { kindOf, type TileId } from '../../../src/shared/tiles.js';
import { S0, autoplayUntil, buildWall, makeHand, tileOf } from '../../support/hand.js';
import { uni } from '../../support/tiles.js';

describe('自動摸打／自動和牌', () => {
  it('自動摸打：摸切、不鳴牌；只和最高分時放過較低分的和牌', () => {
    // 座位 1：234m 678m 456s 33p 55p 對碰。銃和 3p → 該刻子為明刻（10 分）；自摸可多一暗刻（15 分）
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = new Hand({ settings: { ...defaultSettings(4), minWinScore: 0, passThree: false }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀛') });
    h.start();
    h.drawCount[1] = 1; // 避免成立地和
    expect(autoAction(h, 0, { play: true, win: false, onlyMax: false })).toEqual({ type: 'discard', tile: h.drawn });
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀛') });
    expect(h.pending.get(1)?.ron).toBe(true);
    expect(h.winPreview(1)).toMatchObject({ score: { total: 10 }, best: 15 });
    expect(autoAction(h, 1, { play: true, win: false, onlyMax: false })).toEqual({ type: 'ron' });
    expect(autoAction(h, 1, { play: true, win: false, onlyMax: true })).toEqual({ type: 'pass' });
  });

  it('自動摸打：能暗槓或明槓時停下來交給玩家決定（回傳 null）', () => {
    // 座位 0 手上三張 🀇、摸到第四張 → 可暗槓
    const h = makeHand(['🀇🀇🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀚', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀇');
    expect(h.pending.get(0)?.ankan).toEqual([uni('🀇')[0]]);
    expect(autoAction(h, 0, { play: true, win: false, onlyMax: false })).toBeNull();
    // 座位 3 有三張 🀡：座位 2 打出 🀡 時可明槓
    const h2 = makeHand(['🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀈🀉🀊🀌🀍🀎🀛🀛🀛🀚🀓🀔🀕', '🀡🀇🀇🀈🀈🀉🀉🀙🀚🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'], '🀆🀁');
    autoplayUntil(h2, () => h2.current === 2 && h2.phase === 'turn');
    h2.act(2, { type: 'discard', tile: tileOf(h2, 2, '🀡') });
    expect(h2.pending.get(3)?.minkan).toBe(true);
    expect(autoAction(h2, 3, { play: true, win: false, onlyMax: false })).toBeNull();
    // 不鳴牌：只能槓（不能和）時自動略過，沒開自動摸打也一樣
    expect(autoAction(h2, 3, { play: false, win: false, onlyMax: false, noCall: true })).toEqual({ type: 'pass' });
  });

  it('自動和牌（沒開自動摸打）：只有能和時才自動，其他交給玩家', () => {
    const hands = [S0, '🀈🀉🀊🀌🀍🀎🀓🀔🀕🀛🀛🀝🀝', '🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];
    const h = new Hand({ settings: { ...defaultSettings(4), minWinScore: 0, passThree: false }, startSeat: 0, smallHandAvailable: [true, true, true, true], wall: buildWall(4, 0, hands, '🀛') });
    h.start();
    h.drawCount[1] = 1;
    const winOnly = { play: false, win: true, onlyMax: false };
    expect(autoAction(h, 0, winOnly)).toBeNull(); // 輪到自己打牌：不自動
    h.act(0, { type: 'discard', tile: tileOf(h, 0, '🀛') });
    expect(autoAction(h, 1, winOnly)).toEqual({ type: 'ron' });
    // 只和最高分：銃和 10 分 < 最高 15 分 → 交給玩家（不自動略過）
    expect(autoAction(h, 1, { ...winOnly, onlyMax: true })).toBeNull();
    expect(autoAction(h, 1, { play: false, win: false, onlyMax: false })).toBeNull();
    // 不鳴牌：能和（也能碰）時不自動略過，交給玩家
    expect(autoAction(h, 1, { play: false, win: false, onlyMax: false, noCall: true })).toBeNull();
  });
});

describe('AI 依推薦牌型做牌', () => {
  const others = ['🀐🀑🀒🀓🀔🀕🀖🀗🀘🀛🀜🀝🀞', '🀀🀁🀂🀃🀄🀅🀆🀐🀑🀒🀓🀔🀕', '🀊🀋🀌🀍🀎🀏🀖🀗🀘🀡🀡🀡🀃'];

  it('換三張：朝清一色／混一色，換掉其他花色的牌', () => {
    const h = makeHand(['🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆🀈🀙', ...others], '🀁', { passThree: true });
    const a = decideAction(h, 0, 'normal');
    expect(a.type).toBe('passThree');
    const kinds = (a as { tiles: TileId[] }).tiles.map(kindOf);
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain(uni('🀈')[0]);
  });

  it('和牌最低分數高於底分時，打牌朝期望值最高的牌型', () => {
    // 1～9p＋中中＋2m 3s＋摸 9s：要湊到 40 分，留筒子與中，打掉萬子或索子
    const h = makeHand(['🀙🀚🀛🀜🀝🀞🀟🀠🀡🀆🀆🀈🀒', ...others], '🀘', { minWinScore: 40 });
    const a = decideAction(h, 0, 'normal');
    expect(a.type).toBe('discard');
    const k = kindOf((a as { tile: TileId }).tile);
    expect([uni('🀈')[0], uni('🀒')[0], uni('🀘')[0]]).toContain(k);
  });
});
