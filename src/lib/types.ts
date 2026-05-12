// === Signal & Engine Types ===
export type CryptoAction = "BUY" | "SELL" | "HOLD";
export type SignalType = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
export type EngineId = "claude" | "gpt4o" | "gemini" | "grok" | "perplexity";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type CircuitBreakerState = "ACTIVE" | "WARNING" | "TRIGGERED" | "MANUAL_STOP";

// === Exchange Types ===
export interface ExchangeConfig {
  id: string;
  apiKey: string;
  secret: string;
  sandbox: boolean;
  pairs: string[];
  tradeAmountJPY: number;
  maxPositionJPY: number;
}

export interface TickerData {
  pair: string;
  price: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  changePercent24h: number;
  timestamp: number;
  /** maker 指値配置に必要 */
  bid?: number;
  ask?: number;
}

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Balance {
  currency: string;
  free: number;
  used: number;
  total: number;
}

export interface OrderResult {
  id: string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price: number;
  status: "open" | "closed" | "canceled";
  timestamp: number;
  fee?: number;
}

// === Trading Types ===
export interface TradeRecord {
  id: string;
  timestamp: string;
  exchange: string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_loss" | "take_profit";
  amount: number;
  price: number;
  valueJPY: number;
  orderId: string;
  fee: number;
  pnl?: number;
  pnlPercent?: number;
  paperTrade: boolean;
  aiDecision?: AIDecision;
}

export interface Position {
  pair: string;
  exchange: string;
  amount: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  valueJPY: number;
  stopLoss?: number;
  takeProfit?: number;
  entryTimestamp: string;
}

export interface AIDecision {
  timestamp: string;
  pair: string;
  exchange: string;
  action: CryptoAction;
  confidence: number;
  reason: string;
  riskLevel: RiskLevel;
  suggestedStopLossPercent: number;
  suggestedTakeProfitPercent: number;
  technicalScore: number;
  fearGreedIndex: number;
  engineResults?: EngineResult[];
}

export interface EngineResult {
  engine: EngineId;
  status: "success" | "error" | "loading";
  action?: CryptoAction;
  confidence?: number;
  summary?: string;
  risks?: string[];
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  error?: string;
  duration?: number;
}

export interface DailyPnL {
  date: string;
  startCapitalJPY: number;
  currentCapitalJPY: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  totalPnLPercent: number;
  trades: number;
  wins: number;
  losses: number;
  circuitBreakerTriggered: boolean;
}

// === Bot Config ===
export interface BotConfig {
  enabled: boolean;
  paperMode: boolean;
  intervalSeconds: number;
  exchanges: ExchangeConfig[];
  pairs: string[];
  maxDailyLossPercent: number;
  defaultStopLossPercent: number;
  defaultTakeProfitPercent: number;
  minConfidenceToTrade: number;
  minEngineConsensus: number;
}

export interface BotStatus {
  running: boolean;
  paperMode: boolean;
  lastCycleTimestamp: string | null;
  nextCycleTimestamp: string | null;
  circuitBreakerState: CircuitBreakerState;
  activePairs: string[];
  cycleCount: number;
}

// === Wallet Types ===
export interface WalletAllocation {
  pair: string;
  targetPercent: number;
  maxPositionJPY: number;
}

export interface WalletConfig {
  totalCapitalJPY: number;
  allocationTargets: WalletAllocation[];
  reservePercent: number;
}

// === Technical Signal ===
export interface TechnicalSignal {
  rsi: number | null;
  macdHistogram: number | null;
  bbPosition: string | null;
  atr: number | null;
  sma20: number | null;
  sma50: number | null;
  volumeRatio: number | null;
  close: number;
  changePercent1h: number;
  changePercent24h: number;
  signal: SignalType;
  score: number;
}

// === Engine Config ===
export const ENGINE_CONFIG: Record<EngineId, {
  name: string;
  icon: string;
  vendor: string;
  color: string;
  weight: number;
}> = {
  claude: { name: "Claude", icon: "🟣", vendor: "Anthropic", color: "#8B5CF6", weight: 1.0 },
  gpt4o: { name: "GPT-4o", icon: "🟢", vendor: "OpenAI", color: "#10B981", weight: 1.0 },
  gemini: { name: "Gemini", icon: "🔵", vendor: "Google", color: "#3B82F6", weight: 0.9 },
  grok: { name: "Grok", icon: "⚫", vendor: "xAI", color: "#6B7280", weight: 0.8 },
  perplexity: { name: "Perplexity", icon: "🔍", vendor: "Perplexity AI", color: "#06B6D4", weight: 0.9 },
};

// === bitFlyer Pairs ===
export const BITFLYER_PAIRS = [
  "BTC/JPY",
  "ETH/JPY",
  "XRP/JPY",
  "XLM/JPY",
  "MONA/JPY",
] as const;

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  paperMode: true,
  intervalSeconds: 900,
  exchanges: [],
  pairs: ["BTC/JPY", "ETH/JPY", "XRP/JPY"],
  maxDailyLossPercent: 2.0,
  defaultStopLossPercent: 2.0,
  defaultTakeProfitPercent: 3.0,
  minConfidenceToTrade: 60,
  minEngineConsensus: 3,
};
