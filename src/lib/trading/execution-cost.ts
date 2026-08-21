/**
 * 執行コストの計測 (TCA)。
 *
 * 【なぜ要るか】このボットは資産の約39回転ぶん売買している (2026-08-21 時点で
 * 売買代金 ¥2,625,222 / NAV ¥68,247) のに、記録されている手数料は ¥0 だった。
 * 取引所の約定履歴を引いても totalFees は 0 のままで、気配差ぶんの支払いも
 * どこにも残っていない。つまり出ている損益は全部グロスで、**コストを引いた後に
 * プラスなのかマイナスなのか判定できない状態**だった。
 *
 * 回転数が多い仕組みほど、方向を当てる精度より執行コストのほうが効く。
 * ここでは発注直前の中値を基準に、実際の約定値との差を1件ずつ残す。
 */

export interface ExecutionCost {
  at: string;
  pair: string;
  side: "buy" | "sell";
  amountBase: number;
  /** 実際の約定単価 */
  fillPrice: number;
  /** 発注直前の中値 (best_bid と best_ask の中間)。これを基準に不利分を測る */
  refMid: number;
  notionalJPY: number;
  /** 中値に対して不利だった額。買いで高く買えば +、売りで安く売れば + */
  slippageJPY: number;
  /** メイカー指値で約定したか (false = 成行フォールバック) */
  viaMaker: boolean;
}

/** 中値に対する不利分。買いは高く買うほど、売りは安く売るほどコスト。 */
export function slippageJPY(
  side: "buy" | "sell",
  fillPrice: number,
  refMid: number,
  amountBase: number
): number {
  if (!(fillPrice > 0) || !(refMid > 0) || !(amountBase > 0)) return 0;
  const diff = side === "buy" ? fillPrice - refMid : refMid - fillPrice;
  return diff * amountBase;
}

export interface CostSummaryRow {
  pair: string;
  fills: number;
  makerFills: number;
  makerRate: number;
  notionalJPY: number;
  slippageJPY: number;
  /** 売買代金に対するコスト率 */
  costPercent: number;
}

export interface CostSummary {
  rows: CostSummaryRow[];
  fills: number;
  makerRate: number;
  notionalJPY: number;
  slippageJPY: number;
  costPercent: number;
  since: string | null;
}

export function summarizeExecutionCosts(costs: ExecutionCost[]): CostSummary {
  const byPair = new Map<string, CostSummaryRow>();
  for (const c of costs) {
    const row = byPair.get(c.pair) ?? {
      pair: c.pair, fills: 0, makerFills: 0, makerRate: 0,
      notionalJPY: 0, slippageJPY: 0, costPercent: 0,
    };
    row.fills += 1;
    if (c.viaMaker) row.makerFills += 1;
    row.notionalJPY += c.notionalJPY;
    row.slippageJPY += c.slippageJPY;
    byPair.set(c.pair, row);
  }
  const rows = Array.from(byPair.values()).map((r) => ({
    ...r,
    makerRate: r.fills > 0 ? (r.makerFills / r.fills) * 100 : 0,
    costPercent: r.notionalJPY > 0 ? (r.slippageJPY / r.notionalJPY) * 100 : 0,
  }));
  rows.sort((a, b) => b.slippageJPY - a.slippageJPY);

  const fills = rows.reduce((s, r) => s + r.fills, 0);
  const makerFills = rows.reduce((s, r) => s + r.makerFills, 0);
  const notionalJPY = rows.reduce((s, r) => s + r.notionalJPY, 0);
  const slip = rows.reduce((s, r) => s + r.slippageJPY, 0);
  return {
    rows,
    fills,
    makerRate: fills > 0 ? (makerFills / fills) * 100 : 0,
    notionalJPY,
    slippageJPY: slip,
    costPercent: notionalJPY > 0 ? (slip / notionalJPY) * 100 : 0,
    since: costs.length > 0 ? costs[0].at : null,
  };
}
