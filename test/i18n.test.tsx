import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DICTS, playerName, setLang, t, tileLabel, tn, windShort } from '../src/client/i18n/index.js';
import { allKeys } from './support/i18nKeys.js';

afterEach(() => setLang('zh'));

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('多國語言', () => {
  const keys = allKeys();

  it('程式裡用到的字串（含伺服器訊息、牌型名稱與說明）英日文都有翻譯', () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      const missing = keys.filter((k) => !(k in dict));
      expect(missing, `${lang} 缺少翻譯`).toEqual([]);
    }
  });

  it('翻譯保留相同的 {變數}，也沒有多餘（已不再使用）的字串', () => {
    const used = new Set(keys);
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(dict)) {
        expect(placeholders(v), `${lang}: ${k}`).toEqual(placeholders(k));
      }
      expect(Object.keys(dict).filter((k) => !used.has(k)), `${lang} 有多餘的字串`).toEqual([]);
    }
  });

  it('切換語言：t 取代變數，找不到的字串退回中文', () => {
    expect(t('第 {n} / {total} 局', { n: 2, total: 4 })).toBe('第 2 / 4 局');
    setLang('en');
    expect(t('第 {n} / {total} 局', { n: 2, total: 4 })).toBe('Hand 2 / 4');
    expect(t('不存在的字串')).toBe('不存在的字串');
    setLang('ja');
    expect(t('碰碰和')).toBe('対々和');
  });

  it('tn 可以插入元件；牌名、門風與電腦名稱依語言顯示', () => {
    setLang('en');
    expect(renderToStaticMarkup(<>{tn('打出 {tile} 後聽：', { tile: <b>X</b> })}</>)).toBe('Discard <b>X</b> to wait on:');
    expect(tileLabel(0)).toBe('1 Man');
    expect(tileLabel(31)).toBe('Red');
    expect(windShort(28)).toBe('S');
    expect(playerName({ nickname: '電腦 2', isAI: true })).toBe('AI 2');
    // 真人的暱稱照原樣
    expect(playerName({ nickname: '電腦 2', isAI: false })).toBe('電腦 2');
    setLang('zh');
    expect(tileLabel(0)).toBe('一萬');
    expect(windShort(28)).toBe('南');
  });
});
