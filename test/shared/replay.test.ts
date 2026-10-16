import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anonymizeReplay, parseReplay, replayFrame } from '../../src/shared/replay.js';
import { REPLAY_SCHEMA_VERSION } from '../../src/shared/replaySchema.js';

// 回放檔格式：分享出去的檔案會留很久，格式變動要加版本並寫轉換，舊檔才看得了。
// replaySchema.ts 的程式（不含註解、空白與版本號本身）有變動時第一個測試會失敗：
// 請把 REPLAY_SCHEMA_VERSION 加一、在 replay.ts 的 MIGRATIONS 補上轉換、放一個新版的範例檔到 test/fixtures/，
// 再把下面兩個值更新成錯誤訊息裡的新值。只改註解不需要加版本。
const RECORDED = { version: 1, hash: 'a17fa7ab78e7032f' };

const schemaSrc = readFileSync(new URL('../../src/shared/replaySchema.ts', import.meta.url), 'utf8');
const fixtureDir = new URL('../fixtures/', import.meta.url);
const fixtures = readdirSync(fixtureDir).filter((f) => /^replay-v\d+\.json$/.test(f));

describe('回放檔格式', () => {
  it('replaySchema.ts 變動時必須同時調整 REPLAY_SCHEMA_VERSION', () => {
    const src = schemaSrc
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .replace(/export const REPLAY_SCHEMA_VERSION = \d+;/, '')
      .replace(/\s+/g, ' ');
    const hash = createHash('sha256').update(src).digest('hex').slice(0, 16);
    if (hash !== RECORDED.hash) {
      expect.fail(
        `replaySchema.ts 已變動（hash ${hash}）。請確認 REPLAY_SCHEMA_VERSION 已從 ${RECORDED.version} 加一（目前 ${REPLAY_SCHEMA_VERSION}）、` +
          `replay.ts 的 MIGRATIONS 已補上轉換、test/fixtures/ 已放新版範例檔，` +
          `再把 test/shared/replay.test.ts 的 RECORDED 更新為 { version: ${Math.max(REPLAY_SCHEMA_VERSION, RECORDED.version + 1)}, hash: '${hash}' }。`,
      );
    }
    expect(REPLAY_SCHEMA_VERSION).toBe(RECORDED.version);
  });

  it('replaySchema.ts 不 import 其他型別（否則格式會跟著別的檔案悄悄改變）', () => {
    expect(schemaSrc).not.toMatch(/^\s*import\b/m);
  });

  it('每一版都有範例檔', () => {
    for (let v = 1; v <= REPLAY_SCHEMA_VERSION; v++) expect(fixtures).toContain(`replay-v${v}.json`);
  });

  for (const name of fixtures) {
    it(`${name}：讀得出來，每一局都能播完且與局結果一致`, () => {
      const f = parseReplay(readFileSync(new URL(name, fixtureDir), 'utf8'));
      expect(f.schema).toBe(REPLAY_SCHEMA_VERSION);
      for (const h of f.hands) {
        const end = replayFrame(h, h.events.length);
        end.hands.forEach((hand, s) => {
          const all = end.drawn[s] !== null ? [...hand, end.drawn[s]!] : hand;
          expect([...all].sort((a, b) => a - b)).toEqual([...h.result.hands[s]].sort((a, b) => a - b));
        });
      }
    });
  }
});

describe('讀取回放檔', () => {
  const sample = () => JSON.parse(readFileSync(new URL('replay-v1.json', fixtureDir), 'utf8'));

  it('不是回放檔、來自較新版本、內容損毀時給出對應的錯誤', () => {
    expect(() => parseReplay('not json')).toThrow('這不是原點麻將的回放檔');
    expect(() => parseReplay({ format: 'x', schema: 1 })).toThrow('這不是原點麻將的回放檔');
    expect(() => parseReplay({ ...sample(), schema: REPLAY_SCHEMA_VERSION + 1 })).toThrow('這個回放檔來自較新的版本，請重新整理網頁後再試');
    expect(() => parseReplay({ ...sample(), hands: [] })).toThrow('回放檔已損毀，無法讀取');
    const bad = sample();
    bad.hands[0].events.push({ t: 'discard', s: 9, tile: 0 });
    expect(() => parseReplay(bad)).toThrow('回放檔已損毀，無法讀取');
  });

  it('匿名：真人的名字清空，電腦的名字保留', () => {
    const f = anonymizeReplay(parseReplay(sample()));
    expect(f.anonymous).toBe(true);
    expect(f.players.map((p) => p.name)).toEqual(['', '電腦 1', '', '電腦 2']);
  });

  it('第 0 步是配牌，超出範圍的步數會夾在頭尾', () => {
    const h = parseReplay(sample()).hands[0];
    expect(replayFrame(h, -5)).toEqual(replayFrame(h, 0));
    expect(replayFrame(h, 0).hands).toEqual(h.deal.map((d) => [...d].sort((a, b) => a - b)));
    expect(replayFrame(h, 99999)).toEqual(replayFrame(h, h.events.length));
  });
});
