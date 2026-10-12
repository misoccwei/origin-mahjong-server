import { describe, expect, it } from 'vitest';
import { YAKU, evaluateWin } from '../src/shared/scoring.js';
import { YAKU_INFO } from '../src/shared/yakuInfo.js';
import { meld, uni } from './helpers.js';

// 牌型表的資料與計分程式一致：每個牌型都有說明，每個牌例都真的會計到該牌型
describe('牌型表', () => {
  it('每個牌型都有說明', () => {
    for (const id of Object.keys(YAKU)) expect(YAKU_INFO[id]?.desc, id).toBeTruthy();
  });

  for (const [id, info] of Object.entries(YAKU_INFO)) {
    if (!info.example) continue;
    const y = YAKU[id];
    it(`${id} ${y.name} 的牌例`, () => {
      const ex = info.example!;
      const melds = (ex.melds ?? []).map((m) => meld(m));
      const win = uni(ex.win!)[0];
      const s = evaluateWin({
        concealed: [...uni(ex.hand), win],
        melds,
        winTile: win,
        tsumo: !!ex.tsumo,
        seatWind: 27,
        advanced: !!y.advanced || !!y.expansion,
        expansion: !!y.expansion,
        baseScore: 0,
      });
      expect(s, '應為和牌形').not.toBeNull();
      // 滿貫時只留最高的滿貫牌型，所以只檢查非滿貫牌例
      if (!s!.limit || y.points >= 160) expect(s!.yaku.map((h) => h.name)).toContain(y.name);
    });
  }
});
