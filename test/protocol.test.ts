import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

// 防止「改了協定卻沒加版本」：舊伺服器配新網頁時，畫面會因為缺欄位而壞掉，
// 而版本號正是連線時用來偵測這種情況的依據。
// protocol.ts 有任何變動時這個測試會失敗：請把 PROTOCOL_VERSION 加一，再把下面兩個值更新成錯誤訊息裡的新值。
const RECORDED = { version: 3, hash: '213dcd569fca89cf' };

describe('協定版本', () => {
  it('protocol.ts 變動時必須同時調整 PROTOCOL_VERSION', () => {
    const src = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(src).digest('hex').slice(0, 16);
    if (hash !== RECORDED.hash) {
      expect.fail(
        `protocol.ts 已變動（hash ${hash}）。請確認 PROTOCOL_VERSION 已從 ${RECORDED.version} 加一（目前 ${PROTOCOL_VERSION}），` +
          `再把 test/protocol.test.ts 的 RECORDED 更新為 { version: ${Math.max(PROTOCOL_VERSION, RECORDED.version + 1)}, hash: '${hash}' }。`,
      );
    }
    expect(PROTOCOL_VERSION).toBe(RECORDED.version);
  });
});
