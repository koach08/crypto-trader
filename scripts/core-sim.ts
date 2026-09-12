/**
 * コア枠のシミュレータ。本番と同じ純関数 (planCoreBuy / planCoreTakeProfit /
 * applyCore*) を日足 12h 刻みで回す。core-target / core-reentry の両ハーネスが使う。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { OHLCVBar } from "../src/lib/types";
import {
  applyCoreFill, applyCoreSell, planCoreBuy, planCoreTakeProfit,
  type CoreHoldConfig, type CoreHoldingState,
} from "../src/lib/trading/core-holding";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
export const SYMBOLS: Record<string, string> = { "BTC/JPY": "BTC-JPY", "ETH/JPY": "ETH-JPY", "XRP/JPY": "XRP-JPY" };
const MIN_BASE: Record<string, number> = { BTC: 0.001, ETH: 0.01, XRP: 0.1 };
export const COST_ONE_WAY = 0.0018;
export const START_CASH = 120_000;

export async function fetchDaily(pair: string): Promise<OHLCVBar[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const symbol = SYMBOLS[pair];
  const cache = path.join(CACHE_DIR, `${symbol}-daily.json`);
  if (existsSync(cache)) {
    const raw = JSON.parse(readFileSync(cache, "utf8")) as { fetchedAt: number; bars: OHLCVBar[] };
    if (Date.now() - raw.fetchedAt < 12 * 60 * 60 * 1000) return raw.bars;
  }
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < (r?.timestamp ?? []).length; i++) {
    const close = q?.close?.[i];
    if (close == null) continue;
    bars.push({ timestamp: r.timestamp[i] * 1000, open: close, high: close, low: close, close, volume: 0 });
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), bars }));
  return bars;
}

export function cfgFor(targetPct: number, over: Partial<CoreHoldConfig> = {}): CoreHoldConfig {
  return {
    enabled: true,
    targetPct,
    weights: { "BTC/JPY": 0.5, "ETH/JPY": 0.3, "XRP/JPY": 0.2 },
    tranches: 4,
    intervalHours: 12,
    minTrancheJPY: 3000,
    takeProfitPct: 0.2,
    takeProfitFraction: 0.25,
    reentryDiscountPct: 0.05,
    ...over,
  };
}

function minOrderJPY(pair: string, price: number): number {
  return Math.ceil((MIN_BASE[pair.split("/")[0]] ?? 0.001) * price * 1.1);
}

export interface Result {
  finalNav: number; returnPct: number; mddPct: number; realized: number;
  buys: number; sells: number; avgCashPct: number;
}

export function simulate(bars: Record<string, number[]>, ts: number[], from: number, to: number, cfg: CoreHoldConfig): Result {
  let cash = START_CASH;
  let state: CoreHoldingState = { lots: [], lastBuyAt: {}, lastSellPrice: {}, realizedJPY: 0 };
  let buys = 0, sells = 0, peak = 0, mdd = 0, cashPctSum = 0, steps = 0;

  for (let i = from; i < to; i++) {
    const prices: Record<string, number> = {};
    for (const p of Object.keys(SYMBOLS)) prices[p] = bars[p][i];
    const mo: Record<string, number> = {};
    for (const p of Object.keys(SYMBOLS)) mo[p] = minOrderJPY(p, prices[p]);

    for (let half = 0; half < 2; half++) {
      const nowMs = ts[i] + half * 12 * 3600 * 1000;
      let holdings = 0;
      for (const p of Object.keys(SYMBOLS)) holdings += state.lots.filter(l => l.pair === p).reduce((s, l) => s + l.amountBase, 0) * prices[p];
      const nav = cash + holdings;
      peak = Math.max(peak, nav);
      mdd = Math.min(mdd, (nav - peak) / peak);
      cashPctSum += cash / nav; steps++;

      // 本番と同じ順: 利確 → 積立。1 ステップ 1 件。
      const tp = planCoreTakeProfit({ state, cfg, prices, minOrderJPY: mo });
      if (tp.plan) {
        const px = tp.plan.priceJPY * (1 - COST_ONE_WAY);
        const r = applyCoreSell(state, tp.plan.pair, tp.plan.amountBase, px);
        state = r.state;
        cash += tp.plan.amountBase * px;
        sells++;
        continue;
      }
      const buy = planCoreBuy({ navJPY: nav, jpyFree: cash, cfg, state, prices, minOrderJPY: mo, nowMs });
      if (buy.plan) {
        const px = prices[buy.plan.pair] * (1 + COST_ONE_WAY);
        const amt = buy.plan.amountJPY / px;
        state = applyCoreFill(state, {
          pair: buy.plan.pair, amountBase: amt, priceJPY: px, costJPY: buy.plan.amountJPY,
          at: new Date(nowMs).toISOString(),
        });
        cash -= buy.plan.amountJPY;
        buys++;
      }
    }
  }
  let holdings = 0;
  for (const p of Object.keys(SYMBOLS)) holdings += state.lots.filter(l => l.pair === p).reduce((s, l) => s + l.amountBase, 0) * bars[p][to - 1];
  const finalNav = cash + holdings;
  return {
    finalNav, returnPct: (finalNav / START_CASH - 1) * 100, mddPct: mdd * 100,
    realized: state.realizedJPY ?? 0, buys, sells, avgCashPct: (cashPctSum / steps) * 100,
  };
}


/** 3 ペアの終値を揃え、重ならない 1 年区間 + 全期間を返す */
export async function loadWindows() {
  const raw: Record<string, OHLCVBar[]> = {};
  for (const p of Object.keys(SYMBOLS)) raw[p] = await fetchDaily(p);
  const len = Math.min(...Object.values(raw).map(b => b.length));
  const bars: Record<string, number[]> = {};
  for (const p of Object.keys(SYMBOLS)) bars[p] = raw[p].slice(raw[p].length - len).map(b => b.close);
  const ts = raw["BTC/JPY"].slice(raw["BTC/JPY"].length - len).map(b => b.timestamp);
  const SLICE = 365;
  const slices: Array<[number, number, string]> = [];
  for (let end = len; end - SLICE >= 0; end -= SLICE) {
    const start = end - SLICE;
    slices.push([start, end, `${new Date(ts[start]).toISOString().slice(0, 7)}〜${new Date(ts[end - 1]).toISOString().slice(0, 7)}`]);
  }
  slices.reverse();
  slices.push([slices[0][0], len, `全期間 ${new Date(ts[slices[0][0]]).toISOString().slice(0, 7)}〜`]);
  return { bars, ts, slices };
}
