import { describe, expect, it } from 'vitest';
import { outcomeRecommend } from '../src/shared/outcome.js';
import { EAST } from '../src/shared/tiles.js';
import { uni } from './helpers.js';

const input = (hand: string, extra = {}) => ({ concealed: uni(hand), melds: [], seatWind: EAST, advanced: true, expansion: true, ...extra });
const k = (s: string) => uni(s)[0];

describe('推薦牌型（進階型：結果導向）', () => {
  it('依最後和牌的分數把進張方向分組：進一筒、四筒做成三暗刻，二筒、三筒只有二暗刻', () => {
    // 11p 44p 23p 9p 中中中 東東東：一向聽
    const r = outcomeRecommend(input('🀙🀙🀜🀜🀚🀛🀡🀄🀄🀄🀀🀀🀀'));
    expect(r.shanten).toBe(1);
    const groups = r.plans[0].groups;
    const of = (t: string) => groups.find((g) => g.draws.includes(k(t)))!;
    expect(of('🀙').yaku).toContain('三暗刻');
    expect(of('🀜').yaku).toContain('三暗刻');
    expect(of('🀚')).toBe(of('🀛'));
    expect(of('🀚').yaku).toContain('二暗刻');
    expect(of('🀙').total).toBeGreaterThan(of('🀚').total);
    // 由高分排到低分
    for (let i = 1; i < groups.length; i++) expect(groups[i - 1].total).toBeGreaterThanOrEqual(groups[i].total);
  });

  it('已聽牌時每張聽的牌分開列出和牌分數', () => {
    // 123456789m 23p 東東：聽 1p、4p，兩者都是一氣通貫
    const r = outcomeRecommend(input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀚🀛🀀🀀'));
    expect(r.shanten).toBe(0);
    const draws = r.plans[0].groups.flatMap((g) => g.draws).sort((a, b) => a - b);
    expect(draws).toEqual([k('🀙'), k('🀜')]);
    expect(r.plans[0].groups.every((g) => g.yaku.includes('一氣通貫'))).toBe(true);
  });

  it('看不到剩的牌不列入；未達和牌最低分數的和法不列入', () => {
    const hand = '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀚🀛🀀🀀';
    const visible = new Array(34).fill(0);
    for (const t of uni(hand)) visible[t]++;
    visible[k('🀙')] = 4;
    const draws = outcomeRecommend(input(hand, { visible })).plans[0].groups.flatMap((g) => g.draws);
    expect(draws).toEqual([k('🀜')]);
    expect(outcomeRecommend(input(hand, { minWinScore: 320 })).plans).toEqual([]);
  });

  it('手上多一張時依打哪張分開；三向聽以上不計算', () => {
    const r = outcomeRecommend(input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀚🀛🀀🀀🀃'));
    expect(r.plans[0].discard).toBe(k('🀃'));
    expect(outcomeRecommend(input('🀇🀋🀏🀙🀝🀡🀐🀔🀘🀀🀁🀂🀃')).tooFar).toBe(true);
  });
});
