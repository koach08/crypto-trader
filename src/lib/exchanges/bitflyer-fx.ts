/**
 * BitFlyer Lightning FX 専用アダプタ (BTC/JPY 永続先物、最大 2x レバレッジ)
 *
 * 現物 (BitFlyerExchange) と独立して動かす。
 * 同じ API キー使用。ただし Lightning FX 口座開設が必要 (BitFlyer 側で承認後利用可)。
 *
 * MVP: LONG のみ実装 (買って後で売って利確/損切)。
 * SHORT は別途追加可能だが初期は対応しない (リスク管理シンプル化)。
 */

import ccxt, { type Exchange as CcxtExchange } from "ccxt";
import type { ExchangeConfig } from "../types";

// BitFlyer Lightning FX のシンボル
const FX_SYMBOL = "FX_BTC_JPY";
const MIN_FX_BTC = 0.01; // BitFlyer FX 最小発注 0.01 BTC

export interface FXOpenOrderResult {
  id: string;
  symbol: string;
  amount: number;       // BTC
  entryPrice: number;   // JPY/BTC
  marginJPY: number;    // 拘束された証拠金
  leverage: number;
  fee: number;
  timestamp: number;
}

export interface FXPosition {
  symbol: string;
  side: "long" | "short" | null;
  amount: number;       // BTC
  entryPrice: number;   // JPY/BTC (avg)
  markPrice: number;    // 現在の評価価格
  unrealizedPnL: number; // JPY
  marginJPY: number;
  leverage: number;
}

export class BitFlyerFXExchange {
  id = "bitflyer-fx";
  private exchange: CcxtExchange;

  constructor(config: ExchangeConfig) {
    this.exchange = new ccxt.bitflyer({
      apiKey: config.apiKey,
      secret: config.secret,
      // FX は spot とは別市場として扱う必要あり
      options: { defaultType: "spot" }, // bitflyer ccxt 実装: FX もこれで OK、symbol で分岐
    });
  }

  async connect(): Promise<void> {
    await this.exchange.loadMarkets();
  }

  async getCollateralJPY(): Promise<{ total: number; free: number }> {
    // BitFlyer FX 証拠金取得 (/v1/me/getcollateral 相当)
    // ccxt の bitflyer は実装してるはず: privateGetGetcollateral
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (this.exchange as any).privateGetGetcollateral();
      return {
        total: Number(resp.collateral ?? 0),
        free: Number(resp.collateral ?? 0) - Number(resp.require_collateral ?? 0),
      };
    } catch (e) {
      console.warn("[bitflyer-fx] getCollateral 失敗:", e instanceof Error ? e.message : e);
      return { total: 0, free: 0 };
    }
  }

  async getTicker(): Promise<{ price: number; bid: number; ask: number }> {
    const ticker = await this.exchange.fetchTicker(FX_SYMBOL);
    return {
      price: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
    };
  }

  /** LONG ポジションを開く: 指定 JPY 証拠金 × leverage 倍の BTC を買う */
  async openLong(marginJPY: number, leverage = 2): Promise<FXOpenOrderResult> {
    const ticker = await this.getTicker();
    if (!ticker.price || ticker.price <= 0) throw new Error("FX ticker 取得失敗");

    const positionJPY = marginJPY * leverage;
    const rawAmount = positionJPY / ticker.price;
    const amount = Math.floor(rawAmount * 1e8) / 1e8;

    if (amount < MIN_FX_BTC) {
      throw new Error(`FX 注文額が最小 ${MIN_FX_BTC} BTC 未満 (要求 ${amount} BTC, ¥${marginJPY} margin × ${leverage}x ÷ ¥${ticker.price})`);
    }

    console.log(`[bitflyer-fx] openLong ${amount} BTC @ ¥${ticker.price} (margin ¥${marginJPY}, leverage ${leverage}x)`);
    const order = await this.exchange.createMarketBuyOrder(FX_SYMBOL, amount);

    return {
      id: order.id,
      symbol: FX_SYMBOL,
      amount: order.amount ?? amount,
      entryPrice: order.average ?? ticker.price,
      marginJPY,
      leverage,
      fee: order.fee?.cost ?? 0,
      timestamp: order.timestamp ?? Date.now(),
    };
  }

  /** LONG を成行で閉じる (持ってる量を全部売却) */
  async closeLong(amount: number): Promise<{ id: string; fillPrice: number; fee: number }> {
    if (amount <= 0) throw new Error("close amount must be positive");
    console.log(`[bitflyer-fx] closeLong ${amount} BTC`);
    const order = await this.exchange.createMarketSellOrder(FX_SYMBOL, amount);
    const ticker = await this.getTicker();
    return {
      id: order.id,
      fillPrice: order.average ?? ticker.price,
      fee: order.fee?.cost ?? 0,
    };
  }

  /** 現在の FX ポジション取得 */
  async getPosition(): Promise<FXPosition | null> {
    try {
      // BitFlyer 個別 endpoint: /v1/me/getpositions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const positions: any[] = await (this.exchange as any).privateGetGetpositions({ product_code: FX_SYMBOL });
      if (!positions || positions.length === 0) return null;

      // 複数 lot を集約
      let totalSize = 0;
      let weightedEntry = 0;
      let totalCommission = 0;
      let side: "long" | "short" | null = null;
      for (const p of positions) {
        const size = Number(p.size ?? 0);
        const entry = Number(p.price ?? 0);
        side = p.side === "BUY" ? "long" : "short";
        totalSize += size;
        weightedEntry += size * entry;
        totalCommission += Number(p.commission ?? 0);
      }
      if (totalSize <= 0) return null;
      const avgEntry = weightedEntry / totalSize;

      const ticker = await this.getTicker();
      const markPrice = ticker.price;
      const direction = side === "long" ? 1 : -1;
      const unrealizedPnL = (markPrice - avgEntry) * totalSize * direction - totalCommission;

      const collateral = await this.getCollateralJPY();
      const positionValueJPY = markPrice * totalSize;
      const inferredLeverage = collateral.total > 0 ? positionValueJPY / collateral.total : 0;

      return {
        symbol: FX_SYMBOL,
        side,
        amount: totalSize,
        entryPrice: avgEntry,
        markPrice,
        unrealizedPnL,
        marginJPY: collateral.total,
        leverage: inferredLeverage,
      };
    } catch (e) {
      console.warn("[bitflyer-fx] getPosition 失敗:", e instanceof Error ? e.message : e);
      return null;
    }
  }
}
