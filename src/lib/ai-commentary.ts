/**
 * AI Daily Commentary: 毎朝 9:00 JST に Claude が当日のレポート生成.
 *
 * 含む内容:
 *   - 過去 24h の取引サマリ (件数、WR、損益、最大勝ち/負け)
 *   - 当日の市場状況 (intel 8 ソース要約、F&G、価格変動)
 *   - 「なぜ動いた/動かなかったか」分析
 *   - 明日の見立て (短期予測 + 警戒シナリオ)
 *
 * 出力先:
 *   - Slack/console (sendAlert)
 *   - 永続化 (daily-commentary log)
 *
 * 発火条件: cycle 内で「JST 9 時台 + 当日まだ未発火」なら 1 回だけ実行.
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadData, saveData } from "./data";
import { sendAlert } from "./alerts";
import type { TradeRecord } from "./types";
import type { AggregatedIntel } from "./intel/aggregator";
import type { CapitalPolicy } from "./trading/capital-policy";

const STATE_FILE = "ai-commentary-state";
const LOG_FILE = "ai-commentary-log";

interface CommentaryState {
  lastFiredDate: string; // "YYYY-MM-DD" in JST
}

export interface CommentaryEntry {
  date: string;
  generatedAt: string;
  summary: string;
  tradeStats: {
    count: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    biggestWin: number;
    biggestLoss: number;
  };
  intelSnapshot: { total: number; verdict: string };
  policySnapshot: { tier: string; buffer: number };
  /** 構造化 JSON (AI 出力) */
  ai?: {
    summary: string;
    keyEvents: string[];
    tomorrowOutlook: string;
    watchPoints: string[];
  };
}

function jstDateString(d: Date = new Date()): string {
  // UTC → JST (+9h) で YYYY-MM-DD
  const jstMs = d.getTime() + 9 * 3600 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

function jstHour(d: Date = new Date()): number {
  const jstMs = d.getTime() + 9 * 3600 * 1000;
  return new Date(jstMs).getUTCHours();
}

/** 当日 (JST) 9 時台に発火可能か (まだ未発火なら true) */
export async function shouldFireCommentary(): Promise<boolean> {
  const hour = jstHour();
  if (hour !== 9) return false; // 9:00-9:59 のみ
  const state = await loadData<CommentaryState>(STATE_FILE, { lastFiredDate: "" });
  const today = jstDateString();
  return state.lastFiredDate !== today;
}

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  if (_ai) return _ai;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _ai = new Anthropic({ apiKey: key });
  return _ai;
}

/**
 * 過去 24h の trade を集計 → AI に分析させてレポート生成 + Slack 配信.
 */
export async function runDailyCommentary(opts: {
  trades: TradeRecord[];
  intel: AggregatedIntel | null;
  policy: CapitalPolicy | null;
  currentNAV: number;
}): Promise<CommentaryEntry | null> {
  const today = jstDateString();
  const ai = getAI();

  // 過去 24h の取引
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = opts.trades.filter(t => new Date(t.timestamp).getTime() >= cutoff);
  const sells = recent.filter(t => t.side === "sell" && typeof t.pnl === "number");
  const wins = sells.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = sells.filter(t => (t.pnl ?? 0) < 0).length;
  const totalPnL = sells.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const pnls = sells.map(t => t.pnl ?? 0);
  const biggestWin = pnls.length > 0 ? Math.max(...pnls) : 0;
  const biggestLoss = pnls.length > 0 ? Math.min(...pnls) : 0;
  const winRate = sells.length > 0 ? wins / sells.length : 0;

  const tradeStats = {
    count: recent.length,
    wins, losses, winRate,
    totalPnL,
    biggestWin, biggestLoss,
  };

  // AI に分析させる
  let aiResult: CommentaryEntry["ai"] | undefined;
  if (ai) {
    try {
      const tradeRows = recent
        .filter(t => t.side === "sell")
        .slice(-30)
        .map(t => `${t.timestamp.slice(11, 16)} ${t.pair} ${t.side} ¥${(t.valueJPY ?? 0).toFixed(0)} pnl=¥${(t.pnl ?? 0).toFixed(0)}`)
        .join("\n");
      const intelStr = opts.intel
        ? `total ${opts.intel.totalScore} (${opts.intel.verdict}). 投機 ${opts.intel.categories.speculation.score} / 実需 ${opts.intel.categories.utility.score} / マクロ ${opts.intel.categories.macro.score}`
        : "intel データ取得失敗";
      const policyStr = opts.policy
        ? `tier ${opts.policy.tier}, buffer ${opts.policy.cashBufferPercent}%, boost ${opts.policy.convictionBoost.toFixed(2)}x`
        : "policy 未取得";

      const prompt = `あなたは crypto trading bot の専属アナリスト. 昨日 24h の取引を分析し、今日のレポートを user に配信してください.

## 取引サマリ (過去 24h)
- 総取引: ${recent.length} 件 (sell 確定: ${sells.length})
- 勝率: ${(winRate * 100).toFixed(1)}% (W${wins}/L${losses})
- 累計損益: ¥${totalPnL.toFixed(0)}
- 最大勝ち: ¥${biggestWin.toFixed(0)}
- 最大負け: ¥${biggestLoss.toFixed(0)}
- 現 NAV: ¥${opts.currentNAV.toFixed(0)}

## 市場 intel
${intelStr}

## bot 状態
${policyStr}

## 取引ログ (直近 30 件)
${tradeRows || "(取引なし)"}

## 求める JSON 出力
{
  "summary": "<昨日何が起きたかの 2-3 行要約>",
  "keyEvents": [<重要イベント 3-5 個>],
  "tomorrowOutlook": "<今日の見立て 2-3 行>",
  "watchPoints": [<注意すべき点 3-5 個>]
}

日本語で簡潔に. 感情的でなく事実ベースで.JSON のみ返答.`;

      const resp = await ai.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map(c => c.text).join("");
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const sanitized = jsonMatch[0].replace(/,(\s*[}\]])/g, "$1");
        const parsed = JSON.parse(sanitized);
        aiResult = {
          summary: String(parsed.summary ?? "").slice(0, 500),
          keyEvents: Array.isArray(parsed.keyEvents) ? parsed.keyEvents.slice(0, 5).map(String) : [],
          tomorrowOutlook: String(parsed.tomorrowOutlook ?? "").slice(0, 500),
          watchPoints: Array.isArray(parsed.watchPoints) ? parsed.watchPoints.slice(0, 5).map(String) : [],
        };
      }
    } catch (e) {
      console.warn("[daily-commentary] AI 失敗:", e instanceof Error ? e.message : e);
    }
  }

  // フォールバック: AI 無しでも基本サマリは出す
  const summaryText = aiResult?.summary ?? `過去 24h: ${recent.length} 取引, 勝率 ${(winRate * 100).toFixed(0)}%, 累計 ¥${totalPnL.toFixed(0)}, NAV ¥${opts.currentNAV.toFixed(0)}`;

  // Slack 配信
  const slackFields: Record<string, string> = {
    "Trades": `${sells.length}件 W${wins}/L${losses}`,
    "PnL": `¥${totalPnL.toFixed(0)}`,
    "WR": `${(winRate * 100).toFixed(0)}%`,
    "NAV": `¥${opts.currentNAV.toFixed(0)}`,
  };
  if (opts.intel) slackFields["Intel"] = `${opts.intel.totalScore} (${opts.intel.verdict})`;
  if (opts.policy) slackFields["Tier"] = opts.policy.tier;

  let message = `📊 *Daily Commentary ${today}*\n${summaryText}`;
  if (aiResult?.tomorrowOutlook) {
    message += `\n\n*今日の見立て*: ${aiResult.tomorrowOutlook}`;
  }
  if (aiResult?.watchPoints && aiResult.watchPoints.length > 0) {
    message += `\n*注意*: ${aiResult.watchPoints.slice(0, 3).join(" / ")}`;
  }

  await sendAlert({
    level: "info",
    message,
    dedupeKey: `daily-commentary:${today}`,
    fields: slackFields,
  });

  // 永続化
  const entry: CommentaryEntry = {
    date: today,
    generatedAt: new Date().toISOString(),
    summary: summaryText,
    tradeStats,
    intelSnapshot: opts.intel
      ? { total: opts.intel.totalScore, verdict: opts.intel.verdict }
      : { total: 0, verdict: "取得失敗" },
    policySnapshot: opts.policy
      ? { tier: opts.policy.tier, buffer: opts.policy.cashBufferPercent }
      : { tier: "?", buffer: 0 },
    ai: aiResult,
  };

  const logs = await loadData<CommentaryEntry[]>(LOG_FILE, []);
  logs.push(entry);
  await saveData(LOG_FILE, logs.slice(-90));
  await saveData(STATE_FILE, { lastFiredDate: today });

  console.log(`[daily-commentary] generated for ${today}`);
  return entry;
}

export async function getCommentaryLog(limit = 30): Promise<CommentaryEntry[]> {
  const logs = await loadData<CommentaryEntry[]>(LOG_FILE, []);
  return logs.slice(-limit);
}
