/**
 * トレンドゲートは、どれだけの期間 閉じているのか。
 *
 * 本番は「終値 > MA50 > MA200」で入る設計だが、数週間ずっと開いていない。
 * MA200 は下落後の回復に大きく遅れるので、**上昇の初期を丸ごと逃す**可能性がある。
 * 本番を変える前に、まず「どれだけ逃しているか」を測る。
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/gate-analysis.harness.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import type { OHLCVBar } from "../src/lib/types";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const SYMBOLS: Record<string, string> = { "BTC/JPY": "BTC-JPY", "ETH/JPY": "ETH-JPY", "XRP/JPY": "XRP-JPY" };

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
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < (r?.timestamp ?? []).length; i++) {
    const close = q?.close?.[i];
    if (close == null) continue;
    bars.push({ timestamp: r.timestamp[i] * 1000, open: q.open?.[i] ?? close, high: q.high?.[i] ?? close, low: q.low?.[i] ?? close, close, volume: q.volume?.[i] ?? 0 });
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), bars }));
  return bars;
}

const sma = (a: number[], n: number, i: number) =>
  i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n;

/** ゲートが開いている日だけ保有した場合のリターン (翌日の値動きを取る) */
function gatedReturn(closes: number[], fast: number, slow: number) {
  let equity = 1, openDays = 0, total = 0;
  for (let i = Math.max(fast, slow); i < closes.length - 1; i++) {
    total++;
    const mf = sma(closes, fast, i), ms = sma(closes, slow, i);
    const open = mf != null && ms != null && closes[i] > mf && mf > ms;
    if (open) {
      openDays++;
      equity *= closes[i + 1] / closes[i];
    }
  }
  return { returnPercent: (equity - 1) * 100, openPercent: (openDays / total) * 100, openDays, total };
}

test("ゲート分析", async () => {
  const bars: Record<string, OHLCVBar[]> = {};
  for (const p of Object.keys(SYMBOLS)) bars[p] = await fetchDaily(p);

  const PARAMS: Array<[number, number, string]> = [
    [50, 200, "本番 (50/200)"],
    [20, 100, "やや速い (20/100)"],
    [20, 50, "速い (20/50)"],
    [10, 30, "かなり速い (10/30)"],
  ];

  for (const label of ["5年", "2年", "1年"] as const) {
    const days = label === "5年" ? 1825 : label === "2年" ? 730 : 365;
    console.log(`\n================ ${label} ================`);
    console.log([ "ゲート".padEnd(18), "ペア".padEnd(5), "開いてた割合".padStart(12), "ゲート運用".padStart(11), "買い持ち".padStart(10) ].join(" "));
    for (const [f, sl, name] of PARAMS) {
      let sumG = 0, sumB = 0, sumO = 0, n = 0;
      for (const pair of Object.keys(SYMBOLS)) {
        const all = bars[pair].map(b => b.close);
        const closes = all.slice(Math.max(0, all.length - days));
        if (closes.length < 250) continue;
        const g = gatedReturn(closes, f, sl);
        const bh = (closes[closes.length - 1] / closes[0] - 1) * 100;
        sumG += g.returnPercent; sumB += bh; sumO += g.openPercent; n++;
        console.log([ name.padEnd(18), pair.split("/")[0].padEnd(5),
          `${g.openPercent.toFixed(0)}%`.padStart(12),
          `${g.returnPercent.toFixed(1)}%`.padStart(11),
          `${bh.toFixed(1)}%`.padStart(10) ].join(" "));
      }
      if (n) console.log(`${"  → 3ペア平均".padEnd(18)} ${"".padEnd(5)} ${(sumO/n).toFixed(0)+"%"} 開放 / ゲート ${(sumG/n).toFixed(1)}% / 買い持ち ${(sumB/n).toFixed(1)}%\n`);
    }
  }
}, 10 * 60 * 1000);
