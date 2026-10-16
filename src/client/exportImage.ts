import type { HandResultView, RoomView } from '../shared/protocol.js';
import type { Meld } from '../shared/rules.js';
import type { HandScore } from '../shared/scoring.js';
import { WHITE, kindOf, type TileId, type TileKind } from '../shared/tiles.js';
import { playerName, t, tileLabel } from './i18n/index.js';
import { faceUrl } from './components/Tile.js';
import { toast } from './net.js';

// 結算畫面匯出成圖片：直接用 canvas 畫（不依賴 DOM 截圖，iOS Safari 也能正確畫出牌面 SVG）。
// 手機用系統分享（可以存到相簿），電腦直接下載 PNG。

const W = 720;
const PAD = 24;
const TW = 30; // 牌寬
const TH = 40;
const FONT = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif";
const C = { bg: '#12372a', panel: '#fbfaf6', ink: '#1f2421', muted: '#6b726e', win: '#c0392b', tenpai: '#2f80ed', pos: '#1f7a3a', neg: '#b3261e', gold: '#d4a017', edge: '#d9d2bd' };

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string) {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

/** 先畫在高度足夠的畫布上，最後依實際用到的高度裁切 */
class Painter {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  y = PAD;
  /** 量高度用：只計算位置、不畫 */
  dry = false;
  private faces = new Map<string, HTMLImageElement>();

  constructor(maxHeight: number) {
    const scale = 2;
    this.canvas.width = W * scale;
    this.canvas.height = maxHeight * scale;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(scale, scale);
    this.ctx.fillStyle = C.bg;
    this.ctx.fillRect(0, 0, W, maxHeight);
    this.ctx.textBaseline = 'middle';
  }

  async preload(kinds: TileKind[]) {
    const srcs = [...new Set(kinds.filter((k) => k !== WHITE).map(faceUrl)), '/tiles/Back.svg'];
    await Promise.all(srcs.map(async (s) => this.faces.set(s, await loadImage(s).catch(() => null as unknown as HTMLImageElement))));
  }

  font(size: number, weight = 400) {
    this.ctx.font = `${weight} ${size}px ${FONT}`;
  }

  text(s: string, x: number, y: number, opts: { size?: number; weight?: number; color?: string; align?: CanvasTextAlign } = {}) {
    this.font(opts.size ?? 15, opts.weight ?? 400);
    this.ctx.fillStyle = opts.color ?? C.ink;
    this.ctx.textAlign = opts.align ?? 'left';
    if (!this.dry) this.ctx.fillText(s, x, y);
    return this.ctx.measureText(s).width;
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) {
    if (this.dry) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  tile(x: number, y: number, kind: TileKind | null, highlight = false) {
    if (this.dry) return;
    const ctx = this.ctx;
    if (kind === null) {
      this.roundRect(x, y, TW, TH, 4, '#e8742c');
      const back = this.faces.get('/tiles/Back.svg');
      if (back) ctx.drawImage(back, x, y, TW, TH);
      return;
    }
    this.roundRect(x, y, TW, TH, 4, '#fffdf5', highlight ? C.gold : C.edge);
    if (highlight) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.gold;
      ctx.stroke();
    }
    if (kind === WHITE) {
      ctx.strokeStyle = '#3d6fb0';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + TW * 0.22, y + TH * 0.18, TW * 0.56, TH * 0.64);
      return;
    }
    const img = this.faces.get(faceUrl(kind));
    if (img) ctx.drawImage(img, x + TW * 0.1, y + TH * 0.08, TW * 0.8, TH * 0.84);
  }

  /** 手牌一排：hand、和牌的那張（隔開並標亮）、鳴牌；空間不夠時換行 */
  handRow(x0: number, maxX: number, hand: TileId[], melds: Meld[], extra?: TileKind) {
    let x = x0;
    const step = TW + 1;
    const wrap = (need: number) => {
      if (x + need > maxX) {
        x = x0;
        this.y += TH + 6;
      }
    };
    for (const t of hand) {
      wrap(step);
      this.tile(x, this.y, kindOf(t));
      x += step;
    }
    if (extra !== undefined) {
      x += 8;
      wrap(step);
      this.tile(x, this.y, extra, true);
      x += step;
    }
    for (const m of melds) {
      x += 10;
      wrap(m.tiles.length * step);
      m.tiles.forEach((t, i) => {
        const hidden = t < 0 || (m.type === 'ankan' && (i === 0 || i === 3));
        this.tile(x, this.y, hidden ? null : kindOf(t));
        x += step;
      });
    }
    this.y += TH;
  }

  /** 牌型明細：一行放不下就換行 */
  chips(x0: number, maxX: number, items: string[], total: string) {
    let x = x0;
    const h = 24;
    const all = [...items.map((s) => ({ s, total: false })), { s: total, total: true }];
    for (const { s, total: isTotal } of all) {
      this.font(13, isTotal ? 700 : 400);
      const w = this.ctx.measureText(s).width + 18;
      if (x + w > maxX) {
        x = x0;
        this.y += h + 6;
      }
      this.roundRect(x, this.y, w, h, 12, isTotal ? C.ink : '#fff', isTotal ? undefined : '#e2dccb');
      this.text(s, x + 9, this.y + h / 2, { size: 13, weight: isTotal ? 700 : 400, color: isTotal ? '#fff' : C.ink });
      x += w + 6;
    }
    this.y += h;
  }

  /** 依實際內容高度裁切 */
  finish(): HTMLCanvasElement {
    const h = Math.ceil(this.y + PAD);
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = h * 2;
    out.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return out;
  }
}

const signed = (d: number) => (d > 0 ? `+${d}` : `${d}`);
const deltaColor = (d: number) => (d > 0 ? C.pos : d < 0 ? C.neg : C.muted);

function scoreChips(score: HandScore) {
  const items = score.baseScore > 0 ? [t('和牌底分 {n}', { n: score.baseScore })] : [];
  for (const y of score.yaku) items.push(`${t(y.name)}${y.count > 1 ? ` ×${y.count}` : ''} ${y.points}`);
  return items;
}

function header(p: Painter, room: RoomView, subtitle: string, title: string) {
  p.text(t('原點麻將'), PAD, p.y + 12, { size: 14, weight: 700, color: C.gold });
  p.text(`${t('房號 {id}', { id: room.id })}${t('・')}${subtitle}${t('・')}${new Date().toLocaleString()}`, W - PAD, p.y + 12, { size: 13, color: '#b7cfc3', align: 'right' });
  p.y += 34;
  p.text(title, PAD, p.y + 16, { size: 26, weight: 800, color: '#fff' });
  p.y += 44;
}

/** 一局的結果；totals 為這一局結束後的累計分數 */
export async function renderHandResult(
  room: RoomView,
  { handNo, totalHands, result: r, totals }: { handNo: number; totalHands: number; result: HandResultView; totals: number[] },
): Promise<HTMLCanvasElement> {
  const names = room.players.map((p) => (p.nickname ? playerName(p) : '-'));
  const p = new Painter(3000);
  const kinds = [...r.hands.flat(), ...r.melds.flat().flatMap((m) => m.tiles)].filter((t) => t >= 0).map(kindOf);
  kinds.push(...r.tenpai.flatMap((x) => [...x.waits, x.best.tile]));
  await p.preload(kinds);

  const title = r.kind === 'draw' ? t('流局') : r.winners.map((w) => t(w.tsumo ? '{name} 自摸' : '{name} 和牌', { name: names[w.seat] })).join(t('、'));
  header(p, room, t('第 {n} / {total} 局', { n: handNo, total: totalHands }), title);

  const winnerOf = (s: number) => r.winners.find((w) => w.seat === s);
  const tenpaiOf = (s: number) => (winnerOf(s) ? undefined : r.tenpai.find((t) => t.seat === s));
  const order = room.players.map((x) => x.seat).sort((a, b) => {
    const rank = (s: number) => (winnerOf(s) ? 0 : tenpaiOf(s) ? 1 : 2);
    return rank(a) - rank(b) || a - b;
  });
  const left = PAD + 16;
  const right = W - PAD - 16;
  for (const s of order) {
    const w = winnerOf(s);
    const tp = tenpaiOf(s);
    const visible = r.hands[s].length > 0;
    const top = p.y;
    // 同一段程式跑兩次：第一次只量高度（dry），畫好卡片背景後再真的畫內容
    const draw = () => {
      p.y = top + 12;
      const tag = w ? (w.tsumo ? t('自摸') : t('銃和・放銃 {name}', { name: names[w.from!] })) : tp ? t('聽牌') : r.shown.includes(s) ? t('展示手牌') : t('未聽牌');
      const nw = p.text(names[s], left, p.y + 11, { size: 17, weight: 700 });
      p.font(12, 700);
      const tw = p.ctx.measureText(tag).width + 16;
      p.roundRect(left + nw + 10, p.y + 1, tw, 20, 10, w ? C.win : tp ? C.tenpai : '#ece8dc');
      p.text(tag, left + nw + 18, p.y + 11, { size: 12, weight: 700, color: w || tp ? '#fff' : C.muted });
      p.text(signed(r.deltas[s]), right, p.y + 11, { size: 19, weight: 800, color: deltaColor(r.deltas[s]), align: 'right' });
      p.y += 30;
      if (tp) {
        p.text(`${t('聽 {tiles}', { tiles: tp.waits.map(tileLabel).join(t('、')) })}${t('・')}${t(tp.best.tsumo ? '最高分的和法：自摸「{tile}」' : '最高分的和法：銃和「{tile}」', { tile: tileLabel(tp.best.tile) })}`, left, p.y + 9, { size: 13, color: C.muted });
        p.y += 24;
      }
      if (visible) {
        const hand = w ? r.hands[s].filter((x) => x !== w.tile) : r.hands[s];
        p.handRow(left, right, hand, r.melds[s], w ? kindOf(w.tile) : tp?.best.tile);
        p.y += 10;
      }
      if (w || tp) {
        const score = (w ?? tp!.best).score;
        p.chips(left, right, scoreChips(score), `${w ? t('和牌分數') : t('最高和牌分數')}${score.limit ? t('（滿貫）') : ''} ${score.total}`);
        p.y += 6;
      }
    };
    p.dry = true;
    draw();
    p.dry = false;
    const height = p.y - top + 6;
    p.roundRect(PAD, top, W - 2 * PAD, height, 10, w ? '#fff8f6' : tp ? '#f5f9ff' : C.panel);
    p.roundRect(PAD, top, 5, height, 2, w ? C.win : tp ? C.tenpai : '#c9c4b5');
    draw();
    p.y = Math.max(p.y, top + height) + 10;
  }

  // 分數表
  const rowH = 30;
  const top = p.y;
  p.roundRect(PAD, top, W - 2 * PAD, rowH * room.players.length + 12, 10, C.panel);
  p.y += 6;
  for (const pl of room.players) {
    const d = r.deltas[pl.seat];
    p.text(names[pl.seat], left, p.y + rowH / 2, { size: 15, weight: 600 });
    p.text(signed(d), right - 120, p.y + rowH / 2, { size: 15, weight: 700, color: deltaColor(d), align: 'right' });
    p.text(String(totals[pl.seat]), right, p.y + rowH / 2, { size: 15, weight: 700, align: 'right' });
    p.y += rowH;
  }
  p.y += 6;
  return p.finish();
}

/** 最終結算：排名與各局紀錄 */
export async function renderFinal(room: RoomView): Promise<HTMLCanvasElement> {
  const names = room.players.map((x) => (x.nickname ? playerName(x) : '-'));
  const p = new Painter(1200 + room.history.length * 60);
  header(p, room, t('共 {n} 局', { n: room.history.length }), room.dissolved ? t('牌局已解散') : t('最終結算'));
  const ranking = [...room.players].sort((a, b) => b.score - a.score);
  const left = PAD + 16;
  const right = W - PAD - 16;
  const rowH = 40;
  p.roundRect(PAD, p.y, W - 2 * PAD, rowH * ranking.length + 12, 10, C.panel);
  p.y += 6;
  ranking.forEach((pl, i) => {
    const cy = p.y + rowH / 2;
    p.roundRect(left, cy - 13, 26, 26, 13, i === 0 ? C.gold : '#ece8dc');
    p.text(String(i + 1), left + 13, cy, { size: 14, weight: 800, color: i === 0 ? '#fff' : C.ink, align: 'center' });
    p.text(names[pl.seat], left + 40, cy, { size: 17, weight: 700 });
    p.text(String(pl.score), right, cy, { size: 20, weight: 800, align: 'right' });
    p.y += rowH;
  });
  p.y += 22;

  if (room.history.length) {
    p.text(t('各局紀錄'), PAD, p.y + 10, { size: 17, weight: 700, color: '#fff' });
    p.y += 28;
    const n = room.players.length;
    const colW = 64;
    const colX = (i: number) => right - (n - 1 - i) * colW;
    const textMax = colX(0) - colW - left - 36;
    const top = p.y;
    const lines = room.history.map((h) =>
      h.kind === 'draw'
        ? t('流局')
        : h.winners
            .map((w) =>
              t(w.tsumo ? '{name} 自摸 {total}分 {yaku}' : '{name} 銃和（{from}） {total}分 {yaku}', {
                name: names[w.seat],
                from: names[w.from!] ?? '',
                total: w.total,
                yaku: w.yaku.map((y) => t(y)).join(t('・')),
              }),
            )
            .join(' / '),
    );
    // 結果文字太長時截斷
    p.font(13);
    const fit = (s: string) => {
      if (p.ctx.measureText(s).width <= textMax) return s;
      while (s.length && p.ctx.measureText(s + '…').width > textMax) s = s.slice(0, -1);
      return s + '…';
    };
    const rowH2 = 28;
    p.roundRect(PAD, top, W - 2 * PAD, rowH2 * (room.history.length + 2) + 12, 10, C.panel);
    p.y += 6;
    const cy = () => p.y + rowH2 / 2;
    p.text(t('局'), left, cy(), { size: 13, weight: 700, color: C.muted });
    p.text(t('結果'), left + 36, cy(), { size: 13, weight: 700, color: C.muted });
    names.forEach((nm, i) => p.text(fitTo(p, nm, colW - 6), colX(i), cy(), { size: 13, weight: 700, color: C.muted, align: 'right' }));
    p.y += rowH2;
    room.history.forEach((h, idx) => {
      p.text(String(h.handNo), left, cy(), { size: 13 });
      p.text(fit(lines[idx]), left + 36, cy(), { size: 13 });
      h.deltas.forEach((d, i) => p.text(signed(d), colX(i), cy(), { size: 13, weight: 600, color: deltaColor(d), align: 'right' }));
      p.y += rowH2;
    });
    p.text(t('合計'), left, cy(), { size: 13, weight: 700 });
    room.players.forEach((pl) => p.text(String(pl.score), colX(pl.seat), cy(), { size: 13, weight: 800, align: 'right' }));
    p.y += rowH2 + 6;
  }
  return p.finish();
}

function fitTo(p: Painter, s: string, max: number) {
  p.font(13, 700);
  if (p.ctx.measureText(s).width <= max) return s;
  while (s.length && p.ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/** 存成圖片：手機（可分享檔案時）用系統分享，可以存到相簿；其他情況直接下載 */
export async function saveCanvas(canvas: HTMLCanvasElement, filename: string) {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error(t('無法產生圖片'));
  await saveFile(new File([blob], filename, { type: 'image/png' }));
}

/** 存檔：手機（可分享檔案時）用系統分享（可以直接傳到 LINE、存到相簿），其他情況直接下載 */
export async function saveFile(file: File) {
  const filename = file.name;
  const blob = file;
  const mobile = window.matchMedia?.('(pointer: coarse)').matches;
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      // 只分享檔案：帶 title／text 的話，LINE 等 App 會多送一則檔名文字訊息
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // 分享失敗時改用下載
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 匯出按鈕用：產生並存檔，失敗時提示 */
export async function exportImage(render: () => Promise<HTMLCanvasElement>, filename: string) {
  try {
    await saveCanvas(await render(), filename);
  } catch (e) {
    toast(t('匯出圖片失敗：{error}', { error: (e as Error).message }));
  }
}
