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
import { getAggregatedIntel } from "../intel/aggregator";
import { detectBottomOpportunity, detectTopOpportunity, detectAggressiveReversal } from "../quant/timing";
import { analyzeMultiTimeframe, type MultiTimeframeAnalysis } from "../quant/timeframe-analyzer";
import { classifyPositionStyle } from "./position-style";
import { tryOpenFXLong, checkFXPositionExit } from "./fx-engine";
import { reflectOnLoss } from "../quant/reflection";
import { getActiveLessons, matchLessons, rebuildLessonsFromReflections } from "../quant/lessons";
import { computeAllocations, type ForwardSignal, type PairAllocation } from "./capital-allocator";
import { evaluateTier } from "./capital-policy";
import { evaluateKillSwitch, isKillSwitchActive } from "./kill-switch";
import { sendAlert } from "../alerts";
import { checkOpportunities } from "../opportunity-detector";
import { shouldFireCommentary, runDailyCommentary } from "../ai-commentary";
import { getCapitalPolicy } from "./capital-policy";
import { shouldFireDCA, executeDCA } from "./dca";
import { runGridCycle } from "./grid-trader";
import { analyzeLossPatterns } from "../quant/loss-analyzer";
import { getActiveOverrides, runStrategicRetrospective } from "../quant/retrospective";
import { computeAutoGuardrails, getAutoGuardrails, isBlockedHourJST, type AutoGuardrails } from "../quant/auto-guardrails";
import { evaluateAllocation, recordAllocationEvent } from "./allocation-maintainer";
import { assessPreTradeRisk, buildPortfolioRiskOverlay } from "./institutional-risk";

// 緊急ロスカット閾値（pipelineと無関係に発火）
const EMERGENCY_LOSS_PERCENT = 5.0;

const PAPER_VIRTUAL_CAPITAL_JPY = 1_000_000; // ペーパートレード仮想資金 ¥100万
const PAPER_TRADE_AMOUNT_JPY = 50_000;       // 1回の取引額
const PAPER_MAX_POSITION_JPY = 200_000;      // ペアあたり最大ポジション

// ライブモード設定
const LIVE_MIN_TRADE_JPY = 3_000;            // 最小取引額 ¥3,000 (旧 ¥1,000 だと手数料負けで判断データ取れず)
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

function numericFactor(value: number | string | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Yahoo/CoinGecko fallback で volume=0 が返るペアでも判断材料を奪わないように、
// 直近 N 本の bar 全部が volume=0 = データ欠損として扱う閾値
const VOLUME_DATA_MISSING_THRESHOLD = 0.001;

// XRP の per-pair 損失制限を「直近 N 日に loss が確認されたら」だけに限定するためのウィンドウ
const PAIR_LOSS_LOOKBACK_DAYS = 7;
const PAIR_LOSS_LOOKBACK_MS = PAIR_LOSS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

function hasRecentLosses(trades: TradeRecord[], pair: string, lookbackMs: number, minLosses: number = 2): boolean {
  const cutoff = Date.now() - lookbackMs;
  let losses = 0;
  for (const t of trades) {
    if (t.pair !== pair) continue;
    if (t.side !== "sell") continue;
    if (t.pnl == null || t.pnl >= 0) continue;
    if (new Date(t.timestamp).getTime() < cutoff) continue;
    losses++;
    if (losses >= minLosses) return true;
  }
  return false;
}

function evaluateAdaptiveBuyGuardrails(input: {
  action: AIDecision["action"];
  pair: string;
  confidence: number;
  fearGreed: number;
  regime: MarketRegime;
  quantAnalysis: ReturnType<typeof runQuantAnalysis>;
  audit: ReturnType<typeof calculateFinalDecision>["audit"];
  recentTrades: TradeRecord[];
  autoGuardrails: AutoGuardrails | null;
}): string[] {
  if (input.action !== "BUY") return [];

  const volumeRatio = numericFactor(
    input.quantAnalysis.signals.find((s) => s.name === "出来高異常")?.factors.ratio,
  );
  const rangePosition = numericFactor(
    input.quantAnalysis.signals.find((s) => s.name === "ATRブレイクアウト")?.factors.rangePosition,
  );
  const directionalVotes = input.audit.votes.filter((v) => v.action !== "HOLD");
  const supportVotes = directionalVotes.filter((v) => v.action === "BUY").length;
  const opposingVotes = directionalVotes.filter((v) => v.action === "SELL").length;
  const reasons: string[] = [];

  // Volume データ欠損判定: Yahoo/CoinGecko fallback は volume=0 を返す。
  // volumeRatio が VOLUME_DATA_MISSING_THRESHOLD 未満 ≒ データ欠損とみなし volume 系 gate を無視。
  const volumeDataMissing = volumeRatio == null || volumeRatio < VOLUME_DATA_MISSING_THRESHOLD;

  // 厳格化: 「客観的に絶対避けるべき」局面のみ block.
  // 旧設計は守りすぎて「動かない bot」になった (volume<0.3 で全部 block).
  // 新設計: volume<0.1x (=ほぼ板無し) かつ BUY 票 0 票の極端時のみ.
  // ただし volume データ欠損時は判断保留せず通す (fallback OHLCV では出来高情報が無い)
  if (!volumeDataMissing && volumeRatio != null && volumeRatio < 0.10 && supportVotes === 0) {
    reasons.push(`板枯渇 volume=${volumeRatio.toFixed(2)}x かつ BUY支持0票 (約定リスク高)`);
  }
  // レンジ高値圏での反対票多数: 「天井圏で買い」は客観的に不利
  if (
    !volumeDataMissing &&
    volumeRatio != null &&
    rangePosition != null &&
    volumeRatio < 0.15 &&
    rangePosition > 80 &&
    opposingVotes >= 3
  ) {
    reasons.push(`レンジ天井圏${rangePosition.toFixed(0)}% + 板薄 + 反対票${opposingVotes}票`);
  }
  // XRP の per-pair 損失制限: 直近 7 日に 2 件以上の loss-sell があった時のみ発動
  // (永続ルール化で「いつまでも XRP 買えない」状態を回避)
  if (input.pair === "XRP/JPY" && input.confidence < 74 && supportVotes <= 3) {
    if (hasRecentLosses(input.recentTrades, "XRP/JPY", PAIR_LOSS_LOOKBACK_MS, 2)) {
      reasons.push(`XRPは直近${PAIR_LOSS_LOOKBACK_DAYS}日に損失集中のため conf<74 かつ BUY支持${supportVotes}票では見送り`);
    }
  }

  // === Auto-guardrails (常時更新の loss-pattern 由来) ===
  if (input.autoGuardrails) {
    const ag = input.autoGuardrails;
    // ペア損失集中: high risk ペアは conf 閾値 +10 を要求
    if (ag.highRiskPairs.includes(input.pair) && input.confidence < 60) {
      reasons.push(`[auto] ${input.pair} 高損失集中ペア conf<60 では見送り`);
    }
    // レジーム損失集中: 例 TRENDING_UP で 93% 負け → BUY 慎重に
    if (ag.highRiskRegimes.includes(input.regime) && input.confidence < 70) {
      reasons.push(`[auto] ${input.regime} は高損失レジーム、conf<70 では見送り (高値掴み警戒)`);
    }
    // 時間帯損失集中: 該当時間帯の BUY 完全 block
    if (isBlockedHourJST(ag.blockedHourRanges)) {
      reasons.push(`[auto] JST 高損失時間帯 (${ag.blockedHourRanges.join(",")}) のため BUY 見送り`);
    }
  }

  return reasons;
}

// ライブポジション追跡（エントリー価格・SL/TPを保持）
interface LivePositionEntry {
  pair: string;
  entryPrice: number;
  amount: number;
  entryTimestamp: string;
  stopLossPercent: number;
  takeProfitPercent: number;
  /** Position style: SCALP / SWING / HOLD (デフォルト SCALP 互換) */
  style?: "SCALP" | "SWING" | "HOLD";
  /** style 決定理由 */
  styleReason?: string;
  /** 部分利確段階 (style 別に定義) */
  partialTakeProfits?: { triggerPercent: number; sellRatio: number; newSlPercent: number }[];
  /** 既に発火した PTP の index (次は ptpTriggeredCount から) */
  ptpTriggeredCount?: number;
  /** 元の amount (PTP で減ってもこの値で総 P&L 計算可) */
  originalAmount?: number;
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
  /** 動的配分: ペア → 最大ポジション JPY (毎サイクル更新) */
  pairAllocations: Map<string, number>;
  /** 直近の配分計算結果 (dashboard 表示用) */
  lastAllocationDetails: PairAllocation[];
}

const state: EngineState = {
  running: false,
  paperMode: true,
  intervalId: null,
  cycleCount: 0,
  lastCycleTimestamp: null,
  pairs: ["BTC/JPY", "ETH/JPY", "XRP/JPY", "SOL/JPY"],
  intervalSeconds: 300,
  riskManager: new RiskManager(Number(process.env.MAX_DAILY_LOSS_PERCENT || "5.0")),
  paperTrader: new PaperTrader(),
  decisions: [],
  recentTrades: [],
  livePositions: new Map(),
  liveTrades: [],
  cooldownUntil: new Map(),
  pairAllocations: new Map(),
  lastAllocationDetails: [],
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

/** 負けトレード後の AI 振り返り → ルール化。失敗しても黙って続行 */
async function triggerLossReflection(
  pair: string,
  pnl: number,
  pnlPercent: number,
  exitPrice: number,
  exitReason: string,
): Promise<void> {
  if (pnl >= 0) return; // 勝ちトレードは反省不要
  try {
    const recentAudits = await getAudits(20);
    const audit = recentAudits.reverse().find(a => a.pair === pair && (a.finalAction === "BUY" || a.finalAction === "SELL"));
    if (!audit) return;
    await reflectOnLoss(audit, { pnl, pnlPercent, exitPrice, exitReason });
    // 5 取引ごとに lessons 再構築 (重い処理ではないので頻度高め)
    if (state.cycleCount % 5 === 0) {
      await rebuildLessonsFromReflections();
    }
    // 20 取引ごとに 戦略リトロスペクティブ (AI が全 trade 見直し → SL/TP/conf 倍率提案)
    const tradeCount = state.liveTrades.filter(t => t.side === "sell" && t.pnl !== undefined).length;
    if (tradeCount > 0 && tradeCount % 20 === 0) {
      const audits = await getAudits(200);
      await runStrategicRetrospective(state.liveTrades, audits, tradeCount).catch(() => null);
      // tier 昇進/降格チェック (retrospective 直後に評価し直す)
      await evaluateTier(state.liveTrades).catch(e => console.warn("[capital-policy] tier 評価失敗:", e));
    }
  } catch (e) {
    console.warn("[reflection] トリガー失敗:", e instanceof Error ? e.message : e);
  }
}

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

function isSellableAmount(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
  amountBase: number,
  currentPrice: number,
): boolean {
  if (amountBase <= 0 || currentPrice <= 0) return false;
  const minJPY = exchange.getMinOrderJPY?.(pair, currentPrice) ?? 0;
  return minJPY <= 0 || amountBase * currentPrice >= minJPY * 0.9;
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

  // Fetch data (短期 1h + 中期 4h + 長期 1d を並列取得)
  STEP("2-fetch-start");
  const emptyBars: import("../types").OHLCVBar[] = [];
  const [ticker, bars, fourHourBars, dailyBars, balance, position, fearGreed] = await Promise.all([
    exchange.getTicker(pair),
    exchange.getOHLCV(pair, "1h", 100),
    exchange.getOHLCV(pair, "4h", 100).catch(() => emptyBars),
    exchange.getOHLCV(pair, "1d", 100).catch(() => emptyBars),
    exchange.getBalance(),
    exchange.getPosition(pair),
    getFearGreedIndex(),
  ]);
  STEP(`3-fetched price=${ticker?.price} bars=${bars?.length}/4h:${fourHourBars?.length}/1d:${dailyBars?.length} fng=${fearGreed?.value}`);

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

  // MTF を AI prompt 投入前に計算 (後段の override にも再利用)
  const mtfForPrompt: MultiTimeframeAnalysis | null =
    (fourHourBars && fourHourBars.length >= 50 && dailyBars && dailyBars.length >= 50)
      ? analyzeMultiTimeframe({ hourlyBars: bars, fourHourBars, dailyBars })
      : null;

  // AI self-awareness: 自分のパフォーマンスと負けパターンを prompt に注入
  const autoGuardrailsForPrompt = await getAutoGuardrails().catch(() => null);
  const closedTrades = state.liveTrades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const performanceContext = closedTrades.length >= 5 ? {
    closedTrades: closedTrades.length,
    winRate: (wins / closedTrades.length) * 100,
    netPnLJPY: closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
  } : null;

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
    mtf: mtfForPrompt,
    autoGuardrails: autoGuardrailsForPrompt,
    performanceContext,
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

  // Intel: whale flows + Reddit sentiment + funding rate (10 分キャッシュ)
  let intelBias: Awaited<ReturnType<typeof getAggregatedIntel>> | null = null;
  try {
    intelBias = await getAggregatedIntel();
  } catch (e) {
    console.warn(`[${pair}] intel 取得失敗:`, e instanceof Error ? e.message : e);
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
    intelBias: intelBias ? {
      score: intelBias.totalScore,
      reason: `${intelBias.verdict} (whale:${intelBias.components.whale.score} fund:${intelBias.components.funding.score} community:${intelBias.components.community.score})`,
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

  // 積極反転検出 (extreme 条件不要、段階的)
  const reversalOp = detectAggressiveReversal(timingInput);

  // === Opportunity 検知 (bot 判断と独立、純粋な「機会」を Slack push) ===
  try {
    const recentBars = bars.slice(-14);
    const low14 = Math.min(...recentBars.map(b => b.low));
    const high14 = Math.max(...recentBars.map(b => b.high));
    const near14LowPercent = low14 > 0 ? ((ticker.price - low14) / low14) * 100 : 100;
    const near14HighPercent = high14 > 0 ? ((high14 - ticker.price) / high14) * 100 : 100;
    const volumeRatio = numericFactor(
      quantAnalysis.signals.find(s => s.name === "出来高異常")?.factors.ratio,
    ) ?? 1.0;
    await checkOpportunities({
      pair,
      price: ticker.price,
      near14LowPercent,
      near14HighPercent,
      fearGreed: fearGreed.value,
      volumeRatio,
      intel: intelBias,
      bottomFire: bottomOp.fire,
      bottomConfidence: bottomOp.confidence,
      reversalFire: reversalOp.fire,
    });
  } catch (e) {
    console.warn(`[${pair}] opportunity check 失敗:`, e instanceof Error ? e.message : e);
  }

  // 底打ち/反転 override が発火したら MTF check を skip するフラグ
  // 「下降トレンド中の底値買い」を MTF discipline で潰さないため
  let bypassMtfCheck = false;

  if (bottomOp.fire && decision.action !== "BUY") {
    console.log(`[${pair}] 🔻 底打ち検出 → BUY override (${bottomOp.confidence}% 確信): ${bottomOp.conditions.join(" / ")}`);
    decision.action = "BUY";
    decision.confidence = bottomOp.confidence;
    decision.reason = `[底打ちoverride ${bottomOp.confidence}%] ${bottomOp.conditions.join(" / ")}`;
    if (bottomOp.confidence >= 80) bypassMtfCheck = true;
  } else if (reversalOp.fire && decision.action !== "BUY") {
    // 積極反転: 条件少ない代わりに confidence 段階 (65/78/88)
    console.log(`[${pair}] 📈 反転検出 → BUY override (${reversalOp.confidence}% 確信): ${reversalOp.conditions.join(" / ")}`);
    decision.action = "BUY";
    decision.confidence = reversalOp.confidence;
    decision.reason = `[反転 ${reversalOp.confidence}%] ${reversalOp.conditions.join(" / ")}`;
    if (reversalOp.confidence >= 85) bypassMtfCheck = true;
  } else if (topOp.fire && decision.action !== "SELL") {
    console.log(`[${pair}] 🔺 天井検出 → SELL override (${topOp.confidence}% 確信): ${topOp.conditions.join(" / ")}`);
    decision.action = "SELL";
    decision.confidence = topOp.confidence;
    decision.reason = `[天井override ${topOp.confidence}%] ${topOp.conditions.join(" / ")}`;
  }

  // === MTF 短期/中期/長期 マルチタイムフレーム合議 ===
  // 「歴史的に安い + 反転兆候 + 短期確認」が揃ったら底値仕込みで強制 BUY
  // 逆に「歴史的に高い + 失速」なら強制 SELL
  // (AI prompt 投入時に計算済みの mtfForPrompt を再利用)
  if (mtfForPrompt) {
    const mtf = mtfForPrompt;
    if (state.cycleCount % 6 === 0) {
      console.log(`[${pair}] MTF: ${mtf.reason}`);
    }
    if (mtf.bottomFishing && decision.action !== "BUY") {
      console.log(`[${pair}] 🎯 MTF 底値仕込み → BUY override: ${mtf.reason}`);
      decision.action = "BUY";
      decision.confidence = 80;
      decision.reason = `[MTF底値 ${mtf.consensus}] 短${mtf.short.label} 中${mtf.medium.label} 長${mtf.long.label}`;
    } else if (mtf.topTaking && decision.action !== "SELL") {
      console.log(`[${pair}] 🔝 MTF 天井利確 → SELL override: ${mtf.reason}`);
      decision.action = "SELL";
      decision.confidence = 80;
      decision.reason = `[MTF天井 ${mtf.consensus}] 短${mtf.short.label} 中${mtf.medium.label} 長${mtf.long.label}`;
    }
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
  //    MTF は警告のみで block しない (旧設計: 下降トレンド逆張りを全部潰してた).
  //    判断は score 側 (Quant + Tech) に任せ、MTF は disciplineNotes に記録するのみ.
  //    例外: confidence 50% 未満 + MTF 不一致 = 弱い判断 → HOLD (両方妥当な場合のみ却下)
  if (decision.action !== "HOLD") {
    const mtf = checkMTFAlignment(bars, decision.action);
    disciplineNotes.push(`[MTF] ${mtf.reason}`);
    if (!mtf.aligned && decision.confidence < 50 && !bypassMtfCheck) {
      // 弱い判断 (conf<50) かつ MTF も不一致 = 両方妥当なら HOLD
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
      disciplineNotes.push(`[MTF] 弱判断 + 不一致で HOLD`);
    } else if (!mtf.aligned) {
      // 強い判断 (conf>=50) または override 経由 → MTF 不一致でも続行
      disciplineNotes.push(`[MTF] 不一致だが conf${decision.confidence}% で続行`);
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

  const preRiskCapital = state.paperMode
    ? PAPER_VIRTUAL_CAPITAL_JPY
    : (balance.find((b) => b.currency === "JPY")?.total ?? 0) + position.amount * ticker.price;
  const preRiskCurrentPositionJPY = state.paperMode
    ? (state.paperTrader.getPosition(pair)?.amount ?? 0) * ticker.price
    : position.amount * ticker.price;
  const preRiskMaxPositionJPY = state.paperMode
    ? PAPER_MAX_POSITION_JPY
    : state.pairAllocations.get(pair) ?? LIVE_MAX_POSITION_JPY;
  const institutionalRisk = assessPreTradeRisk({
    bars,
    action: decision.action,
    confidence: decision.confidence,
    regime,
    totalCapitalJPY: preRiskCapital,
    currentPositionJPY: preRiskCurrentPositionJPY,
    maxPositionJPY: preRiskMaxPositionJPY,
    dailyPnL: state.riskManager.getDailyPnL(),
  });
  decision.institutionalRisk = institutionalRisk;
  if (decision.action === "BUY") {
    if (institutionalRisk.gate === "AVOID") {
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 35);
      decision.reason = `${decision.reason} | [RiskGate] AVOID: ${institutionalRisk.warnings.join(" / ") || "risk score low"}`;
    } else if (institutionalRisk.gate === "REDUCE_SIZE") {
      decision.reason = `${decision.reason} | [RiskGate] REDUCE_SIZE x${institutionalRisk.sizeMultiplier}: ${institutionalRisk.warnings.join(" / ")}`;
    } else {
      decision.reason = `${decision.reason} | [RiskGate] TRADEABLE risk=${institutionalRisk.riskScore}`;
    }
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
      ) * (decision.institutionalRisk?.sizeMultiplier ?? 1);

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
    // 戦略 override 適用: 全体 + ペア別 (perPair 優先)
    const overrides = await getActiveOverrides();
    const pairOverride = overrides.perPair[pair];
    // ペア別倍率 > 全体倍率の順で適用
    const effectiveSlMul = pairOverride?.slMultiplier ?? overrides.slMultiplier;
    const effectiveTpMul = pairOverride?.tpMultiplier ?? overrides.tpMultiplier;
    const baseTpSl = regimeAdjustedTpSl(regime);
    const regimeTpSl = {
      tp: baseTpSl.tp * effectiveTpMul,
      sl: baseTpSl.sl * effectiveSlMul,
    };
    // 除外ペア (最終手段)
    if (overrides.excludePairs.includes(pair)) {
      console.log(`[${pair}] 戦略除外中 → サイクル skip`);
      return;
    }
    // hold-only モード: 新規 BUY 止めて既存ポジの含み益待ち
    const isHoldOnly = pairOverride?.style === "hold-only";

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
    // リトロスペクティブで決まった confidence 加算を適用 (ペア別 > 全体)
    const effectiveConfBonus = pairOverride?.confidenceBonus ?? overrides.confidenceBonus;
    const effectiveThreshold = LIVE_CONFIDENCE_THRESHOLD + effectiveConfBonus;
    // hold-only モード時は BUY 完全停止 (TP/SL は通常動作)
    if (isHoldOnly && decision.action === "BUY") {
      console.log(`[${pair}] hold-only モード: 新規 BUY 停止 (${pairOverride?.reasoning ?? ""})`);
      return;
    }
    if (decision.action === "BUY" && decision.confidence >= effectiveThreshold) {
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
      // Auto-guardrails: 直近キャッシュ取得 (engine 内で 10 サイクルごと再計算)
      const autoGuardrails = await getAutoGuardrails().catch(() => null);
      const adaptiveBlocks = evaluateAdaptiveBuyGuardrails({
        action: decision.action,
        pair,
        confidence: decision.confidence,
        fearGreed: fearGreed.value,
        regime,
        quantAnalysis,
        audit: scoringResult.audit,
        recentTrades: state.liveTrades,
        autoGuardrails,
      });
      // 適応ガードレール: 厳格化済 (volume<0.1x + BUY票0 等の極端時のみ block).
      // override や強い判断時は警告のみで続行.
      if (adaptiveBlocks.length > 0 && !bypassMtfCheck && decision.confidence < 70) {
        console.log(`[${pair}] BUY見送り(REJECT): 適応ガードレール ${adaptiveBlocks.join(" / ")} | conf${decision.confidence}% < 70`);
        return;
      } else if (adaptiveBlocks.length > 0) {
        console.log(`[${pair}] BUY続行(WARN): 適応ガードレール ${adaptiveBlocks.join(" / ")} | bypass=${bypassMtfCheck} or conf${decision.confidence}%≥70`);
      }
      // Lessons learned: 過去同じパターンで複数回負けてたら BUY 見送り
      try {
        const activeLessons = await getActiveLessons();
        if (activeLessons.length > 0) {
          const rsiVals = (await import("../indicators")).rsi(bars.map(b => b.close), 14);
          const lastRSI = rsiVals.filter((v): v is number => v != null).slice(-1)[0];
          const check = matchLessons(
            {
              action: "BUY",
              pair,
              regime,
              fearGreed: fearGreed.value,
              rsi: lastRSI,
              composite: scoringResult.audit.votes.reduce((s, v) => s + v.score * v.weight, 0),
              confidence: decision.confidence,
            },
            activeLessons,
          );
          if (check.blocked) {
            console.log(`[${pair}] BUY見送り: 学習ルール ${check.matched.length}件 hit`);
            for (const m of check.matched) {
              console.log(`  → ${m.rule.slice(0, 80)} (${m.reason})`);
            }
            return;
          }
        }
      } catch (e) {
        console.warn(`[${pair}] lessons チェック失敗:`, e instanceof Error ? e.message : e);
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
      // 動的配分: 既定値ではなく、capital-allocator が決めた pair 別上限を使う
      const dynamicMax = state.pairAllocations.get(pair) ?? LIVE_MAX_POSITION_JPY;
      const baseTradeAmount = state.riskManager.calculatePositionSizeJPY(
        decision.confidence,
        jpyFree + currentPositionJPY,
        currentPositionJPY,
        dynamicMax,
      );
      // Volatility-targeted sizing: 高ボラなら小さく、低ボラなら標準
      const volFactor = volScalingFactor(lastATR, ticker.price, 1.0);
      const tradeAmount = Math.round(baseTradeAmount * volFactor);
      const riskAdjustedTradeAmount = Math.min(
        Math.round(tradeAmount * (decision.institutionalRisk?.sizeMultiplier ?? 1)),
        decision.institutionalRisk?.suggestedMaxTradeJPY ?? tradeAmount,
      );
      if (volFactor !== 1.0) {
        console.log(`[${pair}] vol scaling: ATR/price=${((lastATR / ticker.price) * 100).toFixed(2)}% → factor ${volFactor.toFixed(2)}x (¥${Math.round(baseTradeAmount)} → ¥${tradeAmount})`);
      }
      if (riskAdjustedTradeAmount !== tradeAmount) {
        console.log(`[${pair}] institutional risk sizing: ¥${tradeAmount} → ¥${riskAdjustedTradeAmount} (${decision.institutionalRisk?.gate})`);
      }

      // ペア固有の最小発注額 (BitFlyer: ETH 0.01, BTC 0.001, etc) を尊重
      const perPairMin = liveExchange.getMinOrderJPY?.(pair, ticker.price) ?? LIVE_MIN_TRADE_JPY;
      const minRequired = Math.max(LIVE_MIN_TRADE_JPY, perPairMin);
      if (riskAdjustedTradeAmount < minRequired) {
        console.log(`[${pair}] BUY見送り: 注文額 ¥${Math.round(riskAdjustedTradeAmount)} < 最小 ¥${minRequired}`);
        return;
      }
      if (riskAdjustedTradeAmount >= minRequired && jpyFree >= riskAdjustedTradeAmount) {
        try {
          const { order, viaMaker } = await executeBuy(liveExchange, pair, riskAdjustedTradeAmount);
          const trade: TradeRecord = {
            id: `live-${Date.now()}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair,
            side: "buy",
            type: viaMaker ? "limit" : "market",
            amount: order.amount,
            price: order.price,
            valueJPY: riskAdjustedTradeAmount,
            orderId: order.id,
            fee: order.fee ?? 0,
            paperTrade: false,
            aiDecision: decision,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);

          // ポジション追跡 — style 分類 (SCALP/SWING/HOLD) で TP/SL + PTP 決定
          const styleParams = classifyPositionStyle({
            composite: scoringResult.audit.votes.reduce((s, v) => s + v.score * v.weight, 0),
            regime,
            fearGreed: fearGreed.value,
            mtf: mtfForPrompt,
            bottomOp,
          });
          const existing = state.livePositions.get(pair);
          if (existing) {
            const totalAmount = existing.amount + order.amount;
            const avgPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / totalAmount;
            existing.entryPrice = avgPrice;
            existing.amount = totalAmount;
            // 追加 BUY: style は既存維持 (途中で SCALP → HOLD に切替は混乱)
            existing.stopLossPercent = styleParams.style === existing.style ? styleParams.slPercent : existing.stopLossPercent;
            existing.takeProfitPercent = styleParams.style === existing.style ? styleParams.tpPercent : existing.takeProfitPercent;
          } else {
            state.livePositions.set(pair, {
              pair,
              entryPrice: order.price,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: styleParams.slPercent,
              takeProfitPercent: styleParams.tpPercent,
              style: styleParams.style,
              styleReason: styleParams.reasoning,
              partialTakeProfits: styleParams.partialTakeProfits,
              ptpTriggeredCount: 0,
              originalAmount: order.amount,
            });
          }
          const ptpInfo = styleParams.partialTakeProfits.length > 0
            ? ` PTP[${styleParams.partialTakeProfits.map(p => `+${p.triggerPercent}%→${(p.sellRatio * 100).toFixed(0)}%売`).join(",")}]`
            : "";
          console.log(`[${pair}] LIVE BUY [${styleParams.style}] TP${styleParams.tpPercent}% / SL${styleParams.slPercent}%${ptpInfo} — ${styleParams.reasoning}`);

          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[${pair}] LIVE BUY: ¥${riskAdjustedTradeAmount.toLocaleString()} @ ¥${order.price.toLocaleString()}`);
        } catch (e) {
          console.error(`[${pair}] LIVE BUY 失敗:`, e);
        }
      }
    }
    // SELL判断
    else if (
      decision.action === "SELL" &&
      decision.confidence >= LIVE_CONFIDENCE_THRESHOLD &&
      realPosition.free > 0 &&
      isSellableAmount(liveExchange, pair, realPosition.free, ticker.price)
    ) {
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
        // 負けトレードなら AI 振り返り → ルール抽出
        triggerLossReflection(pair, pnl, pnlPercent, fillPrice, "AI_SELL").catch(() => {});
      } catch (e) {
        console.error(`[${pair}] LIVE SELL 失敗:`, e);
      }
    }

    // ライブ SL/TP チェック（トレーリングストップ込み）
    if (livePos && realPosition.free > 0 && isSellableAmount(liveExchange, pair, realPosition.free, ticker.price)) {
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

      // === Partial Take Profit (PTP) チェック ===
      // 段階的に部分利確、残りは大きな move を狙う設計
      if (livePos.partialTakeProfits && livePos.partialTakeProfits.length > 0) {
        const nextPtpIndex = livePos.ptpTriggeredCount ?? 0;
        const nextPtp = livePos.partialTakeProfits[nextPtpIndex];
        if (nextPtp && changePercent >= nextPtp.triggerPercent && realPosition.free > 0 && isSellableAmount(liveExchange, pair, realPosition.free, ticker.price)) {
          // 部分売却実行
          const sellAmount = realPosition.free * nextPtp.sellRatio;
          try {
            const { order: ptpOrder } = await executeSell(liveExchange, pair, sellAmount);
            const fillPrice = ptpOrder.price > 0 ? ptpOrder.price : ticker.price;
            const partialPnl = (fillPrice - livePos.entryPrice) * ptpOrder.amount;
            const partialPnlPct = ((fillPrice - livePos.entryPrice) / livePos.entryPrice) * 100;
            const ptpTrade: TradeRecord = {
              id: `ptp-${Date.now()}`,
              timestamp: new Date().toISOString(),
              exchange: "bitflyer",
              pair,
              side: "sell",
              type: "take_profit",
              amount: ptpOrder.amount,
              price: fillPrice,
              valueJPY: ptpOrder.amount * fillPrice,
              orderId: ptpOrder.id,
              fee: ptpOrder.fee ?? 0,
              pnl: partialPnl,
              pnlPercent: partialPnlPct,
              paperTrade: false,
            };
            state.recentTrades.push(ptpTrade);
            state.liveTrades.push(ptpTrade);
            state.riskManager.recordTrade(partialPnl);
            // SL を新しい位置に上書き
            livePos.stopLossPercent = -nextPtp.newSlPercent; // newSlPercent は entry からの +X%
            livePos.ptpTriggeredCount = nextPtpIndex + 1;
            await saveData("live-trades", state.liveTrades.slice(-200));
            await saveData("live-positions", Array.from(state.livePositions.values()));
            console.log(`[${pair}] 🎯 PTP #${nextPtpIndex + 1}: +${changePercent.toFixed(2)}% で ${(nextPtp.sellRatio * 100).toFixed(0)}% 売却 (¥${Math.round(partialPnl).toLocaleString()})、残り SL を +${nextPtp.newSlPercent}% に移動`);
            await recordOutcome(pair, fillPrice, partialPnl, partialPnlPct).catch(() => {});
            // 全 PTP 終わってなければ trigger スキップ (継続保有)
            triggerType = null;
          } catch (e) {
            console.error(`[${pair}] PTP 失敗:`, e instanceof Error ? e.message : e);
          }
        }
      }

      // Final TP/SL チェック (PTP 全消化後 or PTP 無し)
      if (!triggerType) {
        if (changePercent <= livePos.stopLossPercent) {
          // SL は負値で扱う仕様 (PTP で SL を +X% にした時もこれで OK)
          if (livePos.stopLossPercent < 0 && changePercent <= livePos.stopLossPercent) triggerType = "stop_loss";
          else if (livePos.stopLossPercent >= 0 && changePercent <= livePos.stopLossPercent) triggerType = "stop_loss";
        }
        if (!triggerType && changePercent >= livePos.takeProfitPercent) {
          triggerType = "take_profit";
        }
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
          // 負けトレードなら AI 振り返り → ルール抽出
          triggerLossReflection(pair, pnl, pnlPercent, fillPrice, triggerType).catch(() => {});
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

async function closeAllLivePositions(reason: string): Promise<void> {
  if (state.paperMode) return;
  const exchange = getExchange();
  for (const [pair, livePos] of [...state.livePositions]) {
    try {
      const realPos = await exchange.getPosition(pair);
      if (realPos.free <= 0.0000001) {
        state.livePositions.delete(pair);
        continue;
      }
      const ticker = await exchange.getTicker(pair);
      const order = await exchange.marketSell(pair, realPos.free);
      const fillPrice = order.price > 0 ? order.price : ticker.price;
      const pnl = (fillPrice - livePos.entryPrice) * order.amount;
      const pnlPercent = livePos.entryPrice > 0 ? ((fillPrice - livePos.entryPrice) / livePos.entryPrice) * 100 : 0;
      const trade: TradeRecord = {
        id: `killswitch-${Date.now()}-${pair.replace("/", "")}`,
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
      console.log(`[kill-switch] ${pair} closeout fill ¥${fillPrice.toFixed(0)} PnL ¥${pnl.toFixed(0)} (${reason})`);
    } catch (e) {
      console.error(`[kill-switch] ${pair} closeout 失敗:`, e instanceof Error ? e.message : e);
    }
  }
}

async function runCycle(): Promise<void> {
  state.cycleCount++;
  state.lastCycleTimestamp = new Date().toISOString();
  console.log(`\n=== サイクル #${state.cycleCount} (${state.lastCycleTimestamp}) ===`);

  // === 継続学習ループ: 10 サイクルごとに auto-guardrails / lessons を再計算 ===
  // 損失パターン (ペア集中 / レジーム集中 / 時間帯集中) を実データから自動抽出し
  // evaluateAdaptiveBuyGuardrails に反映する。lessons も clustering 再構築。
  if (state.cycleCount % 10 === 0 && state.liveTrades.length >= 5) {
    try {
      const ag = await computeAutoGuardrails(state.liveTrades);
      if (ag.reasons.length > 0) {
        console.log(`[auto-guardrails] 更新: ${ag.reasons.join(" / ")}`);
      }
    } catch (e) {
      console.warn("[auto-guardrails] 失敗:", e instanceof Error ? e.message : e);
    }
    try {
      const lessons = await rebuildLessonsFromReflections();
      const active = lessons.filter(l => l.active);
      if (active.length > 0) {
        console.log(`[lessons] active ${active.length} 件: ${active.slice(0, 3).map(l => `${l.id} (${l.occurrences}x)`).join(", ")}`);
      }
    } catch (e) {
      console.warn("[lessons] 再構築失敗:", e instanceof Error ? e.message : e);
    }
  }

  // === Kill switch: 既に発火済みなら cycle 全スキップ (新規エントリ防止) ===
  if (await isKillSwitchActive()) {
    console.warn(`[kill-switch] アクティブ. cycle スキップ. 手動 reset まで停止状態`);
    state.running = false;
    return;
  }

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

    // === Kill switch (reduce only モード) ===
    // 発火時の挙動: 「新規 BUY 停止」のみ. 既存 position は強制 close しない.
    // 理由: 旧設計 (全 close) は底値売りマシン化した (5/26 -42% で発火→ 5/28 +100% 反発を逃す).
    // reduce only なら、保有資産の自然な反発を取れる. 手動 reset で BUY 再開可能.
    try {
      const ks = await evaluateKillSwitch(currentCapital);
      if (ks.justTriggered) {
        state.running = false;
        await sendAlert({
          level: "critical",
          message: `🚨 kill switch 発火 (NAV -${ks.drawdownPct.toFixed(1)}%). 新規 BUY 停止. 既存 ${state.livePositions.size} ポジションは保持 (反発期待). 手動 reset 必要.`,
          dedupeKey: "kill-switch:reduce-only",
          fields: {
            "NAV": `¥${Math.round(currentCapital).toLocaleString()}`,
            "保持中": `${state.livePositions.size} positions`,
          },
        });
        return;
      }
    } catch (e) {
      console.warn("[kill-switch] 評価失敗:", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error("日付ロールオーバー失敗:", e);
  }

  // === 損失パターン分析 → 「ヤバいペア」を penalty 化 ===
  let lossAnalysis: ReturnType<typeof analyzeLossPatterns> | null = null;
  try {
    const auditsForAnalysis = await getAudits(500);
    lossAnalysis = analyzeLossPatterns(state.liveTrades, auditsForAnalysis);
    if (state.cycleCount % 6 === 0 && lossAnalysis.patterns.length > 0) {
      console.log("[損失分析] 検知パターン:");
      for (const p of lossAnalysis.patterns.slice(0, 3)) {
        console.log(`  [${p.category}] ${p.finding}`);
        console.log(`     → ${p.suggestion}`);
      }
    }
  } catch (e) {
    console.warn("[損失分析] エラー:", e instanceof Error ? e.message : e);
  }

  // === 動的資金配分: 全ペア軽量スキャン → 配分決定 ===
  // 各ペアの過去成績 + forward signal (現在の quant edge) で配分。
  // この前段で「どこに資金集中すべきか」を毎サイクル決める。
  try {
    // 「総資産」= NAV = JPY 残高 + 仮想通貨評価額 (含み益も含めた現時点 net asset value)
    // フォールバック: NAV 取れなければ JPY 残高、それも 0 なら startCapital → 50000
    let totalCapital = state.riskManager.getDailyPnL().startCapitalJPY || 50000;
    const forwardSignals: ForwardSignal[] = [];
    if (!state.paperMode) {
      const liveExchange = getExchange();
      try {
        const balance = await liveExchange.getBalance();
        const jpy = balance.find(b => b.currency === "JPY")?.total ?? 0;
        let cryptoValueJPY = 0;
        for (const bal of balance) {
          if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
          try {
            const t = await liveExchange.getTicker(`${bal.currency}/JPY`);
            cryptoValueJPY += bal.total * t.price;
          } catch {/* ticker 取れないペアはスキップ */}
        }
        const nav = jpy + cryptoValueJPY;
        if (nav > 0) totalCapital = nav;
      } catch (e) {
        console.warn("[配分] NAV 取得失敗、startCapital fallback:", e instanceof Error ? e.message : e);
      }
      for (const pair of state.pairs) {
        try {
          const bars = await liveExchange.getOHLCV(pair, "1h", 100);
          if (!bars || bars.length < 50) continue;
          const qa = runQuantAnalysis(bars);
          forwardSignals.push({
            pair,
            edgeScore: qa.compositeScore, // -100 〜 +100
            reason: `composite ${qa.compositeScore}, conf ${qa.compositeConfidence}`,
          });
        } catch {/* スキャン失敗時はそのペアをスキップ */}
      }
    }
    const allocations = await computeAllocations(totalCapital, state.pairs, state.liveTrades, forwardSignals);
    // 損失分析の topPair (一番損失出してるペア) には penalty (50% 縮小)
    if (lossAnalysis?.topPair && lossAnalysis.topPair.totalLoss < -300) {
      const target = allocations.find(a => a.pair === lossAnalysis!.topPair!.pair);
      if (target) {
        target.maxJPY = Math.round(target.maxJPY * 0.5);
        target.reason += ` | 🔻 損失集中ペナルティ 50% (累計 ¥${Math.round(lossAnalysis.topPair.totalLoss)})`;
      }
    }
    state.lastAllocationDetails = allocations;
    state.pairAllocations.clear();
    for (const a of allocations) state.pairAllocations.set(a.pair, a.maxJPY);
    if (state.cycleCount % 6 === 0 && allocations.length > 0) {
      console.log("[配分] 動的資金配分:");
      for (const a of allocations) {
        console.log(`  ${a.pair}: ¥${a.maxJPY.toLocaleString()} (${a.multiplier.toFixed(2)}x) — ${a.reason}`);
      }
    }
  } catch (e) {
    console.warn("[配分] 計算失敗:", e instanceof Error ? e.message : e);
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

  // Capital policy: 48サイクル (12時間) ごとに tier 自動評価 (retrospective が未発火でも進級チェック)
  if (state.cycleCount > 0 && state.cycleCount % 48 === 0) {
    try {
      await evaluateTier(state.liveTrades);
    } catch (e) {
      console.warn("[capital-policy] 定期 tier 評価失敗:", e instanceof Error ? e.message : e);
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

  // === Daily Commentary: JST 9時台に当日 1 回だけ AI レポート生成 + Slack 配信 ===
  try {
    if (await shouldFireCommentary()) {
      let currentNAV = state.riskManager.getDailyPnL().startCapitalJPY || 0;
      if (!state.paperMode) {
        try {
          const exchange = getExchange();
          const balance = await exchange.getBalance();
          const jpy = balance.find(b => b.currency === "JPY")?.total ?? 0;
          let cryptoVal = 0;
          for (const bal of balance) {
            if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
            try {
              const t = await exchange.getTicker(`${bal.currency}/JPY`);
              cryptoVal += bal.total * t.price;
            } catch {/* skip */}
          }
          if (jpy + cryptoVal > 0) currentNAV = jpy + cryptoVal;
        } catch {/* fallback */}
      }
      const [intel, policy] = await Promise.all([
        getAggregatedIntel().catch(() => null),
        getCapitalPolicy().catch(() => null),
      ]);
      await runDailyCommentary({
        trades: state.liveTrades,
        intel,
        policy,
        currentNAV,
      });
    }
  } catch (e) {
    console.warn("[daily-commentary] 失敗:", e instanceof Error ? e.message : e);
  }

  // === DCA (週次積立): 長期視点で機械的に定額買い ===
  try {
    if (await shouldFireDCA()) {
      const fgVal = (await getFearGreedIndex().catch(() => ({ value: 50 }))).value;
      const ksActive = await isKillSwitchActive();
      await executeDCA({
        pairs: state.pairs,
        fearGreed: fgVal,
        killSwitchActive: ksActive,
        marketBuy: async (pair: string, jpyAmount: number) => {
          if (state.paperMode) {
            return { ok: false, reason: "paperMode" };
          }
          try {
            const exchange = getExchange();
            const balance = await exchange.getBalance();
            const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
            if (jpyFree < jpyAmount) return { ok: false, reason: `JPY 不足 (free ¥${jpyFree})` };
            const order = await exchange.marketBuy(pair, jpyAmount);
            const trade: TradeRecord = {
              id: `dca-${Date.now()}-${pair.replace("/", "")}`,
              timestamp: new Date().toISOString(),
              exchange: "bitflyer",
              pair, side: "buy", type: "market",
              amount: order.amount, price: order.price,
              valueJPY: jpyAmount, orderId: order.id, fee: order.fee ?? 0,
              paperTrade: false,
            };
            state.recentTrades.push(trade);
            state.liveTrades.push(trade);
            // livePosition への加算 (既存 if あれば平均化)
            const existing = state.livePositions.get(pair);
            if (existing) {
              const newTotal = existing.amount + order.amount;
              existing.entryPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / newTotal;
              existing.amount = newTotal;
            } else {
              state.livePositions.set(pair, {
                pair, entryPrice: order.price, amount: order.amount,
                entryTimestamp: new Date().toISOString(),
                stopLossPercent: 8.0,   // DCA は長期視点で SL 緩め
                takeProfitPercent: 30.0, // TP も大きく
                style: "HOLD",
                styleReason: "DCA 長期積立",
              });
            }
            await saveData("live-trades", state.liveTrades.slice(-200));
            await saveData("live-positions", Array.from(state.livePositions.values()));
            return { ok: true, orderId: order.id, fillPrice: order.price, amount: order.amount };
          } catch (e) {
            return { ok: false, reason: e instanceof Error ? e.message : String(e) };
          }
        },
      });
    }
  } catch (e) {
    console.warn("[DCA] 失敗:", e instanceof Error ? e.message : e);
  }

  // === Grid trader (短期上下取り): GRID_ENABLED=1 で有効. 6 cycle ごとに評価 ===
  if (process.env.GRID_ENABLED === "1" && state.cycleCount % 6 === 0 && !state.paperMode) {
    try {
      const exchange = getExchange();
      const balance = await exchange.getBalance();
      const jpy = balance.find(b => b.currency === "JPY")?.total ?? 0;
      let nav = jpy;
      const tickerMap: Record<string, number> = {};
      for (const p of state.pairs) {
        try {
          const t = await exchange.getTicker(p);
          tickerMap[p] = t.price;
          const base = p.split("/")[0];
          const bal = balance.find(b => b.currency === base);
          if (bal) nav += bal.total * t.price;
        } catch {/* skip */}
      }
      const intel = await getAggregatedIntel().catch(() => null);
      const fgVal = (await getFearGreedIndex().catch(() => ({ value: 50 }))).value;
      const policy = await getCapitalPolicy().catch(() => null);
      const gridCapPercent = Number(process.env.GRID_CAPITAL_PERCENT ?? "15"); // NAV の何 % を grid に
      const ksActive = await isKillSwitchActive();
      if (!ksActive) {
        await runGridCycle({
          nav,
          capitalAvailable: Math.round(nav * (gridCapPercent / 100)),
          pairs: state.pairs,
          fearGreed: fgVal,
          intel,
          tickerMap,
          marketBuy: async (pair, jpyAmount) => {
            try {
              const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
              if (jpyFree < jpyAmount) return { ok: false };
              const order = await exchange.marketBuy(pair, jpyAmount);
              const trade: TradeRecord = {
                id: `grid-${Date.now()}-${pair.replace("/", "")}`,
                timestamp: new Date().toISOString(),
                exchange: "bitflyer",
                pair, side: "buy", type: "market",
                amount: order.amount, price: order.price,
                valueJPY: jpyAmount, orderId: order.id, fee: order.fee ?? 0,
                paperTrade: false,
              };
              state.recentTrades.push(trade);
              state.liveTrades.push(trade);
              await saveData("live-trades", state.liveTrades.slice(-200));
              return { ok: true, fillPrice: order.price, amount: order.amount };
            } catch (e) {
              console.warn(`[grid] ${pair} marketBuy 失敗:`, e instanceof Error ? e.message : e);
              return { ok: false };
            }
          },
          marketSell: async (pair, baseAmount) => {
            try {
              const realPos = await exchange.getPosition(pair);
              if (realPos.free < baseAmount) return { ok: false };
              const order = await exchange.marketSell(pair, Math.min(realPos.free, baseAmount));
              const fillPrice = order.price > 0 ? order.price : (tickerMap[pair] ?? 0);
              const trade: TradeRecord = {
                id: `grid-${Date.now()}-${pair.replace("/", "")}-s`,
                timestamp: new Date().toISOString(),
                exchange: "bitflyer",
                pair, side: "sell", type: "market",
                amount: order.amount, price: fillPrice,
                valueJPY: order.amount * fillPrice, orderId: order.id, fee: order.fee ?? 0,
                paperTrade: false,
              };
              state.recentTrades.push(trade);
              state.liveTrades.push(trade);
              await saveData("live-trades", state.liveTrades.slice(-200));
              return { ok: true, fillPrice, amount: order.amount };
            } catch (e) {
              console.warn(`[grid] ${pair} marketSell 失敗:`, e instanceof Error ? e.message : e);
              return { ok: false };
            }
          },
        });
      }
    } catch (e) {
      console.warn("[grid] cycle 失敗:", e instanceof Error ? e.message : e);
    }
  }

  // === Allocation maintainer: DISABLED (Plan A redesign 2026-05-30) ===
  // 「下落相場で落ちるナイフを掴む」リスクが高く、現在の bot 設計 (5min day trading
  // で edge 出ない構造) のままでは損失加速器になるため停止。
  // 代わりに Weekly DCA baseline (低頻度・規律的) で target ratio に近づける。
  if (false && !state.paperMode && state.cycleCount % 3 === 0) {
    try {
      const exchange = getExchange();
      const balance = await exchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      let cryptoValueJPY = 0;
      const pairScores: { pair: string; compositeScore: number; price: number }[] = [];
      for (const p of state.pairs) {
        try {
          const t = await exchange.getTicker(p);
          const base = p.split("/")[0];
          const bal = balance.find(b => b.currency === base);
          if (bal) cryptoValueJPY += bal.total * t.price;
          // 最新 decision の composite を引き当て
          const lastDec = [...state.decisions].reverse().find(d => d.pair === p);
          const composite = lastDec ? lastDec.confidence - 50 : 0; // confidence 50% = neutral
          pairScores.push({ pair: p, compositeScore: composite, price: t.price });
        } catch { /* skip */ }
      }
      const fgVal = (await getFearGreedIndex().catch(() => ({ value: 50 }))).value;
      const ksActive = await isKillSwitchActive();
      const decision = await evaluateAllocation({
        jpyFree,
        cryptoValueJPY,
        fearGreed: fgVal,
        dailyPnLPercent: state.riskManager.getDailyPnL()?.totalPnLPercent ?? 0,
        killSwitchActive: ksActive,
        pairScores,
      });
      if (decision.shouldBuy && decision.pair && decision.amountJPY) {
        console.log(`[alloc] ${decision.reason}`);
        try {
          const { order, viaMaker } = await executeBuy(exchange, decision.pair, decision.amountJPY);
          const trade: TradeRecord = {
            id: `alloc-${Date.now()}-${decision.pair.replace("/", "")}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair: decision.pair,
            side: "buy",
            type: "market",
            amount: order.amount,
            price: order.price,
            valueJPY: decision.amountJPY,
            orderId: order.id,
            fee: order.fee ?? 0,
            paperTrade: false,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);
          // livePosition に加算 (既存あれば平均化)
          const existing = state.livePositions.get(decision.pair);
          if (existing) {
            const newTotal = existing.amount + order.amount;
            existing.entryPrice = (existing.entryPrice * existing.amount + order.price * order.amount) / newTotal;
            existing.amount = newTotal;
          } else {
            state.livePositions.set(decision.pair, {
              pair: decision.pair,
              entryPrice: order.price,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: 5.0,   // allocation は中期視点で SL 緩め
              takeProfitPercent: 15.0, // TP も大きく
              style: "HOLD",
              styleReason: "allocation maintainer 受動 BUY",
            });
          }
          await recordAllocationEvent({
            timestamp: new Date().toISOString(),
            pair: decision.pair,
            amountJPY: decision.amountJPY,
            price: order.price,
            reason: decision.reason,
          });
          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          console.log(`[alloc] ${decision.pair} BUY ¥${decision.amountJPY.toLocaleString()} @ ¥${order.price.toFixed(0)} ${viaMaker ? "(maker)" : "(taker)"}`);
        } catch (e) {
          console.warn("[alloc] BUY 失敗:", e instanceof Error ? e.message : e);
        }
      } else if (decision.diagnostics.triggered) {
        // 発動条件は満たしたが他の安全弁で stop した場合のログ
        console.log(`[alloc] skip: ${decision.reason} (現金率 ${(decision.diagnostics.cashRatio * 100).toFixed(1)}%)`);
      }
    } catch (e) {
      console.warn("[alloc] cycle 失敗:", e instanceof Error ? e.message : e);
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
    if (!isSellableAmount(exchange, pair, realPos.free, currentPrice)) {
      console.log(`[${pair}] 緊急ロスカット対象だが売却可能数量未満: amount=${realPos.free}`);
      return false;
    }

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
    triggerLossReflection(pair, pnl, pnlPercent, fillPrice, "EMERGENCY").catch(() => {});
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
  // 5分サイクルでも約半年分を保持。全期間チャートはAPI側で均等サンプリングする。
  await saveData("nav-history", history.slice(-50_000));
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

export function getPortfolioRiskOverlay() {
  const dailyPnL = state.riskManager.getDailyPnL();
  const positions = getPositions();
  const cumulative = getCumulativePnL();
  const capitalJPY = cumulative.startCapitalJPY > 0
    ? cumulative.startCapitalJPY
    : dailyPnL.startCapitalJPY;
  return buildPortfolioRiskOverlay({
    positions,
    dailyPnL,
    capitalJPY,
    paperMode: state.paperMode,
    recentDecisions: state.decisions,
  });
}

export async function getEngineAllocations() {
  return state.lastAllocationDetails;
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
