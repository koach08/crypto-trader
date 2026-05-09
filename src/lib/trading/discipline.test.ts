import { describe, it, expect } from "vitest";
import { checkEdge, checkSentimentEdge, checkMTFAlignment, computeTrailingStop } from "./discipline";
import type { OHLCVBar } from "../types";

describe("checkEdge (期待値ゲート)", () => {
  it("勝率高 + TP大 → pass", () => {
    const r = checkEdge(80, 5.0, 1.0); // 80%勝率, TP5%, SL1%
    expect(r.passed).toBe(true);
    expect(r.expectedReturnPercent).toBeGreaterThan(0);
  });

  it("勝率低 + TP小 → block", () => {
    const r = checkEdge(40, 0.5, 2.0); // 40%, TP0.5%, SL2%
    expect(r.passed).toBe(false);
    expect(r.expectedReturnPercent).toBeLessThan(0);
  });

  it("ペイアウト=リスク + 勝率50% → 手数料負け", () => {
    const r = checkEdge(50, 1.0, 1.0);
    expect(r.passed).toBe(false); // 手数料0.30%×0.5 余裕に足りない
  });
});

describe("checkSentimentEdge (F&G フィルタ)", () => {
  it("HOLD は常に pass", () => {
    expect(checkSentimentEdge(50, "HOLD").passed).toBe(true);
    expect(checkSentimentEdge(20, "HOLD").passed).toBe(true);
  });

  it("F&G ≤ 35 で BUY 通過", () => {
    expect(checkSentimentEdge(20, "BUY").passed).toBe(true);
    expect(checkSentimentEdge(35, "BUY").passed).toBe(true);
  });

  it("F&G > 35 で BUY ブロック", () => {
    expect(checkSentimentEdge(40, "BUY").passed).toBe(false);
    expect(checkSentimentEdge(50, "BUY").passed).toBe(false);
    expect(checkSentimentEdge(70, "BUY").passed).toBe(false);
  });

  it("F&G ≥ 65 で SELL 通過", () => {
    expect(checkSentimentEdge(70, "SELL").passed).toBe(true);
    expect(checkSentimentEdge(85, "SELL").passed).toBe(true);
  });

  it("F&G < 65 で SELL ブロック", () => {
    expect(checkSentimentEdge(60, "SELL").passed).toBe(false);
    expect(checkSentimentEdge(50, "SELL").passed).toBe(false);
  });
});

describe("checkMTFAlignment", () => {
  const makeBars = (closes: number[]): OHLCVBar[] =>
    closes.map((c, i) => ({
      timestamp: i * 3600_000,
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      volume: 100,
    }));

  it("HOLD は常に pass", () => {
    const r = checkMTFAlignment(makeBars([100, 101, 102]), "HOLD");
    expect(r.aligned).toBe(true);
  });

  it("h4 上昇トレンドで BUY 一致", () => {
    // 100→200で右肩上がり50本
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 1.25);
    const r = checkMTFAlignment(makeBars(closes), "BUY");
    expect(r.aligned).toBe(true);
    expect(r.htfTrend).toBe("UP");
  });

  it("h4 下降トレンドで BUY 不一致", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 200 - i * 1.25);
    const r = checkMTFAlignment(makeBars(closes), "BUY");
    expect(r.aligned).toBe(false);
    expect(r.htfTrend).toBe("DOWN");
  });

  it("データ不足時は pass", () => {
    const r = checkMTFAlignment(makeBars([100, 101]), "BUY");
    expect(r.aligned).toBe(true);
  });
});

describe("computeTrailingStop", () => {
  it("含み益が breakeven 未満 → SL 維持", () => {
    const r = computeTrailingStop({
      entryPrice: 100,
      currentPrice: 100.5, // +0.5%
      atr: 1,
      currentStopLossPercent: 2.0,
    });
    expect(r.newStopLossPercent).toBe(2.0);
    expect(r.movedToBreakeven).toBe(false);
  });

  it("含み益 +1% (breakeven 到達) → SL を 0 に", () => {
    const r = computeTrailingStop({
      entryPrice: 100,
      currentPrice: 101,
      atr: 1,
      currentStopLossPercent: 2.0,
    });
    expect(r.newStopLossPercent).toBeLessThanOrEqual(0);
  });

  it("含み益が ATR×2 超 → トレーリング発動", () => {
    const r = computeTrailingStop({
      entryPrice: 100,
      currentPrice: 105,
      atr: 1, // ATR% = 1%
      currentStopLossPercent: 2.0,
      trailFactor: 1.0,
    });
    expect(r.trailing).toBe(true);
    // SL は -(profit - atrTrail) = -(5 - 1) = -4
    expect(r.newStopLossPercent).toBeLessThan(0);
  });
});
