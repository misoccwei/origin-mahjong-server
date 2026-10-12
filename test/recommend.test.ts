import { describe, expect, it } from 'vitest';
import { fastestWin, recommendYaku } from '../src/shared/recommend.js';
import { EAST, isHonor, suitOf } from '../src/shared/tiles.js';
import { meld, uni } from './helpers.js';

const input = (hand: string, advanced = true, melds = [] as ReturnType<typeof meld>[]) => ({ concealed: uni(hand), melds, seatWind: EAST, advanced });
const rec = (hand: string, advanced = true, melds = [] as ReturnType<typeof meld>[]) => recommendYaku(input(hand, advanced, melds));

describe('推薦牌型（牌效率）', () => {
  it('筒子加字牌為主的手牌推薦混一色／清一色，並附有效牌張數', () => {
    const r = rec('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐');
    expect(r[0].name).toMatch(/混一色|清一色/);
    expect(r[0].ukeire).toBeGreaterThan(0);
    expect(r.find((x) => x.name === '混一色')).toBeDefined();
  });

  it('輪到自己（多一張）時，朝混一色建議打掉其他花色的牌', () => {
    const r = rec('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐🀈');
    const half = r.find((x) => x.name === '混一色')!;
    expect(half.discard).toBeDefined();
    expect(isHonor(half.discard!) || suitOf(half.discard!) !== 1).toBe(true);
  });

  it('最快和牌：打掉孤張字牌即聽牌，有效牌扣掉自己手上的張數', () => {
    // 123456789m 11p 23p + 東：打東聽 1p／4p（1p 自己已有 2 張 → 剩 2；4p 剩 4）
    const f = fastestWin(input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀚🀛🀀'));
    expect(f).toEqual({ shanten: 0, ukeire: 6, discard: uni('🀀')[0] });
  });

  it('有效牌會扣掉看得到的牌（例如河裡的牌）', () => {
    const visible = new Array(34).fill(0);
    for (const k of uni('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀚🀛')) visible[k]++;
    visible[uni('🀜')[0]] = 4; // 4p 全部出現過
    expect(fastestWin({ ...input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀙🀙🀚🀛'), visible }).ukeire).toBe(2);
  });

  it('全帶么九會被推薦（每組都含么九）', () => {
    // 123m 123p 99m 99p 東東 + 1s
    const r = rec('🀇🀈🀉🀙🀚🀛🀏🀏🀡🀡🀀🀀🀐');
    const chanta = r.find((x) => x.name === '全帶么九');
    expect(chanta).toBeDefined();
    expect(chanta!.shanten).toBe(1);
  });

  it('對子多時推薦七對子（進階）', () => {
    expect(rec('🀇🀇🀋🀋🀎🀎🀙🀙🀟🀟🀘🀀🀂').map((x) => x.name)).toContain('七對子');
    expect(rec('🀇🀇🀋🀋🀎🀎🀙🀙🀟🀟🀘🀀🀂', false).map((x) => x.name)).not.toContain('七對子');
  });

  it('與鳴牌衝突的牌型不推薦', () => {
    const names = rec('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆', true, [meld('🀇🀈🀉')]).map((x) => x.name);
    expect(names).not.toContain('清一色');
    expect(names).not.toContain('碰碰和');
  });
});
