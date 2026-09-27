/**
 * 「放置に勝っているか」を出す。
 *
 * 入金するかどうかの基準として本人と決めたのがこれ。基準なのに、いままでは
 * 手元のスクリプトを叩かないと出なかった。画面に常時出すために純関数にする。
 *
 * 放置には 2 つの意味があるので両方出す:
 *   A 円のまま置く      … 何もしない。入れた金の合計そのもの
 *   B 均等買い持ち      … 入れた日にその日の価格で 3 ペアを均等に買い、以後触らない
 *
 * 入出金の日付ごとにその日の価格で組むので、途中入金があっても比較が歪まない。
 * (単純に「開始日の価格で全額買った」とすると、後から入れた金まで開始日の
 *  安値で買ったことになり、放置側が不当に有利になる)
 */

export interface BenchmarkFlow {
  at: string;
  /** 入金は +、出金は - */
  amountJPY: number;
}

export interface BenchmarkLeg {
  at: string;
  amountJPY: number;
  /** その日の価格。取れなかったペアは null */
  prices: Record<string, number | null>;
}

export interface DoNothingBenchmark {
  /** 入れた金の合計 (= 円のまま置いた場合の現在価値) */
  cashOnlyJPY: number;
  /** 入れた日に均等に買って持ちっぱなしにした場合の現在価値 */
  holdJPY: number | null;
  /** 現在のアプリの総資産 */
  appJPY: number;
  /** アプリ − 円のまま */
  vsCashJPY: number;
  /** アプリ − 均等買い持ち */
  vsHoldJPY: number | null;
  /** 均等買い持ちの各ペアの数量 */
  holdUnits: Record<string, number>;
  legs: BenchmarkLeg[];
  /** 価格が取れず均等買い持ちを組めなかった入出金 */
  missing: string[];
}

export function buildDoNothingBenchmark(input: {
  flows: BenchmarkFlow[];
  pairs: string[];
  /** その時刻に最も近い価格を返す。無ければ null */
  priceAt: (pair: string, atMs: number) => number | null;
  currentPrices: Record<string, number>;
  currentNavJPY: number;
  /** ペアの比重。省略時は均等 */
  weights?: Record<string, number>;
  /** 入金のうち暗号資産に回す割合 (残りは円のまま)。省略時は 1 */
  investedFraction?: number;
}): DoNothingBenchmark {
  const { flows, pairs, priceAt, currentPrices, currentNavJPY } = input;
  const invested = Math.min(1, Math.max(0, input.investedFraction ?? 1));
  const wSum = pairs.reduce((a, p) => a + (input.weights?.[p] ?? 1), 0);
  const w = (p: string) => (input.weights?.[p] ?? 1) / wSum;
  let cashLeg = 0;
  const units: Record<string, number> = {};
  for (const p of pairs) units[p] = 0;
  const legs: BenchmarkLeg[] = [];
  const missing: string[] = [];
  let cashOnly = 0;
  let holdOk = true;

  for (const f of flows) {
    cashOnly += f.amountJPY;
    const atMs = Date.parse(f.at);
    const prices: Record<string, number | null> = {};
    let legOk = true;
    for (const p of pairs) {
      const px = priceAt(p, atMs);
      prices[p] = px;
      if (!(px && px > 0)) legOk = false;
    }
    legs.push({ at: f.at, amountJPY: f.amountJPY, prices });
    if (!legOk) { holdOk = false; missing.push(f.at); continue; }
    // 出金は持っている数量を比例で減らす (買い持ちの相手も同じ日に同じ額を引き出す)
    cashLeg += f.amountJPY * (1 - invested);
    for (const p of pairs) units[p] += (f.amountJPY * invested * w(p)) / (prices[p] as number);
  }

  let holdJPY: number | null = null;
  if (holdOk) {
    holdJPY = cashLeg;
    for (const p of pairs) {
      const px = currentPrices[p];
      if (!(px > 0)) { holdJPY = null; break; }
      holdJPY += units[p] * px;
    }
  }

  return {
    cashOnlyJPY: cashOnly,
    holdJPY,
    appJPY: currentNavJPY,
    vsCashJPY: currentNavJPY - cashOnly,
    vsHoldJPY: holdJPY == null ? null : currentNavJPY - holdJPY,
    holdUnits: units,
    legs,
    missing,
  };
}

/** 時系列から、指定時刻に最も近い点の価格を引く。 */
export function nearestPrice(
  series: Array<{ ts: number; price: number }>,
  atMs: number,
  /** これより離れていたら null (別の相場の値を拾わないため) */
  maxDistanceMs = 3 * 24 * 60 * 60 * 1000
): number | null {
  let best: { ts: number; price: number } | null = null;
  for (const s of series) {
    if (!(s.price > 0)) continue;
    if (!best || Math.abs(s.ts - atMs) < Math.abs(best.ts - atMs)) best = s;
  }
  if (!best || Math.abs(best.ts - atMs) > maxDistanceMs) return null;
  return best.price;
}

/**
 * 「均等買い持ちに負けている差」を要因に分ける。
 *
 * 反実仮想を 1 段ずつ近づけていき、各段の差を要因とする。足すと必ず全体の差に一致する:
 *   均等買い持ち
 *   → 同じ金を本番の比重 (50/30/20) で持つ          … 銘柄の比重の効果
 *   → さらに目標比率 (85%) だけ持ち、残りを円で置く … 現金を寝かせた効果
 *   → 実際のアプリ                                    … 売買・利確・タイミングの効果
 *
 * 最後の段は「比重も現金比率も同じで持ちっぱなしにした場合」との差なので、
 * アプリが実際に何かをしたこと (積立の時期、利確、戦術枠の売買) の損得だけが残る。
 */
export interface BenchmarkLadder {
  steps: Array<{ label: string; valueJPY: number | null }>;
  effects: Array<{ label: string; deltaJPY: number | null; note: string }>;
  totalGapJPY: number | null;
}

export function buildBenchmarkLadder(input: {
  flows: BenchmarkFlow[];
  pairs: string[];
  priceAt: (pair: string, atMs: number) => number | null;
  currentPrices: Record<string, number>;
  currentNavJPY: number;
  weights: Record<string, number>;
  investedFraction: number;
}): BenchmarkLadder {
  const base = { flows: input.flows, pairs: input.pairs, priceAt: input.priceAt, currentPrices: input.currentPrices, currentNavJPY: input.currentNavJPY };
  const eq = buildDoNothingBenchmark(base).holdJPY;
  const weighted = buildDoNothingBenchmark({ ...base, weights: input.weights }).holdJPY;
  const withCash = buildDoNothingBenchmark({ ...base, weights: input.weights, investedFraction: input.investedFraction }).holdJPY;
  const app = input.currentNavJPY;
  const d = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
  const pct = Math.round(input.investedFraction * 100);
  return {
    steps: [
      { label: "均等に買って持つ", valueJPY: eq },
      { label: "本番の比重で持つ", valueJPY: weighted },
      { label: `本番の比重で ${pct}% だけ持つ`, valueJPY: withCash },
      { label: "実際のアプリ", valueJPY: app },
    ],
    effects: [
      { label: "銘柄の比重", deltaJPY: d(weighted, eq), note: "BTC/ETH/XRP を均等でなく本番の比重で持ったことの差" },
      { label: "現金を寝かせた", deltaJPY: d(withCash, weighted), note: `入れた金の ${100 - pct}% を円のまま置いたことの差` },
      { label: "売買・利確・タイミング", deltaJPY: d(app, withCash), note: "比重も現金比率も同じで持ちっぱなしにした場合との差。アプリが実際に動いたことの損得" },
    ],
    totalGapJPY: d(app, eq),
  };
}

/**
 * 放置との差が縮んでいるのか広がっているのか。
 * NAV スナップショットを 1 日 1 点に間引き、各時点で「それまでに入れた金」だけを使って
 * 円のまま / 均等買い持ちを組み直す。
 */
export interface BenchmarkPoint {
  at: string;
  appJPY: number;
  cashOnlyJPY: number;
  holdJPY: number | null;
}

export function buildBenchmarkSeries(input: {
  snapshots: Array<{ at: string; navJPY: number; prices: Record<string, number> }>;
  flows: BenchmarkFlow[];
  pairs: string[];
  priceAt: (pair: string, atMs: number) => number | null;
  /** 1 点あたりの間隔。既定 1 日 */
  stepMs?: number;
}): BenchmarkPoint[] {
  const step = input.stepMs ?? 24 * 60 * 60 * 1000;
  const sorted = [...input.snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: BenchmarkPoint[] = [];
  let lastMs = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const snap = sorted[i];
    const ms = Date.parse(snap.at);
    const isLast = i === sorted.length - 1;
    if (!isLast && ms - lastMs < step) continue;
    lastMs = ms;
    const flowsSoFar = input.flows.filter((f) => Date.parse(f.at) <= ms);
    if (flowsSoFar.length === 0) continue;
    const b = buildDoNothingBenchmark({
      flows: flowsSoFar, pairs: input.pairs, priceAt: input.priceAt,
      currentPrices: snap.prices, currentNavJPY: snap.navJPY,
    });
    out.push({ at: snap.at, appJPY: snap.navJPY, cashOnlyJPY: b.cashOnlyJPY, holdJPY: b.holdJPY });
  }
  return out;
}
