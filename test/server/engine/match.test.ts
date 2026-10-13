import { describe, expect, it } from 'vitest';
import { Match } from '../../../src/server/engine/match.js';
import { defaultSettings } from '../../../src/shared/rules.js';
import { playHandWithAI, seededRng } from '../../support/hand.js';

describe('一場牌局', () => {
  it('起始玩家每局輪替、加圈', () => {
    const m = new Match(defaultSettings(4), { firstStart: 2, rng: seededRng(3) });
    const starts: number[] = [];
    while (!m.finished) {
      starts.push(m.startSeat);
      playHandWithAI(m.startHand());
      m.completeHand();
    }
    expect(starts).toEqual([2, 3, 0, 1]);
    m.extend();
    expect(m.finished).toBe(false);
    expect(m.totalHands).toBe(8);
  });
});
