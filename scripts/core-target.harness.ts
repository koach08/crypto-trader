/**
 * コア目標比率は 85% のままでよいか、上げるべきか。
 *
 * 戦術枠を引退させた後、目標の残り (15%) は現金で寝る。用途は
 * 「利確 (+20% で 1/4 売る) → 5% 下で買い戻す」の回転資金だけ。
 * 上げれば含み益は増えるが、買い戻しの弾と下げの緩衝が減る。どちらが効くか。
 *
 * 本番と同じ純関数 (planCoreBuy / planCoreTakeProfit / applyCore*) を日足で回す。
 * 12 時間ごとの積立を再現するため 1 日 2 ステップ (同じ終値)。
 * bitFlyer の最小注文・往復コスト 0.36% を入れる。
 *
 * 採用条件を先に決める (後から都合よく選ばないため):
 *   重ならない 1 年区間 4 本すべてで最終 NAV が 85% を上回り、
 *   かつ最大ドローダウンがどの区間でも 5pt 以上悪化しないこと。
 *   1 つでも欠けたら 85% のまま。
 *
 * 注意: loadCoreConfig は targetPct を 0.95 で頭打ちにしている。
 *       100% は「上限を外した場合」の参考値。
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/core-target.harness.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import type { OHLCVBar } from "../src/lib/types";
import {
  applyCoreFill, applyCoreSell, planCoreBuy, planCoreTakeProfit,
  type CoreHoldConfig, type CoreHoldingState,
} from "../src/lib/trading/core-holding";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const SYMBOLS: Record<string, string> = { "BTC/JPY": "BTC-JPY", "ETH/JPY": "ETH-JPY", "XRP/JPY": "XRP-JPY" };
const MIN_BASE: Record<string, number> = { BTC: 0.001, ETH: 0.01, XRP: 0.1 };
const COST_ONE_WAY = 0.0018;
const START_CASH = 120_000;

async function fetchDaily(pair: string): Promise<OHLCVBar[]> {
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

function cfgFor(targetPct: number): CoreHoldConfig {
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
  };
}

function minOrderJPY(pair: string, price: number): number {
  return Math.ceil((MIN_BASE[pair.split("/")[0]] ?? 0.001) * price * 1.1);
}

interface Result {
  finalNav: number; returnPct: number; mddPct: number; realized: number;
  buys: number; sells: number; avgCashPct: number;
}

function simulate(bars: Record<string, number[]>, ts: number[], from: number, to: number, cfg: CoreHoldConfig): Result {
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

test("コア目標比率の比較", async () => {
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

  const TARGETS = [0.70, 0.85, 0.95, 1.00];
  const wins: Record<number, number> = {};
  const mddOk: Record<number, boolean> = {};
  for (const t of TARGETS) { wins[t] = 0; mddOk[t] = true; }

  console.log(`\n開始現金 ¥${START_CASH.toLocaleString()} / 往復コスト ${(COST_ONE_WAY * 200).toFixed(2)}% / 本番と同じ関数を 12h 刻みで回す\n`);
  for (const [from, to, label] of slices) {
    const isFull = label.startsWith("全期間");
    console.log(`================ ${label} ================`);
    console.log(["目標".padEnd(6), "最終NAV".padStart(10), "リターン".padStart(9), "最大DD".padStart(8), "利確確定".padStart(9), "買/売".padStart(8), "平均現金".padStart(9)].join(" "));
    const base = simulate(bars, ts, from, to, cfgFor(0.85));
    for (const t of TARGETS) {
      const r = t === 0.85 ? base : simulate(bars, ts, from, to, cfgFor(t));
      if (!isFull) {
        if (r.finalNav > base.finalNav) wins[t]++;
        if (r.mddPct < base.mddPct - 5) mddOk[t] = false;
      }
      const d = r.finalNav - base.finalNav;
      console.log([`${(t * 100).toFixed(0)}%`.padEnd(6), `¥${Math.round(r.finalNav).toLocaleString()}`.padStart(10),
        `${r.returnPct.toFixed(1)}%`.padStart(9), `${r.mddPct.toFixed(1)}%`.padStart(8),
        `¥${Math.round(r.realized).toLocaleString()}`.padStart(9), `${r.buys}/${r.sells}`.padStart(8),
        `${r.avgCashPct.toFixed(0)}%`.padStart(9),
        t === 0.85 ? "  (現行)" : `  ${d >= 0 ? "+" : ""}¥${Math.round(d).toLocaleString()} vs 85%`].join(" "));
    }
    console.log("");
  }
  const n = slices.length - 1;
  console.log("================ 採用判定 (重ならない区間のみ) ================");
  for (const t of TARGETS) {
    if (t === 0.85) continue;
    const ok = wins[t] === n && mddOk[t];
    console.log(`${(t * 100).toFixed(0)}%: NAV で 85% に勝った区間 ${wins[t]}/${n} / DD 5pt 以内 ${mddOk[t] ? "OK" : "NG"} → ${ok ? "採用条件を満たす" : "不採用"}${t === 1 ? " (※ 上限 0.95 を外す必要あり)" : ""}`);
  }
}, 10 * 60 * 1000);
