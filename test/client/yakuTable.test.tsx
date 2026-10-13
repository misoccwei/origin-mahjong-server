import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { YakuTable } from '../../src/client/components/YakuTable.js';
import { text } from '../support/snapshots.js';

describe('牌型表', () => {
  it('列出所有牌型（含擴充與改名後的清么），並有種類與分數篩選', () => {
    const html = renderToString(<YakuTable />);
    expect(html).toContain('四清么');
    expect(html).not.toContain('二對清么');
    expect(html).toContain('十三不搭');
    expect(html).toContain('對稱類');
    expect(html).toContain('任何分數');
    expect(text(html)).toContain('共 76 個牌型');
  });

  it('牌局中預設只列出這桌適用的牌型', () => {
    const name = (n: string) => new RegExp(`class="yaku-name">${n}<`);
    expect(renderToString(<YakuTable advanced expansion={false} defaultShowAll={false} />)).not.toMatch(name('十三不搭'));
    expect(renderToString(<YakuTable advanced expansion={false} defaultShowAll={false} />)).toMatch(name('七對子'));
    expect(renderToString(<YakuTable advanced={false} expansion={false} defaultShowAll={false} />)).not.toMatch(name('七對子'));
  });
});
