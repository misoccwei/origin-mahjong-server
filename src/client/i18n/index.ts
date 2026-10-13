import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react';
import type { TileKind } from '../../shared/tiles.js';
import { tileName } from '../../shared/tiles.js';
import { en } from './en.js';
import { ja } from './ja.js';

// 多國語言：繁體中文（原文）、英文、日文。
// 以繁體中文原文當作翻譯的 key：t('房間已滿')；英日文字典缺少時退回中文。
// 伺服器送來的錯誤訊息也是固定的中文字串，網頁端用同一份字典翻譯，協定不需要改。
// 變數用 {name}：t('第 {n} 局', { n: 3 })；要插入元件（例如牌）時用 tn()。

export type Lang = 'zh' | 'en' | 'ja';

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

export const DICTS: Record<Exclude<Lang, 'zh'>, Record<string, string>> = { en, ja };

const STORAGE_KEY = 'lang';
const HTML_LANG: Record<Lang, string> = { zh: 'zh-Hant', en: 'en', ja: 'ja' };

function detect(): Lang {
  // 伺服器渲染與測試（沒有 window）一律用中文
  if (typeof window === 'undefined') return 'zh';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en' || saved === 'ja') return saved;
  } catch {
    // 無法讀取時依瀏覽器語言
  }
  const nav = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('ja')) return 'ja';
  return 'en';
}

let lang: Lang = detect();
const listeners = new Set<() => void>();

function applyDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = HTML_LANG[lang];
  document.title = t('原點麻將');
}
applyDocument();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 無法儲存時只在這次有效
  }
  applyDocument();
  listeners.forEach((l) => l());
}

/** 讓元件在切換語言時重新渲染（App 最外層呼叫一次即可） */
export function useLang(): Lang {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => lang,
    () => lang,
  );
}

function lookup(key: string): string {
  return lang === 'zh' ? key : DICTS[lang][key] ?? key;
}

/** 翻譯；vars 取代 {name} */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = lookup(key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 翻譯並插入元件：tn('打出 {tile} 後聽：', { tile: <Tile .../> }) */
export function tn(key: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = lookup(key).split(/\{(\w+)\}/g);
  return createElement(
    Fragment,
    null,
    ...parts.map((p, i) => (i % 2 ? createElement(Fragment, { key: i }, vars[p] ?? `{${p}}`) : p)),
  );
}

const EN_HONORS = ['East', 'South', 'West', 'North', 'Red', 'Green', 'White'];
const EN_SUITS = ['Man', 'Pin', 'Sou'];

/** 牌名（提示文字、title 用） */
export function tileLabel(k: TileKind): string {
  if (lang !== 'en') return tileName(k);
  return k < 27 ? `${(k % 9) + 1} ${EN_SUITS[Math.floor(k / 9)]}` : EN_HONORS[k - 27];
}

/** 門風（東南西北）；英文用 E S W N */
export function windShort(k: TileKind): string {
  return lang === 'en' ? 'ESWN'[k - 27] : '東南西北'[k - 27];
}

/** 玩家名稱：電腦的名字是伺服器取的「電腦 N」，依語言顯示 */
export function playerName(p: { nickname: string | null; isAI?: boolean } | undefined): string {
  const name = p?.nickname ?? '';
  const m = p?.isAI ? /^電腦 (\d+)$/.exec(name) : null;
  return m ? t('電腦 {n}', { n: m[1] }) : name;
}
