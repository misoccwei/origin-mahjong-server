import { describe, expect, it } from 'vitest';
import type { HandResultView } from '../../src/shared/protocol.js';
import { HAND, game, render, room, text, tid } from '../support/snapshots.js';

describe('結算畫面', () => {
  const winHand = [0, 0, 1, 1, 2, 2, 9, 10, 11, 18, 19, 20, 27, 27].map((k, i) => tid(k, i % 2));
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
            yaku: [{ id: '2.2.1', name: '四清么', points: 10, count: 1 }, { id: '4.2.2', name: '二暗刻', points: 10, count: 1 }, { id: '3.0', name: '五門齊', points: 20, count: 1 }],
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
    expect(text(html)).toContain('最高分的和法：自摸「九萬」');
    expect(html).toContain('二暗刻');
    expect(html).toContain('五門齊');
    expect(html).toContain('最高和牌分數');
    // 實得 5 分 < 最高 40 分：說明被和牌者的分數限制
    expect(text(html)).toContain('實得 5 分');
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
