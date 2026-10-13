import { describe, expect, it } from 'vitest';
import { defaultSettings, type RuleSettings } from '../../../src/shared/rules.js';
import { playMatch } from '../../support/hand.js';

// 讓 AI 打完整場：每一步都檢查牌的總數不變、行動合法，零和式分數總和為 0。比較慢，但能抓到狀態機的邊角錯誤。

describe('AI 對局模擬', () => {
  const configs: [string, Partial<RuleSettings>][] = [
    ['4人基本加分式', { advanced: false }],
    ['4人進階加分式+換三張', { advanced: true, passThree: true }],
    ['4人進階零和式+小牌限制', { advanced: true, scoring: 'zeroSum', smallHandLimit: true }],
    ['4人基本零和式', { advanced: false, scoring: 'zeroSum' }],
    ['4人初學者 AI', { aiLevel: 'beginner' }],
    ['4人簡單 AI', { aiLevel: 'easy' }],
    ['4人困難 AI', { aiLevel: 'hard', scoring: 'zeroSum' }],
  ];
  for (const [name, extra] of configs) {
    it(name, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const s = { ...defaultSettings(4), ...extra };
        const m = playMatch(s, seed);
        expect(m.history.length).toBe(4);
        if (s.scoring === 'zeroSum') expect(m.scores.reduce((a, b) => a + b, 0)).toBe(0);
      }
    });
  }
  it('2人、3人', () => {
    for (const pc of [2, 3] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const s = { ...defaultSettings(pc), advanced: seed % 2 === 0, passThree: true, scoring: seed > 2 ? ('zeroSum' as const) : ('additive' as const) };
        const m = playMatch(s, seed * 7);
        expect(m.history.length).toBe(pc * 2);
        if (s.scoring === 'zeroSum') expect(m.scores.reduce((a, b) => a + b, 0)).toBe(0);
      }
    }
  });
});
