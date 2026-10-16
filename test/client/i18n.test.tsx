import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { LobbyScreen } from '../../src/client/components/Lobby.js';
import { FinalScreen, WaitingRoom } from '../../src/client/components/RoomScreens.js';
import { YakuTable } from '../../src/client/components/YakuTable.js';
import { appState, game, player, render, room, text } from '../support/snapshots.js';
import { DICTS, playerName, setLang, t, tileLabel, tn, windShort } from '../../src/client/i18n/index.js';
import { allKeys } from '../support/i18nKeys.js';
import { ReplayScreen } from '../../src/client/components/Replay.js';
import { anonymizeReplay, parseReplay } from '../../src/shared/replay.js';

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

  it('英文介面沒有漏翻的中文：大廳、等待房間、牌桌（打牌、鳴牌、結果）、最終結算、牌型表', () => {
    setLang('en');
    // 暱稱用英文，畫面上就不該再出現任何漢字（牌面是圖片，不算文字）
    const players = [0, 1, 2, 3].map((s) => player(s, { nickname: s === 0 ? 'Me' : `電腦 ${s}` }));
    const r = room({ players });
    const turn = game({ pending: { kind: 'turn', discard: [], tsumo: true, ankan: [27] }, myWaits: [{ kind: 5, left: 2 }], myWaitScore: { min: 20, max: 40 } });
    const claim = game({ phase: 'claim', currentSeat: 1, pending: { kind: 'claim', pon: true, chi: [[1, 5]], ron: true }, lastDiscard: { seat: 1, tile: 8 }, recentDiscard: { seat: 1, tile: 8 } });
    const result = game({
      phase: 'result',
      result: {
        kind: 'win',
        winners: [{ seat: 1, tsumo: false, from: 0, tile: 8, score: { form: 'standard', groups: [], yaku: [{ id: '3.1.2', name: '混一色', points: 40, count: 1 }], yakuPoints: 40, limit: false, baseScore: 0, total: 40 } }],
        tenpai: [],
        deltas: [-40, 40, 0, 0],
        lines: [],
        hands: [[], [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14], [], []],
        melds: [[], [], [], []],
        shown: [],
        acknowledged: [],
      },
    });
    const finished = room({
      players,
      status: 'finished',
      replays: [{ handNo: 1, result: result.result! }],
      history: [{ handNo: 1, startSeat: 0, kind: 'win', winners: [{ seat: 1, total: 40, tsumo: false, from: 0, yaku: ['混一色'] }], deltas: [-40, 40, 0, 0] }],
    });
    const screens = {
      lobby: renderToString(<LobbyScreen state={appState({ nickname: 'Me' })} />),
      waiting: renderToString(<WaitingRoom room={room({ players, status: 'waiting' })} />),
      turn: render(r, turn),
      claim: render(r, claim),
      result: render(r, result),
      spectator: render(room({ players, mySeat: null }), game({ myHand: [] })),
      final: renderToString(<FinalScreen room={finished} />),
      yaku: renderToString(<YakuTable advanced expansion />),
      replayPicker: renderToString(<ReplayScreen file={null} />),
      replay: renderToString(<ReplayScreen file={anonymizeReplay(parseReplay(readFileSync(new URL('../fixtures/replay-v1.json', import.meta.url), 'utf8')))} />),
    };
    expect(text(screens.turn)).toContain('Your turn');
    expect(text(screens.claim)).toContain('Pon');
    expect(text(screens.result)).toContain('Half Flush');
    expect(text(screens.final)).toContain('AI 1 won off Me 40 pts Half Flush');
    expect(text(screens.final)).toContain('Save replay file');
    expect(text(screens.replay)).toContain('Player 1');
    for (const [name, html] of Object.entries(screens)) {
      // 語言選單本來就用各語言自己的名字（繁體中文、日本語）
      const visible = text(html.replace(/<select aria-label="Language"[\s\S]*?<\/select>/g, ''));
      const leftovers = visible.match(/[\u4e00-\u9fff]+/g);
      expect(leftovers, name).toBeNull();
    }
  });
});

