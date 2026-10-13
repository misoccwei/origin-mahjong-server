import { describe, expect, it } from 'vitest';
import { outcomeRecommend, type OutcomeInput } from '../../src/shared/outcome.js';
import { EAST } from '../../src/shared/tiles.js';
import { uni } from '../support/tiles.js';

const input = (hand: string, extra: Partial<OutcomeInput> = {}): OutcomeInput => ({
  concealed: uni(hand),
  melds: [],
  seatWind: EAST,
  advanced: true,
  expansion: false,
  minWinScore: 20,
  drawsLeft: 12,
  ...extra,
});
const k = (s: string) => uni(s)[0];
const RED = k('🀄');

describe('推薦牌型（進階型：期望得分）', () => {
  it('聽坎張、手上有一對中：列出碰中與摸到中改聽的方向，分數比直接和高', () => {
    // 68m 123m 345m 999m 中中：聽七萬（混一色）
    const r = outcomeRecommend(input('🀌🀎🀇🀈🀉🀉🀊🀋🀏🀏🀏🀄🀄'));
    expect(r.shanten).toBe(0);
    const plan = r.plans[0];
    const win = plan.groups.find((g) => g.via === 'win')!;
    expect(win.draws).toEqual([k('🀍')]);
    const pon = plan.groups.find((g) => g.via === 'pon' && g.draws.includes(RED))!;
    expect(pon.yaku).toContain('番牌');
    expect(pon.total).toBeGreaterThan(win.total);
    const draw = plan.groups.find((g) => g.via === 'draw' && g.draws.includes(RED))!;
    expect(draw.yaku).toContain('番牌');
    // 和牌率與期望得分：各組的機率加起來就是整體
    expect(plan.winRate).toBeGreaterThan(0);
    expect(plan.winRate).toBeLessThan(1);
    expect(plan.groups.reduce((a, g) => a + g.rate, 0)).toBeLessThanOrEqual(plan.winRate + 1e-9);
  });

  it('有人打出中時，比較碰與不碰：碰中的期望得分較高，排在前面', () => {
    const r = outcomeRecommend(input('🀌🀎🀇🀈🀉🀉🀊🀋🀏🀏🀏🀄🀄', { claim: { tile: RED, pon: true, chi: [] } }));
    const best = r.plans[0];
    expect(best.call).toEqual({ type: 'pon', kinds: [RED, RED, RED] });
    expect(best.discard).toBeDefined();
    const pass = r.plans.find((p) => !p.call)!;
    expect(best.ev).toBeGreaterThan(pass.ev);
    expect(best.groups.every((g) => g.yaku.includes('番牌'))).toBe(true);
  });

  it('聽的牌和不到最低分數時，指出要靠改聽才能和', () => {
    // 68m 234p 567p 345s 中中：和七萬只有平和（自摸再加不求人），未達 20 分
    const r = outcomeRecommend(input('🀌🀎🀚🀛🀜🀝🀞🀟🀒🀓🀔🀄🀄'));
    const groups = r.plans[0].groups;
    expect(groups.some((g) => g.via === 'win')).toBe(false);
    const change = groups.find((g) => g.draws.includes(RED))!;
    expect(change.via).toBe('draw');
    expect(change.total).toBeGreaterThanOrEqual(20);
  });

  it('一向聽以上：依第一張進牌分組，越高分的方向和牌率越低時仍以期望得分排序', () => {
    // 11p 44p 23p 9p 中中中 東東東：一向聽
    const r = outcomeRecommend(input('🀙🀙🀜🀜🀚🀛🀡🀄🀄🀄🀀🀀🀀'));
    expect(r.shanten).toBe(1);
    const groups = r.plans[0].groups;
    const of = (t: string) => groups.find((g) => g.via === 'draw' && g.draws.includes(k(t)))!;
    expect(of('🀙').yaku).toContain('三暗刻');
    expect(of('🀙').total).toBeGreaterThan(of('🀚').total);
  });

  it('看不到剩的牌不列入；未達和牌最低分數的和法不列入', () => {
    const hand = '🀇🀈🀉🀊🀋🀌🀍🀎🀏🀚🀛🀀🀀';
    const visible = new Array(34).fill(0);
    for (const t of uni(hand)) visible[t]++;
    visible[k('🀙')] = 4;
    const wins = outcomeRecommend(input(hand, { visible })).plans[0].groups.filter((g) => g.via === 'win');
    expect(wins.flatMap((g) => g.draws)).toEqual([k('🀜')]);
    expect(outcomeRecommend(input(hand, { minWinScore: 320 })).plans).toEqual([]);
  });

  it('剩下的巡數越少，和牌率越低', () => {
    const hand = '🀙🀙🀜🀜🀚🀛🀡🀄🀄🀄🀀🀀🀀';
    const many = outcomeRecommend(input(hand, { drawsLeft: 15 })).plans[0];
    const few = outcomeRecommend(input(hand, { drawsLeft: 3 })).plans[0];
    expect(few.winRate).toBeLessThan(many.winRate);
    expect(few.ev).toBeLessThan(many.ev);
  });

  it('手上多一張時依打哪張分開；三向聽以上不計算', () => {
    const r = outcomeRecommend(input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀚🀛🀀🀀🀃'));
    expect(r.plans[0].discard).toBe(k('🀃'));
    for (let i = 1; i < r.plans.length; i++) expect(r.plans[i - 1].ev).toBeGreaterThanOrEqual(r.plans[i].ev);
    expect(outcomeRecommend(input('🀇🀋🀏🀙🀝🀡🀐🀔🀘🀀🀁🀂🀃')).tooFar).toBe(true);
  });
});
