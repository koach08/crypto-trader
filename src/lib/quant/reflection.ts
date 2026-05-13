/**
 * 自己反省システム: 各負けトレードを AI に分析させ「次回どう避けるか」を抽出。
 *
 * 哲学: 統計的な signal-learning だけでは「なぜ負けた」が分からない。
 * Claude に文脈ごと渡して「人間トレーダーの振り返り」と同じ事をやらせる。
 *
 * 流れ:
 *   1. 負けトレード発生
 *   2. 当時の audit log + 結果を Claude に送る
 *   3. 「根本原因 + 回避ルール」を JSON で受け取る
 *   4. lessons.ts のルールリストに追加
 *   5. 次の判断時にルール照合 → 該当すればスキップ or 警告
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DecisionAudit } from "./audit-log";
import { loadData, saveData } from "../data";

export interface LossReflection {
  id: string;
  timestamp: string;
  pair: string;
  pnl: number;
  pnlPercent: number;
  /** 何が悪かったか (ヒトが読む文章) */
  rootCause: string;
  /** 次回これを見たら避けるルール (engine が使える具体的条件) */
  preventionRule: string;
  /** ルールのカテゴリ */
  category: "timing" | "regime" | "size" | "news" | "execution" | "other";
  /** decision 時のコンテキスト (デバッグ用) */
  decisionContext: {
    action: string;
    confidence: number;
    reason: string;
    regime: string;
    fearGreed: number;
  };
}

const REFLECTION_FILE = "loss-reflections";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

export async function reflectOnLoss(
  audit: DecisionAudit,
  outcome: { pnl: number; pnlPercent: number; exitPrice: number; exitReason: string }
): Promise<LossReflection | null> {
  const ai = getAnthropic();
  if (!ai) {
    console.warn("[reflection] ANTHROPIC_API_KEY 未設定、振り返りスキップ");
    return null;
  }

  const prompt = `あなたは経験豊富な crypto トレーダーです。以下の負けトレードを振り返って、次回同じ失敗を避けるためのルールを抽出してください。

## トレード情報
- ペア: ${audit.pair}
- アクション: ${audit.finalAction}
- 確信度: ${audit.finalConfidence}%
- AI 判断理由: ${audit.finalReason}
- レジーム: ${audit.marketState.regime}
- Fear&Greed: ${audit.marketState.fearGreedIndex}
- エントリー価格: ¥${audit.marketState.price}
- 出口価格: ¥${outcome.exitPrice}
- 損益: ¥${outcome.pnl.toFixed(0)} (${outcome.pnlPercent.toFixed(2)}%)
- 出口理由: ${outcome.exitReason}

## クオンツシグナル詳細
${audit.quantSignals?.map(s => `- ${s.name}: score ${s.score}, ${s.reason ?? ""}`).join("\n") ?? "なし"}

## 各ソースの投票
${audit.votes.map(v => `- ${v.source}: ${v.action} (${v.score}pt, conf ${v.confidence}%)`).join("\n")}

## 質問
1. **何が悪かったか** (短く 1-2 文): なぜこのトレードが失敗したのか
2. **回避ルール** (具体的に): 次回どんな条件が揃ってたら BUY/SELL を見送るべきか。engine が判定できる形式で。例: "RSI > 70 かつ 過去 5 サイクルで +3% 以上の急騰時は BUY 見送り"
3. **カテゴリ**: timing / regime / size / news / execution / other のいずれか

JSON のみで返答（前後の解説不要）:
{
  "rootCause": "...",
  "preventionRule": "...",
  "category": "..."
}`;

  try {
    const resp = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map(c => c.text)
      .join("");

    // JSON 抽出 (前後に解説あれば剥がす)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[reflection] JSON 抽出失敗:", text.slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);

    const reflection: LossReflection = {
      id: `refl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      pair: audit.pair,
      pnl: outcome.pnl,
      pnlPercent: outcome.pnlPercent,
      rootCause: String(parsed.rootCause ?? "不明"),
      preventionRule: String(parsed.preventionRule ?? "不明"),
      category: ["timing", "regime", "size", "news", "execution", "other"].includes(parsed.category)
        ? parsed.category
        : "other",
      decisionContext: {
        action: audit.finalAction,
        confidence: audit.finalConfidence,
        reason: audit.finalReason,
        regime: audit.marketState.regime,
        fearGreed: audit.marketState.fearGreedIndex,
      },
    };

    // 永続化
    const existing = await loadData<LossReflection[]>(REFLECTION_FILE, []);
    existing.push(reflection);
    await saveData(REFLECTION_FILE, existing.slice(-200)); // 最大 200 件保持

    console.log(`[reflection] 振り返り完了 (${reflection.category}): ${reflection.rootCause}`);
    console.log(`[reflection] 回避ルール: ${reflection.preventionRule}`);
    return reflection;
  } catch (e) {
    console.warn("[reflection] AI 呼出し失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getReflections(limit = 50): Promise<LossReflection[]> {
  const all = await loadData<LossReflection[]>(REFLECTION_FILE, []);
  return all.slice(-limit);
}

/**
 * カテゴリ別の集計 (どのカテゴリで負けが多いか可視化)
 */
export async function getReflectionStats(): Promise<{
  total: number;
  byCategory: Record<string, { count: number; totalLoss: number }>;
  recentRules: { rule: string; count: number }[];
}> {
  const all = await loadData<LossReflection[]>(REFLECTION_FILE, []);
  const byCategory: Record<string, { count: number; totalLoss: number }> = {};
  const ruleFreq: Record<string, number> = {};
  for (const r of all) {
    const cat = r.category;
    if (!byCategory[cat]) byCategory[cat] = { count: 0, totalLoss: 0 };
    byCategory[cat].count++;
    byCategory[cat].totalLoss += r.pnl;
    // 似たルールをカウント (前 80 文字で雑にグループ化)
    const ruleKey = r.preventionRule.slice(0, 80);
    ruleFreq[ruleKey] = (ruleFreq[ruleKey] ?? 0) + 1;
  }
  const recentRules = Object.entries(ruleFreq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));
  return { total: all.length, byCategory, recentRules };
}
