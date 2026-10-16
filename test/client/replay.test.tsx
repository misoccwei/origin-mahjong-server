import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplayScreen } from '../../src/client/components/Replay.js';
import { anonymizeReplay, parseReplay } from '../../src/shared/replay.js';
import { text } from '../support/snapshots.js';

// 回放頁面：選擇檔案的畫面、播放畫面（第 0 步＝配牌，四家手牌正面朝上）

const sample = () => parseReplay(readFileSync(new URL('../fixtures/replay-v1.json', import.meta.url), 'utf8'));

describe('回放頁面', () => {
  it('沒有載入檔案時顯示選擇檔案', () => {
    const html = text(renderToString(<ReplayScreen file={null} />));
    expect(html).toContain('牌局回放');
    expect(html).toContain('選擇回放檔，或拖曳到這裡');
  });

  it('播放畫面：從配牌開始，四家手牌都正面朝上，有播放控制與局數', () => {
    const f = sample();
    const raw = renderToString(<ReplayScreen file={f} />);
    const html = text(raw);
    expect(html).toContain('配牌');
    expect(html).toContain(`第 0 / ${f.hands[0].events.length} 步`);
    expect(html).toContain(`第 1 / ${f.hands.length} 局`);
    expect(html).toContain('播放');
    expect(html).toContain('小明');
    expect(html).toContain('Alice');
    expect(html).toContain('電腦 1');
    expect((raw.match(/class="side-hand face-up"/g) ?? []).length).toBe(4);
    expect(raw).not.toMatch(/class="tile back"/);
  });

  it('匿名的回放：真人顯示為「玩家 N」', () => {
    const html = text(renderToString(<ReplayScreen file={anonymizeReplay(sample())} />));
    expect(html).toContain('玩家 1');
    expect(html).toContain('玩家 3');
    expect(html).not.toContain('小明');
    expect(html).toContain('匿名');
  });
});
