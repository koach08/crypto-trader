import type { BotStatus, AIDecision, TradeRecord } from "../types";
import { getExchange } from "../exchanges/factory";
import { generateCryptoSignal, detectRegime, type MarketRegime } from "../indicators";
import { buildAnalysisPrompt } from "../ai/crypto-prompt";
import { runAllEngines, runSingleEngine, setEnginesPaperMode } from "../ai/engines";
import { buildConsensus } from "../ai/consensus";
import { getFearGreedIndex } from "../ai/fear-greed";
import { RiskManager } from "./risk-manager";
import { PaperTrader } from "./paper-trader";
import { loadData, saveData } from "../data";
import { runQuantAnalysis, BASELINE_SIGNAL_WEIGHTS, setActiveSignalWeights } from "../quant/signals";
import { calculateFinalDecision } from "../quant/scoring-engine";
import { saveAudit, recordOutcome, getAudits } from "../quant/audit-log";
import { computeLearnedWeights } from "../quant/signal-learning";
import { checkMTFAlignment, checkEdge, calibrateConfidence, computeTrailingStop, checkSentimentEdge } from "./discipline";
import { atr as atrIndicator } from "../indicators";
import { computeLifetimePnL } from "./lifetime";
import { fetchExternalBias } from "../external/investment-app";
import { detectBottomOpportunity, detectTopOpportunity } from "../quant/timing";
import { tryOpenFXLong, checkFXPositionExit } from "./fx-engine";

// 緊急ロスカット閾値（pipelineと無関係に発火）
const EMERGENCY_LOSS_PERCENT = 5.0;

const PAPER_VIRTUAL_CAPITAL_JPY = 1_000_000; // ペーパートレード仮想資金 ¥100万
const PAPER_TRADE_AMOUNT_JPY = 50_000;       // 1回の取引額
const PAPER_MAX_POSITION_JPY = 200_000;      // ペアあたり最大ポジション

// ライブモード設定（少額スタート）
const LIVE_MIN_TRADE_JPY = 1_000;            // 最小取引額 ¥1,000
const LIVE_MAX_POSITION_JPY = 30_000;        // ペアあたり最大ポジション ¥30,000
// 確信度閾値: 取引させたいので 50 に下げる (動かない > 動いて学ぶ)
const LIVE_CONFIDENCE_THRESHOLD = 50;

// DCA は無効化。HOLD時に買い続ける構造が "売れない bot" の主因だった。
// 真にDCAしたいなら別ジョブで個別に積立する設計に分離すべき。
const DCA_ENABLED = false;
const DCA_AMOUNT_JPY = 0;
const DCA_INTERVAL_CYCLES = 999;

// === Profit-First モード ===
// crypto は手数料 0.30% 往復なので TP/SL は株より広めに
const PROFIT_FIRST_TP_PERCENT = 2.0;
const PROFIT_FIRST_SL_PERCENT = 1.0;
const DAILY_TARGET_PERCENT = 0.3; // 元金の 0.3%/日 = ¥230 (¥77K想定)

/**
 * レジーム適応 TP/SL: 相場タイプで利確/損切幅を変える。
 * - TRENDING_UP: 利を伸ばす (TP 広め, SL 標準)
 * - TRENDING_DOWN: 警戒 (TP 浅め, SL 浅め)
 * - VOLATILE: SL 広めにしないとノイズで切られる
 * - RANGING: scalp (TP 浅め, SL 浅め) — 何度も拾う
 */
function regimeAdjustedTpSl(regime: MarketRegime): { tp: number; sl: number } {
  switch (regime) {
    case "TRENDING_UP":   return { tp: 3.0, sl: 1.0 };
    case "TRENDING_DOWN": return { tp: 1.5, sl: 1.0 };
    case "VOLATILE":      return { tp: 2.5, sl: 2.0 };
    case "RANGING":       return { tp: 1.2, sl: 0.6 };
  }
}

/**
 * Volatility-targeted position sizing.
 * 高ボラ (大きな ATR/価格比) なら小さく、低ボラなら標準サイズ。
 * Carver "Systematic Trading" の vol targeting を簡易化。
 * targetVolPercent: 1取引あたり想定 1% リスクを目安
 */
function volScalingFactor(atr: number, price: number, targetVolPercent: number = 1.0): number {
  if (!atr || !price || price <= 0) return 1.0;
  const atrPercent = (atr / price) * 100;
  if (atrPercent <= 0) return 1.0;
  // 比率 = target / atrPercent。例: target 1%, atr 2% → 0.5x。target 1%, atr 0.5% → 2.0x (上限あり)
  const factor = targetVolPercent / atrPercent;
  return Math.max(0.3, Math.min(1.5, factor)); // 0.3x〜1.5x の範囲
}

/**
 * Time-of-day フィルタ: 流動性低い時間帯は新規 BUY 控える。
 * crypto 24h だが、JST 深夜 + 早朝 (3-7時) は BTC/ETH 出来高薄、スプレッド広い。
 * (CoinGecko/Kaiko レポートで観測されてる傾向)
 */
function isLowLiquidityHourJST(): boolean {
  const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).getHours();
  return hour >= 3 && hour < 7;
}

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
  /** SL/負け確定後のクールダウン (pair → unix ms。それまで BUY 禁止) */
  cooldownUntil: Map<string, number>;
}

const state: EngineState = {
  running: false,
  paperMode: true,
  intervalId: null,
  cycleCount: 0,
  lastCycleTimestamp: null,
  pairs: ["BTC/JPY", "ETH/JPY", "XRP/JPY"],
  intervalSeconds: 300,
  riskManager: new RiskManager(Number(process.env.MAX_DAILY_LOSS_PERCENT || "5.0")),
  paperTrader: new PaperTrader(),
  decisions: [],
  recentTrades: [],
  livePositions: new Map(),
  liveTrades: [],
  cooldownUntil: new Map(),
};

// 連敗ガード: SL や負け確定後、同じペアを一定時間 BUY 禁止 (リベンジ買い防止)
// 損失額に比例: 小さい損 = 短い cooldown (scalp 対応)、大きい損 = 長い cooldown
const COOLDOWN_MS_AFTER_LOSS = 30 * 60 * 1000; // 通常 30分

function adaptiveCooldownMs(pnlPercent: number): number {
  const absPnl = Math.abs(pnlPercent);
  if (absPnl < 0.5) return 5 * 60 * 1000;   // <0.5% → 5分 (scalp 対応)
  if (absPnl < 1.5) return 15 * 60 * 1000;  // <1.5% → 15分
  if (absPnl < 3.0) return 30 * 60 * 1000;  // <3% → 30分
  return 60 * 60 * 1000;                     // >=3% → 60分
}

// Maker-only 指値モード: 約定すれば手数料 0%。timeout で成行フォールバック
const USE_MAKER_ONLY = process.env.USE_MAKER_ONLY !== "false";  // default true
const MAKER_TIMEOUT_MS = Number(process.env.MAKER_TIMEOUT_MS ?? "30000");

/**
 * BUY 実行ヘルパー: maker 指値を試し、timeout なら成行にフォールバック。
 * 既存の戦略コードを変えずに「実行レイヤーだけ手数料 0% 化」する。
 */
async function executeBuy(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
  amountJPY: number,
): Promise<{ order: import("../types").OrderResult; viaMaker: boolean }> {
  if (USE_MAKER_ONLY && exchange.limitBuyMakerOnly) {
    const makerOrder = await exchange.limitBuyMakerOnly(pair, amountJPY, MAKER_TIMEOUT_MS);
    if (makerOrder) return { order: makerOrder, viaMaker: true };
    console.log(`[${pair}] maker BUY timeout → 成行フォールバック`);
  }
  const order = await exchange.marketBuy(pair, amountJPY);
  return { order, viaMaker: false };
}

/**
 * SELL 実行ヘルパー: maker 指値を試し、timeout なら成行にフォールバック。
 * TP/SL/緊急ロスカット 全部から呼ぶ。
 */
async function executeSell(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
  amountBase: number,
  forceMarket = false,
): Promise<{ order: import("../types").OrderResult; viaMaker: boolean }> {
  if (!forceMarket && USE_MAKER_ONLY && exchange.limitSellMakerOnly) {
    const makerOrder = await exchange.limitSellMakerOnly(pair, amountBase, MAKER_TIMEOUT_MS);
    if (makerOrder) return { order: makerOrder, viaMaker: true };
    console.log(`[${pair}] maker SELL timeout → 成行フォールバック`);
  }
  const order = await exchange.marketSell(pair, amountBase);
  return { order, viaMaker: false };
}

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
      // 過去のバグで pnl が不正値 (-100% など、order.average=0 由来) のものを補正
      let repaired = 0;
      for (const t of state.liveTrades) {
        if (t.pnlPercent !== undefined && t.pnlPercent <= -90 && t.price === 0) {
          // ccxt が average=0 で返したことによる偽計算。pnl を 0 に置き換える
          t.pnl = 0;
          t.pnlPercent = 0;
          repaired++;
        }
      }
      if (repaired > 0) {
        await saveData("live-trades", state.liveTrades.slice(-200));
        console.log(`[migration] live-trades: ${repaired} 件の不正pnlを補正 (price=0 由来)`);
      }
      const savedPositions = await loadData<LivePositionEntry[]>("live-positions", []);
      for (const p of savedPositions) {
        // 古い保存形式で SL/TP が欠落している場合のデフォルト
        if (typeof p.stopLossPercent !== "number") p.stopLossPercent = 2.0;
        if (typeof p.takeProfitPercent !== "number") p.takeProfitPercent = 3.0;
        state.livePositions.set(p.pair, p);
      }
      // 連敗クールダウンを復元 (期限切れは捨てる)
      const savedCooldowns = await loadData<Array<[string, number]>>("cooldowns", []);
      const now = Date.now();
      for (const [pair, until] of savedCooldowns) {
        if (until > now) state.cooldownUntil.set(pair, until);
      }
    })();
  }
  return _initPromise;
}

async function persistCooldowns(): Promise<void> {
  await saveData("cooldowns", Array.from(state.cooldownUntil.entries()));
}
ensureDataLoaded();

async function runCycleForPair(pair: string): Promise<void> {
  const STEP = (n: string) => console.log(`[${pair}] step:${n}`);
  STEP("0-start");
  let exchange;
  try {
    exchange = getExchange();
    STEP("0a-got-exchange");
    await exchange.connect();
    STEP("0b-connected-success");
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[${pair}] CONNECT 失敗: ${err.name}: ${err.message}`);
    console.error(`CONNECT_STACK: ${err.stack}`);
    throw e;
  }
  STEP("1-connected");

  // Check circuit breaker
  if (state.riskManager.isCircuitBroken()) {
    console.log(`[${pair}] サーキットブレーカー発動中 - スキップ`);
    return;
  }

  // Fetch data
  STEP("2-fetch-start");
  const [ticker, bars, balance, position, fearGreed] = await Promise.all([
    exchange.getTicker(pair),
    exchange.getOHLCV(pair, "1h", 100),
    exchange.getBalance(),
    exchange.getPosition(pair),
    getFearGreedIndex(),
  ]);
  STEP(`3-fetched price=${ticker?.price} bars=${bars?.length} fng=${fearGreed?.value}`);

  // バー数不足は判断不能 → サイクルスキップ (CryptoCompare等の障害対策)
  if (!bars || bars.length < 50) {
    console.log(`[${pair}] bars 不足 (${bars?.length ?? 0}本)、サイクルスキップ`);
    return;
  }

  // === 緊急ロスカット番兵: pipeline 前に独立判定 ===
  // AI 判断・規律フィルタ・確信度閾値とは無関係に、含み損が閾値超えたら強制売却
  if (!state.paperMode) {
    STEP("4a-emergency-check");
    const cut = await emergencyLossCut(pair, ticker.price);
    if (cut) {
      console.log(`[${pair}] 緊急ロスカット後はサイクル終了`);
      return;
    }
  }

  // Technical analysis
  STEP("5-tech-signal");
  const signal = generateCryptoSignal(bars);

  // レジーム検出（相場タイプ判定）
  STEP("6-regime");
  const regime = detectRegime(bars);
  STEP(`7-regime-done ${regime}`);

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

  // === クオンツ分析 + スコアリングエンジン ===
  // 外部マルチソース bias (investment-app: news/macro/fed-tone/F&G)
  // 各 API はキャッシュ付き、サイクル毎の呼出しはほぼ無料
  let externalBias: Awaited<ReturnType<typeof fetchExternalBias>> | null = null;
  try {
    const baseSym = pair.split("/")[0].toLowerCase();
    externalBias = await fetchExternalBias([baseSym, "crypto", "暗号"]);
  } catch (e) {
    console.warn(`[${pair}] external bias 取得失敗:`, e instanceof Error ? e.message : e);
  }

  // LLMの判断を「アドバイザーの1人」として、統計的シグナルと合議で最終判断
  const quantAnalysis = runQuantAnalysis(bars);
  const scoringResult = calculateFinalDecision({
    pair,
    price: ticker.price,
    quantAnalysis,
    aiAction: decision.action,
    aiConfidence: decision.confidence,
    aiReason: decision.reason,
    technicalScore: signal.score,
    regime,
    fearGreedIndex: fearGreed.value,
    externalBias: externalBias ? {
      score: externalBias.score,
      reason: externalBias.components.map(c => c.name).join(","),
    } : null,
  });

  // スコアリングエンジンの結果でdecisionを上書き
  decision.action = scoringResult.action;
  decision.confidence = scoringResult.confidence;
  decision.reason = scoringResult.reason;

  // === タイミング検出 override (底打ち / 天井) ===
  // 通常の scoring engine は trend-follow 寄り。マルチソースで「ここが底」と
  // 判定できれば、regime を無視して BUY override (押し目買い)。同様に天井で
  // SELL override (利確)。3/4 条件揃わないと発火しない (過剰反応防止)。
  const timingInput = {
    bars,
    cryptoFearGreed: fearGreed.value,
    externalBias,
    price: ticker.price,
  };
  const bottomOp = detectBottomOpportunity(timingInput);
  const topOp = detectTopOpportunity(timingInput);

  if (bottomOp.fire && decision.action !== "BUY") {
    console.log(`[${pair}] 🔻 底打ち検出 → BUY override (${bottomOp.confidence}% 確信): ${bottomOp.conditions.join(" / ")}`);
    decision.action = "BUY";
    decision.confidence = bottomOp.confidence;
    decision.reason = `[底打ちoverride ${bottomOp.confidence}%] ${bottomOp.conditions.join(" / ")}`;
  } else if (topOp.fire && decision.action !== "SELL") {
    console.log(`[${pair}] 🔺 天井検出 → SELL override (${topOp.confidence}% 確信): ${topOp.conditions.join(" / ")}`);
    decision.action = "SELL";
    decision.confidence = topOp.confidence;
    decision.reason = `[天井override ${topOp.confidence}%] ${topOp.conditions.join(" / ")}`;
  }

  // === FX レバ (BTC/JPY のみ): 高確信底打ちで LONG エントリー、毎サイクル TP/SL チェック ===
  if (pair === "BTC/JPY") {
    // 既存ポジションの TP/SL チェック
    await checkFXPositionExit(ticker.price).catch(e => console.warn("[fx] check 失敗:", e));
    // 高確信 BOTTOM_BUY 検出時のみエントリー (USE_FX_LEVERAGE が true でないと内部で skip)
    if (bottomOp.fire && bottomOp.confidence >= 80) {
      await tryOpenFXLong({
        confidence: bottomOp.confidence,
        source: `底打ち ${bottomOp.conditions.join(",")}`,
      }).catch(e => console.warn("[fx] open 失敗:", e));
    }
  }

  // === 取引規律フィルタ群（Alpha Arena 教訓） ===
  // 勝ち取引の率を上げるため、期待値マイナスの取引を排除する
  const disciplineNotes: string[] = [];

  // 1. 信頼度キャリブレーション: 過去の判断と実績から確信度を補正
  if (decision.action !== "HOLD") {
    const allAudits = await getAudits(500).catch(() => []);
    const cal = calibrateConfidence(allAudits, decision.confidence);
    if (cal.calibrated !== cal.raw) {
      decision.confidence = cal.calibrated;
      disciplineNotes.push(`[補正] ${cal.reason}`);
    }
  }

  // 1.5. F&G フィルタは無効化 (本番運用で「動かない bot」原因の主因だった)
  // F&G 値は audit log に残すが、エントリー gating には使わない
  if (decision.action !== "HOLD") {
    disciplineNotes.push(`[F&G] ${fearGreed.value} ${fearGreed.label} (フィルタOFF)`);
  }

  // 2. マルチタイムフレーム整合性: h1の判断がh4トレンドと逆なら見送り
  if (decision.action !== "HOLD") {
    const mtf = checkMTFAlignment(bars, decision.action);
    if (!mtf.aligned) {
      disciplineNotes.push(`[MTF] ${mtf.reason}`);
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
    } else {
      disciplineNotes.push(`[MTF] ${mtf.reason}`);
    }
  }

  // 3. 期待値ゲート: 手数料を引いてもプラスEVか確認
  if (decision.action !== "HOLD") {
    const tp = decision.suggestedTakeProfitPercent ?? 3.0;
    const sl = decision.suggestedStopLossPercent ?? 2.0;
    const edge = checkEdge(decision.confidence, tp, sl);
    if (!edge.passed) {
      disciplineNotes.push(`[EV] ${edge.reason}`);
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
    } else {
      disciplineNotes.push(`[EV] ${edge.reason}`);
    }
  }

  if (disciplineNotes.length > 0) {
    decision.reason = `${decision.reason} | ${disciplineNotes.join(" / ")}`;
  }

  // 監査ログを保存（判断根拠の完全な記録）
  const auditEntry = {
    ...scoringResult.audit,
    id: `audit-${Date.now()}-${pair.replace("/", "")}`,
    timestamp: new Date().toISOString(),
  };
  await saveAudit(auditEntry).catch(() => {}); // 監査ログ保存失敗はbot停止しない

  // Store decision
  state.decisions.push(decision);
  if (state.decisions.length > 500) state.decisions = state.decisions.slice(-500);

  console.log(`[${pair}] ${decision.action} 確信度${decision.confidence}% [${regime}] Q:${quantAnalysis.compositeScore} - ${decision.reason}`);

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
    let livePos = state.livePositions.get(pair);
    const currentPositionJPY = realPosition.amount * ticker.price;

    // 現サイクルの ATR を計算 (vol scaling / regime SL の根拠に使う)
    const atrValsForBuy = atrIndicator(
      bars.map(b => b.high),
      bars.map(b => b.low),
      bars.map(b => b.close),
      14,
    );
    const lastATR = atrValsForBuy.filter((v): v is number => v !== null).slice(-1)[0] ?? 0;
    const regimeTpSl = regimeAdjustedTpSl(regime);

    // 残高はあるが livePos が無い → BitFlyer 約定履歴から FIFO で真の avg を計算
    // (旧実装は ticker.price を fake entry にしていて、TP/SL が経済実態と乖離してた)
    if (!livePos && realPosition.amount > 0 && ticker.price > 0) {
      let trueAvgPrice = ticker.price; // フォールバック
      try {
        if (liveExchange.fetchExecutions) {
          const executions = await liveExchange.fetchExecutions(pair);
          const summary = computeLifetimePnL(executions);
          const pairData = summary.byPair.find(p => p.pair === pair);
          if (pairData && pairData.averageBuyPrice > 0 && pairData.remainingInventory > 0) {
            trueAvgPrice = pairData.averageBuyPrice;
            console.log(`[${pair}] FIFO avg 取得成功: ¥${trueAvgPrice.toFixed(2)} (残在庫 ${pairData.remainingInventory})`);
          } else {
            console.log(`[${pair}] FIFO avg 取得失敗 → ticker.price フォールバック ¥${ticker.price.toFixed(0)}`);
          }
        }
      } catch (e) {
        console.log(`[${pair}] FIFO 計算エラー (${e instanceof Error ? e.message : "unknown"}) → ticker.price フォールバック`);
      }

      const reconstructed: LivePositionEntry = {
        pair,
        entryPrice: trueAvgPrice,
        amount: realPosition.amount,
        entryTimestamp: new Date().toISOString(),
        stopLossPercent: regimeTpSl.sl,
        takeProfitPercent: regimeTpSl.tp,
      };
      state.livePositions.set(pair, reconstructed);
      livePos = reconstructed;
      await saveData("live-positions", Array.from(state.livePositions.values()));
      console.log(`[${pair}] livePos 再構築: ${realPosition.amount} @ ¥${trueAvgPrice.toFixed(0)} (FIFO avg, regime ${regime} → TP${regimeTpSl.tp}% / SL${regimeTpSl.sl}%)`);
    }

    // livePos.amount と realPosition.amount のズレ検知 + 同期
    // 外部買い付けや手動取引で実残高が増えた場合、FIFO avg を取り直して同期
    if (livePos && realPosition.amount > 0 && Math.abs(realPosition.amount - livePos.amount) / Math.max(realPosition.amount, livePos.amount) > 0.01) {
      console.log(`[${pair}] livePos.amount ${livePos.amount} ≠ realPosition.amount ${realPosition.amount} → FIFO 再計算`);
      try {
        if (liveExchange.fetchExecutions) {
          const executions = await liveExchange.fetchExecutions(pair);
          const summary = computeLifetimePnL(executions);
          const pairData = summary.byPair.find(p => p.pair === pair);
          if (pairData && pairData.averageBuyPrice > 0 && pairData.remainingInventory > 0) {
            livePos.entryPrice = pairData.averageBuyPrice;
            livePos.amount = realPosition.amount;
            await saveData("live-positions", Array.from(state.livePositions.values()));
            console.log(`[${pair}] 同期完了: ${realPosition.amount} @ ¥${pairData.averageBuyPrice.toFixed(2)}`);
          }
        }
      } catch { /* keep current */ }
    }

    // BUY判断
    if (decision.action === "BUY" && decision.confidence >= LIVE_CONFIDENCE_THRESHOLD) {
      // Cooldown: 直近 SL や負け確定があったペアはしばらく BUY 禁止 (リベンジ買い防止)
      const cdUntil = state.cooldownUntil.get(pair) ?? 0;
      if (Date.now() < cdUntil) {
        const remainMin = Math.ceil((cdUntil - Date.now()) / 60000);
        console.log(`[${pair}] BUY見送り: クールダウン中 (残り ${remainMin} 分)`);
        return;
      }
      // Time-of-day フィルタ: maker-only 指値の場合はスリッページ無関係なので skip 不要。
      // taker fallback の場合のみ低流動性時間帯を回避。
      if (!USE_MAKER_ONLY && isLowLiquidityHourJST()) {
        console.log(`[${pair}] BUY見送り: 低流動性時間帯 (JST 3-7時, taker mode)`);
        return;
      }
      // 重要経済指標 6h 以内 → 取引控える (FOMC/雇用統計などで暴騰暴落リスク)
      if (externalBias?.pause) {
        console.log(`[${pair}] BUY見送り: ${externalBias.pauseReason}`);
        return;
      }
      // Profit-First: 日次目標達成済みなら新規エントリー停止 (利益を守る)
      const dailyPnL = state.riskManager.getDailyPnL();
      const dailyTargetJPY = (dailyPnL.startCapitalJPY * DAILY_TARGET_PERCENT) / 100;
      if (dailyPnL.realizedPnL >= dailyTargetJPY && dailyTargetJPY > 0) {
        console.log(`[${pair}] BUY見送り: 本日目標達成 ¥${Math.round(dailyPnL.realizedPnL).toLocaleString()} ≥ ¥${Math.round(dailyTargetJPY).toLocaleString()}`);
        return;
      }
      const balance = await liveExchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      const baseTradeAmount = state.riskManager.calculatePositionSizeJPY(
        decision.confidence,
        jpyFree + currentPositionJPY,
        currentPositionJPY,
        LIVE_MAX_POSITION_JPY,
      );
      // Volatility-targeted sizing: 高ボラなら小さく、低ボラなら標準
      const volFactor = volScalingFactor(lastATR, ticker.price, 1.0);
      const tradeAmount = Math.round(baseTradeAmount * volFactor);
      if (volFactor !== 1.0) {
        console.log(`[${pair}] vol scaling: ATR/price=${((lastATR / ticker.price) * 100).toFixed(2)}% → factor ${volFactor.toFixed(2)}x (¥${Math.round(baseTradeAmount)} → ¥${tradeAmount})`);
      }

      // ペア固有の最小発注額 (BitFlyer: ETH 0.01, BTC 0.001, etc) を尊重
      const perPairMin = liveExchange.getMinOrderJPY?.(pair, ticker.price) ?? LIVE_MIN_TRADE_JPY;
      const minRequired = Math.max(LIVE_MIN_TRADE_JPY, perPairMin);
      if (tradeAmount < minRequired) {
        console.log(`[${pair}] BUY見送り: 注文額 ¥${Math.round(tradeAmount)} < 最小 ¥${minRequired}`);
        return;
      }
      if (tradeAmount >= minRequired && jpyFree >= tradeAmount) {
        try {
          const { order, viaMaker } = await executeBuy(liveExchange, pair, tradeAmount);
          const trade: TradeRecord = {
            id: `live-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "buy",
            type: viaMaker ? "limit" : "market",
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

          // ポジション追跡（Profit-First TP/SL を強制採用）
          const existing = state.livePositions.get(pair);
          if (existing) {
            const totalAmount = existing.amount + order.amount;
            const avgPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / totalAmount;
            existing.entryPrice = avgPrice;
            existing.amount = totalAmount;
            existing.stopLossPercent = regimeTpSl.sl;
            existing.takeProfitPercent = regimeTpSl.tp;
          } else {
            state.livePositions.set(pair, {
              pair,
              entryPrice: order.price,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: regimeTpSl.sl,
              takeProfitPercent: regimeTpSl.tp,
            });
          }
          console.log(`[${pair}] LIVE BUY ${regime} → TP${regimeTpSl.tp}% / SL${regimeTpSl.sl}% 設定`);

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
        const { order } = await executeSell(liveExchange, pair, realPosition.free);
        const fillPrice = order.price > 0 ? order.price : ticker.price;
        const entryPrice = livePos?.entryPrice ?? 0;
        const pnl = entryPrice > 0 ? (fillPrice - entryPrice) * order.amount : 0;
        const pnlPercent = entryPrice > 0 ? ((fillPrice - entryPrice) / entryPrice) * 100 : 0;

        const trade: TradeRecord = {
          id: `live-${Date.now()}`,
          timestamp: new Date().toISOString(),
          exchange: "bitflyer",
          pair,
          side: "sell",
          type: "market",
          amount: order.amount,
          price: fillPrice,
          valueJPY: order.amount * fillPrice,
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
        if (pnl < 0) {
          const cdMs = adaptiveCooldownMs(pnlPercent);
          state.cooldownUntil.set(pair, Date.now() + cdMs);
          await persistCooldowns();
          console.log(`[${pair}] 負け確定 (${pnlPercent.toFixed(2)}%) → クールダウン ${cdMs / 60000}分セット`);
        }

        await saveData("live-trades", state.liveTrades.slice(-200));
        await saveData("live-positions", Array.from(state.livePositions.values()));
        console.log(`[${pair}] LIVE SELL: 損益 ¥${pnl.toLocaleString()} (${pnlPercent.toFixed(1)}%)`);
        // 監査ログに結果を記録（改善ループ用）
        await recordOutcome(pair, fillPrice, pnl, pnlPercent).catch(() => {});
      } catch (e) {
        console.error(`[${pair}] LIVE SELL 失敗:`, e);
      }
    }

    // ライブ SL/TP チェック（トレーリングストップ込み）
    if (livePos && realPosition.free > 0) {
      // トレーリングストップ: 含み益が出たら SL をブレイクイーブン → ATR追従で引き上げ
      const atrVals = atrIndicator(
        bars.map(b => b.high),
        bars.map(b => b.low),
        bars.map(b => b.close),
        14
      );
      const lastATR = atrVals.filter((v): v is number => v !== null).slice(-1)[0] ?? 0;
      if (lastATR > 0 && typeof livePos.stopLossPercent === "number") {
        const trail = computeTrailingStop({
          entryPrice: livePos.entryPrice,
          currentPrice: ticker.price,
          atr: lastATR,
          currentStopLossPercent: livePos.stopLossPercent,
          breakevenTriggerPercent: 1.0,
          trailFactor: 1.0,
        });
        if (trail.movedToBreakeven || trail.trailing) {
          const oldSL = livePos.stopLossPercent;
          livePos.stopLossPercent = trail.newStopLossPercent;
          if (livePos.stopLossPercent !== oldSL && typeof livePos.stopLossPercent === "number") {
            console.log(`[${pair}] トレーリングSL: ${oldSL.toFixed(2)}% → ${livePos.stopLossPercent.toFixed(2)}% (${trail.reason})`);
            await saveData("live-positions", Array.from(state.livePositions.values()));
          }
        }
      }

      const changePercent = ((ticker.price - livePos.entryPrice) / livePos.entryPrice) * 100;
      let triggerType: "stop_loss" | "take_profit" | null = null;

      if (changePercent <= -livePos.stopLossPercent) {
        triggerType = "stop_loss";
      } else if (changePercent >= livePos.takeProfitPercent) {
        triggerType = "take_profit";
      }

      if (triggerType) {
        try {
          // SL は緊急性高い → maker timeout を短く (10s)、TP は通常 (30s)
          // ただし TP/SL 両方とも maker 試行 → timeout で成行フォールバック
          const { order } = await executeSell(liveExchange, pair, realPosition.free, triggerType === "stop_loss");
          // BitFlyer (ccxt) は order.average を 0 で返すことがある。ticker.price で代替。
          const fillPrice = order.price > 0 ? order.price : ticker.price;
          const pnl = (fillPrice - livePos.entryPrice) * order.amount;
          const pnlPercent = ((fillPrice - livePos.entryPrice) / livePos.entryPrice) * 100;

          const trade: TradeRecord = {
            id: `live-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "sell",
            type: triggerType,
            amount: order.amount,
            price: fillPrice,
            valueJPY: order.amount * fillPrice,
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
          if (triggerType === "stop_loss" || pnl < 0) {
            const cdMs = adaptiveCooldownMs(pnlPercent);
            state.cooldownUntil.set(pair, Date.now() + cdMs);
            await persistCooldowns();
            console.log(`[${pair}] SL/負け確定 (${pnlPercent.toFixed(2)}%) → クールダウン ${cdMs / 60000}分セット`);
          }

          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[${pair}] LIVE ${triggerType.toUpperCase()}: 損益 ¥${pnl.toLocaleString()} (${pnlPercent.toFixed(1)}%)`);
          await recordOutcome(pair, fillPrice, pnl, pnlPercent).catch(() => {});
        } catch (e) {
          console.error(`[${pair}] LIVE ${triggerType.toUpperCase()} 失敗:`, e);
        }
      }
    }

    // DCA（ドルコスト平均法）: HOLDでもNサイクルごとに少額積立
    // レジームに応じてDCA額を調整
    // 重要: 下降トレンドではDCA停止 (含み損拡大の負け筋を防ぐ)
    const dcaMultiplier = regime === "TRENDING_UP" ? 2.0    // 上昇トレンド: 積極的に積む
                        : regime === "RANGING" ? 1.0        // レンジ: 通常ペース
                        : regime === "TRENDING_DOWN" ? 0    // 下降トレンド: DCA停止
                        : 0;                                // VOLATILE: DCA停止
    const dcaAmount = Math.round(DCA_AMOUNT_JPY * dcaMultiplier);

    if (DCA_ENABLED && decision.action === "HOLD" && state.cycleCount % DCA_INTERVAL_CYCLES === 0 && dcaAmount > 0) {
      const balance = await liveExchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      const currentPositionJPY = realPosition.amount * ticker.price;

      if (jpyFree >= dcaAmount && currentPositionJPY < LIVE_MAX_POSITION_JPY) {
        try {
          const { order } = await executeBuy(liveExchange, pair, dcaAmount);
          const trade: TradeRecord = {
            id: `dca-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "buy",
            type: "market",
            amount: order.amount,
            price: order.price,
            valueJPY: dcaAmount,
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
          console.log(`[${pair}] DCA BUY: ¥${dcaAmount} [${regime}] @ ¥${order.price.toLocaleString()}`);
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

  // 日付ロールオーバー: 0時を跨いだら dailyPnL をリセット
  try {
    let currentCapital = 0;
    if (state.paperMode) {
      const positions = state.paperTrader.getAllPositions();
      const positionValue = positions.reduce((s, p) => s + p.valueJPY, 0);
      const realizedSoFar = state.paperTrader
        .getTrades()
        .filter((t) => t.side === "sell" && t.pnl !== undefined)
        .reduce((s, t) => s + (t.pnl ?? 0), 0);
      currentCapital = PAPER_VIRTUAL_CAPITAL_JPY + realizedSoFar + positionValue;
    } else {
      const exchange = getExchange();
      await exchange.connect();
      const balance = await exchange.getBalance();
      currentCapital = balance.find((b) => b.currency === "JPY")?.total ?? 0;
      // 保有暗号通貨も評価額に加算
      for (const [posPair, pos] of state.livePositions) {
        try {
          const t = await exchange.getTicker(posPair);
          currentCapital += pos.amount * t.price;
        } catch { /* ティッカー取れない場合は無視 */ }
      }
    }
    const rolled = await state.riskManager.rolloverIfNewDay(currentCapital);
    if (rolled) {
      console.log(`日付ロールオーバー: 開始資金 ¥${currentCapital.toLocaleString()} で本日損益をリセット`);
    }
  } catch (e) {
    console.error("日付ロールオーバー失敗:", e);
  }

  for (const pair of state.pairs) {
    try {
      await runCycleForPair(pair);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`[${pair}] サイクルエラー: ${err.name}: ${err.message}`);
      console.error(`STACK: ${err.stack}`);
    }
  }

  // PnL履歴を記録（グラフ用、12サイクル=3時間ごと）
  if (state.cycleCount % 12 === 0) {
    const daily = state.riskManager.getDailyPnL();
    const history = await loadData<{ timestamp: string; realizedPnL: number; unrealizedPnL: number; totalPnL: number; trades: number }[]>("pnl-history", []);
    history.push({
      timestamp: new Date().toISOString(),
      realizedPnL: daily.realizedPnL,
      unrealizedPnL: daily.unrealizedPnL,
      totalPnL: daily.totalPnL,
      trades: daily.trades,
    });
    await saveData("pnl-history", history.slice(-500));
  }

  // 総資産スナップショット（毎サイクル記録、ライブモードのみ）
  if (!state.paperMode) {
    try {
      await recordNavSnapshot();
    } catch (e) {
      console.error("NAV snapshot 失敗:", e);
    }
  }

  // Phase 2: 信号ウェイト学習を 24サイクル(=6時間)ごとに再計算
  if (state.cycleCount % 24 === 0) {
    try {
      const audits = await getAudits(500);
      const summary = computeLearnedWeights(audits, BASELINE_SIGNAL_WEIGHTS);
      if (summary.ready) {
        setActiveSignalWeights(summary.learned);
        console.log(
          `[learning] シグナルウェイト更新 (完了取引${summary.completedAudits}件):`,
          Object.entries(summary.learned)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(", ")
        );
      }
    } catch (e) {
      console.error("learning失敗:", e);
    }
  }
}

interface NavSnapshot {
  timestamp: string;
  jpy: number;
  cryptoValueJPY: number;
  total: number;
  positions: Record<string, { amount: number; price: number; valueJPY: number }>;
}

/**
 * BitFlyer の実残高 + 約定履歴から livePositions を再構築する。
 * Bot 再起動・デプロイで in-memory state が消えても、SL/TP が機能するように。
 */
async function reconcileLivePositionsFromExchange(): Promise<void> {
  if (state.paperMode) return;
  try {
    const exchange = getExchange();
    if (!exchange.fetchExecutions) return;
    await exchange.connect();

    for (const pair of state.pairs) {
      const realPos = await exchange.getPosition(pair);
      if (realPos.amount <= 0.0000001) continue;

      const tracked = state.livePositions.get(pair);
      const alreadyAligned =
        tracked &&
        Math.abs(tracked.amount - realPos.amount) < 0.00001 &&
        typeof tracked.stopLossPercent === "number" &&
        tracked.entryPrice > 0;
      if (alreadyAligned) continue;

      // FIFO で残在庫の avg buy price を計算
      let avgPrice = 0;
      try {
        const executions = await exchange.fetchExecutions(pair);
        const summary = computeLifetimePnL(executions);
        const stats = summary.byPair.find((p) => p.pair === pair);
        if (stats && stats.remainingInventory > 0 && stats.averageBuyPrice > 0) {
          avgPrice = stats.averageBuyPrice;
        }
      } catch (e) {
        console.error(`[reconcile] ${pair} 約定履歴取得失敗:`, e);
      }

      // フォールバック: 現在価格を avg として記録（直ちには SL 発火しない）
      if (avgPrice <= 0) {
        try {
          const ticker = await exchange.getTicker(pair);
          avgPrice = ticker.price;
        } catch {
          continue;
        }
      }

      state.livePositions.set(pair, {
        pair,
        entryPrice: avgPrice,
        amount: realPos.amount,
        entryTimestamp: tracked?.entryTimestamp ?? new Date().toISOString(),
        stopLossPercent:
          typeof tracked?.stopLossPercent === "number" ? tracked.stopLossPercent : 2.0,
        takeProfitPercent:
          typeof tracked?.takeProfitPercent === "number" ? tracked.takeProfitPercent : 3.0,
      });
      console.log(
        `[reconcile] ${pair}: amount=${realPos.amount} avg=¥${Math.round(avgPrice).toLocaleString()} SL=2.0% TP=3.0% から復元`
      );
    }

    await saveData("live-positions", Array.from(state.livePositions.values()));
  } catch (e) {
    console.error("livePositions 復元失敗:", e);
  }
}

/**
 * 緊急ロスカット番兵。pipeline と完全独立に動作。
 * 含み損が EMERGENCY_LOSS_PERCENT を超えたら問答無用で全量売却。
 * AI の HOLD 判断・MTF/EV フィルタ・確信度閾値をすべて無視する。
 */
async function emergencyLossCut(pair: string, currentPrice: number): Promise<boolean> {
  if (state.paperMode) return false;
  try {
    const exchange = getExchange();
    const realPos = await exchange.getPosition(pair);
    if (realPos.free <= 0.0000001) return false;

    const livePos = state.livePositions.get(pair);
    if (!livePos || livePos.entryPrice <= 0) return false;

    const lossPercent = ((currentPrice - livePos.entryPrice) / livePos.entryPrice) * 100;
    if (lossPercent > -EMERGENCY_LOSS_PERCENT) return false;

    console.log(
      `[${pair}] 🚨 緊急ロスカット発動: 含み損 ${lossPercent.toFixed(2)}% (${-EMERGENCY_LOSS_PERCENT}% 閾値超え)`
    );
    const order = await exchange.marketSell(pair, realPos.free);
    const fillPrice = order.price > 0 ? order.price : currentPrice;
    const pnl = (fillPrice - livePos.entryPrice) * order.amount;
    const pnlPercent = ((fillPrice - livePos.entryPrice) / livePos.entryPrice) * 100;

    const trade: TradeRecord = {
      id: `emergency-${Date.now()}`,
      timestamp: new Date().toISOString(),
      exchange: "bitflyer",
      pair,
      side: "sell",
      type: "stop_loss",
      amount: order.amount,
      price: fillPrice,
      valueJPY: order.amount * fillPrice,
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
    // 緊急ロスカットは強い負けシグナル → クールダウン長め (60分)
    state.cooldownUntil.set(pair, Date.now() + COOLDOWN_MS_AFTER_LOSS * 2);
    await persistCooldowns();
    console.log(`[${pair}] 緊急ロスカット → クールダウン ${(COOLDOWN_MS_AFTER_LOSS * 2) / 60000}分セット`);
    await saveData("live-trades", state.liveTrades.slice(-200));
    await saveData("live-positions", Array.from(state.livePositions.values()));
    await recordOutcome(pair, fillPrice, pnl, pnlPercent).catch(() => {});
    console.log(`[${pair}] 緊急ロスカット執行: 損益 ¥${Math.round(pnl).toLocaleString()} (${pnlPercent.toFixed(1)}%)`);
    return true;
  } catch (e) {
    console.error(`[${pair}] 緊急ロスカット失敗:`, e);
    return false;
  }
}

async function recordNavSnapshot(): Promise<void> {
  const exchange = getExchange();
  await exchange.connect();
  const balance = await exchange.getBalance();
  const jpy = balance.find((b) => b.currency === "JPY")?.total ?? 0;

  let cryptoValueJPY = 0;
  const positions: NavSnapshot["positions"] = {};
  // 全暗号通貨残高を評価 (state.pairs に限らない、BTC/XLM/MONA等の dust も合算)
  for (const bal of balance) {
    if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
    const pair = `${bal.currency}/JPY`;
    try {
      const t = await exchange.getTicker(pair);
      const valueJPY = bal.total * t.price;
      cryptoValueJPY += valueJPY;
      positions[pair] = { amount: bal.total, price: t.price, valueJPY };
    } catch {
      // ticker取得失敗はスキップ
    }
  }
  const total = jpy + cryptoValueJPY;
  const history = await loadData<NavSnapshot[]>("nav-history", []);
  // 直近スナップショットと差が±¥10未満かつ5分以内なら重複扱いでスキップ
  const last = history[history.length - 1];
  if (last) {
    const lastTime = new Date(last.timestamp).getTime();
    const sinceLast = Date.now() - lastTime;
    if (sinceLast < 5 * 60 * 1000 && Math.abs(last.total - total) < 10) return;
  }
  history.push({
    timestamp: new Date().toISOString(),
    jpy,
    cryptoValueJPY,
    total,
    positions,
  });
  // 最大2000件保持（1サイクル15分なら約3週間）
  await saveData("nav-history", history.slice(-2000));
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
    // 既存データ修復: dailyPnL を本日分のみに再計算
    await state.riskManager.recomputeDailyFromTrades(state.paperTrader.getTrades());
    console.log(`Bot起動 | ペーパー: true | 仮想資金: ¥${PAPER_VIRTUAL_CAPITAL_JPY.toLocaleString()} | ペア: ${state.pairs.join(", ")} | 間隔: ${state.intervalSeconds}秒`);
  } else {
    const exchange = getExchange();
    await exchange.connect();
    const balance = await exchange.getBalance();
    const jpyTotal = balance.find(b => b.currency === "JPY")?.total ?? 0;
    await state.riskManager.init(jpyTotal);
    // 既存データ修復: dailyPnL を本日分のみに再計算
    await state.riskManager.recomputeDailyFromTrades(state.liveTrades);
    // 不正pnl補正後、CBが誤発動状態なら解除（recompute後の正味loss%で再判定される）
    if (state.riskManager.getState() !== "TRIGGERED") {
      state.riskManager.reset();
      await state.riskManager.save();
    }
    // 重要: livePositions を BitFlyer 実残高から復元（SL/TP動作の前提）
    await reconcileLivePositionsFromExchange();
    console.log(`Bot起動 | ライブ | 資金: ¥${jpyTotal.toLocaleString()} | ペア: ${state.pairs.join(", ")} | 間隔: ${state.intervalSeconds}秒`);
  }

  // Phase 2: 起動時にも学習済みウェイトを適用 (前回までの蓄積を引き継ぐ)
  try {
    const audits = await getAudits(500);
    const summary = computeLearnedWeights(audits, BASELINE_SIGNAL_WEIGHTS);
    if (summary.ready) {
      setActiveSignalWeights(summary.learned);
      console.log(`[learning] 起動時ウェイト適用 (完了取引${summary.completedAudits}件)`);
    } else {
      console.log(`[learning] サンプル不足 (完了取引${summary.completedAudits}件 < 30/シグナル)、baseline使用`);
    }
  } catch (e) {
    console.error("[learning] 起動時失敗:", e);
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
