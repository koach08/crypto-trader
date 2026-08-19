/**
 * 戦略マトリクス検証ハーネス。
 *
 * 目的: 「本当に利益が出るか」を、本番に出す**前に**数字で確かめる。
 * 実運用の -25% は戦略の方向 (下落局面でのロング逆張り) が原因だったので、
 * 変更案は必ずここで
 *   1. 複数ペア
 *   2. 複数期間 (強気/弱気の両方)
 *   3. buy&hold と、移動平均だけの対照群 (control)
 * に対して並べてから採否を決める。1 ペア 1 期間で勝っただけの案は採用しない。
 *
 * 実行: npm run bt
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import { runBacktest, type BacktestConfig, type BacktestResult } from "../src/lib/backtest/replay";
import type { OHLCVBar } from "../src/lib/types";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const CAPITAL = 63_000;

// BitFlyer 現物 taker 0.15% + 実測スリッページ。往復で ~0.35% 取られる前提で評価する。
const FEE_PERCENT = 0.15;
const SLIPPAGE_PERCENT = 0.05;

// 本番が実際に扱う 5 ペア。検証対象を本番と揃えないと、検証した設定と
// 動いている設定が別物になる (この罠で 3 回はまっている)。
const SYMBOLS: Record<string, string> = {
  "BTC/JPY": "BTC-JPY",
  "ETH/JPY": "ETH-JPY",
  "XRP/JPY": "XRP-JPY",
  "XLM/JPY": "XLM-JPY",
  "MONA/JPY": "MONA-JPY",
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
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000),
  });
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
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), bars }));
  return bars;
}

async function fetchFng(): Promise<Map<string, number>> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cache = path.join(CACHE_DIR, "fng.json");
  let entries: Array<[string, number]> = [];
  if (existsSync(cache)) {
    const raw = JSON.parse(readFileSync(cache, "utf8")) as { fetchedAt: number; entries: Array<[string, number]> };
    if (Date.now() - raw.fetchedAt < 12 * 60 * 60 * 1000) return new Map(raw.entries);
  }
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=0", {
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json();
    for (const e of (json.data ?? []) as Array<{ value: string; timestamp: string }>) {
      const date = new Date(Number(e.timestamp) * 1000).toISOString().split("T")[0];
      entries.push([date, Number(e.value)]);
    }
  } catch {
    entries = [];
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), entries }));
  return new Map(entries);
}

interface Variant {
  name: string;
  note: string;
  overrides: Partial<BacktestConfig>;
}

/**
 * V0 は現状の本番設定。それ以外は「V0 に対して 1 つだけ変える」形にして、
 * 何が効いたのかが分かるようにする。
 */
const VARIANTS: Variant[] = [
  {
    name: "V0 現行",
    note: "クオンツ+規律フィルタ、逆張り許可、TP10/SL2",
    overrides: { strategy: "quant", trendGate: false, takeProfitPercent: 10, stopLossPercent: 2 },
  },
  {
    name: "V1 +trendGate",
    note: "V0 に「下降トレンド中は BUY しない」だけ追加",
    overrides: { strategy: "quant", trendGate: true, takeProfitPercent: 10, stopLossPercent: 2 },
  },
  {
    name: "V2 +trendGate+広SL",
    note: "V1 の SL を 2%→5%。往復コスト 0.35% に対し余裕を持たせる",
    overrides: { strategy: "quant", trendGate: true, takeProfitPercent: 15, stopLossPercent: 5 },
  },
  {
    name: "V3 順張り化",
    note: "V2 に加え、上昇トレンド確定時は F&G の「恐怖でなければ買うな」を免除",
    overrides: {
      strategy: "quant",
      trendGate: true,
      trendFollowEntries: true,
      takeProfitPercent: 15,
      stopLossPercent: 5,
    },
  },
  {
    name: "C  MAロングのみ",
    note: "移動平均 50/200 だけ。クオンツも AI も F&G も使わない。下降時は現金",
    overrides: {
      strategy: "trend",
      takeProfitPercent: 9999,
      stopLossPercent: 9999,
      emergencyLossPercent: 9999,
    },
  },
  {
    name: "C+SL8 実務版",
    note: "C 50/200 に -8% の保険 SL。本番の損切り機構を残した場合",
    overrides: {
      strategy: "trend",
      takeProfitPercent: 9999,
      stopLossPercent: 8,
      emergencyLossPercent: 9999,
    },
  },
  // C のパラメータ感応度。特定の 50/200 でだけ勝つなら、それは偶然の可能性が高い。
  ...[
    [20, 100],
    [30, 150],
    [50, 200],
    [100, 200],
  ].map<Variant>(([fast, slow]) => ({
    name: `C ${fast}/${slow}`,
    note: `移動平均 ${fast}/${slow} のロングのみ`,
    overrides: {
      strategy: "trend",
      trendFast: fast,
      trendSlow: slow,
      takeProfitPercent: 9999,
      stopLossPercent: 9999,
      emergencyLossPercent: 9999,
    },
  })),
];

interface Period {
  label: string;
  days: number | null; // null = 全期間
}

const PERIODS: Period[] = [
  { label: "5y全期間", days: null },
  { label: "直近2y", days: 730 },
  { label: "直近1y", days: 365 },
];

function slice(bars: OHLCVBar[], days: number | null, warmup: number): OHLCVBar[] {
  if (days === null) return bars;
  // 評価期間 + ウォームアップ分を余分に確保する (ウォームアップ中は取引しない)
  const need = days + warmup + 5;
  return bars.slice(Math.max(0, bars.length - need));
}

function fmt(v: string | number, w: number): string {
  return String(v).padStart(w);
}

function row(label: string, s: BacktestResult["stats"]): string {
  return [
    label.padEnd(18),
    fmt(s.totalReturnPercent.toFixed(1) + "%", 9),
    fmt(s.buyAndHoldReturnPercent.toFixed(1) + "%", 9),
    fmt(s.alphaPercent.toFixed(1) + "%", 9),
    fmt(String(s.numTrades), 6),
    fmt(s.winRate.toFixed(0) + "%", 6),
    fmt(String(s.profitFactor), 7),
    fmt(s.maxDrawdownPercent.toFixed(1) + "%", 8),
    fmt(String(s.sharpe), 7),
  ].join(" ");
}

const HEADER = [
  "変種".padEnd(18),
  fmt("戦略", 9),
  fmt("B&H", 9),
  fmt("α", 9),
  fmt("取引", 6),
  fmt("勝率", 6),
  fmt("PF", 7),
  fmt("最大DD", 8),
  fmt("Sharpe", 7),
].join(" ");

/**
 * ポートフォリオ検証: 本番の実挙動に合わせる。
 *
 * 本番は「1 ペアに全資金」ではなく「各ペアに固定額 (LIVE_BASE_TRADE_JPY=¥15,000)」を
 * 独立に張る。単一ペアの検証結果をそのまま本番の期待値だと思ってはいけない。
 * ここでは各ペアを資金 1/N で独立に回し、日次の合計エクイティを積み上げて評価する。
 */
function combineEquity(
  curves: Array<Array<{ date: string; equity: number }>>,
  sleeveCapital: number
): { totalReturnPercent: number; maxDrawdownPercent: number; days: number } {
  const byDate = new Map<string, number>();
  const allDates = new Set<string>();
  for (const c of curves) for (const p of c) allDates.add(p.date);
  const dates = [...allDates].sort();

  // 各スリーブは自分の最新値を持ち越す (その日にバーが無ければ前日値)
  const last = curves.map(() => sleeveCapital);
  const idx = curves.map(() => 0);
  for (const d of dates) {
    let total = 0;
    for (let i = 0; i < curves.length; i++) {
      const c = curves[i];
      while (idx[i] < c.length && c[idx[i]].date <= d) {
        last[i] = c[idx[i]].equity;
        idx[i]++;
      }
      total += last[i];
    }
    byDate.set(d, total);
  }

  const series = dates.map((d) => byDate.get(d) as number);
  const start = sleeveCapital * curves.length;
  const end = series[series.length - 1] ?? start;
  let peak = series[0] ?? start;
  let maxDD = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    totalReturnPercent: ((end - start) / start) * 100,
    maxDrawdownPercent: maxDD,
    days: dates.length,
  };
}

/** 買って持ちっぱなし (B) のエクイティ曲線 */
function buyHoldCurve(bars: OHLCVBar[], warmup: number, capital: number) {
  const entry = bars[warmup].close;
  const units = capital / entry;
  return bars.slice(warmup).map((b) => ({
    date: new Date(b.timestamp).toISOString().split("T")[0],
    equity: units * b.close,
  }));
}

test("ポートフォリオ: 現金で待つ vs 持ちっぱなし", { timeout: 20 * 60 * 1000 }, async () => {
  const fng = await fetchFng();
  const warmup = 200;
  const pairs = Object.keys(SYMBOLS);
  const sleeve = CAPITAL / pairs.length;

  const MODES = [
    {
      key: "A 現行 (上昇で買い / MA50割れで売り / 他は現金)",
      cfg: { strategy: "trend" as const, takeProfitPercent: 9999, stopLossPercent: 8, emergencyLossPercent: 9999 },
    },
    {
      key: "C 買ったら売らない (上昇で入り、以後ホールド)",
      cfg: { strategy: "trend" as const, holdForever: true, takeProfitPercent: 9999, stopLossPercent: 9999, emergencyLossPercent: 9999 },
    },
  ];

  for (const period of PERIODS) {
    console.log(`\n================ ${period.label} ================`);
    for (const mode of MODES) {
      const curves: Array<Array<{ date: string; equity: number }>> = [];
      const perPair: string[] = [];
      for (const pair of pairs) {
        const bars = slice(await fetchDaily(pair), period.days, warmup);
        if (bars.length < warmup + 30) continue;
        const r = runBacktest({
          pair, bars, fngByDate: fng,
          initialCapital: sleeve,
          slippagePercent: SLIPPAGE_PERCENT,
          feePercent: FEE_PERCENT,
          warmupBars: warmup,
          ...mode.cfg,
        });
        curves.push(r.equityCurve.map((p) => ({ date: p.date, equity: p.equity })));
        perPair.push(`${pair.split("/")[0]} ${r.stats.totalReturnPercent.toFixed(1)}%`);
      }
      if (curves.length === 0) continue;
      const c = combineEquity(curves, sleeve);
      console.log(
        `  ${mode.key}\n    リターン ${c.totalReturnPercent.toFixed(1)}%  最大DD ${c.maxDrawdownPercent.toFixed(1)}%  | ${perPair.join(" / ")}`
      );
    }

    // B: 買って持ちっぱなし
    const bhCurves: Array<Array<{ date: string; equity: number }>> = [];
    const bhPer: string[] = [];
    for (const pair of pairs) {
      const bars = slice(await fetchDaily(pair), period.days, warmup);
      if (bars.length < warmup + 30) continue;
      const cur = buyHoldCurve(bars, warmup, sleeve);
      bhCurves.push(cur);
      const ret = ((cur[cur.length - 1].equity - sleeve) / sleeve) * 100;
      bhPer.push(`${pair.split("/")[0]} ${ret.toFixed(1)}%`);
    }
    if (bhCurves.length > 0) {
      const c = combineEquity(bhCurves, sleeve);
      console.log(
        `  B 買って持ちっぱなし (最初から全額を暗号資産)\n    リターン ${c.totalReturnPercent.toFixed(1)}%  最大DD ${c.maxDrawdownPercent.toFixed(1)}%  | ${bhPer.join(" / ")}`
      );
    }
  }
});

test("戦略マトリクス", { timeout: 20 * 60 * 1000 }, async () => {
  {
    const fng = await fetchFng();
    const warmup = 200; // MA200 を使うので 200 本必要

    // 変種 → 期間 → 合計リターンを集計して、最後に総合勝者を出す
    const totals = new Map<string, number[]>();

    for (const pair of Object.keys(SYMBOLS)) {
      const all = await fetchDaily(pair);
      console.log(`\n\n================ ${pair} (${all.length} bars) ================`);

      for (const period of PERIODS) {
        const bars = slice(all, period.days, warmup);
        if (bars.length < warmup + 30) {
          console.log(`\n--- ${period.label}: データ不足 (${bars.length} bars) スキップ`);
          continue;
        }
        console.log(`\n--- ${period.label} (${bars.length} bars) ---`);
        console.log(HEADER);

        for (const v of VARIANTS) {
          try {
            const result = runBacktest({
              pair,
              bars,
              fngByDate: fng,
              initialCapital: CAPITAL,
              slippagePercent: SLIPPAGE_PERCENT,
              feePercent: FEE_PERCENT,
              warmupBars: warmup,
              ...v.overrides,
            });
            console.log(row(v.name, result.stats));
            const arr = totals.get(v.name) ?? [];
            arr.push(result.stats.totalReturnPercent);
            totals.set(v.name, arr);
          } catch (e) {
            console.log(`${v.name.padEnd(18)} エラー: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    }

    console.log("\n\n================ 総合 (全ペア×全期間の平均リターン) ================");
    const ranked = [...totals.entries()]
      .map(([name, arr]) => ({
        name,
        avg: arr.reduce((s, x) => s + x, 0) / arr.length,
        n: arr.length,
        worst: Math.min(...arr),
      }))
      .sort((a, b) => b.avg - a.avg);
    for (const r of ranked) {
      console.log(
        `${r.name.padEnd(18)} 平均 ${r.avg.toFixed(1).padStart(7)}%  最悪 ${r.worst
          .toFixed(1)
          .padStart(7)}%  (n=${r.n})`
      );
    }
    console.log("\n変種の内容:");
    for (const v of VARIANTS) console.log(`  ${v.name.padEnd(18)} ${v.note}`);
  }
});
