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
import { applyAiPolicyUpdate, getCapitalPolicy, limitsFor } from "../trading/capital-policy";

export interface PairOverride {
  /** このペア専用 SL multiplier */
  slMultiplier: number;
  /** このペア専用 TP multiplier */
  tpMultiplier: number;
  /** このペア専用 confidence 加算 */
  confidenceBonus: number;
  /** このペアの戦略タイプ */
  style: "scalp" | "swing" | "position" | "hold-only";
  /** AI 判断の根拠 */
  reasoning: string;
}

export interface StrategyOverrides {
  /** 全体 SL multiplier (0.5 = 半分, 2.0 = 倍) */
  slMultiplier: number;
  /** 全体 TP multiplier */
  tpMultiplier: number;
  /** 全体 confidence threshold 加算 (例: +5 で閾値厳しく) */
  confidenceBonus: number;
  /** ペアごとの取引除外フラグ — 最後の手段 (なるべく使わない) */
  excludePairs: string[];
  /** ペアごとの専用戦略 (これが本命) */
  perPair: Record<string, PairOverride>;
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
  perPair: {},
  preferredPatterns: [],
  avoidPatterns: [],
  reasoning: "初期値 (調整なし)",
  appliedAt: "1970-01-01T00:00:00Z",
  basedOnTrades: 0,
};

function clampPairOverride(o: Partial<PairOverride>): PairOverride {
  const style = (["scalp", "swing", "position", "hold-only"] as const).includes(o.style as never)
    ? (o.style as PairOverride["style"])
    : "swing";
  return {
    slMultiplier: Math.max(0.3, Math.min(3.0, o.slMultiplier ?? 1.0)),
    tpMultiplier: Math.max(0.3, Math.min(3.0, o.tpMultiplier ?? 1.0)),
    confidenceBonus: Math.max(-15, Math.min(25, o.confidenceBonus ?? 0)),
    style,
    reasoning: String(o.reasoning ?? "").slice(0, 300),
  };
}

/** 安全範囲に強制 clamp */
function clampOverrides(o: Partial<StrategyOverrides>): StrategyOverrides {
  const perPair: Record<string, PairOverride> = {};
  for (const [pair, override] of Object.entries(o.perPair ?? {})) {
    if (typeof override === "object" && override !== null) {
      perPair[pair] = clampPairOverride(override as Partial<PairOverride>);
    }
  }
  return {
    slMultiplier: Math.max(0.5, Math.min(2.0, o.slMultiplier ?? 1.0)),
    tpMultiplier: Math.max(0.5, Math.min(2.5, o.tpMultiplier ?? 1.0)),
    confidenceBonus: Math.max(-15, Math.min(20, o.confidenceBonus ?? 0)),
    excludePairs: (o.excludePairs ?? []).slice(0, 3),
    perPair,
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

  // === Capital policy 現状 (AI に投入量の裁量を持たせる) ===
  const currentPolicy = await getCapitalPolicy();
  const tierLimits = limitsFor(currentPolicy.tier);
  const policyContext = `## 現在のキャリア tier: ${currentPolicy.tier}
- 投入可能上限: ${tierLimits.maxDeployPercent}% (バッファ最低 ${100 - tierLimits.maxDeployPercent}%)
- 現状の cash buffer: ${currentPolicy.cashBufferPercent}% (この tier の許容: ${tierLimits.bufferMinPercent}-${tierLimits.bufferMaxPercent}%)
- 現状の conviction boost: ${currentPolicy.convictionBoost.toFixed(2)}x (この tier の上限: ${tierLimits.maxConvictionBoost}x)
- 自動評価メトリクス: ${currentPolicy.metrics.totalTrades}件 WR${(currentPolicy.metrics.winRate * 100).toFixed(0)}% Sharpe${currentPolicy.metrics.sharpe.toFixed(2)} maxDD${currentPolicy.metrics.maxDrawdownPercent.toFixed(1)}%`;

  const prompt = `あなたは crypto bot トレーダーのストラテジスト. 直近 ${enriched.length} 取引のデータを見て、戦略と「投入量」を JSON で提案してください.

${policyContext}

**重要**: 「負けてるペアを除外する」は最終手段です. まず「**ペアごとに合った戦略**」を提案してください.
例えば XRP は値動き小さい銀行系銘柄なので、ETH 用の TP/SL では機能しないことが多いです.
各ペアの特性に合わせた tp/sl/confidence を per-pair で出してください.

## 全体集計
- 総取引: ${enriched.length}
- 勝率: ${(winRate * 100).toFixed(1)}% (W${wins.length} / L${losses.length})
- 累計損益: ¥${totalPnL.toFixed(0)}
- 平均勝ち: ¥${avgWin.toFixed(0)}
- 平均負け: ¥${avgLoss.toFixed(0)}

## ペア別
${pairSummary}

## 取引履歴 (新しい順 50件まで)
${tradeRows}

## 期待する JSON 形式

{
  "slMultiplier": <0.5-2.0、全体 SL 倍率>,
  "tpMultiplier": <0.5-2.5、全体 TP 倍率>,
  "confidenceBonus": <-15..+20、全体閾値加算>,
  "excludePairs": [],  // 原則空。ペア別 perPair で適応する事を推奨
  "perPair": {
    "XRP/JPY": {
      "slMultiplier": <例: XRP のボラに合わせ 0.5 = SL タイト>,
      "tpMultiplier": <例: 1.5 = TP 広げて少ない頻度で大きく取る>,
      "confidenceBonus": <例: +10 = この pair はノイズ多いから厳しめ>,
      "style": "scalp" | "swing" | "position" | "hold-only",
      "reasoning": "短く根拠"
    },
    "ETH/JPY": { ... },
    "BTC/JPY": { ... }
  },
  "capital": {
    "cashBufferPercent": <数値、現 tier の許容範囲内: ${tierLimits.bufferMinPercent}-${tierLimits.bufferMaxPercent}%>,
    "convictionBoost": <数値、0.7-${tierLimits.maxConvictionBoost}。強シグナル時の追加倍率>,
    "reasoning": "<投入量判断の根拠 2-3 行>"
  },
  "preferredPatterns": [<勝ちやすいパターン 3つ>],
  "avoidPatterns": [<避けるべきパターン 3つ>],
  "reasoning": "<全体戦略 4-5 行>"
}

## ガイドライン
- **負けてるペアこそ「ペア別戦略を立てる」**. 除外は最後の手段
- 値動き小さいペア (XRP, XLM) → scalp 不向き. swing or position 向き. TP/SL 広く
- 値動き大きいペア (ETH, MONA) → scalp 向きの可能性. TP/SL 通常
- 大型流動性ペア (BTC) → 中速 swing 向き
- WR 30% 以下なら style 変更を必須 (例: scalp → position)
- "hold-only" は「新規 BUY 止めて含み益待ち」モード
- excludePairs は完全に手に負えない場合の最終手段

### Capital (投入量) 判断ガイド
- 直近成績好調 (WR≥55%、累損益+、Sharpe>0.8) → cashBuffer を tier 最低近くまで下げ、convictionBoost を tier 上限近くまで上げる
- 直近不調 (WR<45% or 累損益マイナス) → cashBuffer を tier 最高近くまで上げ、convictionBoost を 0.8 まで下げる (守りに入る)
- 中間 → 現状維持か小幅調整
- ※ tier 自体の上下は別 logic が自動判定するので、ここでは現 tier 枠内で動かす

JSON のみ返答`;

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
    // Claude が "+8" と書く事がある (JSON spec 外) → "+" を除去
    const sanitized = jsonMatch[0].replace(/:\s*\+(\d)/g, ": $1");
    const parsed = JSON.parse(sanitized);
    const overrides = clampOverrides({ ...parsed, basedOnTrades: totalTradeCount });

    // 永続化
    await saveData(OVERRIDES_FILE, overrides);
    // 履歴ログ
    const logs = await loadData<StrategyOverrides[]>(RETRO_LOG_FILE, []);
    logs.push(overrides);
    await saveData(RETRO_LOG_FILE, logs.slice(-30));

    // === Capital policy 更新 (AI 提案、tier 枠内で clamp) ===
    const cap = parsed && typeof parsed === "object" ? (parsed as { capital?: { cashBufferPercent?: number; convictionBoost?: number; reasoning?: string } }).capital : undefined;
    if (cap && (typeof cap.cashBufferPercent === "number" || typeof cap.convictionBoost === "number")) {
      try {
        await applyAiPolicyUpdate({
          cashBufferPercent: cap.cashBufferPercent,
          convictionBoost: cap.convictionBoost,
          reasoning: cap.reasoning ?? overrides.reasoning,
        });
      } catch (e) {
        console.warn("[retrospective] capital policy 更新失敗:", e instanceof Error ? e.message : e);
      }
    }

    console.log(`[retrospective] 全体: SL×${overrides.slMultiplier} TP×${overrides.tpMultiplier} conf+${overrides.confidenceBonus}`);
    for (const [pair, p] of Object.entries(overrides.perPair)) {
      console.log(`[retrospective] ${pair}: SL×${p.slMultiplier} TP×${p.tpMultiplier} conf+${p.confidenceBonus} [${p.style}] — ${p.reasoning}`);
    }
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
