import { useMemo, useState } from 'react';
import { CATEGORY_NAMES, YAKU, type YakuDef } from '../../shared/scoring.js';
import { parseUnicodeTiles } from '../../shared/tiles.js';
import { YAKU_INFO, type YakuExample } from '../../shared/yakuInfo.js';
import { Tile } from './Tile.js';
import { t } from '../i18n/index.js';

const POINT_STEPS = [5, 10, 20, 40, 80, 160, 320];

function ExampleTiles({ ex }: { ex: YakuExample }) {
  return (
    <div className="yaku-example">
      {parseUnicodeTiles(ex.hand).map((k, i) => (
        <Tile key={'h' + i} kind={k} small />
      ))}
      {(ex.melds ?? []).map((m, i) => (
        <span key={'m' + i} className="ex-meld">
          {parseUnicodeTiles(m).map((k, j) => (
            <Tile key={j} kind={k} small />
          ))}
        </span>
      ))}
      {ex.win && (
        <span className="ex-win">
          <span className="small muted">{ex.tsumo ? t('自摸') : t('和')}</span>
          <Tile kind={parseUnicodeTiles(ex.win)[0]} small highlight />
        </span>
      )}
    </div>
  );
}

/**
 * 牌型表：可以依種類或分數快速篩選。
 * advanced／expansion 是目前桌上的規則，用來標示「這桌不適用」的牌型；showAll 可以切換是否列出不適用的牌型。
 */
export function YakuTable({ advanced, expansion, defaultShowAll = true }: { advanced?: boolean; expansion?: boolean; defaultShowAll?: boolean }) {
  const [category, setCategory] = useState<number | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(defaultShowAll);
  const applies = (y: YakuDef) => (!y.advanced || !!advanced) && (!y.expansion || !!expansion);
  const list = useMemo(
    () =>
      Object.values(YAKU)
        .filter((y) => (category === null || y.category === category) && (points === null || y.points === points) && (showAll || applies(y)))
        .sort((a, b) => a.category - b.category || a.id.localeCompare(b.id, 'en', { numeric: true })),
    [category, points, showAll, advanced, expansion],
  );
  const categories = [...new Set(Object.values(YAKU).map((y) => y.category))].sort((a, b) => a - b);
  return (
    <div className="yaku-table">
      <div className="yaku-filters">
        <div className="filter-row">
          <button className={`filter ${category === null ? 'on' : ''}`} onClick={() => setCategory(null)}>{t('全部')}</button>
          {categories.map((c) => (
            <button key={c} className={`filter ${category === c ? 'on' : ''}`} onClick={() => setCategory(category === c ? null : c)}>
              {t(CATEGORY_NAMES[c])}
            </button>
          ))}
        </div>
        <div className="filter-row">
          <button className={`filter ${points === null ? 'on' : ''}`} onClick={() => setPoints(null)}>{t('任何分數')}</button>
          {POINT_STEPS.map((p) => (
            <button key={p} className={`filter ${points === p ? 'on' : ''}`} onClick={() => setPoints(points === p ? null : p)}>
              {p}
            </button>
          ))}
        </div>
        {(advanced !== undefined || expansion !== undefined) && (
          <label className="toggle small">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            {t('也列出這桌不適用的牌型')}
          </label>
        )}
      </div>
      <div className="small muted">{t('共 {n} 個牌型', { n: list.length })}</div>
      <ul className="yaku-list">
        {list.map((y) => {
          const info = YAKU_INFO[y.id];
          return (
            <li key={y.id} className={applies(y) || advanced === undefined ? '' : 'na'}>
              <div className="yaku-head">
                <span className="yaku-id">{y.id}</span>
                <span className="yaku-name">{t(y.name)}</span>
                {y.advanced && <span className="tag adv">{t('進階')}</span>}
                {y.expansion && <span className="tag exp">{t('擴充')}</span>}
                <span className="yaku-pts">
                  {t(y.perGroup ? '每組 {n} 分' : '{n} 分', { n: y.points })}
                  {y.points >= 160 ? t('・滿貫') : ''}
                </span>
              </div>
              <div className="yaku-desc">{info ? t(info.desc) : null}</div>
              {info?.example && <ExampleTiles ex={info.example} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
