/**
 * FX (BitFlyer Lightning FX, BTC/JPY 2x leverage) トレーディングロジック.
 *
 * 哲学:
 * - 高確信シグナル時のみ発動 (Phase 2 底打ち confidence ≥ 80%)
 * - LONG のみ (SHORT 未実装)
 * - SL タイト (-1%、margin の -2%)、TP +2% (margin の +4%)
 * - 1 ポジションのみ (積み増し禁止)
 * - 環境変数で完全 OFF 可能 (USE_FX_LEVERAGE)
 */

import { BitFlyerFXExchange, type FXOpenOrderResult } from "../exchanges/bitflyer-fx";
import { loadData, saveData } from "../data";

const USE_FX_LEVERAGE = process.env.USE_FX_LEVERAGE === "true";
const FX_MARGIN_JPY = Number(process.env.FX_MARGIN_JPY ?? "5000");
const FX_LEVERAGE = Number(process.env.FX_LEVERAGE ?? "2");
const FX_TP_PERCENT = Number(process.env.FX_TP_PERCENT ?? "2.0");
const FX_SL_PERCENT = Number(process.env.FX_SL_PERCENT ?? "1.0");
const FX_MIN_CONFIDENCE = Number(process.env.FX_MIN_CONFIDENCE ?? "80");

interface FXOpenPosition {
  id: string;
  amount: number;
  entryPrice: number;
  marginJPY: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  openedAt: string;
  source: string;
}

interface FXTradeRecord {
  id: string;
  openedAt: string;
  closedAt?: string;
  amount: number;
  entryPrice: number;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  closeReason?: "TP" | "SL" | "MANUAL";
  source: string;
}

let fxExchange: BitFlyerFXExchange | null = null;
let openPosition: FXOpenPosition | null = null;
let trades: FXTradeRecord[] = [];

function getFXExchange(): BitFlyerFXExchange | null {
  if (!USE_FX_LEVERAGE) return null;
  if (fxExchange) return fxExchange;
  const apiKey = process.env.BITFLYER_API_KEY;
  const secret = process.env.BITFLYER_API_SECRET;
  if (!apiKey || !secret) return null;
  fxExchange = new BitFlyerFXExchange({
    id: "bitflyer-fx",
    apiKey,
    secret,
    sandbox: false,
    pairs: ["FX_BTC_JPY"],
    tradeAmountJPY: FX_MARGIN_JPY,
    maxPositionJPY: FX_MARGIN_JPY * FX_LEVERAGE,
  });
  return fxExchange;
}

let _initialized = false;
async function ensureInit(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  openPosition = await loadData<FXOpenPosition | null>("fx-open-position", null);
  trades = await loadData<FXTradeRecord[]>("fx-trades", []);
}

export interface FXFireInput {
  /** タイミング検出の confidence (0-100) */
  confidence: number;
  /** 検出根拠 (ログ用) */
  source: string;
}

/**
 * FX で LONG エントリーを試みる。
 * 既にポジション保有中、confidence 不足、env 無効 ならスキップ。
 */
export async function tryOpenFXLong(input: FXFireInput): Promise<FXOpenOrderResult | null> {
  if (!USE_FX_LEVERAGE) return null;
  await ensureInit();
  if (input.confidence < FX_MIN_CONFIDENCE) return null;
  if (openPosition) {
    console.log(`[fx] 既にポジション保有中、新規 entry スキップ (現在 ${openPosition.amount} BTC @ ¥${openPosition.entryPrice})`);
    return null;
  }

  const exchange = getFXExchange();
  if (!exchange) return null;

  try {
    await exchange.connect();
    const collateral = await exchange.getCollateralJPY();
    if (collateral.free < FX_MARGIN_JPY) {
      console.log(`[fx] 証拠金不足: free ¥${collateral.free} < required ¥${FX_MARGIN_JPY}`);
      return null;
    }

    const order = await exchange.openLong(FX_MARGIN_JPY, FX_LEVERAGE);
    openPosition = {
      id: order.id,
      amount: order.amount,
      entryPrice: order.entryPrice,
      marginJPY: order.marginJPY,
      leverage: order.leverage,
      tpPercent: FX_TP_PERCENT,
      slPercent: FX_SL_PERCENT,
      openedAt: new Date(order.timestamp).toISOString(),
      source: input.source,
    };
    await saveData("fx-open-position", openPosition);
    console.log(`[fx] 🚀 LONG OPEN: ${order.amount} BTC @ ¥${order.entryPrice} (confidence ${input.confidence}%, ${input.source})`);
    console.log(`[fx]    TP +${FX_TP_PERCENT}% (¥${(order.entryPrice * (1 + FX_TP_PERCENT / 100)).toFixed(0)}), SL -${FX_SL_PERCENT}% (¥${(order.entryPrice * (1 - FX_SL_PERCENT / 100)).toFixed(0)})`);
    return order;
  } catch (e) {
    console.error("[fx] 開く失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 開いてる FX ポジションの TP/SL チェック → 該当すれば close。
 * 毎サイクルから呼ぶ。
 */
export async function checkFXPositionExit(currentBTCPrice: number): Promise<FXTradeRecord | null> {
  if (!USE_FX_LEVERAGE) return null;
  await ensureInit();
  if (!openPosition) return null;

  const changePercent = ((currentBTCPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100;
  let triggerType: "TP" | "SL" | null = null;
  if (changePercent >= openPosition.tpPercent) triggerType = "TP";
  else if (changePercent <= -openPosition.slPercent) triggerType = "SL";

  if (!triggerType) return null;

  const exchange = getFXExchange();
  if (!exchange) return null;

  try {
    await exchange.connect();
    const closeResult = await exchange.closeLong(openPosition.amount);
    const pnl = (closeResult.fillPrice - openPosition.entryPrice) * openPosition.amount * (FX_LEVERAGE / FX_LEVERAGE); // direction long
    const pnlPercent = ((closeResult.fillPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100;

    const trade: FXTradeRecord = {
      id: openPosition.id,
      openedAt: openPosition.openedAt,
      closedAt: new Date().toISOString(),
      amount: openPosition.amount,
      entryPrice: openPosition.entryPrice,
      exitPrice: closeResult.fillPrice,
      pnl,
      pnlPercent,
      closeReason: triggerType,
      source: openPosition.source,
    };
    trades.push(trade);
    await saveData("fx-trades", trades.slice(-200));
    openPosition = null;
    await saveData("fx-open-position", null);

    console.log(`[fx] ${triggerType === "TP" ? "🎯" : "🛑"} ${triggerType}: 損益 ¥${pnl.toFixed(0)} (${pnlPercent.toFixed(2)}%, margin 比 ${(pnlPercent * FX_LEVERAGE).toFixed(2)}%)`);
    return trade;
  } catch (e) {
    console.error("[fx] close 失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** ダッシュボード/監視用 */
export async function getFXState(): Promise<{
  enabled: boolean;
  open: FXOpenPosition | null;
  recentTrades: FXTradeRecord[];
  config: { marginJPY: number; leverage: number; tpPercent: number; slPercent: number; minConfidence: number };
}> {
  await ensureInit();
  return {
    enabled: USE_FX_LEVERAGE,
    open: openPosition,
    recentTrades: trades.slice(-20),
    config: {
      marginJPY: FX_MARGIN_JPY,
      leverage: FX_LEVERAGE,
      tpPercent: FX_TP_PERCENT,
      slPercent: FX_SL_PERCENT,
      minConfidence: FX_MIN_CONFIDENCE,
    },
  };
}
