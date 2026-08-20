import { describe, it, expect } from "vitest";
import {
  loadCoreConfig,
  computeCoreTargetsJPY,
  planCoreBuy,
  planCoreTakeProfit,
  applyCoreSell,
  applyCoreFill,
  sellableAmount,
  coreAmount,
  summarizeCore,
  clampCoreToBalance,
  tacticalBasis,
  mergeCoreConfig,
  EMPTY_CORE_STATE,
  type CoreHoldConfig,
  type CoreHoldingState,
} from "./core-holding";

/**
 * コア保有の規約を固定する。
 * 特に「コア分は絶対に売却対象に入らない」は、外すと長期枠ごと投げ売る事故になるので
 * ここで縛っておく (trend-gate.test.ts / sl-trigger.test.ts と同じ趣旨)。
 */

const cfg: CoreHoldConfig = {
  enabled: true,
  targetPct: 0.7,
  weights: { "BTC/JPY": 0.6, "ETH/JPY": 0.4 },
  tranches: 4,
  intervalHours: 24,
  minTrancheJPY: 3000,
  takeProfitPct: 0.2,
  takeProfitFraction: 0.25,
  reentryDiscountPct: 0.05,
};

const prices = { "BTC/JPY": 10_000_000, "ETH/JPY": 300_000, "XRP/JPY": 160 };
// bitFlyer 実測相当: BTC 0.001 単位 = 約 ¥11,000、ETH 0.01 単位 = 約 ¥3,300
const minOrderJPY = { "BTC/JPY": 11_000, "ETH/JPY": 3_300 };
const NOW = Date.parse("2026-08-19T09:00:00.000Z");

describe("computeCoreTargetsJPY", () => {
  it("NAV × 目標比率を比重どおりに割り振る", () => {
    const t = computeCoreTargetsJPY(100_000, cfg);
    expect(t["BTC/JPY"]).toBeCloseTo(42_000, 0); // 100,000 × 0.7 × 0.6
    expect(t["ETH/JPY"]).toBeCloseTo(28_000, 0); // 100,000 × 0.7 × 0.4
  });

  it("比重は合計 1 でなくても正規化される", () => {
    const t = computeCoreTargetsJPY(100_000, { ...cfg, weights: { "BTC/JPY": 3, "ETH/JPY": 1 } });
    expect(t["BTC/JPY"]).toBeCloseTo(52_500, 0);
    expect(t["ETH/JPY"]).toBeCloseTo(17_500, 0);
  });
});

describe("planCoreBuy", () => {
  it("無効化されていれば何も出さない", () => {
    const { plan, skip } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, enabled: false },
      state: EMPTY_CORE_STATE, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan).toBeNull();
    expect(skip?.reason).toContain("CORE_HOLD_ENABLED");
  });

  it("空の状態では充足率が最も低いペアを 1 件だけ返す", () => {
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg,
      state: EMPTY_CORE_STATE, prices, minOrderJPY, nowMs: NOW,
    });
    // 両方 0% なので比重どおり並べたときの先頭 = どちらでもよいが 1 件だけ
    expect(plan).not.toBeNull();
    expect(["BTC/JPY", "ETH/JPY"]).toContain(plan!.pair);
  });

  it("トランシェ額が取引所の最小注文を下回るときは最小注文まで引き上げる", () => {
    // BTC 目標 = 63,000 × 0.7 × 0.6 = ¥26,460 → 4 分割で ¥6,615 は 0.001 BTC に届かない
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "BTC/JPY": 1 } },
      state: EMPTY_CORE_STATE, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan?.pair).toBe("BTC/JPY");
    expect(plan!.amountJPY).toBeGreaterThanOrEqual(11_000);
  });

  it("現金が最小注文に足りなければ発注しない", () => {
    const { plan, skip } = planCoreBuy({
      navJPY: 63_000, jpyFree: 2_000, cfg,
      state: EMPTY_CORE_STATE, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan).toBeNull();
    expect(skip).not.toBeNull();
  });

  it("目標を超える額は買わない", () => {
    const { plan } = planCoreBuy({
      navJPY: 20_000, jpyFree: 500_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 }, tranches: 1 },
      state: EMPTY_CORE_STATE, prices, minOrderJPY, nowMs: NOW,
    });
    // 目標 = 20,000 × 0.7 = ¥14,000。現金が潤沢でもこれを超えない
    expect(plan!.amountJPY).toBeLessThanOrEqual(14_000);
  });

  it("同じペアは間隔を空けるまで連続で買わない", () => {
    const state: CoreHoldingState = {
      lots: [{ at: "2026-08-19T06:00:00.000Z", pair: "ETH/JPY", amountBase: 0.01, priceJPY: 300_000, costJPY: 3_000 }],
      lastBuyAt: { "ETH/JPY": "2026-08-19T06:00:00.000Z" },
    };
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 } },
      state, prices, minOrderJPY, nowMs: NOW, // 3 時間しか経っていない
    });
    expect(plan).toBeNull();
  });

  it("間隔を過ぎていれば再び積む", () => {
    const state: CoreHoldingState = {
      lots: [{ at: "2026-08-17T06:00:00.000Z", pair: "ETH/JPY", amountBase: 0.01, priceJPY: 300_000, costJPY: 3_000 }],
      lastBuyAt: { "ETH/JPY": "2026-08-17T06:00:00.000Z" },
    };
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 } },
      state, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan?.pair).toBe("ETH/JPY");
  });

  it("1 トランシェを超える残りは端数扱いにしない (比重が逆転するため)", () => {
    // 2026-08-19 の本番で踏んだ形。NAV ¥63,695 / 目標 60% / BTC 0.6:ETH 0.4 →
    // BTC 目標 ¥22,930。BTC を 1 回 (¥11,607) 積んだ直後、残り ¥11,323 が
    // 最小注文 ¥11,639 をわずかに下回る。ここを「刻めない端数」として
    // ETH に回すと、ETH 目標が ¥15,287 → ¥26,605 に膨らみ、
    // 指定した 6:4 が実際には 3:7 になる。コアは売らないので取り返せない。
    const liveCfg: CoreHoldConfig = { ...cfg, targetPct: 0.6 };
    const livePrices = { "BTC/JPY": 10_580_000, "ETH/JPY": 306_764 };
    const liveMin = { "BTC/JPY": 11_639, "ETH/JPY": 3_375 };
    const state: CoreHoldingState = {
      lots: [{ at: "2026-08-19T15:20:00.000Z", pair: "BTC/JPY", amountBase: 0.00109863, priceJPY: 10_565_000, costJPY: 11_607 }],
      lastBuyAt: { "BTC/JPY": "2026-08-19T15:20:00.000Z" },
    };
    const { plan } = planCoreBuy({
      navJPY: 63_695, jpyFree: 36_407, cfg: liveCfg, state,
      prices: livePrices, minOrderJPY: liveMin,
      nowMs: Date.parse("2026-08-19T16:20:00.000Z"),
    });
    // ETH は自分の目標 (63,695 × 0.6 × 0.4 ≒ ¥15,287) の範囲で積む
    expect(plan?.pair).toBe("ETH/JPY");
    expect(plan!.targetJPY).toBeLessThan(16_000);
  });

  it("1 トランシェ未満の端数は従来どおり他ペアに回す", () => {
    // 積み切りかけの状態。BTC 目標 ¥26,460 に対し ¥23,000 まで積むと
    // 残り ¥3,460 は最小注文 ¥11,000 に永久に届かない = 本物の端数。
    const state: CoreHoldingState = {
      lots: [{ at: "2026-08-17T09:00:00.000Z", pair: "BTC/JPY", amountBase: 0.0023, priceJPY: 10_000_000, costJPY: 23_000 }],
      lastBuyAt: { "BTC/JPY": "2026-08-17T09:00:00.000Z" },
    };
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 40_000, cfg, state, prices, minOrderJPY, nowMs: NOW,
    });
    // ETH 単独の目標は ¥17,640。端数 ¥3,460 が乗って ¥21,100 前後になる
    expect(plan?.pair).toBe("ETH/JPY");
    expect(plan!.targetJPY).toBeGreaterThan(17_640);
  });

  it("目標に到達していれば買い増さない", () => {
    // ETH 目標 = 63,000 × 0.7 = ¥44,100。0.15 ETH = ¥45,000 で到達済み
    const state: CoreHoldingState = {
      lots: [{ at: "2026-08-01T00:00:00.000Z", pair: "ETH/JPY", amountBase: 0.15, priceJPY: 300_000, costJPY: 45_000 }],
      lastBuyAt: { "ETH/JPY": "2026-08-01T00:00:00.000Z" },
    };
    const { plan, skip } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 } },
      state, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan).toBeNull();
    expect(skip?.reason).toContain("到達");
  });
});

describe("planCoreTakeProfit / applyCoreSell", () => {
  const tpState: CoreHoldingState = {
    lots: [
      { at: "2026-08-01T00:00:00.000Z", pair: "ETH/JPY", amountBase: 0.02, priceJPY: 250_000, costJPY: 5_000 },
      { at: "2026-08-10T00:00:00.000Z", pair: "ETH/JPY", amountBase: 0.02, priceJPY: 300_000, costJPY: 6_000 },
    ],
    lastBuyAt: { "ETH/JPY": "2026-08-10T00:00:00.000Z" },
  };

  it("含み益が閾値を超えたら一部だけ売る (枠ごと畳まない)", () => {
    // 取得平均 = 11,000 / 0.04 = ¥275,000。+20% = ¥330,000
    const { plan } = planCoreTakeProfit({
      state: tpState, cfg, prices: { "ETH/JPY": 350_000 }, minOrderJPY,
    });
    expect(plan?.pair).toBe("ETH/JPY");
    expect(plan!.amountBase).toBeCloseTo(0.04 * 0.25, 8);
    expect(plan!.gainPercent).toBeGreaterThan(20);
  });

  it("閾値に届かなければ売らない", () => {
    const { plan } = planCoreTakeProfit({
      state: tpState, cfg, prices: { "ETH/JPY": 300_000 }, minOrderJPY,
    });
    expect(plan).toBeNull();
  });

  it("売却額が最小注文に届かないなら見送る", () => {
    const tiny: CoreHoldingState = {
      lots: [{ at: "2026-08-01T00:00:00.000Z", pair: "ETH/JPY", amountBase: 0.001, priceJPY: 250_000, costJPY: 250 }],
      lastBuyAt: {},
    };
    const { plan } = planCoreTakeProfit({
      state: tiny, cfg, prices: { "ETH/JPY": 350_000 }, minOrderJPY,
    });
    expect(plan).toBeNull();
  });

  it("売りの下限は取引所の最小注文だけ (minTrancheJPY を掛けない)", () => {
    // 2026-08-21 未明に踏んだ形。XRP のコアが ¥7,242 まで積まれて +22% に乗ったが、
    // 25% 分は ¥1,810 で minTrancheJPY ¥3,000 に届かず利確が発火しなかった。
    // XRP の取引所最小注文は 0.1 XRP ≒ ¥20 なので、本来は売れる。
    const xrpState: CoreHoldingState = {
      lots: [{ at: "2026-08-20T12:00:00.000Z", pair: "XRP/JPY", amountBase: 36.0, priceJPY: 165, costJPY: 5_940 }],
      lastBuyAt: { "XRP/JPY": "2026-08-20T12:00:00.000Z" },
    };
    const { plan } = planCoreTakeProfit({
      state: xrpState, cfg, prices: { "XRP/JPY": 202 },
      minOrderJPY: { "XRP/JPY": 20 },
    });
    expect(plan?.pair).toBe("XRP/JPY");
    expect(plan!.proceedsJPY).toBeGreaterThan(1_500);
    expect(plan!.proceedsJPY).toBeLessThan(3_000); // ¥3,000 未満でも売れること
  });

  it("利確圏のペアには積み増さない (高値で買い足して条件から遠ざけない)", () => {
    // 取得平均 ¥165 に対し ¥202 = +22%。目標に未達でも買わない。
    const xrpState: CoreHoldingState = {
      lots: [{ at: "2026-08-20T12:00:00.000Z", pair: "XRP/JPY", amountBase: 36.0, priceJPY: 165, costJPY: 5_940 }],
      lastBuyAt: {},
    };
    const { plan } = planCoreBuy({
      navJPY: 68_000, jpyFree: 10_000, cfg: { ...cfg, weights: { "XRP/JPY": 1 } },
      state: xrpState, prices: { "XRP/JPY": 202 }, minOrderJPY: { "XRP/JPY": 20 },
      nowMs: Date.parse("2026-08-21T02:00:00.000Z"),
    });
    expect(plan).toBeNull();
  });

  it("利確圏でなければ従来どおり積む", () => {
    const xrpState: CoreHoldingState = {
      lots: [{ at: "2026-08-20T12:00:00.000Z", pair: "XRP/JPY", amountBase: 36.0, priceJPY: 165, costJPY: 5_940 }],
      lastBuyAt: {},
    };
    // 目標 ¥47,600 の 4 分割 = ¥11,900 が出るので、現金はそれ以上必要
    const { plan } = planCoreBuy({
      navJPY: 68_000, jpyFree: 20_000, cfg: { ...cfg, weights: { "XRP/JPY": 1 } },
      state: xrpState, prices: { "XRP/JPY": 175 }, minOrderJPY: { "XRP/JPY": 20 },
      nowMs: Date.parse("2026-08-21T02:00:00.000Z"),
    });
    expect(plan?.pair).toBe("XRP/JPY");
  });

  it("約定を反映すると古いロットから減り、確定損益が積まれる", () => {
    const { state: after, realizedJPY } = applyCoreSell(tpState, "ETH/JPY", 0.02, 350_000);
    expect(coreAmount(after, "ETH/JPY")).toBeCloseTo(0.02, 8);
    // 古いロット (原価 ¥5,000) が消える → 0.02 × 350,000 - 5,000 = ¥2,000
    expect(realizedJPY).toBeCloseTo(2_000, 6);
    expect(after.realizedJPY).toBeCloseTo(2_000, 6);
    expect(after.lastSellPrice?.["ETH/JPY"]).toBe(350_000);
  });

  it("利確直後は同じ値段で買い戻さない (往復コストだけ払う動きを防ぐ)", () => {
    const { state: after } = applyCoreSell(tpState, "ETH/JPY", 0.02, 350_000);
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 } },
      state: after, prices: { "ETH/JPY": 349_000 }, minOrderJPY,
      nowMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(plan).toBeNull();
  });

  it("売値から割引分まで下がれば買い直す", () => {
    const { state: after } = applyCoreSell(tpState, "ETH/JPY", 0.02, 350_000);
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "ETH/JPY": 1 } },
      state: after, prices: { "ETH/JPY": 330_000 }, minOrderJPY,
      nowMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(plan?.pair).toBe("ETH/JPY");
  });
});

describe("sellableAmount", () => {
  it("コア確保分は売却対象から必ず外れる", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.002, priceJPY: 10_000_000, costJPY: 20_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    // 取引所には 0.003 あるが、コアが 0.002 なので売れるのは 0.001 だけ
    expect(sellableAmount(state, "BTC/JPY", 0.003)).toBeCloseTo(0.001, 8);
  });

  it("コアしか無いなら売却量は 0 (マイナスにしない)", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.002, priceJPY: 10_000_000, costJPY: 20_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    expect(sellableAmount(state, "BTC/JPY", 0.002)).toBe(0);
    expect(sellableAmount(state, "BTC/JPY", 0.001)).toBe(0);
  });

  it("コアを持たないペアは全量売れる", () => {
    expect(sellableAmount(EMPTY_CORE_STATE, "XRP/JPY", 12.5)).toBe(12.5);
  });
});

describe("applyCoreFill", () => {
  it("約定を積み増し、直近買付時刻を更新する", () => {
    let state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.001, priceJPY: 10_000_000, costJPY: 10_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    state = applyCoreFill(state, {
      pair: "BTC/JPY", amountBase: 0.001, priceJPY: 9_000_000, costJPY: 9_000,
      at: "2026-08-20T00:00:00.000Z",
    });
    expect(coreAmount(state, "BTC/JPY")).toBeCloseTo(0.002, 8);
    expect(state.lastBuyAt["BTC/JPY"]).toBe("2026-08-20T00:00:00.000Z");
    expect(state.lots).toHaveLength(2);
  });
});

describe("summarizeCore", () => {
  it("取得原価に対する含み損益を出す", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.001, priceJPY: 8_000_000, costJPY: 8_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    const row = summarizeCore(state, { ...cfg, weights: { "BTC/JPY": 1 } }, 63_000, prices)
      .find((r) => r.pair === "BTC/JPY")!;
    expect(row.valueJPY).toBeCloseTo(10_000, 0);
    expect(row.unrealizedPnLJPY).toBeCloseTo(2_000, 0);
    expect(row.unrealizedPnLPercent).toBeCloseTo(25, 1);
  });
});

describe("loadCoreConfig", () => {
  it("既定は無効 (実弾が動くので明示的な opt-in が要る)", () => {
    expect(loadCoreConfig({}).enabled).toBe(false);
    expect(loadCoreConfig({ CORE_HOLD_ENABLED: "1" }).enabled).toBe(false);
    expect(loadCoreConfig({ CORE_HOLD_ENABLED: "true" }).enabled).toBe(true);
  });

  it("比率は 0-0.95 に丸める (全額投入で手数料も払えない状態を作らない)", () => {
    expect(loadCoreConfig({ CORE_HOLD_PCT: "2" }).targetPct).toBe(0.95);
    expect(loadCoreConfig({ CORE_HOLD_PCT: "-1" }).targetPct).toBe(0);
  });

  it("比重を環境変数から読める", () => {
    const c = loadCoreConfig({ CORE_HOLD_WEIGHTS: "BTC/JPY:1,XRP/JPY:1" });
    expect(Object.keys(c.weights).sort()).toEqual(["BTC/JPY", "XRP/JPY"]);
  });
});

describe("clampCoreToBalance", () => {
  it("実残高を超える台帳は按分で切り詰める (手動売却された場合)", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.004, priceJPY: 10_000_000, costJPY: 40_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    const { state: fixed, adjusted } = clampCoreToBalance(state, "BTC/JPY", 0.001);
    expect(adjusted).toBe(true);
    expect(coreAmount(fixed, "BTC/JPY")).toBeCloseTo(0.001, 9);
    // 原価も按分される
    expect(fixed.lots[0].costJPY).toBeCloseTo(10_000, 0);
  });

  it("実残高が足りていれば何もしない", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "BTC/JPY", amountBase: 0.001, priceJPY: 10_000_000, costJPY: 10_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    const { state: same, adjusted } = clampCoreToBalance(state, "BTC/JPY", 0.005);
    expect(adjusted).toBe(false);
    expect(same).toBe(state);
  });

  it("全部売られていればロットが消える (売れないペアを作らない)", () => {
    const state = applyCoreFill(EMPTY_CORE_STATE, {
      pair: "ETH/JPY", amountBase: 0.05, priceJPY: 300_000, costJPY: 15_000,
      at: "2026-08-19T00:00:00.000Z",
    });
    const { state: fixed } = clampCoreToBalance(state, "ETH/JPY", 0);
    expect(coreAmount(fixed, "ETH/JPY")).toBe(0);
    expect(sellableAmount(fixed, "ETH/JPY", 0.02)).toBeCloseTo(0.02, 9);
  });
});

describe("mergeCoreConfig", () => {
  it("保存された設定が env 既定を上書きする", () => {
    const merged = mergeCoreConfig(cfg, { enabled: false, targetPct: 0.3 });
    expect(merged.enabled).toBe(false);
    expect(merged.targetPct).toBe(0.3);
    expect(merged.tranches).toBe(cfg.tranches); // 指定していない項目は据え置き
  });

  it("比率の上限は保存経由でも 0.95", () => {
    expect(mergeCoreConfig(cfg, { targetPct: 5 }).targetPct).toBe(0.95);
  });

  it("空・不正な比重は無視して既定を残す", () => {
    expect(mergeCoreConfig(cfg, { weights: {} }).weights).toEqual(cfg.weights);
    expect(mergeCoreConfig(cfg, { weights: { "BTC/JPY": -1 } }).weights).toEqual(cfg.weights);
  });

  it("override が無ければそのまま", () => {
    expect(mergeCoreConfig(cfg, null)).toEqual(cfg);
  });
});

describe("端数の再配分", () => {
  // BTC 0.001 刻み (≒¥11,265) では埋まらない端数を ETH に回し、
  // 「70% 指定なのに 64% で止まる」を防ぐ
  const state: CoreHoldingState = {
    lots: [{ at: "2026-08-15T00:00:00.000Z", pair: "BTC/JPY", amountBase: 0.00225, priceJPY: 10_000_000, costJPY: 22_500 }],
    lastBuyAt: { "BTC/JPY": "2026-08-15T00:00:00.000Z" },
  };

  it("刻めない端数を残ったペアに回す", () => {
    // BTC 目標 ¥26,460 に対し ¥22,500 保有 → 残 ¥3,960 は最小注文 ¥11,000 未満で発注不能。
    // その分が ETH 側の目標に乗るので、ETH は本来の ¥17,640 より多く積める。
    const { plan } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg,
      state, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan?.pair).toBe("ETH/JPY");
    expect(plan!.targetJPY).toBeGreaterThan(17_640);
  });

  it("回す先が無ければ端数はそのまま見送る (無理な発注をしない)", () => {
    // BTC 単独・目標 ¥44,100 に対し ¥39,000 保有 → 残 ¥5,100。
    // 許容幅 (¥2,205) は超えるが最小注文 ¥11,000 には届かない = 刻めない端数。
    const nearlyFull: CoreHoldingState = {
      lots: [{ at: "2026-08-15T00:00:00.000Z", pair: "BTC/JPY", amountBase: 0.0039, priceJPY: 10_000_000, costJPY: 39_000 }],
      lastBuyAt: { "BTC/JPY": "2026-08-15T00:00:00.000Z" },
    };
    const { plan, skip } = planCoreBuy({
      navJPY: 63_000, jpyFree: 63_000, cfg: { ...cfg, weights: { "BTC/JPY": 1 } },
      state: nearlyFull, prices, minOrderJPY, nowMs: NOW,
    });
    expect(plan).toBeNull();
    expect(skip).not.toBeNull();
  });
});

describe("tacticalBasis", () => {
  it("コアの数量と原価を差し引いた戦術枠だけを返す", () => {
    // 本番で踏んだ形: XRP 実残高 95.763686 / FIFO 平均 ¥187.95 のうち
    // コアが 31.5 XRP・原価 ¥5,997。残りが戦術枠。
    const r = tacticalBasis({
      exchangeAmount: 95.763686, fifoAvgPrice: 187.95,
      coreAmountBase: 31.5, coreCostJPY: 5_997,
    });
    expect(r!.amount).toBeCloseTo(64.263686, 6);
    // (95.763686 × 187.95 - 5,997) / 64.263686
    expect(r!.avgPrice).toBeCloseTo((95.763686 * 187.95 - 5_997) / 64.263686, 6);
    // コアの取得平均は 5,997 / 31.5 = ¥190.4 で全体平均より高い。
    // その分を抜くので戦術枠の平均は下がる (¥186.76)。
    expect(r!.avgPrice).toBeLessThan(187.95);
  });

  it("コアしか無いなら戦術ポジションは無い", () => {
    const r = tacticalBasis({
      exchangeAmount: 0.0011, fifoAvgPrice: 10_500_000,
      coreAmountBase: 0.0011, coreCostJPY: 11_550,
    });
    expect(r).toBeNull();
  });

  it("差し引きが壊れるなら全体平均に落とす (負の取得単価を作らない)", () => {
    const r = tacticalBasis({
      exchangeAmount: 1, fifoAvgPrice: 100,
      coreAmountBase: 0.5, coreCostJPY: 90, // コアを高値で積んだ形
    });
    expect(r!.amount).toBeCloseTo(0.5, 8);
    expect(r!.avgPrice).toBeGreaterThan(0);
  });
});
