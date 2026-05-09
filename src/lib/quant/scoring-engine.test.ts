import { describe, it, expect } from "vitest";
import { calculateFinalDecision } from "./scoring-engine";
import type { QuantAnalysis } from "./signals";

const makeQuant = (compositeScore: number, compositeConfidence = 80): QuantAnalysis => ({
  signals: [],
  compositeScore,
  compositeConfidence,
  recommendation: "HOLD",
  reasons: [],
});

const baseInput = {
  pair: "BTC/JPY",
  price: 1000,
  aiAction: "HOLD" as const,
  aiConfidence: 50,
  aiReason: "test",
  technicalScore: 0,
  regime: "RANGING" as const,
  fearGreedIndex: 50,
};

describe("calculateFinalDecision", () => {
  it("STRONG_OVERRIDE: |quant| ≥ 25 で他無視で発火 (BUY)", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(40),
      aiAction: "SELL",
      aiConfidence: 80,
      technicalScore: -5,
      regime: "TRENDING_DOWN",
    });
    expect(r.action).toBe("BUY");
  });

  it("STRONG_OVERRIDE 反対方向 (SELL)", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(-30),
      aiAction: "BUY",
      aiConfidence: 70,
      technicalScore: 3,
      regime: "TRENDING_UP",
    });
    expect(r.action).toBe("SELL");
  });

  it("中quant + ソース過半数同意で BUY", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(20),
      aiAction: "BUY",
      aiConfidence: 70,
      technicalScore: 3,
      regime: "TRENDING_UP",
    });
    expect(r.action).toBe("BUY");
  });

  it("弱 quant + 意見割れで HOLD", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(5),
      aiAction: "BUY",
      aiConfidence: 70,
      technicalScore: -3,
      regime: "TRENDING_DOWN",
    });
    expect(r.action).toBe("HOLD");
  });

  it("audit votes: 4 ソース全部含む", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(20),
      aiAction: "BUY",
      aiConfidence: 70,
      technicalScore: 3,
      regime: "TRENDING_UP",
    });
    expect(r.audit.votes).toHaveLength(4);
    const sources = r.audit.votes.map((v) => v.source).sort();
    expect(sources).toEqual(["ai", "quant", "regime", "technical"]);
  });

  it("ウェイト合計 ≈ 1.0", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(0),
    });
    const sum = r.audit.votes.reduce((s, v) => s + v.weight, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it("Quant 最大ウェイト (≥0.4)", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(0),
    });
    const quantVote = r.audit.votes.find((v) => v.source === "quant");
    expect(quantVote?.weight).toBeGreaterThanOrEqual(0.4);
  });

  it("AI ウェイトは小さく (≤0.15)", () => {
    const r = calculateFinalDecision({
      ...baseInput,
      quantAnalysis: makeQuant(0),
    });
    const aiVote = r.audit.votes.find((v) => v.source === "ai");
    expect(aiVote?.weight).toBeLessThanOrEqual(0.15);
  });
});
