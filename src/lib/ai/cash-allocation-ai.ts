/**
 * AI-driven dynamic cash allocation decision (Wealth Navi 風だが rule ではなく LLM 判断)。
 *
 * ルールベースの動的 target (F&G / drawdown / ATR / trend の重み付け合算) は
 * シンプルだが市場のニュアンスや intel を取り込めない。
 * このモジュールは Claude に context を渡して「target cash %」を直接返させる。
 *
 * - 1 cycle ごとに毎回呼ぶと token 浪費なので、6h 間隔で cache。
 * - AI 失敗時は呼び出し側の rule-based fallback に委譲。
 */

import Anthropic from "@anthropic-ai/sdk";
import { getModel, MAX_TOKENS } from "../model-config";
import { parseAiJson } from "../json-utils";
import { loadData, saveData } from "../data";

export interface AICashAllocationContext {
  navJPY: number;
  cashRatio: number;
  cryptoRatio: number;
  fearGreed: number;
  fearGreedLabel: string;
  btcPriceJPY: number;
  btc24hChangePercent: number;
  btcAtrPercent: number;
  btcTrendBullish: boolean;
  navPeakJPY: number;
  navDrawdownPct: number;
  recentTradeWinRate: number | null;
  recentTradeCount: number;
  /** intel summary (news, on-chain etc.) */
  intelSummary?: string;
  /** ルールベース推奨 (AI への参考値) */
  ruleBasedTarget: number;
  ruleBasedReason: string;
}

export interface AICashAllocationDecision {
  targetCashPercent: number;  // 10-60
  reason: string;
  confidence: number;          // 0-100
  source: "ai" | "fallback";
  raw?: string;
}

const CACHE_FILE = "ai-cash-allocation-cache";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6h

interface CachedDecision {
  timestamp: string;
  decision: AICashAllocationDecision;
  /** Cache 無効化用: 大きく変わったら再計算したい */
  contextHash: string;
}

function hashContext(ctx: AICashAllocationContext): string {
  return [
    Math.round(ctx.fearGreed),
    Math.round(ctx.btcAtrPercent * 10) / 10,
    ctx.btcTrendBullish ? "B" : "b",
    Math.round(ctx.navDrawdownPct),
    Math.round(ctx.btc24hChangePercent),
  ].join("|");
}

const SYSTEM_PROMPT = `あなたは AI 駆動の crypto 資産配分アドバイザーである。
個人投資家の少額仮想通貨ポートフォリオに対し、市場状況を踏まえて「現金比率の目標値」を提案する。

ユーザーは「利益を上げる」ことを目的としている。そのために必要な exposure と保守のバランスを判断する。
「短期売買では構造的に勝てない」という先入観を持たず、context (F&G / ATR / trend / drawdown / 自分の勝率) から判断する。

判断の原則:
1. **トレンド良好 (bull + 低ボラ + F&G 中立)**: 攻め (10-20% cash) → crypto 多めで beta を取る
2. **バブル域 (F&G ≥ 80)**: 守り (30-45% cash) → 反落リスク回避
3. **パニック域 (F&G ≤ 20)**: 買い場 (10-20% cash) → 攻める
4. **高ボラ (ATR ≥ 4%)**: わずか厚め (+5%) → ドローダウン耐性
5. **下落トレンド**: わずか厚め (+5%)
6. **ドローダウン中 (peak から -10% 超)**: cooling (+5-10%)
7. **自分の勝率が低い (<40%)**: 配分を保守気味に
8. **断言しない**: 「絶対こうなる」型は危険、context に従う

範囲: 10-50% (極端な防御以外は 10-30% を基本)。

## 出力
必ず以下の JSON のみ (他のテキスト不要):
{
  "target_cash_percent": 数値 (10-50 の整数),
  "reason": "判断理由を1-2文で簡潔に",
  "confidence": 数値 (0-100, 自分の判断への自信度)
}`;

function buildUserPrompt(ctx: AICashAllocationContext): string {
  return `以下のポートフォリオ・市場状況を分析し、目標現金比率を提案してください。

## 現状
- NAV: ¥${Math.round(ctx.navJPY).toLocaleString()}
- 現在の現金比率: ${(ctx.cashRatio * 100).toFixed(1)}% (暗号通貨 ${(ctx.cryptoRatio * 100).toFixed(1)}%)
- Peak NAV: ¥${Math.round(ctx.navPeakJPY).toLocaleString()}, peak からの drawdown: ${ctx.navDrawdownPct.toFixed(2)}%

## 市場
- BTC 価格: ¥${Math.round(ctx.btcPriceJPY).toLocaleString()}, 24h 変動: ${ctx.btc24hChangePercent.toFixed(2)}%
- BTC ATR / 価格: ${ctx.btcAtrPercent.toFixed(2)}% (ボラ指標)
- BTC trend (SMA20 vs SMA50): ${ctx.btcTrendBullish ? "↑ bullish" : "↓ bearish"}
- crypto Fear & Greed: ${ctx.fearGreed} (${ctx.fearGreedLabel})

## 自分の最近の取引成績
${ctx.recentTradeCount > 0 && ctx.recentTradeWinRate !== null
  ? `- 直近 ${ctx.recentTradeCount} 件、勝率 ${ctx.recentTradeWinRate.toFixed(1)}%`
  : "- 取引データ不足"}

## ルールベース推奨 (参考値、必ずしも従わなくて良い)
- target_cash_percent ${(ctx.ruleBasedTarget * 100).toFixed(0)}%
- 計算根拠: ${ctx.ruleBasedReason}

${ctx.intelSummary ? `\n## 外部 intel\n${ctx.intelSummary}\n` : ""}

上記を踏まえ、target_cash_percent (10-60) を JSON で返してください。`;
}

async function getCached(contextHash: string): Promise<AICashAllocationDecision | null> {
  try {
    const cache = await loadData<CachedDecision | null>(CACHE_FILE, null);
    if (!cache) return null;
    const age = Date.now() - new Date(cache.timestamp).getTime();
    if (age > CACHE_TTL_MS) return null;
    if (cache.contextHash !== contextHash) return null;
    return cache.decision;
  } catch {
    return null;
  }
}

async function setCached(contextHash: string, decision: AICashAllocationDecision): Promise<void> {
  await saveData<CachedDecision>(CACHE_FILE, {
    timestamp: new Date().toISOString(),
    decision,
    contextHash,
  });
}

export async function decideTargetCashRatio(ctx: AICashAllocationContext): Promise<AICashAllocationDecision> {
  const contextHash = hashContext(ctx);

  // Cache hit (6h 以内かつ context 似てる)
  const cached = await getCached(contextHash);
  if (cached) {
    return { ...cached, source: cached.source };
  }

  // API key なし → fallback
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      targetCashPercent: Math.round(ctx.ruleBasedTarget * 100),
      reason: "AI 利用不可 (ANTHROPIC_API_KEY 未設定)、ルールベース値を使用",
      confidence: 50,
      source: "fallback",
    };
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: getModel("claude", "STANDARD"),
      max_tokens: MAX_TOKENS.STANDARD,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    const parsed = parseAiJson<{ target_cash_percent: number; reason: string; confidence: number }>(
      text,
      (obj) => typeof obj.target_cash_percent === "number"
    );

    if (!parsed) {
      return {
        targetCashPercent: Math.round(ctx.ruleBasedTarget * 100),
        reason: `AI 応答 parse 失敗、ルールベース fallback`,
        confidence: 30,
        source: "fallback",
        raw: text.slice(0, 200),
      };
    }

    const clamped = Math.max(10, Math.min(60, Math.round(parsed.target_cash_percent)));
    const decision: AICashAllocationDecision = {
      targetCashPercent: clamped,
      reason: String(parsed.reason ?? "AI judgment").slice(0, 200),
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      source: "ai",
    };

    await setCached(contextHash, decision);
    return decision;
  } catch (e) {
    return {
      targetCashPercent: Math.round(ctx.ruleBasedTarget * 100),
      reason: `AI 呼び出し失敗 (${e instanceof Error ? e.message : "unknown"})、ルールベース fallback`,
      confidence: 20,
      source: "fallback",
    };
  }
}
