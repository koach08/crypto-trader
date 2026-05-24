/**
 * Kill switch (NAV ベース全停止): 累計で資産が一定 % 落ちたら bot を完全停止.
 *
 * 既存の RiskManager は「1 日の損失上限」を見るだけで、長期で
 * じわじわ削られる場合や、保有暗号通貨の評価額急落には反応しない.
 * この kill-switch は「過去最高 NAV から X% 下落」で発火する.
 *
 * 状態は永続化 (再起動しても解除されない、手動で reset 必要).
 *
 * 環境変数:
 *   KILL_SWITCH_THRESHOLD_PCT  デフォルト 15 (= NAV が peak から -15% で発火)
 *   KILL_SWITCH_DISABLED       "1" で無効化 (テスト用)
 */

import { loadData, saveData } from "../data";
import { sendAlert } from "../alerts";

const STATE_FILE = "kill-switch-state";

export interface KillSwitchState {
  peakNAV: number;
  /** 発火済みフラグ. true = 全停止状態 */
  triggered: boolean;
  /** 発火時の NAV / 理由 */
  triggeredAt?: string;
  triggeredNAV?: number;
  triggeredDrawdownPct?: number;
  /** 最終評価時刻 */
  lastEvaluatedAt: string;
  lastNAV: number;
}

const DEFAULT_STATE: KillSwitchState = {
  peakNAV: 0,
  triggered: false,
  lastEvaluatedAt: new Date(0).toISOString(),
  lastNAV: 0,
};

function getThresholdPct(): number {
  const v = Number(process.env.KILL_SWITCH_THRESHOLD_PCT);
  return Number.isFinite(v) && v > 0 ? v : 15;
}

export async function getKillSwitchState(): Promise<KillSwitchState> {
  return await loadData<KillSwitchState>(STATE_FILE, DEFAULT_STATE);
}

export async function isKillSwitchActive(): Promise<boolean> {
  if (process.env.KILL_SWITCH_DISABLED === "1") return false;
  const s = await getKillSwitchState();
  return s.triggered;
}

/**
 * 現 NAV を評価し peak 更新 / 発火判定. cycle 内で呼ぶ.
 *
 * @returns triggered = true なら engine は新規エントリ停止 + 全 close すべき
 */
export async function evaluateKillSwitch(currentNAV: number): Promise<{
  state: KillSwitchState;
  justTriggered: boolean;
  drawdownPct: number;
}> {
  if (process.env.KILL_SWITCH_DISABLED === "1") {
    return {
      state: { ...DEFAULT_STATE, lastNAV: currentNAV, lastEvaluatedAt: new Date().toISOString() },
      justTriggered: false,
      drawdownPct: 0,
    };
  }

  const state = await getKillSwitchState();
  let justTriggered = false;

  // peak 更新 (初回 or 史上最高)
  if (currentNAV > state.peakNAV) {
    state.peakNAV = currentNAV;
  }

  // drawdown 計算
  const drawdownPct = state.peakNAV > 0 ? ((state.peakNAV - currentNAV) / state.peakNAV) * 100 : 0;
  const threshold = getThresholdPct();

  // 発火判定 (まだ発火してなくて、drawdown が閾値超え、かつ peak が意味ある額)
  if (!state.triggered && drawdownPct >= threshold && state.peakNAV > 1000) {
    state.triggered = true;
    state.triggeredAt = new Date().toISOString();
    state.triggeredNAV = currentNAV;
    state.triggeredDrawdownPct = drawdownPct;
    justTriggered = true;

    await sendAlert({
      level: "critical",
      message: `🚨 KILL SWITCH 発火: NAV が peak から ${drawdownPct.toFixed(1)}% 下落 (threshold ${threshold}%). 全ポジション closeout + bot 停止します.`,
      dedupeKey: "kill-switch:trigger",
      fields: {
        "Peak NAV": `¥${Math.round(state.peakNAV).toLocaleString()}`,
        "Current NAV": `¥${Math.round(currentNAV).toLocaleString()}`,
        "Drawdown": `${drawdownPct.toFixed(2)}%`,
        "Threshold": `${threshold}%`,
      },
    });
    console.error(`[kill-switch] 🚨 発火: NAV ${currentNAV.toFixed(0)} / peak ${state.peakNAV.toFixed(0)} = -${drawdownPct.toFixed(2)}%`);
  } else if (!state.triggered && drawdownPct >= threshold * 0.7) {
    // 警告レベル (threshold の 70% 到達)
    await sendAlert({
      level: "warn",
      message: `⚠️ NAV drawdown ${drawdownPct.toFixed(1)}% (kill threshold ${threshold}% まで残り ${(threshold - drawdownPct).toFixed(1)}%)`,
      dedupeKey: "kill-switch:warn",
      fields: {
        "Peak NAV": `¥${Math.round(state.peakNAV).toLocaleString()}`,
        "Current NAV": `¥${Math.round(currentNAV).toLocaleString()}`,
      },
    });
  }

  state.lastNAV = currentNAV;
  state.lastEvaluatedAt = new Date().toISOString();
  await saveData(STATE_FILE, state);

  return { state, justTriggered, drawdownPct };
}

/** 手動 reset (UI/API から呼ぶ). triggered を解除し peak を現 NAV にリセット */
export async function resetKillSwitch(currentNAV: number, reason: string): Promise<KillSwitchState> {
  const state: KillSwitchState = {
    ...DEFAULT_STATE,
    peakNAV: currentNAV,
    lastNAV: currentNAV,
    lastEvaluatedAt: new Date().toISOString(),
  };
  await saveData(STATE_FILE, state);
  await sendAlert({
    level: "info",
    message: `kill switch 手動リセット (${reason}). peak NAV を ¥${Math.round(currentNAV).toLocaleString()} に再設定.`,
    dedupeKey: `kill-switch:reset:${Date.now()}`,
  });
  return state;
}
