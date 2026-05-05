import type { BotStatus, AIDecision, TradeRecord } from "../types";
import { getExchange } from "../exchanges/factory";
import { generateCryptoSignal } from "../indicators";
import { buildAnalysisPrompt } from "../ai/crypto-prompt";
import { runAllEngines, runSingleEngine, setEnginesPaperMode } from "../ai/engines";
import { buildConsensus } from "../ai/consensus";
import { getFearGreedIndex } from "../ai/fear-greed";
import { RiskManager } from "./risk-manager";
import { PaperTrader } from "./paper-trader";
import { loadData, saveData } from "../data";

const PAPER_VIRTUAL_CAPITAL_JPY = 1_000_000; // ペーパートレード仮想資金 ¥100万
const PAPER_TRADE_AMOUNT_JPY = 50_000;       // 1回の取引額
const PAPER_MAX_POSITION_JPY = 200_000;      // ペアあたり最大ポジション

// ライブモード設定（少額スタート）
const LIVE_MIN_TRADE_JPY = 1_000;            // 最小取引額 ¥1,000
const LIVE_MAX_POSITION_JPY = 30_000;        // ペアあたり最大ポジション ¥30,000
const LIVE_CONFIDENCE_THRESHOLD = 55;        // ライブは確信度55%以上で取引

// ドルコスト平均法（DCA）モード設定
const DCA_ENABLED = true;                    // DCAモード有効
const DCA_AMOUNT_JPY = 500;                  // 1サイクルあたりの積立額
const DCA_INTERVAL_CYCLES = 4;              // 4サイクル（1時間）ごとに積立

// ライブポジション追跡（エントリー価格・SL/TPを保持）
interface LivePositionEntry {
  pair: string;
  entryPrice: number;
  amount: number;
  entryTimestamp: string;
  stopLossPercent: number;
  takeProfitPercent: number;
}

interface EngineState {
  running: boolean;
  paperMode: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  cycleCount: number;
  lastCycleTimestamp: string | null;
  pairs: string[];
  intervalSeconds: number;
  riskManager: RiskManager;
  paperTrader: PaperTrader;
  decisions: AIDecision[];
  recentTrades: TradeRecord[];
  livePositions: Map<string, LivePositionEntry>;
  liveTrades: TradeRecord[];
}

const state: EngineState = {
  running: false,
  paperMode: true,
  intervalId: null,
  cycleCount: 0,
  lastCycleTimestamp: null,
  pairs: ["BTC/JPY", "ETH/JPY", "XRP/JPY"],
  intervalSeconds: 900,
  riskManager: new RiskManager(Number(process.env.MAX_DAILY_LOSS_PERCENT || "5.0")),
  paperTrader: new PaperTrader(),
  decisions: [],
  recentTrades: [],
  livePositions: new Map(),
  liveTrades: [],
};

// Eagerly load saved data so the API can return history before the bot starts
let _initPromise: Promise<void> | null = null;
export async function ensureReady(): Promise<void> {
  return ensureDataLoaded();
}
async function ensureDataLoaded(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      await state.paperTrader.init();
      await state.riskManager.loadSaved();
      state.decisions = await loadData<AIDecision[]>("decisions", []);
      state.liveTrades = await loadData<TradeRecord[]>("live-trades", []);
      const savedPositions = await loadData<LivePositionEntry[]>("live-positions", []);
      for (const p of savedPositions) {
        state.livePositions.set(p.pair, p);
      }
    })();
  }
  return _initPromise;
}
ensureDataLoaded();

async function runCycleForPair(pair: string): Promise<void> {
  const exchange = getExchange();
  await exchange.connect();

  // Check circuit breaker
  if (state.riskManager.isCircuitBroken()) {
    console.log(`[${pair}] サーキットブレーカー発動中 - スキップ`);
    return;
  }

  // Fetch data
  const [ticker, bars, balance, position, fearGreed] = await Promise.all([
    exchange.getTicker(pair),
    exchange.getOHLCV(pair, "1h", 100),
    exchange.getBalance(),
    exchange.getPosition(pair),
    getFearGreedIndex(),
  ]);

  // Technical analysis
  const signal = generateCryptoSignal(bars);

  // Recent decisions for this pair (anti flip-flop)
  const recentForPair = state.decisions
    .filter(d => d.pair === pair)
    .slice(-5)
    .map(d => ({
      action: d.action,
      confidence: d.confidence,
      reason: d.reason,
      timestamp: d.timestamp,
    }));

  // Build prompt
  const prompt = buildAnalysisPrompt({
    pair,
    ticker,
    signal,
    fearGreed,
    position,
    balance,
    recentDecisions: recentForPair,
    paperMode: state.paperMode,
  });

  // Run AI - full consensus for borderline signals, single engine otherwise
  const useFull = signal.score >= -1 && signal.score <= 1; // borderline
  let decision: AIDecision;
  if (useFull) {
    const results = await runAllEngines(prompt, "STANDARD");
    decision = buildConsensus(results, pair, "bitflyer", signal.score, fearGreed.value, state.paperMode);
  } else {
    const result = await runSingleEngine(prompt, "STANDARD");
    decision = buildConsensus([result], pair, "bitflyer", signal.score, fearGreed.value, state.paperMode);
  }

  // Store decision
  state.decisions.push(decision);
  if (state.decisions.length > 500) state.decisions = state.decisions.slice(-500);

  console.log(`[${pair}] ${decision.action} 確信度${decision.confidence}% - ${decision.reason}`);

  // Paper mode execution
  if (state.paperMode) {
    const paperPos = state.paperTrader.getPosition(pair);

    if (decision.action === "BUY" && decision.confidence >= 55) {
      const totalCapital = PAPER_VIRTUAL_CAPITAL_JPY;
      const currentPositionJPY = paperPos ? paperPos.amount * ticker.price : 0;
      const tradeAmount = state.riskManager.calculatePositionSizeJPY(
        decision.confidence,
        totalCapital,
        currentPositionJPY,
        PAPER_MAX_POSITION_JPY,
      );

      if (tradeAmount > 0) {
        const trade = await state.paperTrader.executeBuy(pair, tradeAmount, ticker, decision);
        state.recentTrades.push(trade);
        console.log(`[${pair}] PAPER BUY: ¥${tradeAmount.toLocaleString()}`);
      }
    } else if (decision.action === "SELL" && decision.confidence >= 55 && paperPos) {
      const trade = await state.paperTrader.executeSell(pair, ticker, decision);
      if (trade) {
        state.riskManager.recordTrade(trade.pnl ?? 0);
        state.recentTrades.push(trade);
        console.log(`[${pair}] PAPER SELL: 損益 ¥${(trade.pnl ?? 0).toLocaleString()}`);
      }
    }

    // Update position price and unrealized P&L every cycle
    const currentPos = state.paperTrader.getPosition(pair);
    if (currentPos) {
      await state.paperTrader.updatePositionPrice(pair, ticker.price);
    }

    // Update risk manager with total unrealized P&L
    state.riskManager.updateUnrealizedPnL(state.paperTrader.getTotalUnrealizedPnL());

    // Check stop-loss / take-profit
    if (currentPos) {
      const sltp = state.paperTrader.checkStopLossTakeProfit(pair, ticker.price);
      if (sltp) {
        const trade = await state.paperTrader.executeSell(pair, ticker, decision, sltp);
        if (trade) {
          state.riskManager.recordTrade(trade.pnl ?? 0);
          state.recentTrades.push(trade);
          console.log(`[${pair}] ${sltp.toUpperCase()}: 損益 ¥${(trade.pnl ?? 0).toLocaleString()}`);
        }
      }
    }
  } else {
    // === ライブモード実行 ===
    const liveExchange = getExchange();
    const realPosition = await liveExchange.getPosition(pair);
    const livePos = state.livePositions.get(pair);
    const currentPositionJPY = realPosition.amount * ticker.price;

    // BUY判断
    if (decision.action === "BUY" && decision.confidence >= LIVE_CONFIDENCE_THRESHOLD) {
      const balance = await liveExchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      const tradeAmount = state.riskManager.calculatePositionSizeJPY(
        decision.confidence,
        jpyFree + currentPositionJPY,
        currentPositionJPY,
        LIVE_MAX_POSITION_JPY,
      );

      if (tradeAmount >= LIVE_MIN_TRADE_JPY && jpyFree >= tradeAmount) {
        try {
          const order = await liveExchange.marketBuy(pair, tradeAmount);
          const trade: TradeRecord = {
            id: `live-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "buy",
            type: "market",
            amount: order.amount,
            price: order.price,
            valueJPY: tradeAmount,
            orderId: order.id,
            fee: order.fee ?? 0,
            paperTrade: false,
            aiDecision: decision,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);

          // ポジション追跡（平均取得単価を計算）
          const existing = state.livePositions.get(pair);
          if (existing) {
            const totalAmount = existing.amount + order.amount;
            const avgPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / totalAmount;
            existing.entryPrice = avgPrice;
            existing.amount = totalAmount;
            existing.stopLossPercent = decision.suggestedStopLossPercent;
            existing.takeProfitPercent = decision.suggestedTakeProfitPercent;
          } else {
            state.livePositions.set(pair, {
              pair,
              entryPrice: order.price,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: decision.suggestedStopLossPercent,
              takeProfitPercent: decision.suggestedTakeProfitPercent,
            });
          }

          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[${pair}] LIVE BUY: ¥${tradeAmount.toLocaleString()} @ ¥${order.price.toLocaleString()}`);
        } catch (e) {
          console.error(`[${pair}] LIVE BUY 失敗:`, e);
        }
      }
    }
    // SELL判断
    else if (decision.action === "SELL" && decision.confidence >= LIVE_CONFIDENCE_THRESHOLD && realPosition.free > 0) {
      try {
        const order = await liveExchange.marketSell(pair, realPosition.free);
        const entryPrice = livePos?.entryPrice ?? 0;
        const pnl = entryPrice > 0 ? (order.price - entryPrice) * order.amount : 0;
        const pnlPercent = entryPrice > 0 ? ((order.price - entryPrice) / entryPrice) * 100 : 0;

        const trade: TradeRecord = {
          id: `live-${Date.now()}`,
          timestamp: new Date().toISOString(),
          exchange: "bitflyer",
          pair,
          side: "sell",
          type: "market",
          amount: order.amount,
          price: order.price,
          valueJPY: order.amount * order.price,
          orderId: order.id,
          fee: order.fee ?? 0,
          pnl,
          pnlPercent,
          paperTrade: false,
          aiDecision: decision,
        };
        state.recentTrades.push(trade);
        state.liveTrades.push(trade);
        state.riskManager.recordTrade(pnl);
        state.livePositions.delete(pair);

        await saveData("live-trades", state.liveTrades.slice(-200));
        await saveData("live-positions", Array.from(state.livePositions.values()));
        console.log(`[${pair}] LIVE SELL: 損益 ¥${pnl.toLocaleString()} (${pnlPercent.toFixed(1)}%)`);
      } catch (e) {
        console.error(`[${pair}] LIVE SELL 失敗:`, e);
      }
    }

    // ライブ SL/TP チェック
    if (livePos && realPosition.free > 0) {
      const changePercent = ((ticker.price - livePos.entryPrice) / livePos.entryPrice) * 100;
      let triggerType: "stop_loss" | "take_profit" | null = null;

      if (changePercent <= -livePos.stopLossPercent) {
        triggerType = "stop_loss";
      } else if (changePercent >= livePos.takeProfitPercent) {
        triggerType = "take_profit";
      }

      if (triggerType) {
        try {
          const order = await liveExchange.marketSell(pair, realPosition.free);
          const pnl = (order.price - livePos.entryPrice) * order.amount;
          const pnlPercent = ((order.price - livePos.entryPrice) / livePos.entryPrice) * 100;

          const trade: TradeRecord = {
            id: `live-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "sell",
            type: triggerType,
            amount: order.amount,
            price: order.price,
            valueJPY: order.amount * order.price,
            orderId: order.id,
            fee: order.fee ?? 0,
            pnl,
            pnlPercent,
            paperTrade: false,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);
          state.riskManager.recordTrade(pnl);
          state.livePositions.delete(pair);

          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[${pair}] LIVE ${triggerType.toUpperCase()}: 損益 ¥${pnl.toLocaleString()} (${pnlPercent.toFixed(1)}%)`);
        } catch (e) {
          console.error(`[${pair}] LIVE ${triggerType.toUpperCase()} 失敗:`, e);
        }
      }
    }

    // DCA（ドルコスト平均法）: HOLDでもNサイクルごとに少額積立
    if (DCA_ENABLED && decision.action === "HOLD" && state.cycleCount % DCA_INTERVAL_CYCLES === 0) {
      const balance = await liveExchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      const currentPositionJPY = realPosition.amount * ticker.price;

      if (jpyFree >= DCA_AMOUNT_JPY && currentPositionJPY < LIVE_MAX_POSITION_JPY) {
        try {
          const order = await liveExchange.marketBuy(pair, DCA_AMOUNT_JPY);
          const trade: TradeRecord = {
            id: `dca-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "buy",
            type: "market",
            amount: order.amount,
            price: order.price,
            valueJPY: DCA_AMOUNT_JPY,
            orderId: order.id,
            fee: order.fee ?? 0,
            paperTrade: false,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);

          // ポジション追跡を更新
          const existing = state.livePositions.get(pair);
          if (existing) {
            const totalAmount = existing.amount + order.amount;
            const avgPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / totalAmount;
            existing.entryPrice = avgPrice;
            existing.amount = totalAmount;
          } else {
            state.livePositions.set(pair, {
              pair,
              entryPrice: order.price,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: decision.suggestedStopLossPercent,
              takeProfitPercent: decision.suggestedTakeProfitPercent,
            });
          }

          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[${pair}] DCA BUY: ¥${DCA_AMOUNT_JPY} @ ¥${order.price.toLocaleString()}`);
        } catch (e) {
          console.error(`[${pair}] DCA BUY 失敗:`, e);
        }
      }
    }

    // ライブ含み損益をリスクマネージャーに反映
    let totalUnrealized = 0;
    for (const [posP, pos] of state.livePositions) {
      const curPrice = posP === pair ? ticker.price : (await liveExchange.getTicker(posP)).price;
      totalUnrealized += (curPrice - pos.entryPrice) * pos.amount;
    }
    state.riskManager.updateUnrealizedPnL(totalUnrealized);
  }

  await state.riskManager.save();
  await saveData("decisions", state.decisions.slice(-100));
}

async function runCycle(): Promise<void> {
  state.cycleCount++;
  state.lastCycleTimestamp = new Date().toISOString();
  console.log(`\n=== サイクル #${state.cycleCount} (${state.lastCycleTimestamp}) ===`);

  for (const pair of state.pairs) {
    try {
      await runCycleForPair(pair);
    } catch (e) {
      console.error(`[${pair}] サイクルエラー:`, e);
    }
  }
}

// === Public API ===

export async function startBot(options?: {
  pairs?: string[];
  intervalSeconds?: number;
  paperMode?: boolean;
}): Promise<void> {
  if (state.running) return;

  if (options?.pairs) state.pairs = options.pairs;
  if (options?.intervalSeconds) state.intervalSeconds = options.intervalSeconds;
  if (options?.paperMode !== undefined) state.paperMode = options.paperMode;

  state.running = true;
  setEnginesPaperMode(state.paperMode);
  await ensureDataLoaded();

  // Initialize risk manager with capital
  if (state.paperMode) {
    // ペーパーモード: 仮想資金で検証
    await state.riskManager.init(PAPER_VIRTUAL_CAPITAL_JPY);
    console.log(`Bot起動 | ペーパー: true | 仮想資金: ¥${PAPER_VIRTUAL_CAPITAL_JPY.toLocaleString()} | ペア: ${state.pairs.join(", ")} | 間隔: ${state.intervalSeconds}秒`);
  } else {
    const exchange = getExchange();
    await exchange.connect();
    const balance = await exchange.getBalance();
    const jpyTotal = balance.find(b => b.currency === "JPY")?.total ?? 0;
    await state.riskManager.init(jpyTotal);
    console.log(`Bot起動 | ライブ | 資金: ¥${jpyTotal.toLocaleString()} | ペア: ${state.pairs.join(", ")} | 間隔: ${state.intervalSeconds}秒`);
  }

  // Run immediately
  await runCycle();

  // Set interval
  state.intervalId = setInterval(() => {
    runCycle().catch(console.error);
  }, state.intervalSeconds * 1000);
}

export function stopBot(): void {
  if (!state.running) return;
  state.running = false;
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  console.log("Bot停止");
}

export async function killBot(): Promise<void> {
  stopBot();
  state.riskManager.triggerManualStop();
  await state.riskManager.save();
  console.log("緊急停止 - サーキットブレーカー発動");
}

export function getBotStatus(): BotStatus {
  return {
    running: state.running,
    paperMode: state.paperMode,
    lastCycleTimestamp: state.lastCycleTimestamp,
    nextCycleTimestamp: state.running && state.lastCycleTimestamp
      ? new Date(new Date(state.lastCycleTimestamp).getTime() + state.intervalSeconds * 1000).toISOString()
      : null,
    circuitBreakerState: state.riskManager.getState(),
    activePairs: state.pairs,
    cycleCount: state.cycleCount,
  };
}

export function getDecisions(): AIDecision[] {
  return state.decisions;
}

export function getTrades(): TradeRecord[] {
  if (state.paperMode) {
    return state.paperTrader.getTrades();
  }
  return state.liveTrades;
}

export function getPositions() {
  if (state.paperMode) {
    return state.paperTrader.getAllPositions();
  }
  return Array.from(state.livePositions.values()).map(p => ({
    pair: p.pair,
    exchange: "bitflyer",
    amount: p.amount,
    avgEntryPrice: p.entryPrice,
    currentPrice: 0, // updated by cycle
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    valueJPY: 0,
    stopLoss: p.entryPrice * (1 - p.stopLossPercent / 100),
    takeProfit: p.entryPrice * (1 + p.takeProfitPercent / 100),
    entryTimestamp: p.entryTimestamp,
  }));
}

export function getDailyPnL() {
  return state.riskManager.getDailyPnL();
}

export function getCumulativePnL() {
  const trades = state.paperMode ? state.paperTrader.getTrades() : state.liveTrades;
  const sells = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const totalRealizedPnL = sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const totalFees = trades.reduce((sum, t) => sum + (t.fee ?? 0), 0);
  const wins = sells.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = sells.filter(t => (t.pnl ?? 0) < 0).length;

  let unrealizedPnL: number;
  let positionValueJPY: number;
  let startCapital: number;

  if (state.paperMode) {
    unrealizedPnL = state.paperTrader.getTotalUnrealizedPnL();
    const positions = state.paperTrader.getAllPositions();
    positionValueJPY = positions.reduce((sum, p) => sum + p.valueJPY, 0);
    startCapital = PAPER_VIRTUAL_CAPITAL_JPY;
  } else {
    unrealizedPnL = state.riskManager.getDailyPnL().unrealizedPnL;
    positionValueJPY = 0; // updated by live cycle
    startCapital = state.riskManager.getDailyPnL().startCapitalJPY;
  }

  return {
    startCapitalJPY: startCapital,
    totalRealizedPnL,
    unrealizedPnL,
    totalPnL: totalRealizedPnL + unrealizedPnL,
    totalPnLPercent: startCapital > 0 ? (totalRealizedPnL + unrealizedPnL) / startCapital * 100 : 0,
    totalFees,
    netPnL: totalRealizedPnL + unrealizedPnL - totalFees,
    totalTrades: trades.length,
    closedTrades: sells.length,
    wins,
    losses,
    winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
    positionValueJPY,
    firstTradeDate: trades.length > 0 ? trades[0].timestamp : null,
    lastTradeDate: trades.length > 0 ? trades[trades.length - 1].timestamp : null,
  };
}

export async function runSingleCycle(): Promise<void> {
  await runCycle();
}
