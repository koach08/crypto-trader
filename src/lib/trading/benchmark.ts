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
}): DoNothingBenchmark {
  const { flows, pairs, priceAt, currentPrices, currentNavJPY } = input;
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
    // 出金は持っている数量を比例で減らす (均等買い持ちの相手も同じ日に同じ額を引き出す)
    const perPair = f.amountJPY / pairs.length;
    for (const p of pairs) units[p] += perPair / (prices[p] as number);
  }

  let holdJPY: number | null = null;
  if (holdOk) {
    holdJPY = 0;
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
