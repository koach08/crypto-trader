/**
 * 戦略リトロスペクティブ: 一定取引数ごとに AI が全 trade を見直し、戦略を提案。
 *
 * 既存:
 *   - reflection.ts: 個別損失の振り返り (ミクロ)
 *   - loss-analyzer.ts: 統計的パターン検出 (マクロ統計)
 *
 * このモジュール:
 *   - AI が「全勝ち負け」を読み、「次にどう変えるか」具体提案
 *   - 結果を JSON で保存 → engine が読んで自動適用
 *   - 安全範囲内 (TP 0.5-3.0%, SL 0.3-2.0% 等) に clamp
 */

import Anthropic from "@anthropic-ai/sdk";
import type { TradeRecord } from "../types";
import type { DecisionAudit } from "./audit-log";
import { loadData, saveData } from "../data";

export interface StrategyOverrides {
  /** 全体 SL multiplier (0.5 = 半分, 2.0 = 倍) */
  slMultiplier: number;
  /** 全体 TP multiplier */
  tpMultiplier: number;
  /** 全体 confidence threshold 加算 (例: +5 で閾値厳しく) */
  confidenceBonus: number;
  /** ペアごとの取引除外フラグ */
  excludePairs: string[];
  /** 信頼度高い好みパターン (UI 表示用) */
  preferredPatterns: string[];
  /** 避けるべきパターン (UI 表示用) */
  avoidPatterns: string[];
  /** 直近のリトロスペクティブ理由 (ログ用) */
  reasoning: string;
  /** 適用日時 */
  appliedAt: string;
  /** どの取引数時点で生成されたか */
  basedOnTrades: number;
}

const OVERRIDES_FILE = "strategy-overrides";
const RETRO_LOG_FILE = "retrospective-log";

const DEFAULT_OVERRIDES: StrategyOverrides = {
  slMultiplier: 1.0,
  tpMultiplier: 1.0,
  confidenceBonus: 0,
  excludePairs: [],
  preferredPatterns: [],
  avoidPatterns: [],
  reasoning: "初期値 (調整なし)",
  appliedAt: "1970-01-01T00:00:00Z",
  basedOnTrades: 0,
};

/** 安全範囲に強制 clamp */
function clampOverrides(o: Partial<StrategyOverrides>): StrategyOverrides {
  return {
    slMultiplier: Math.max(0.5, Math.min(2.0, o.slMultiplier ?? 1.0)),
    tpMultiplier: Math.max(0.5, Math.min(2.5, o.tpMultiplier ?? 1.0)),
    confidenceBonus: Math.max(-15, Math.min(20, o.confidenceBonus ?? 0)),
    excludePairs: (o.excludePairs ?? []).slice(0, 3), // 最大 3 ペア除外
    preferredPatterns: (o.preferredPatterns ?? []).slice(0, 5),
    avoidPatterns: (o.avoidPatterns ?? []).slice(0, 5),
    reasoning: String(o.reasoning ?? "").slice(0, 1000),
    appliedAt: new Date().toISOString(),
    basedOnTrades: Number(o.basedOnTrades ?? 0),
  };
}

export async function getActiveOverrides(): Promise<StrategyOverrides> {
  return await loadData<StrategyOverrides>(OVERRIDES_FILE, DEFAULT_OVERRIDES);
}

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  if (_ai) return _ai;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _ai = new Anthropic({ apiKey: key });
  return _ai;
}

interface TradeWithAudit {
  trade: TradeRecord;
  audit?: DecisionAudit;
}

/**
 * 直近 N 取引から戦略改善提案を AI に出させる.
 * 重い処理 (Claude 呼出し) なので頻繁には呼ばない。
 */
export async function runStrategicRetrospective(
  trades: TradeRecord[],
  audits: DecisionAudit[],
  totalTradeCount: number,
): Promise<StrategyOverrides | null> {
  const ai = getAI();
  if (!ai) {
    console.warn("[retrospective] ANTHROPIC_API_KEY 未設定、スキップ");
    return null;
  }

  // SELL 側 (確定損益あり) のみ
  const sells = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  if (sells.length < 10) {
    console.log(`[retrospective] サンプル不足 (${sells.length}件)、スキップ`);
    return null;
  }

  // 各 trade に近い audit を紐付け
  const enriched: TradeWithAudit[] = sells.slice(-50).map(trade => {
    const tradeMs = new Date(trade.timestamp).getTime();
    const audit = audits
      .filter(a => a.pair === trade.pair)
      .sort((a, b) => Math.abs(new Date(a.timestamp).getTime() - tradeMs) - Math.abs(new Date(b.timestamp).getTime() - tradeMs))[0];
    return { trade, audit };
  });

  // 集計
  const wins = enriched.filter(e => (e.trade.pnl ?? 0) > 0);
  const losses = enriched.filter(e => (e.trade.pnl ?? 0) < 0);
  const winRate = enriched.length > 0 ? wins.length / enriched.length : 0;
  const totalPnL = enriched.reduce((s, e) => s + (e.trade.pnl ?? 0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + (e.trade.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, e) => s + (e.trade.pnl ?? 0), 0) / losses.length : 0;

  // ペア別
  const byPair: Record<string, { count: number; wins: number; losses: number; pnl: number }> = {};
  for (const e of enriched) {
    if (!byPair[e.trade.pair]) byPair[e.trade.pair] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    byPair[e.trade.pair].count++;
    if ((e.trade.pnl ?? 0) > 0) byPair[e.trade.pair].wins++;
    else byPair[e.trade.pair].losses++;
    byPair[e.trade.pair].pnl += e.trade.pnl ?? 0;
  }

  // Trade 詳細を 1行ずつ要約
  const tradeRows = enriched.map(e => {
    const t = e.trade;
    const a = e.audit;
    return `${t.timestamp.slice(5, 16)} ${t.pair} ${(t.pnl ?? 0) > 0 ? "WIN" : "LOSS"} ¥${(t.pnl ?? 0).toFixed(0)} (${(t.pnlPercent ?? 0).toFixed(2)}%) ${a ? `regime=${a.marketState.regime} conf=${a.finalConfidence}% F&G=${a.marketState.fearGreedIndex}` : "(audit 無)"}`;
  }).join("\n");

  const pairSummary = Object.entries(byPair)
    .map(([p, d]) => `  ${p}: ${d.count}件 WR${(d.wins / d.count * 100).toFixed(0)}% PnL¥${d.pnl.toFixed(0)}`)
    .join("\n");

  const prompt = `あなたは crypto bot トレーダーのストラテジスト. 直近 ${enriched.length} 取引のデータを見て、戦略の調整を JSON で提案してください.

## 集計
- 総取引: ${enriched.length}
- 勝率: ${(winRate * 100).toFixed(1)}% (W${wins.length} / L${losses.length})
- 累計損益: ¥${totalPnL.toFixed(0)}
- 平均勝ち: ¥${avgWin.toFixed(0)}
- 平均負け: ¥${avgLoss.toFixed(0)}
- R:R 実績: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "N/A"}

## ペア別
${pairSummary}

## 取引履歴 (新しい順)
${tradeRows}

## 質問
次の戦略パラメータをどう調整すべきか、JSON で返してください:
{
  "slMultiplier": <0.5-2.0 の数値、現在の SL を倍率調整。例 0.7 = SL 30%厳しく>,
  "tpMultiplier": <0.5-2.5 の数値、現在の TP を倍率調整。例 1.5 = TP 50%広く>,
  "confidenceBonus": <-15 〜 +20 の数値、確信度閾値の加算。+ で厳しく>,
  "excludePairs": [<取引から完全除外すべきペア>], 最大 3 つ,
  "preferredPatterns": [<勝ちやすいパターン>], 短文で 3 個,
  "avoidPatterns": [<避けるべきパターン>], 短文で 3 個,
  "reasoning": "<3-4 行で根拠説明>"
}

提案の方針:
- WR 50% 未満なら閾値厳しく (confidenceBonus +5〜+10)
- 平均負け > 平均勝ち なら SL タイト化 (slMultiplier 0.7)
- 1ペアの WR 著しく低い (<30%) ならそのペアを exclude
- WR 60%超え + R:R 良好なら TP 広く (tpMultiplier 1.3-1.5)
- 何も顕著でなければ全部 1.0 (微調整不要)

JSON のみ返答 (前後の解説不要)`;

  try {
    const resp = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map(c => c.text)
      .join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[retrospective] JSON 抽出失敗");
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const overrides = clampOverrides({ ...parsed, basedOnTrades: totalTradeCount });

    // 永続化
    await saveData(OVERRIDES_FILE, overrides);
    // 履歴ログ
    const logs = await loadData<StrategyOverrides[]>(RETRO_LOG_FILE, []);
    logs.push(overrides);
    await saveData(RETRO_LOG_FILE, logs.slice(-30));

    console.log(`[retrospective] 戦略更新: SL×${overrides.slMultiplier} TP×${overrides.tpMultiplier} conf+${overrides.confidenceBonus} 除外[${overrides.excludePairs.join(",")}]`);
    console.log(`[retrospective] 根拠: ${overrides.reasoning}`);
    return overrides;
  } catch (e) {
    console.warn("[retrospective] AI 呼出し失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getRetrospectiveLog(limit = 10): Promise<StrategyOverrides[]> {
  const all = await loadData<StrategyOverrides[]>(RETRO_LOG_FILE, []);
  return all.slice(-limit);
}
