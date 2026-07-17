import { describe, it, expect } from "vitest";
import {
  computeLearnedWeights,
  computeSignalAccuracies,
  shrunkAccuracy,
} from "./signal-learning";
import type { DecisionAudit } from "./audit-log";

const BASELINE = {
  RSI平均回帰: 1.0,
  ボリンジャー逆張り: 0.8,
  モメンタム: 1.2,
};

/** BUY 監査を1件作る。sig = [name, score] のリスト、win=結果が勝ちか */
function buyAudit(sigs: [string, number][], win: boolean): DecisionAudit {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date(0).toISOString(),
    pair: "BTC/JPY",
    finalAction: "BUY",
    finalConfidence: 70,
    finalReason: "test",
    votes: [],
    marketState: { price: 1, regime: "RANGING", fearGreedIndex: 50, technicalScore: 0 },
    quantSignals: sigs.map(([name, score]) => ({
      name,
      score,
      confidence: 80,
      reason: "",
      factors: {},
    })),
    outcome: { pnl: win ? 10 : -10, wasCorrect: win },
  };
}

describe("shrunkAccuracy (Beta縮小)", () => {
  it("サンプル0なら0.5 (中立)", () => {
    expect(shrunkAccuracy(0, 0)).toBeCloseTo(0.5, 6);
  });
  it("少数サンプルは0.5側へ強く引き戻される", () => {
    // 生1/8=0.125 → 事前α0=β0=6 で (1+6)/(8+12)=0.35
    expect(shrunkAccuracy(1, 8)).toBeCloseTo(0.35, 6);
  });
  it("サンプルが増えるほど生の勝率へ寄る", () => {
    const shrunk = shrunkAccuracy(80, 100); // 生0.8
    expect(shrunk).toBeGreaterThan(0.7);
    expect(shrunk).toBeLessThan(0.8);
  });
});

describe("computeLearnedWeights (縮小推定でのウェイト調整)", () => {
  it("証拠不足(<6件)のシグナルは baseline のまま据え置き", () => {
    const audits = Array.from({ length: 5 }, () => buyAudit([["RSI平均回帰", 60]], false));
    const summary = computeLearnedWeights(audits, BASELINE);
    const rsi = summary.perSignal.find((s) => s.name === "RSI平均回帰")!;
    expect(rsi.total).toBe(5);
    expect(rsi.weightMultiplier).toBe(1.0);
    expect(summary.learned["RSI平均回帰"]).toBe(1.0);
  });

  it("負け続ける逆張りシグナルは下方修正されるが下限0.5で潰しきらない", () => {
    // RSI が毎回 BUY方向(+60)を示して全敗 → agreed & loss = incorrect
    const audits = Array.from({ length: 8 }, () => buyAudit([["RSI平均回帰", 60]], false));
    const summary = computeLearnedWeights(audits, BASELINE);
    const rsi = summary.perSignal.find((s) => s.name === "RSI平均回帰")!;
    expect(rsi.total).toBe(8);
    expect(rsi.correct).toBe(0);
    expect(rsi.weightMultiplier).toBeLessThan(1.0);
    expect(rsi.weightMultiplier).toBeGreaterThanOrEqual(0.5); // 下限クランプ
    expect(summary.ready).toBe(true);
  });

  it("当てているシグナルは上方修正される", () => {
    // モメンタムが毎回 BUY(+50) を示して全勝 → agreed & win = correct
    const audits = Array.from({ length: 12 }, () => buyAudit([["モメンタム", 50]], true));
    const summary = computeLearnedWeights(audits, BASELINE);
    const mo = summary.perSignal.find((s) => s.name === "モメンタム")!;
    expect(mo.weightMultiplier).toBeGreaterThan(1.0);
    expect(mo.weightMultiplier).toBeLessThanOrEqual(1.6); // 上限クランプ
    expect(summary.learned["モメンタム"]).toBeGreaterThan(BASELINE["モメンタム"]);
  });

  it("|score|<5 のノイズシグナルは集計対象外", () => {
    const audits = Array.from({ length: 10 }, () => buyAudit([["RSI平均回帰", 3]], false));
    const stats = computeSignalAccuracies(audits);
    expect(stats["RSI平均回帰"]).toBeUndefined();
  });

  it("完全に五分(勝率0.5)なら実質 baseline (ready=false)", () => {
    const audits = [
      ...Array.from({ length: 5 }, () => buyAudit([["モメンタム", 50]], true)),
      ...Array.from({ length: 5 }, () => buyAudit([["モメンタム", 50]], false)),
    ];
    const summary = computeLearnedWeights(audits, BASELINE);
    const mo = summary.perSignal.find((s) => s.name === "モメンタム")!;
    expect(mo.weightMultiplier).toBeCloseTo(1.0, 1);
  });
});
