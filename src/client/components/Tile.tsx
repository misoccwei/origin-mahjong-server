import { WHITE, kindOf, numOf, suitOf, type TileId, type TileKind } from '../../shared/tiles.js';

// 牌面圖：FluffyStuff/riichi-mahjong-tiles（CC0），放在 public/tiles
const HONOR_FILES = ['Ton', 'Nan', 'Shaa', 'Pei', 'Chun', 'Hatsu', 'Haku'];

import { tileLabel } from '../i18n/index.js';

export function faceUrl(k: TileKind) {
  const name = k < 27 ? ['Man', 'Pin', 'Sou'][suitOf(k)] + numOf(k) : HONOR_FILES[k - 27];
  return `/tiles/${name}.svg`;
}

const preloaded: HTMLImageElement[] = [];

/** 預先載入所有牌面與底圖，牌第一次出現時不會先露出空白的白色牌 */
export function preloadTiles() {
  if (preloaded.length > 0 || typeof Image === 'undefined') return;
  const urls = ['/tiles/Front.svg', '/tiles/Back.svg', ...Array.from({ length: 34 }, (_, k) => faceUrl(k))];
  for (const u of urls) {
    const img = new Image();
    img.src = u;
    preloaded.push(img);
  }
}

interface Props {
  tile?: TileId;
  kind?: TileKind;
  back?: boolean;
  small?: boolean;
  sideways?: boolean;
  selected?: boolean;
  dim?: boolean;
  highlight?: boolean;
  /** 與目前指著的手牌同種（河裡標紅） */
  match?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  title?: string;
}

export function Tile(p: Props) {
  const cls = ['tile'];
  if (p.small) cls.push('small');
  if (p.sideways) cls.push('sideways');
  if (p.selected) cls.push('selected');
  if (p.dim) cls.push('dim');
  if (p.highlight) cls.push('highlight');
  if (p.match) cls.push('match');
  if (p.onClick) cls.push('clickable');
  if (p.back) {
    return <span className={[...cls, 'back'].join(' ')} />;
  }
  const k = p.kind ?? kindOf(p.tile!);
  if (k === WHITE) cls.push('haku');
  return (
    <span
      className={cls.join(' ')}
      onClick={p.onClick}
      onMouseEnter={p.onMouseEnter}
      onMouseLeave={p.onMouseLeave}
      title={p.title ?? tileLabel(k)}
      role={p.onClick ? 'button' : undefined}
    >
      <img src={faceUrl(k)} alt={tileLabel(k)} draggable={false} />
    </span>
  );
}
