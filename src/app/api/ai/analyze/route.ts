import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import { generateCryptoSignal } from "@/lib/indicators";
import { buildAnalysisPrompt } from "@/lib/ai/crypto-prompt";
import { runAllEngines, runSingleEngine } from "@/lib/ai/engines";
import { buildConsensus } from "@/lib/ai/consensus";
import { getFearGreedIndex } from "@/lib/ai/fear-greed";

export async function POST(req: NextRequest) {
  const { pair = "BTC/JPY", fullConsensus = false } = await req.json();

  try {
    const exchange = getExchange();
    await exchange.connect();

    // Fetch data in parallel
    const [ticker, bars, balance, position, fearGreed] = await Promise.all([
      exchange.getTicker(pair),
      exchange.getOHLCV(pair, "1h", 100),
      exchange.getBalance(),
      exchange.getPosition(pair),
      getFearGreedIndex(),
    ]);

    // Technical analysis
    const signal = generateCryptoSignal(bars);

    // Build prompt
    const prompt = buildAnalysisPrompt({
      pair,
      ticker,
      signal,
      fearGreed,
      position,
      balance,
    });

    // Run AI analysis
    let decision;
    if (fullConsensus) {
      const results = await runAllEngines(prompt, "STANDARD");
      decision = buildConsensus(results, pair, "bitflyer", signal.score, fearGreed.value);
    } else {
      const result = await runSingleEngine(prompt, "STANDARD");
      decision = buildConsensus([result], pair, "bitflyer", signal.score, fearGreed.value);
    }

    return NextResponse.json({
      decision,
      ticker,
      signal,
      fearGreed,
      position,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
