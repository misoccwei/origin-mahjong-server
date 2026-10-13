import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_NAMES, YAKU } from '../../src/shared/scoring.js';
import { YAKU_INFO } from '../../src/shared/yakuInfo.js';

// 需要翻譯的字串：網頁程式中所有含中文的字串常值（註解除外）、伺服器送給玩家的訊息、牌型名稱／種類／說明。
// 翻譯以中文原文為 key，test/i18n.test.ts 用這份清單檢查英日文字典是否齊全。

const CJK = /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const root = new URL('../../', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** 去掉註解（// 與 /* *\/），保留字串 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => (m.startsWith('/*') ? '' : pre ?? ''));
}

/** 單引號字串常值 */
function literals(src: string): string[] {
  return [...stripComments(src).matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).filter((s) => CJK.test(s));
}

export function clientKeys(): string[] {
  const i18n = readFileSync(join(root, 'src/client/i18n/index.ts'), 'utf8');
  return [
    ...files(join(root, 'src/client'))
      .filter((f) => !f.includes('/i18n/'))
      .flatMap((f) => literals(readFileSync(f, 'utf8'))),
    // i18n 模組本身只取 t('…') 呼叫（其他是語言名稱等不需翻譯的字）
    ...[...stripComments(i18n).matchAll(/\bt\('((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]),
  ];
}

/** 伺服器送給玩家的訊息：fail('…')、message: '…'、reason: '…'、error: '…'，以及 hand.act 的回傳 */
export function serverKeys(): string[] {
  const out: string[] = [];
  for (const f of files(join(root, 'src/server'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(?:fail\(|message: |reason: |error: |return )'((?:[^'\\\n]|\\.)*)'/g)) if (CJK.test(m[1])) out.push(m[1]);
  }
  return out;
}

export function yakuKeys(): string[] {
  return [
    ...Object.values(YAKU).map((y) => y.name),
    ...Object.values(CATEGORY_NAMES),
    ...Object.values(YAKU_INFO).map((i) => i.desc),
  ];
}

export function allKeys(): string[] {
  return [...new Set([...clientKeys(), ...serverKeys(), ...yakuKeys()])];
}
