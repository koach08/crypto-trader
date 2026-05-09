import { NextRequest, NextResponse } from "next/server";
import { runBacktest } from "@/lib/backtest/replay";
import type { OHLCVBar } from "@/lib/types";

const YAHOO_SYMBOLS: Record<string, string> = {
  "BTC/JPY": "BTC-JPY",
  "ETH/JPY": "ETH-JPY",
  "XRP/JPY": "XRP-JPY",
};

async function fetchYahooDaily(symbol: string, range: string): Promise<OHLCVBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error("Yahoo: no result");
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0];
  if (!q) throw new Error("Yahoo: no quote");
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
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
  return bars;
}

async function fetchFngHistory(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=600", {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 3600 },
    });
    if (!r.ok) return map;
    const json = await r.json();
    for (const e of (json.data ?? []) as Array<{ value: string; timestamp: string }>) {
      const date = new Date(Number(e.timestamp) * 1000).toISOString().split("T")[0];
      map.set(date, Number(e.value));
    }
  } catch {
    /* fallback empty */
  }
  return map;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair") ?? "BTC/JPY";
  const range = url.searchParams.get("range") ?? "1y";
  const initialCapital = Number(url.searchParams.get("capital") ?? "100000");
  const tp = Number(url.searchParams.get("tp") ?? "10");
  const sl = Number(url.searchParams.get("sl") ?? "2");
  const symbol = YAHOO_SYMBOLS[pair];
  if (!symbol) {
    return NextResponse.json({ error: `Unknown pair: ${pair}` }, { status: 400 });
  }

  try {
    const [bars, fngByDate] = await Promise.all([
      fetchYahooDaily(symbol, range),
      fetchFngHistory(),
    ]);
    if (bars.length < 60) {
      return NextResponse.json(
        { error: `データ不足: ${bars.length} bars` },
        { status: 400 }
      );
    }
    const result = runBacktest({
      pair,
      bars,
      fngByDate,
      initialCapital,
      slippagePercent: 0.1,
      feePercent: 0.15,
      warmupBars: 50,
      takeProfitPercent: tp,
      stopLossPercent: sl,
    });
    // 出力サイズ削減: equity curve は均等サンプリング 100点
    const sampleStep = Math.max(1, Math.floor(result.equityCurve.length / 100));
    const equityCurve = result.equityCurve.filter((_, i) => i % sampleStep === 0);
    return NextResponse.json({
      ...result,
      equityCurve,
      tradeCount: result.trades.length,
      // tradesは最初の/最後の20件だけ返す (UIで全部見られなくていい)
      trades: [...result.trades.slice(0, 10), ...result.trades.slice(-10)],
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
