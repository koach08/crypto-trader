/**
 * DCA (Dollar Cost Averaging) mode — 長期積立.
 *
 * 思想: 「上下繰り返す仮想通貨は、定期定額買いが retail で最も合理的」
 * (S&P 500 で半世紀証明された手法を crypto に応用).
 *
 * 動作:
 *   - 週 1 回 (デフォ 月曜 9:00 JST) に各 pair で固定額自動買い
 *   - 既存 bot 判断とは独立 (HOLD/SELL 関係なく定額買う)
 *   - F&G ≤ 25 (極度恐怖) なら size 1.5x にブースト (バリュー期は積立額拡大)
 *   - F&G ≥ 75 (極度貪欲) なら size 0.5x に縮小 (高値掴み回避)
 *
 * 環境変数:
 *   DCA_ENABLED                 "1" で有効化
 *   DCA_AMOUNT_JPY_PER_PAIR     1 pair あたりの基本投入額 (デフォ 3000)
 *   DCA_DAY_OF_WEEK             JST 曜日 0(日)-6(土), デフォ 1 (月曜)
 *   DCA_HOUR_JST                JST 時刻 0-23, デフォ 9
 *   DCA_PAIRS                   対象 pair (デフォ "BTC/JPY,ETH/JPY,XRP/JPY,SOL/JPY")
 *
 * 安全:
 *   - kill switch 発火中は skip
 *   - 同週内の重複発火を防ぐ (永続化)
 */

import { loadData, saveData } from "../data";
import { sendAlert } from "../alerts";

const STATE_FILE = "dca-state";

interface DCAState {
  /** 最終発火日 (JST YYYY-MM-DD) */
  lastFiredDate: string;
}

export interface DCAExecution {
  pair: string;
  baseAmountJPY: number;
  adjustedAmountJPY: number;
  multiplier: number;
  fearGreed: number;
  reason: string;
}

function jstNow(): { date: string; dayOfWeek: number; hour: number } {
  const jstMs = Date.now() + 9 * 3600 * 1000;
  const d = new Date(jstMs);
  return {
    date: d.toISOString().slice(0, 10),
    dayOfWeek: d.getUTCDay(),
    hour: d.getUTCHours(),
  };
}

export async function shouldFireDCA(): Promise<boolean> {
  if (process.env.DCA_ENABLED !== "1") return false;
  const targetDay = Number(process.env.DCA_DAY_OF_WEEK ?? "1");
  const targetHour = Number(process.env.DCA_HOUR_JST ?? "9");
  const { date, dayOfWeek, hour } = jstNow();
  if (dayOfWeek !== targetDay || hour !== targetHour) return false;
  const state = await loadData<DCAState>(STATE_FILE, { lastFiredDate: "" });
  return state.lastFiredDate !== date;
}

/**
 * DCA size 算出 (F&G 連動).
 * Extreme Fear (F&G ≤ 25): 1.5x (バリュー圏で積立増)
 * Fear (26-45): 1.2x
 * Neutral (46-54): 1.0x
 * Greed (55-74): 0.8x
 * Extreme Greed (≥ 75): 0.5x (高値掴み回避)
 */
function calcDCASize(baseJPY: number, fearGreed: number): { amount: number; mult: number; reason: string } {
  let mult = 1.0;
  let reason = "neutral";
  if (fearGreed <= 25) { mult = 1.5; reason = `Extreme Fear ${fearGreed} → 1.5x (バリュー積立)`; }
  else if (fearGreed <= 45) { mult = 1.2; reason = `Fear ${fearGreed} → 1.2x`; }
  else if (fearGreed <= 54) { mult = 1.0; reason = `Neutral ${fearGreed} → 1.0x`; }
  else if (fearGreed <= 74) { mult = 0.8; reason = `Greed ${fearGreed} → 0.8x`; }
  else { mult = 0.5; reason = `Extreme Greed ${fearGreed} → 0.5x (高値掴み回避)`; }
  return { amount: Math.round(baseJPY * mult), mult, reason };
}

/**
 * DCA を実行. 各 pair で marketBuy する.
 *
 * @param ctx engine から渡される: marketBuy 関数, fearGreed 値, 安全フラグ
 */
export async function executeDCA(ctx: {
  pairs: string[];
  fearGreed: number;
  marketBuy: (pair: string, jpyAmount: number) => Promise<{ ok: boolean; reason?: string; orderId?: string; fillPrice?: number; amount?: number }>;
  killSwitchActive: boolean;
}): Promise<DCAExecution[]> {
  const today = jstNow().date;
  if (ctx.killSwitchActive) {
    console.log(`[DCA] kill switch active. skip`);
    return [];
  }
  const baseAmount = Number(process.env.DCA_AMOUNT_JPY_PER_PAIR ?? "3000");
  const executions: DCAExecution[] = [];

  for (const pair of ctx.pairs) {
    const { amount, mult, reason } = calcDCASize(baseAmount, ctx.fearGreed);
    const exec: DCAExecution = {
      pair,
      baseAmountJPY: baseAmount,
      adjustedAmountJPY: amount,
      multiplier: mult,
      fearGreed: ctx.fearGreed,
      reason,
    };
    try {
      const result = await ctx.marketBuy(pair, amount);
      if (result.ok) {
        console.log(`[DCA] ${pair} BUY ¥${amount} @ ¥${result.fillPrice?.toFixed(0) ?? "?"} (${reason})`);
        executions.push(exec);
      } else {
        console.warn(`[DCA] ${pair} BUY 失敗: ${result.reason}`);
      }
    } catch (e) {
      console.warn(`[DCA] ${pair} 例外:`, e instanceof Error ? e.message : e);
    }
  }

  // 状態永続化
  await saveData(STATE_FILE, { lastFiredDate: today });

  // Slack 通知 (任意)
  if (executions.length > 0) {
    const total = executions.reduce((s, e) => s + e.adjustedAmountJPY, 0);
    await sendAlert({
      level: "info",
      message: `📅 DCA 実行 ${today}: ${executions.length}件、合計 ¥${total.toLocaleString()} (F&G ${ctx.fearGreed}, mult ${executions[0].multiplier}x)`,
      dedupeKey: `dca:${today}`,
      fields: Object.fromEntries(executions.map(e => [e.pair, `¥${e.adjustedAmountJPY}`])),
    });
  }

  return executions;
}

export async function getDCAState(): Promise<DCAState> {
  return await loadData<DCAState>(STATE_FILE, { lastFiredDate: "" });
}
