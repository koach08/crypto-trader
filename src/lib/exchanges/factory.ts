import type { IExchange } from "./types";
import type { ExchangeConfig } from "../types";
import { BitFlyerExchange } from "./bitflyer";
import { CcxtGenericExchange } from "./ccxt-exchange";

// Exchanges that need special handling
const SPECIAL_EXCHANGES = new Set(["bitflyer"]);

export function createExchange(config: ExchangeConfig): IExchange {
  if (config.id === "bitflyer") {
    return new BitFlyerExchange(config);
  }
  // All other ccxt-supported exchanges use the generic class
  return new CcxtGenericExchange(config);
}

// === Multi-exchange registry ===
const _exchanges: Map<string, IExchange> = new Map();

function loadExchangeConfig(id: string): ExchangeConfig | null {
  const prefix = id.toUpperCase().replace(/-/g, "_");
  const apiKey = process.env[`${prefix}_API_KEY`] || "";
  const secret = process.env[`${prefix}_SECRET`] || "";
  if (!apiKey) return null;

  return {
    id,
    apiKey,
    secret,
    sandbox: process.env[`${prefix}_SANDBOX`] === "true",
    pairs: (process.env[`${prefix}_PAIRS`] || process.env.TRADING_PAIRS || "BTC/JPY").split(","),
    tradeAmountJPY: Number(process.env[`${prefix}_TRADE_AMOUNT`] || process.env.TRADE_AMOUNT_JPY || "10000"),
    maxPositionJPY: Number(process.env[`${prefix}_MAX_POSITION`] || process.env.MAX_POSITION_JPY || "50000"),
  };
}

/** Get a specific exchange by id */
export function getExchange(id = "bitflyer"): IExchange {
  if (!_exchanges.has(id)) {
    const config = loadExchangeConfig(id);
    if (!config) throw new Error(`Exchange ${id} not configured. Set ${id.toUpperCase()}_API_KEY in .env.local`);
    _exchanges.set(id, createExchange(config));
  }
  return _exchanges.get(id)!;
}

/** Get all configured exchanges */
export function getAllExchanges(): { id: string; exchange: IExchange }[] {
  const ids = ["bitflyer", "binancejp", "bitbank", "bybit", "coincheck"];
  const result: { id: string; exchange: IExchange }[] = [];

  for (const id of ids) {
    try {
      const ex = getExchange(id);
      result.push({ id, exchange: ex });
    } catch {
      // Not configured, skip
    }
  }
  return result;
}

/** Get configs of all available exchanges (for UI) */
export function getExchangeConfigs(): { id: string; configured: boolean }[] {
  const ids = ["bitflyer", "binancejp", "bitbank", "bybit", "coincheck"];
  return ids.map(id => ({
    id,
    configured: !!loadExchangeConfig(id),
  }));
}
