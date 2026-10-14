import { describe, expect, it } from 'vitest';
import { fastestWin, recommendYaku, winProbability } from '../../src/shared/recommend.js';
import { EAST, isHonor, suitOf } from '../../src/shared/tiles.js';
import { meld, uni } from '../support/tiles.js';

const input = (hand: string, advanced = true, melds = [] as ReturnType<typeof meld>[]) => ({ concealed: uni(hand), melds, seatWind: EAST, advanced });
const rec = (hand: string, advanced = true, melds = [] as ReturnType<typeof meld>[]) => recommendYaku(input(hand, advanced, melds));

describe('推薦牌型（牌效率）', () => {
  it('筒子加字牌為主的手牌推薦混一色／清一色，並附有效牌張數', () => {
    const r = rec('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐');
    const half = r.find((x) => x.name === '混一色')!;
    expect(r.indexOf(half)).toBeLessThan(2);
    expect(half.ukeire).toBeGreaterThan(0);
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
    expect(f).toEqual({ shanten: 0, ukeire: 6, discard: uni('🀀')[0], wanted: uni('🀙🀜') });
  });

  it('各牌型列出有效牌的種類（打掉建議的牌之後），剩的張數加起來等於有效牌張數', () => {
    const hand = '🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐🀈';
    const own = new Array(34).fill(0);
    for (const k of uni(hand)) own[k]++;
    for (const r of rec(hand)) {
      if (r.shanten < 0) continue;
      expect(r.wanted.length).toBeGreaterThan(0);
      expect(r.wanted).not.toContain(r.discard);
      expect(r.wanted.reduce((a, k) => a + 4 - own[k], 0)).toBe(r.ukeire);
    }
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

  it('依期望值排序，並標出可吃碰或門清牌型', () => {
    const r = rec('🀇🀇🀋🀋🀎🀎🀙🀙🀟🀟🀘🀀🀂');
    for (let i = 1; i < r.length; i++) expect(r[i - 1].ev).toBeGreaterThanOrEqual(r[i].ev);
    expect(r.find((x) => x.name === '七對子')!.callable).toBe(false);
    expect(r.filter((x) => x.callable).length).toBeGreaterThan(0);
    for (const x of r) expect(x.ev).toBeCloseTo(x.winRate * x.points);
  });

  it('未達和牌最低分數的牌型不推薦', () => {
    const r = recommendYaku({ ...input('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐'), minWinScore: 40 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.points >= 40)).toBe(true);
    // 底分（讓分）會加進去
    const withBase = recommendYaku({ ...input('🀙🀚🀛🀜🀝🀟🀠🀡🀆🀆🀆🀇🀐'), minWinScore: 40, baseScore: 30 }, 20);
    expect(withBase.some((x) => x.points < 40)).toBe(true);
  });

  it('和牌率：剩餘巡數越多、有效牌越多越高；可吃碰的牌型高於門清', () => {
    const p = (s: number, u: number, d: number, callable = true) => winProbability(s, u, 100, d, callable);
    expect(p(-1, 0, 0)).toBe(1);
    expect(p(1, 0, 10)).toBe(0);
    expect(p(1, 10, 15)).toBeGreaterThan(p(1, 10, 5));
    expect(p(1, 20, 10)).toBeGreaterThan(p(1, 10, 10));
    expect(p(2, 20, 10)).toBeLessThan(p(1, 20, 10));
    expect(p(2, 20, 10, true)).toBeGreaterThan(p(2, 20, 10, false));
  });

  it('需要的牌已經用完的牌型不推薦：四張一萬都在自己的暗槓裡，萬子一氣通貫不可能', () => {
    const hand = '🀈🀉🀊🀋🀌🀍🀎🀏🀀🀀';
    const withKan = recommendYaku({ ...input(hand, true, [meld('🀇🀇🀇🀇', false)]) }, 20).map((x) => x.name);
    expect(withKan).not.toContain('一氣通貫');
    // 對照：鳴的是東，一萬還有剩，一氣通貫照樣推薦
    const withPon = recommendYaku({ ...input('🀇🀈🀉🀊🀋🀌🀍🀎🀏🀁', true, [meld('🀀🀀🀀')]) }, 20).map((x) => x.name);
    expect(withPon).toContain('一氣通貫');
  });

  it('看得到的牌也算進去：中已經出現 3 張就不推薦大三元', () => {
    const hand = '🀄🀅🀅🀆🀆🀇🀈🀉🀙🀚🀛🀐🀑';
    const visible = new Array(34).fill(0);
    for (const k of uni(hand)) visible[k]++;
    visible[uni('🀄')[0]] = 4; // 自己 1 張＋河裡 3 張
    expect(recommendYaku({ ...input(hand), visible }, 20).map((x) => x.name)).not.toContain('大三元');
    expect(recommendYaku(input(hand), 20).map((x) => x.name)).toContain('大三元');
  });

  it('一定要拿到特定牌的牌型依那幾張牌估計：只有一張中的番牌，和牌率遠低於已有一對中', () => {
    // 123m 678p 789s 23s ＋ 中東（只有一張中）或 中中
    const yakuhai = (hand: string) => recommendYaku({ ...input(hand), drawsLeft: 15 }, 20).find((x) => x.name === '番牌')!;
    const one = yakuhai('🀇🀈🀉🀞🀟🀠🀖🀗🀘🀑🀒🀄🀀');
    const two = yakuhai('🀇🀈🀉🀞🀟🀠🀖🀗🀘🀑🀒🀄🀄');
    expect(one.winRate).toBeLessThan(two.winRate / 3);
  });

  it('還差很遠的牌型不會估出很高的和牌率（以前 5 向聽的三色同順估到 20% 以上）', () => {
    const hand = '🀏🀚🀝🀞🀟🀠🀔🀕🀖🀘🀀🀅🀆';
    const sanshoku = recommendYaku({ ...input(hand), drawsLeft: 15, minWinScore: 20 }, 20).find((x) => x.name === '三色同順')!;
    expect(sanshoku.shanten).toBeGreaterThanOrEqual(5);
    expect(sanshoku.winRate).toBeLessThan(0.06);
  });
});
