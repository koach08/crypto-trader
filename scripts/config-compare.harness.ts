/**
 * いま本番に入っている設定は、買い持ちに勝てるのか。
 *
 * トレンドゲートが開かないので戦術枠の実弾データが溜まらない。
 * 待っていても学習が進まないので、履歴で先に確かめる。
 *
 * 比較するもの:
 *   旧設定   SL2% / TP3%      … 実際に -¥6,119 を作った設定
 *   新設定   SL8% / TP30%     … 検証値。まだ一度も実弾で動いていない
 *   買い持ち                  … 何もしない対照群
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/config-compare.harness.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import { runBacktest, type BacktestConfig } from "../src/lib/backtest/replay";
import type { OHLCVBar } from "../src/lib/types";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const CAPITAL = 123_000;           // 現在の NAV に合わせる
const FEE_PERCENT = 0.15;
const SLIPPAGE_PERCENT = 0.05;     // 実測 0.04% より保守的に

const SYMBOLS: Record<string, string> = {
  "BTC/JPY": "BTC-JPY",
  "ETH/JPY": "ETH-JPY",
  "XRP/JPY": "XRP-JPY",
};

async function fetchDaily(pair: string): Promise<OHLCVBar[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const symbol = SYMBOLS[pair];
  const cache = path.join(CACHE_DIR, `${symbol}-daily.json`);
  if (existsSync(cache)) {
    const raw = JSON.parse(readFileSync(cache, "utf8")) as { fetchedAt: number; bars: OHLCVBar[] };
    if (Date.now() - raw.fetchedAt < 12 * 60 * 60 * 1000) return raw.bars;
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q?.close?.[i];
    if (close == null) continue;
    bars.push({
      timestamp: ts[i] * 1000,
      open: q.open?.[i] ?? close, high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close, close, volume: q.volume?.[i] ?? 0,
    });
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), bars }));
  return bars;
}

const CONFIGS: Array<{ name: string; opts: Record<string, unknown> }> = [
  // 実際に -¥6,119 を作った設定
  { name: "旧 SL2/TP3", opts: { strategy: "trend", trendGate: true, stopLossPercent: 2, takeProfitPercent: 3 } },
  // いま本番に入っている設定
  { name: "本番 SL8/TP30", opts: { strategy: "trend", trendGate: true, stopLossPercent: 8, takeProfitPercent: 30 } },
  // 元のハーネスで +46.2% と出た設定 (TP は事実上無効)
  { name: "検証済 SL8/TP無効", opts: { strategy: "trend", trendGate: true, stopLossPercent: 8, takeProfitPercent: 9999 } },
  // 損切りもしない = 買って持つだけ
  { name: "持ち切り", opts: { strategy: "trend", trendGate: true, stopLossPercent: 9999, takeProfitPercent: 9999 } },
];

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "5年", days: 1825 },
  { label: "2年", days: 730 },
  { label: "1年", days: 365 },
];

test("設定比較", async () => {
  const bars: Record<string, OHLCVBar[]> = {};
  for (const pair of Object.keys(SYMBOLS)) bars[pair] = await fetchDaily(pair);

  for (const w of WINDOWS) {
    console.log(`\n================ ${w.label} ================`);
    console.log(["設定".padEnd(18), "ペア".padEnd(5), "リターン".padStart(9), "買い持ち".padStart(9), "差".padStart(9), "最大DD".padStart(8), "取引".padStart(5)].join(" "));
    const totals: Record<string, { ret: number; bh: number; n: number }> = {};
    for (const cfg of CONFIGS) {
      for (const pair of Object.keys(SYMBOLS)) {
        const all = bars[pair];
        const slice = all.slice(Math.max(0, all.length - w.days));
        if (slice.length < 250) continue;
        const r = runBacktest({
          pair, bars: slice, initialCapital: CAPITAL,
          slippagePercent: SLIPPAGE_PERCENT, feePercent: FEE_PERCENT,
          ...(cfg.opts as Partial<BacktestConfig>),
        } as BacktestConfig);
        const s = r.stats;
        const t = (totals[cfg.name] ??= { ret: 0, bh: 0, n: 0 });
        t.ret += s.totalReturnPercent; t.bh += s.buyAndHoldReturnPercent; t.n += 1;
        console.log([
          cfg.name.padEnd(18), pair.split("/")[0].padEnd(5),
          `${s.totalReturnPercent.toFixed(1)}%`.padStart(9),
          `${s.buyAndHoldReturnPercent.toFixed(1)}%`.padStart(9),
          `${(s.totalReturnPercent - s.buyAndHoldReturnPercent).toFixed(1)}%`.padStart(9),
          `${s.maxDrawdownPercent.toFixed(1)}%`.padStart(8),
          String(s.numTrades).padStart(5),
        ].join(" "));
      }
    }
    console.log("--- 3ペア平均 ---");
    for (const [name, t] of Object.entries(totals)) {
      const d = (t.ret - t.bh) / t.n;
      console.log(`${name.padEnd(18)} リターン ${(t.ret / t.n).toFixed(1).padStart(7)}% / 買い持ち ${(t.bh / t.n).toFixed(1).padStart(7)}% / 差 ${(d >= 0 ? "+" : "") + d.toFixed(1)}%`);
    }
  }
}, 20 * 60 * 1000);
