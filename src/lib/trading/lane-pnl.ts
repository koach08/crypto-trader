/**
 * 枠別の損益。
 *
 * 【なぜ要るか】これまで損益は 1 つの数字にまとまっていた。-¥14,899 と出ていても、
 * それがコア枠 (買って持つ) から出ているのか戦術枠 (短期売買) から出ているのかが
 * 分からない。実際にはコア枠は含み +¥7,000 前後で利確 +¥863、戦術枠が
 * 182 決済・勝率38%で溶かしている、という状態だった。**どちらが壊れているかを
 * 見ないまま直しようがない**ので、枠で割る。
 *
 * 執行コスト (中値からの不利分) も枠ごとに引く。回転数が違う 2 つを
 * グロスで比べると、回転の多いほうが実態より良く見える。
 */
import type { TradeRecord } from "../types";
import type { ExecutionCost } from "./execution-cost";

export type Lane = "core" | "tactical";

/** 発注元の判定。コア枠の約定は id に core- を付けて記録している。 */
export function laneOf(tradeId: string | undefined): Lane {
  return typeof tradeId === "string" && tradeId.startsWith("core") ? "core" : "tactical";
}

export interface LaneStats {
  lane: Lane;
  /** 約定件数 (買い + 売り) */
  fills: number;
  /** 損益が確定した決済の件数 */
  closes: number;
  wins: number;
  losses: number;
  winRate: number;
  /** 売買代金 */
  turnoverJPY: number;
  /** 確定損益 (グロス) */
  realizedJPY: number;
  /** 中値に対して払った不利分 */
  executionCostJPY: number;
  /** コスト差引後 */
  netRealizedJPY: number;
}

function empty(lane: Lane): LaneStats {
  return {
    lane, fills: 0, closes: 0, wins: 0, losses: 0, winRate: 0,
    turnoverJPY: 0, realizedJPY: 0, executionCostJPY: 0, netRealizedJPY: 0,
  };
}

export function attributePnL(input: {
  trades: TradeRecord[];
  costs: ExecutionCost[];
  /** コア枠の確定損益 (コア台帳が持っている正の値)。trades 側の pnl より信頼する */
  coreRealizedJPY?: number;
}): { core: LaneStats; tactical: LaneStats } {
  const out = { core: empty("core"), tactical: empty("tactical") };

  for (const t of input.trades) {
    const s = out[laneOf(t.id)];
    s.fills += 1;
    s.turnoverJPY += t.valueJPY ?? (t.amount ?? 0) * (t.price ?? 0);
    if (t.side === "sell" && typeof t.pnl === "number") {
      s.closes += 1;
      s.realizedJPY += t.pnl;
      if (t.pnl > 0) s.wins += 1;
      else if (t.pnl < 0) s.losses += 1;
    }
  }

  for (const c of input.costs) {
    out[c.lane ?? "tactical"].executionCostJPY += c.slippageJPY;
  }

  // コア枠の確定損益は台帳の値を正とする。コアの売りは TradeRecord に pnl を
  // 持たせていない (取得原価はコア台帳側にあるため)。
  if (typeof input.coreRealizedJPY === "number") {
    out.core.realizedJPY = input.coreRealizedJPY;
  }

  for (const s of [out.core, out.tactical]) {
    s.winRate = s.closes > 0 ? (s.wins / s.closes) * 100 : 0;
    s.netRealizedJPY = s.realizedJPY - s.executionCostJPY;
  }
  return out;
}
