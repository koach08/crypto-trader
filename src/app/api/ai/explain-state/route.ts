import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getModel, MAX_TOKENS } from "@/lib/model-config";
import { getExchange } from "@/lib/exchanges/factory";
import { getFearGreedIndex } from "@/lib/ai/fear-greed";
import { getKillSwitchState } from "@/lib/trading/kill-switch";
import { loadData } from "@/lib/data";
import type { AIDecision, TradeRecord, Balance } from "@/lib/types";

interface PositionRecord {
  pair: string;
  amount: number;
  entryPrice: number;
  entryTimestamp: string;
  stopLossPercent?: number;
  takeProfitPercent?: number;
}

interface AIAllocationCache {
  timestamp: string;
  decision: {
    targetCashPercent: number;
    reason: string;
    confidence: number;
    source: "ai" | "fallback";
  };
}

/**
 * GET /api/ai/explain-state
 *
 * Claude に現状 (cash 比率、ポジション、最近の判断、AI 配分理由) を渡し、
 * 「なぜ今この状態か」「なぜそのペアか」「なぜ HOLD 多いか」を人語で説明させる。
 */
export async function GET() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY 未設定" }, { status: 503 });
  }

  try {
    const exchange = getExchange();
    await exchange.connect();
    const balance: Balance[] = await exchange.getBalance();
    const jpyTotal = balance.find(b => b.currency === "JPY")?.total ?? 0;
    const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;

    const cryptoBalances: { currency: string; amount: number; price: number; valueJPY: number }[] = [];
    let cryptoVal = 0;
    for (const bal of balance) {
      if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
      try {
        const t = await exchange.getTicker(`${bal.currency}/JPY`);
        const v = bal.total * t.price;
        cryptoBalances.push({ currency: bal.currency, amount: bal.total, price: t.price, valueJPY: v });
        cryptoVal += v;
      } catch { /* skip */ }
    }
    const totalNAV = jpyTotal + cryptoVal;
    const cashRatio = totalNAV > 0 ? jpyTotal / totalNAV : 1;

    const positions = await loadData<PositionRecord[]>("live-positions", []);
    const recentTrades = (await loadData<TradeRecord[]>("live-trades", [])).slice(-15);
    const recentDecisions = (await loadData<AIDecision[]>("decisions", [])).slice(-15);
    const fg = await getFearGreedIndex().catch(() => ({ value: 50, label: "Neutral" }));
    const ks = await getKillSwitchState();
    const cachedAlloc = await loadData<AIAllocationCache | null>("ai-cash-allocation-cache", null);

    const tradingPairs = (process.env.TRADING_PAIRS || "BTC/JPY,ETH/JPY,XLM/JPY,MONA/JPY").split(",").map(p => p.trim());

    // Win rate
    const closedSells = recentTrades.filter(t => t.side === "sell" && typeof t.pnl === "number");
    const wins = closedSells.filter(t => (t.pnl ?? 0) > 0).length;
    const winRate = closedSells.length > 0 ? (wins / closedSells.length) * 100 : null;

    const userPrompt = `あなたは個人投資家のために動いている AI 自動売買 bot の状況解説者です。
忖度なし、根拠ベースで、ユーザーに「なぜ今この状態なのか」を説明してください。

## 設定
- 取引対象 (現在 active): ${tradingPairs.join(", ")}
- BitFlyer 現物 spot、レバなし、最小発注 ¥5,000
- AI 自動配分: ${cachedAlloc ? `cached 適用中 (target cash ${cachedAlloc.decision.targetCashPercent}%, source=${cachedAlloc.decision.source}, 理由: ${cachedAlloc.decision.reason})` : "未発火 (初回判定待ち、cycle 6 ごとに評価)"}

## 現在のバランス
- NAV: ¥${Math.round(totalNAV).toLocaleString()}
- JPY: ¥${Math.round(jpyTotal).toLocaleString()} (free ¥${Math.round(jpyFree).toLocaleString()})
- 現金比率: ${(cashRatio * 100).toFixed(1)}%
- crypto 残高:
${cryptoBalances.map(b => `  - ${b.currency}: ${b.amount} @ ¥${b.price.toLocaleString()} = ¥${Math.round(b.valueJPY).toLocaleString()}`).join("\n") || "  なし"}

## livePositions (bot tracked)
${positions.map(p => `  - ${p.pair}: ${p.amount} @ entry ¥${p.entryPrice} (since ${p.entryTimestamp.slice(0,16)}) SL ${p.stopLossPercent ?? "?"}% TP ${p.takeProfitPercent ?? "?"}%`).join("\n") || "  なし"}

## Kill switch
- Peak NAV: ¥${Math.round(ks.peakNAV).toLocaleString()}, last: ¥${Math.round(ks.lastNAV).toLocaleString()}, drawdown ${ks.peakNAV > 0 ? (((ks.peakNAV - ks.lastNAV) / ks.peakNAV) * 100).toFixed(2) : "0"}%
- triggered: ${ks.triggered}

## 市場
- crypto Fear & Greed: ${fg.value} (${fg.label})

## 最近の bot 判断 (${recentDecisions.length} 件)
${recentDecisions.slice(-10).map(d => `  - ${(d.timestamp ?? "").slice(11,16)} ${d.pair} ${d.action} conf${d.confidence}% — ${(d.reason ?? "").slice(0,120)}`).join("\n")}

## 最近の確定取引 (${closedSells.length} 件、勝率 ${winRate?.toFixed(1) ?? "N/A"}%)
${closedSells.slice(-8).map(t => `  - ${(t.timestamp ?? "").slice(11,16)} ${t.pair} ${t.side} ¥${Math.round(t.valueJPY)} pnl ¥${Math.round(t.pnl ?? 0)} (${t.pnlPercent?.toFixed(2) ?? "?"}%)`).join("\n")}

## ユーザーが知りたいこと
1. 各 crypto 残高が「なぜ」存在するか (特に古い dust = 売却不能なものを区別)
2. なぜ現金比率が ${(cashRatio * 100).toFixed(1)}% なのか (= 高い/低い?)
3. なぜ最近の判断はほとんど HOLD なのか (もし BUY/SELL があれば、それも)
4. 直近の問題点 + 改善できるなら何
5. 全体評価: 今の状態は健全か?

## 出力
JSON のみ:
{
  "summary": "1-2文の全体要約",
  "positions_explanation": "各保有資産の存在理由を簡潔に。dust は明示",
  "cash_ratio_explanation": "現金比率の評価と理由",
  "recent_decisions_explanation": "なぜ最近 HOLD/SELL/BUY 多いか",
  "issues": ["問題点1", "問題点2"],
  "recommendations": ["改善案1", "改善案2"],
  "overall_health": "GOOD" | "OK" | "WARNING" | "BAD"
}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: getModel("claude", "HEAVY"),
      max_tokens: MAX_TOKENS.HEAVY,
      system: "忖度禁止、根拠ベース、user が次のアクションを決められるように具体的に。日本語で。",
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    // Try parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed: unknown = null;
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
    }

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      context: {
        navJPY: Math.round(totalNAV),
        cashRatio,
        cryptoBalances,
        positions,
        fearGreed: fg.value,
        recentDecisionCount: recentDecisions.length,
        recentTradeCount: closedSells.length,
        winRate,
      },
      explanation: parsed ?? text,
      raw: parsed ? undefined : text,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
