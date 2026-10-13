import type { RecommendInput } from './recommend.js';
import type { Meld } from './rules.js';
import { evaluateWin } from './scoring.js';
import { shanten } from './shanten.js';
import { KIND_COUNT, countKinds, isYaochu, kindOf, type TileKind } from './tiles.js';

// 推薦牌型（進階型）：結果導向，以「期望得分」比較打法。
// 往下展開「拿到哪張牌 → 打哪張」直到聽牌、和牌：
// - 拿牌的方式有自己摸、碰（任何一家打出）、吃（上家打出）；聽牌時可以自摸，也可以銃和他家打出的牌；
// - 每巡各種事件的機率依剩下的張數估計（他家打出的牌打 CALL_RATE 折），再依剩下的巡數逐巡計算，
//   所以「快但便宜」與「慢但高分」可以直接比較；每一步都可以選擇不要（摸切、不鳴）；
// - 鳴牌除了讓向聽數前進，也可以只為了做牌（例如碰中：向聽數不變但多了番牌）；
//   目前已聽牌時另外考慮改聽：摸到某張後換成分數更高或更好和的聽牌；
// - 和牌分數用實際計分（自摸、銃和分開算，不含偶然類），未達和牌最低分數的和法不算；
// - 每巡也有一定機率被他家先和走。
// 結果：每種打法（打哪張、要不要鳴）的和牌率與期望得分，以及第一張進牌（摸、碰、吃、和）依最可能的和法分組。
// 聽的牌以向聽數判斷（不含擴充包的十三不搭）。計算量隨向聽數暴增，只算到 2 向聽。

export const OUTCOME_MAX_SHANTEN = 2;
/** 他家打出一張牌、自己能鳴到（或銃和）的折扣：他家會留牌，也不一定輪得到 */
const CALL_RATE = 0.3;
/** 每巡每位他家先和牌的機率 */
const OTHER_WIN_RATE = 0.03;
/** 手上多一張時，先粗算每種打法，只替前幾名再算改聽（改聽要看的局面很多） */
const LATERAL_PLANS = 3;

/** 怎麼拿到這張牌：摸進、碰、吃；和 = 自摸或銃和這張 */
export type OutcomeVia = 'draw' | 'pon' | 'chi' | 'win';

export interface OutcomeGroup {
  via: OutcomeVia;
  /** 拿到這些牌（聽牌時 via = win 是和這些牌；via = draw 是摸到後改聽） */
  draws: TileKind[];
  /** 這些牌還沒看到的張數 */
  left: number;
  /** 最可能的和法 */
  total: number;
  yaku: string[];
  /** 第一張進牌是這一組、最後和牌的機率 */
  rate: number;
}

export interface OutcomePlan {
  /** 鳴目前打出的這張牌（type 與鳴牌後的面子） */
  call?: { type: 'pon' | 'chi'; kinds: TileKind[] };
  /** 手上多一張（或鳴牌後）：先打這張 */
  discard?: TileKind;
  /** 打完後的向聽數；0 = 已聽牌 */
  shanten: number;
  /** 和牌率與期望得分（和牌分數 × 機率） */
  winRate: number;
  ev: number;
  groups: OutcomeGroup[];
}

export interface OutcomeResult {
  /** 目前的向聽數（手上多一張時為打掉最好的一張後） */
  shanten: number;
  plans: OutcomePlan[];
  /** 向聽數太多，沒有計算 */
  tooFar: boolean;
}

interface Final {
  total: number;
  yaku: string[];
}

/** 一個局面（自己打完牌、輪到他家）：index t = 自己還能摸幾次 */
interface Node {
  /** 期望得分 */
  v: Float64Array;
  /** 和牌率 */
  w: Float64Array;
  /** 最可能的和法 */
  rep: Final | null;
}

/** 這一巡可能發生的事：他家打出（碰、吃、銃和）或自己摸進（摸、自摸） */
interface Event {
  via: OutcomeVia;
  tile: TileKind;
  /** 他家打出的（先發生，鳴牌不用消耗自己的摸牌） */
  opp: boolean;
  /** 每巡發生的機率 */
  p: number;
  /** 和牌：分數與牌型 */
  win?: Final;
  /** 拿到後打牌的各種選擇 */
  next: Node[];
}

interface State {
  /** 手牌（不含鳴牌） */
  c: number[];
  melds: Meld[];
  /** 鳴牌後才有的面子用到的牌（各牌種張數） */
  inMeld: number[];
}

/** 進階型的輸入：另外可以帶目前別人打出、自己可以碰／吃的牌 */
export interface OutcomeInput extends RecommendInput {
  claim?: { tile: TileKind; pon: boolean; chi: TileKind[][] };
}

export function outcomeRecommend(input: OutcomeInput, maxPlans = 3): OutcomeResult {
  const { seatWind, advanced } = input;
  const base = input.baseScore ?? 0;
  const minWin = input.minWinScore ?? 0;
  const expansion = !!input.expansion;
  const others = Math.max(0, (input.playerCount ?? 4) - 1);
  const T = Math.max(0, Math.min(24, input.drawsLeft ?? 12));
  const counts0 = countKinds(input.concealed);
  const meldTiles = countKinds(input.melds.flatMap((m) => m.tiles.map(kindOf)));
  const visible = input.visible ?? counts0.map((n, k) => n + meldTiles[k]);
  // 手牌以外看得到的牌；模擬時手牌改變，剩下的張數跟著算（打掉原本手上的牌仍算看得到）
  const outside = visible.map((v, k) => Math.max(0, v - counts0[k]));
  const unseen = Math.max(1, visible.reduce((a, v) => a + Math.max(0, 4 - v), 0));
  const survive = 1 - OTHER_WIN_RATE * others;
  const left = (st: State, k: TileKind) => Math.max(0, 4 - outside[k] - Math.max(st.c[k] + st.inMeld[k], counts0[k]));
  const drawP = (st: State, k: TileKind) => left(st, k) / unseen;
  /** 他家打出這張的機率：任何一家（碰、銃和）或只有上家（吃） */
  const oppP = (st: State, k: TileKind, from: number) => 1 - (1 - (CALL_RATE * left(st, k)) / unseen) ** from;
  const sh = (st: State) => shanten(st.c, st.melds.length, advanced);
  /** 可能有用的牌：手上有的、同花色前後兩張以內的（十三么九另外要么九牌）；離手牌太遠的牌摸進來不會讓向聽數前進 */
  const nearOf = (st: State) => {
    const near = new Array<boolean>(KIND_COUNT).fill(false);
    for (let k = 0; k < KIND_COUNT; k++) {
      if (!st.c[k]) continue;
      near[k] = true;
      if (k >= 27) continue;
      for (let x = Math.max(k - 2, k - (k % 9)); x <= Math.min(k + 2, k - (k % 9) + 8); x++) near[x] = true;
    }
    if (advanced && !st.melds.length) for (let k = 0; k < KIND_COUNT; k++) if (isYaochu(k)) near[k] = true;
    return near;
  };
  const kindsOf = (c: number[]) => c.flatMap((n, k) => new Array<TileKind>(n).fill(k));
  const keyOf = (st: State) => st.c.join('') + '|' + st.inMeld.join('');
  const better = (a: Final | null, b: Final | null) => !!a && (!b || a.total > b.total || (a.total === b.total && a.yaku.length > b.yaku.length));

  /** 和這張牌的分數（未達和牌最低分數為 null） */
  const finalOf = (st: State, w: TileKind, tsumo: boolean): Final | null => {
    st.c[w]++;
    const s = evaluateWin({ concealed: kindsOf(st.c), melds: st.melds, winTile: w, tsumo, seatWind, advanced, baseScore: base, expansion });
    st.c[w]--;
    if (!s || s.total < minWin) return null;
    return { total: s.total, yaku: s.yaku.map((y) => (y.count > 1 ? `${y.name}×${y.count}` : y.name)) };
  };

  /** 鳴牌：拿掉手上的兩張、加上一組面子 */
  const withCall = (st: State, type: 'pon' | 'chi', kinds: TileKind[], called: TileKind): State => {
    const c = [...st.c];
    const inMeld = [...st.inMeld];
    let removed = false;
    for (const k of kinds) {
      inMeld[k]++;
      if (k === called && !removed) removed = true;
      else c[k]--;
    }
    const meld: Meld = { type, tiles: kinds.map((k, i) => k * 4 + i), calledTile: called * 4 };
    return { c, melds: [...st.melds, meld], inMeld };
  };

  /** 拿到牌後（手上多一張）打哪張：向聽數符合 ok 的各種打法 */
  const discards = (st: State, ok: (s: number) => boolean, skip?: TileKind) => {
    const out: State[] = [];
    for (let d = 0; d < KIND_COUNT; d++) {
      if (!st.c[d] || d === skip) continue;
      st.c[d]--;
      if (ok(sh(st))) out.push({ c: [...st.c], melds: st.melds, inMeld: st.inMeld });
      st.c[d]++;
    }
    return out;
  };

  /** 各種鳴牌（碰任何一家、吃上家），鳴了之後打牌的向聽數要符合 ok */
  const callEvents = (st: State, ok: (s: number) => boolean, child: (n: State) => Node): Event[] => {
    const out: Event[] = [];
    if (st.melds.length >= 4) return out;
    for (let k = 0; k < KIND_COUNT; k++) {
      if (left(st, k) <= 0) continue;
      if (st.c[k] >= 2) {
        const next = discards(withCall(st, 'pon', [k, k, k], k), ok).map(child);
        if (next.length) out.push({ via: 'pon', tile: k, opp: true, p: oppP(st, k, others), next });
      }
      if (k < 27 && others > 0) {
        const next: Node[] = [];
        for (let b = Math.max(k - 2, k - (k % 9)); b <= k && b % 9 <= 6; b++) {
          const pair = [b, b + 1, b + 2].filter((x) => x !== k);
          if (pair.some((x) => !st.c[x])) continue;
          next.push(...discards(withCall(st, 'chi', [b, b + 1, b + 2], k), ok, k).map(child));
        }
        if (next.length) out.push({ via: 'chi', tile: k, opp: true, p: oppP(st, k, 1), next });
      }
    }
    return out;
  };

  /** 局面的各種事件。lateral：向聽數不變的改良也算（只在目前的局面） */
  const eventsOf = (st: State, s: number, lateral: boolean): Event[] => {
    const events: Event[] = [];
    const near = nearOf(st);
    if (s === 0) {
      // 聽牌：自摸、銃和（聽的牌用向聽數找，比逐一拆解快）
      for (let w = 0; w < KIND_COUNT; w++) {
        if (!near[w] || left(st, w) <= 0) continue;
        st.c[w]++;
        const wins = sh(st) < 0;
        st.c[w]--;
        if (!wins) continue;
        const tsumo = finalOf(st, w, true);
        const ron = finalOf(st, w, false);
        if (tsumo) events.push({ via: 'win', tile: w, opp: false, p: drawP(st, w), win: tsumo, next: [] });
        if (ron) events.push({ via: 'win', tile: w, opp: true, p: oppP(st, w, others), win: ron, next: [] });
      }
    }
    // 摸進：向聽數前進的打法；聽牌時也可以改聽（向聽數不變、換成別的聽牌）
    const change = lateral && s === 0;
    const want = (x: number) => x === s - 1 || (change && x === s);
    for (let k = 0; k < KIND_COUNT && (s > 0 || change); k++) {
      if (!near[k] || left(st, k) <= 0) continue;
      st.c[k]++;
      const after = sh(st);
      // 聽牌時摸到和的牌是自摸（上面已算）
      const next = (after < s && s > 0) || (change && after === s) ? discards(st, want, after === s ? k : undefined).map((n) => node(n)) : [];
      st.c[k]--;
      if (next.length) events.push({ via: 'draw', tile: k, opp: false, p: drawP(st, k), next });
    }
    // 鳴牌：讓向聽數前進；目前的局面在一向聽以內也可以為了做牌鳴（向聽數不變），再遠展開的局面太多
    const callLateral = lateral && s <= 1;
    if (s > 0 || callLateral) events.push(...callEvents(st, (x) => x === s - 1 || (callLateral && x === s), (n) => node(n)));
    return events;
  };

  const memo = new Map<string, Node>();
  /** 之後的局面：只往前進（不考慮改聽），結果記起來共用 */
  const node = (st: State): Node => {
    const key = keyOf(st);
    const hit = memo.get(key);
    if (hit) return hit;
    const s = sh(st);
    const n = solve(eventsOf(st, s, false), false).node;
    memo.set(key, n);
    return n;
  };

  /** 事件在第 t 巡的價值：和牌分數，或拿牌後最好的打法（鳴牌不消耗摸牌，摸牌消耗一次） */
  const valueAt = (e: Event, t: number): [number, number, Node | null] => {
    if (e.win) return [e.win.total, 1, null];
    const tt = e.opp ? t : t - 1;
    if (tt < 0) return [0, 0, null];
    let best: Node | null = null;
    for (const n of e.next) if (!best || n.v[tt] > best.v[tt]) best = n;
    return best ? [best.v[tt], best.w[tt], best] : [0, 0, null];
  };

  /**
   * 逐巡計算：每巡先輪到他家打牌（碰、吃、銃和），再輪到自己摸牌；每件事都可以選擇不要。
   * track：同時記下每個事件（第一件發生的事）對結果的貢獻，用來分組顯示。
   */
  const solve = (events: Event[], track: boolean) => {
    // 機率總和超過 1 時（他家打出的牌估得多）等比例縮小
    const qScale = Math.min(1, 1 / Math.max(1e-9, events.reduce((a, e) => a + (e.opp ? e.p : 0), 0)));
    const v = new Float64Array(T + 1);
    const w = new Float64Array(T + 1);
    const n = track ? events.length : 0;
    const gv = Array.from({ length: n }, () => new Float64Array(T + 1));
    const gw = Array.from({ length: n }, () => new Float64Array(T + 1));
    const dgv = new Float64Array(n);
    const dgw = new Float64Array(n);
    for (let t = 0; t <= T; t++) {
      // 自己摸牌
      let dv = 0;
      let dw = 0;
      dgv.fill(0);
      dgw.fill(0);
      if (t >= 1) {
        let stay = 1;
        events.forEach((e, i) => {
          if (e.opp) return;
          const [ev, ew] = valueAt(e, t);
          if (ev <= v[t - 1]) return;
          dv += e.p * ev;
          dw += e.p * ew;
          stay -= e.p;
          if (track) (dgv[i] += e.p * ev), (dgw[i] += e.p * ew);
        });
        dv += stay * v[t - 1];
        dw += stay * w[t - 1];
        for (let i = 0; i < n; i++) (dgv[i] += stay * gv[i][t - 1]), (dgw[i] += stay * gw[i][t - 1]);
      }
      // 他家打牌（在自己摸牌之前）
      let ov = 0;
      let ow = 0;
      let stay = 1;
      events.forEach((e, i) => {
        if (!e.opp) return;
        const [ev, ew] = valueAt(e, t);
        if (ev <= dv) return;
        const p = e.p * qScale;
        ov += p * ev;
        ow += p * ew;
        stay -= p;
        if (track) (gv[i][t] += survive * p * ev), (gw[i][t] += survive * p * ew);
      });
      v[t] = survive * (ov + stay * dv);
      w[t] = survive * (ow + stay * dw);
      for (let i = 0; i < n; i++) (gv[i][t] += survive * stay * dgv[i]), (gw[i][t] += survive * stay * dgw[i]);
    }
    // 最可能的和法：期望得分貢獻最大的事件（沒有記錄貢獻時以每巡機率 × 分數估計）
    let rep: Final | null = null;
    let repShare = 0;
    const reps = events.map((e, i) => {
      const [ev, , nx] = valueAt(e, T);
      const r = e.win ?? nx?.rep ?? null;
      const share = track ? gv[i][T] : e.p * ev;
      if (r && share > repShare) (repShare = share), (rep = r);
      return r;
    });
    return { node: { v, w, rep } as Node, gv, gw, reps };
  };

  /** 一種打法的結果：和牌率、期望得分，以及第一張進牌依最可能的和法分組 */
  const planOf = (st: State, s: number, lateral: boolean): Omit<OutcomePlan, 'discard' | 'call'> => {
    const events = eventsOf(st, s, lateral);
    const { node: n, gv, gw, reps } = solve(events, true);
    const groups = new Map<string, OutcomeGroup & { value: number }>();
    events.forEach((e, i) => {
      const r = reps[i];
      if (!r || gw[i][T] <= 1e-6) return;
      const key = `${e.via}|${r.total}|${r.yaku.join('・')}`;
      const g = groups.get(key) ?? { via: e.via, draws: [], left: 0, total: r.total, yaku: r.yaku, rate: 0, value: 0 };
      if (!g.draws.includes(e.tile)) {
        g.draws.push(e.tile);
        g.left += left(st, e.tile);
      }
      g.rate += gw[i][T];
      g.value += gv[i][T];
      groups.set(key, g);
    });
    return {
      shanten: s,
      winRate: n.w[T],
      ev: n.v[T],
      groups: [...groups.values()]
        .sort((a, b) => b.value - a.value || b.total - a.total)
        .map(({ value: _, ...g }) => ({ ...g, draws: g.draws.sort((a, b) => a - b) })),
    };
  };

  const byEv = (a: OutcomePlan, b: OutcomePlan) => b.ev - a.ev || b.winRate - a.winRate;
  const root: State = { c: [...counts0], melds: input.melds, inMeld: new Array(KIND_COUNT).fill(0) };

  if (input.concealed.length % 3 === 2) {
    // 手上多一張：每個不會讓向聽數變差的打法分別算；先不算改聽粗排，前幾名再算改聽
    const s14 = sh(root);
    if (s14 < 0) return { shanten: -1, plans: [], tooFar: false };
    if (s14 > OUTCOME_MAX_SHANTEN) return { shanten: s14, plans: [], tooFar: true };
    const cands: { d: TileKind; st: State; plan: OutcomePlan }[] = [];
    for (let d = 0; d < KIND_COUNT; d++) {
      if (!root.c[d]) continue;
      root.c[d]--;
      const st: State = { c: [...root.c], melds: root.melds, inMeld: root.inMeld };
      root.c[d]++;
      if (sh(st) !== s14) continue;
      cands.push({ d, st, plan: { discard: d, ...planOf(st, s14, false) } });
    }
    cands.sort((a, b) => byEv(a.plan, b.plan));
    const plans = cands.map((x, i) => (i < LATERAL_PLANS ? { discard: x.d, ...planOf(x.st, s14, true) } : x.plan));
    return { shanten: s14, plans: plans.filter((p) => p.groups.length).sort(byEv).slice(0, maxPlans), tooFar: false };
  }

  const s = sh(root);
  if (s > OUTCOME_MAX_SHANTEN) return { shanten: s, plans: [], tooFar: true };
  const plans: OutcomePlan[] = [planOf(root, s, true)];
  // 別人剛打出、自己可以碰／吃的牌：鳴牌後各種打法，與不鳴比較
  const claim = input.claim;
  if (claim) {
    const options: { type: 'pon' | 'chi'; kinds: TileKind[] }[] = [];
    if (claim.pon) options.push({ type: 'pon', kinds: [claim.tile, claim.tile, claim.tile] });
    for (const pair of claim.chi) options.push({ type: 'chi', kinds: [...pair, claim.tile].sort((a, b) => a - b) });
    // 鳴了之後這張牌在自己的面子裡，不再算河裡看得到的牌（鳴牌後的局面另外記，不會和不鳴的混在一起）
    if (outside[claim.tile] > 0) outside[claim.tile]--;
    for (const call of options) {
      const st = withCall(root, call.type, call.kinds, claim.tile);
      for (const n of discards(st, (x) => x <= s, call.type === 'chi' ? claim.tile : undefined)) {
        const ns = sh(n);
        plans.push({ call, discard: n.c.findIndex((x, k) => x < st.c[k]), ...planOf(n, ns, false) });
      }
    }
  }
  return { shanten: s, plans: plans.filter((p) => p.groups.length).sort(byEv).slice(0, maxPlans), tooFar: false };
}
