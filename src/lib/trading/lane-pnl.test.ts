import { describe, it, expect } from "vitest";
import { laneOf, attributePnL } from "./lane-pnl";
import type { TradeRecord } from "../types";
import type { ExecutionCost } from "./execution-cost";

const mkTrade = (id: string, side: "buy" | "sell", valueJPY: number, pnl?: number): TradeRecord => ({
  id, timestamp: "2026-08-22T00:00:00.000Z", exchange: "bitflyer", pair: "XRP/JPY",
  side, type: "market", amount: 1, price: valueJPY, valueJPY, orderId: "x", fee: 0,
  paperTrade: false, ...(pnl !== undefined ? { pnl } : {}),
});
const mkCost = (lane: "core" | "tactical", slip: number): ExecutionCost => ({
  at: "2026-08-22T00:00:00.000Z", pair: "XRP/JPY", side: "buy", amountBase: 1,
  fillPrice: 1, refMid: 1, notionalJPY: 1000, slippageJPY: slip, viaMaker: false, lane,
});

describe("laneOf", () => {
  it("core- で始まる id はコア枠", () => {
    expect(laneOf("core-1787152854247")).toBe("core");
    expect(laneOf("core-tp-1787225784580")).toBe("core");
  });
  it("それ以外は戦術枠", () => {
    expect(laneOf("live-1787149310582")).toBe("tactical");
    expect(laneOf("killswitch-123-XRPJPY")).toBe("tactical");
    expect(laneOf(undefined)).toBe("tactical");
  });
});

describe("attributePnL", () => {
  it("枠ごとに決済・勝率・売買代金を分ける", () => {
    const r = attributePnL({
      trades: [
        mkTrade("live-1", "buy", 15000),
        mkTrade("live-2", "sell", 15500, 500),
        mkTrade("live-3", "sell", 9000, -300),
        mkTrade("core-1", "buy", 13000),
      ],
      costs: [],
    });
    expect(r.tactical.fills).toBe(3);
    expect(r.tactical.closes).toBe(2);
    expect(r.tactical.realizedJPY).toBe(200);
    expect(r.tactical.winRate).toBe(50);
    expect(r.tactical.turnoverJPY).toBe(39500);
    expect(r.core.fills).toBe(1);
    expect(r.core.closes).toBe(0);
  });

  it("執行コストを枠ごとに引く (回転の多い枠が得に見えないように)", () => {
    const r = attributePnL({
      trades: [mkTrade("live-1", "sell", 1000, 400)],
      costs: [mkCost("tactical", 120), mkCost("core", 30)],
    });
    expect(r.tactical.executionCostJPY).toBe(120);
    expect(r.tactical.netRealizedJPY).toBe(280);
    expect(r.core.executionCostJPY).toBe(30);
    expect(r.core.netRealizedJPY).toBe(-30);
  });

  it("コア枠の確定損益は台帳の値を使う", () => {
    const r = attributePnL({
      trades: [mkTrade("core-tp-1", "sell", 3002)],
      costs: [],
      coreRealizedJPY: 863,
    });
    expect(r.core.realizedJPY).toBe(863);
    expect(r.core.netRealizedJPY).toBe(863);
  });
});

describe("attributePnL: 口座全体との整合", () => {
  it("全体が渡されたら戦術枠は引き算で出す (上部の数字と必ず一致する)", () => {
    // 本番で食い違っていた形。上部は取引所ベースで 188決済 -¥5,256、
    // 枠別はアプリ側で 128決済 -¥13,608 になっていた。
    const r = attributePnL({
      trades: [
        mkTrade("core-tp-1", "sell", 3_002),
        mkTrade("live-1", "sell", 12_000, -400),
      ],
      costs: [],
      coreRealizedJPY: 863,
      exchangeTotal: { realizedJPY: -5_256, closedTrades: 188, wins: 92, losses: 96 },
    });
    expect(r.core.realizedJPY).toBe(863);
    expect(r.core.closes).toBe(1);
    // 戦術 = 全体 - コア
    expect(r.tactical.realizedJPY).toBe(-6_119);
    expect(r.tactical.closes).toBe(187);
    // 足すと全体に戻る
    expect(r.core.realizedJPY + r.tactical.realizedJPY).toBe(-5_256);
    expect(r.core.closes + r.tactical.closes).toBe(188);
  });

  it("全体が無ければ従来どおりアプリ側の記録で出す", () => {
    const r = attributePnL({
      trades: [mkTrade("live-1", "sell", 12_000, -400)],
      costs: [],
    });
    expect(r.tactical.realizedJPY).toBe(-400);
    expect(r.tactical.closes).toBe(1);
  });
});
