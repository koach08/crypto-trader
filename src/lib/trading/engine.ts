import type { BotStatus, AIDecision, TradeRecord, ProfitConfig } from "../types";
import { DEFAULT_PROFIT_CONFIG } from "../types";
import { getExchange } from "../exchanges/factory";
import { generateCryptoSignal, detectRegime, type MarketRegime } from "../indicators";
import { buildAnalysisPrompt } from "../ai/crypto-prompt";
import { runAllEngines, runSingleEngine, setEnginesPaperMode } from "../ai/engines";
import { buildConsensus } from "../ai/consensus";
import { getFearGreedIndex } from "../ai/fear-greed";
import { RiskManager } from "./risk-manager";
import { PaperTrader } from "./paper-trader";
import { loadData, saveData } from "../data";
import { slippageJPY, summarizeExecutionCosts, allInCostJPY, type ExecutionCost } from "./execution-cost";
import { attributePnL } from "./lane-pnl";
import { riskBudgetedSize } from "./risk-sizing";
import { refreshArchive, flattenArchive } from "./execution-archive";
import { buildEquityCurve, computeDrawdown, computeTradeQuality, evaluateEdgeBudget, INSTITUTIONAL_BENCHMARK } from "./performance-metrics";
import { buildCryptoReturn, buildFundingReport, type CashFlow } from "./cash-flow";
import { runQuantAnalysis, BASELINE_SIGNAL_WEIGHTS, setActiveSignalWeights } from "../quant/signals";
import { calculateFinalDecision } from "../quant/scoring-engine";
import { saveAudit, recordOutcome, getAudits } from "../quant/audit-log";
import { computeLearnedWeights } from "../quant/signal-learning";
import { checkMTFAlignment, checkEdge, calibrateConfidence, computeTrailingStop, checkSentimentEdge } from "./discipline";
import { atr as atrIndicator } from "../indicators";
import { computeLifetimePnL } from "./lifetime";
import { fetchExternalBias } from "../external/investment-app";
import { getAggregatedIntel } from "../intel/aggregator";
import { getOrderBookSignal } from "../quant/orderbook-signal";
import { detectBottomOpportunity, detectTopOpportunity, detectAggressiveReversal } from "../quant/timing";
import { analyzeMultiTimeframe, type MultiTimeframeAnalysis } from "../quant/timeframe-analyzer";
import { classifyPositionStyle } from "./position-style";
import { tryOpenFXLong, checkFXPositionExit } from "./fx-engine";
import { reflectOnLoss } from "../quant/reflection";
import { getActiveLessons, matchLessons, rebuildLessonsFromReflections } from "../quant/lessons";
import { computeAllocations, fractionalKelly, type ForwardSignal, type PairAllocation } from "./capital-allocator";
import { evaluateTier } from "./capital-policy";
import { evaluateKillSwitch, isKillSwitchActive } from "./kill-switch";
import { evaluateTrend, decideByTrend, type TrendState } from "./trend-gate";
import {
  loadCoreConfig,
  planCoreBuy,
  planCoreTakeProfit,
  applyCoreSell,
  applyCoreFill,
  clampCoreToBalance,
  mergeCoreConfig,
  sellableAmount as coreSellableAmount,
  coreAmount,
  coreCostJPY,
  tacticalBasis,
  summarizeCore,
  EMPTY_CORE_STATE,
  type CoreHoldingState,
  type CoreSkip,
  type CoreHoldConfig,
  type CoreConfigOverride,
} from "./core-holding";
import { sendAlert } from "../alerts";
import { checkOpportunities } from "../opportunity-detector";
import { shouldFireCommentary, runDailyCommentary } from "../ai-commentary";
import { getCapitalPolicy } from "./capital-policy";
import { shouldFireDCA, executeDCA } from "./dca";
import { runGridCycle } from "./grid-trader";
import { analyzeLossPatterns } from "../quant/loss-analyzer";
import { getActiveOverrides, runStrategicRetrospective } from "../quant/retrospective";
import { computeAutoGuardrails, getAutoGuardrails, isBlockedHourJST, type AutoGuardrails } from "../quant/auto-guardrails";
import { evaluateAllocation, recordAllocationEvent, computeDynamicTargetCashRatio } from "./allocation-maintainer";
import { decideTargetCashRatio } from "../ai/cash-allocation-ai";
import { sma as smaIndicator } from "../indicators";
import { assessPreTradeRisk, buildPortfolioRiskOverlay } from "./institutional-risk";

/** 古い未約定買い指値を自動キャンセルして資本を解放 (時間命のcrypto向け) */
async function cleanupStaleOpenBuys(maxAgeMinutes = 5) {
  if (state.paperMode) return;
  const exchange = getExchange();
  try {
    await exchange.connect();
    // 取引対象 (state.pairs) だけでなく、過去に発注し得た既知の JPY ペアも sweep する。
    // pair から外れた後に孤児化した買い指値を取りこぼすと現金が永久ロックされるため。
    // ⚠️ SOL/JPY は BitFlyer に存在しない (BadSymbol) ため入れない。
    const KNOWN_JPY_PAIRS = ["BTC/JPY", "ETH/JPY", "XRP/JPY", "XLM/JPY", "MONA/JPY"];
    const pairs = [...new Set([...state.pairs, ...KNOWN_JPY_PAIRS])];
    let canceled = 0;
    for (const pair of pairs) {
      const opens = await exchange.getOpenOrders(pair).catch(() => []);
      for (const o of opens) {
        if (o.side !== 'buy' || !o.id || !o.timestamp) continue;
        const ageMin = (Date.now() - o.timestamp) / 60000;
        if (ageMin > maxAgeMinutes) {
          const ok = await exchange.cancelOrder(o.id, pair).catch(() => false);
          if (ok) {
            canceled++;
            console.log(`[cleanup] canceled stale buy ${pair} id=${o.id} age=${ageMin.toFixed(1)}m`);
          }
        }
      }
    }
    if (canceled > 0) console.log(`[cleanup] ${canceled} stale buy orders canceled`);
  } catch (e) {
    // ignore
  }
}

// 緊急ロスカット閾値（pipelineと無関係に発火）
const EMERGENCY_LOSS_PERCENT = 5.0;

const PAPER_VIRTUAL_CAPITAL_JPY = 1_000_000; // ペーパートレード仮想資金 ¥100万
const PAPER_TRADE_AMOUNT_JPY = 50_000;       // 1回の取引額
const PAPER_MAX_POSITION_JPY = 200_000;      // ペアあたり最大ポジション

// ライブモード設定
const LIVE_MIN_TRADE_JPY = 3_000;            // 最小取引額 ¥3,000 (旧 ¥1,000 だと手数料負けで判断データ取れず)
// 日足トレンドゲート。既定 ON。比較検証したいときだけ TREND_GATE=false で切る
const TREND_GATE_ENABLED = process.env.TREND_GATE !== "false";
// エントリー判断の出所。"trend" = 日足 MA ルール (既定)、"quant" = 旧クオンツ判断
const ENTRY_MODE = process.env.ENTRY_MODE === "quant" ? "quant" : "trend";
// MA ルールの判断は確信度で強弱を測らないので、実行閾値を通る固定値を使う
const TREND_ENTRY_CONFIDENCE = 75;
// バックテストの C+SL8 と同じ: 保険の損切り -8%、利確は事実上使わずトレンド割れで撤退
const TREND_ENTRY_SL_PERCENT = Number(process.env.TREND_ENTRY_SL_PERCENT ?? "8");
const TREND_ENTRY_TP_PERCENT = Number(process.env.TREND_ENTRY_TP_PERCENT ?? "30");
// 1 回の取引で失ってよい額 (総資産に対する割合)。損切り幅ではなくこちらを固定する。
const RISK_FRACTION_PER_TRADE = Number(process.env.RISK_FRACTION_PER_TRADE ?? "0.01");
// 実績連動の判定に使う直近の決済件数。全期間平均だと、設定を変えた後の成績が
// 変える前の大量のサンプルに埋もれる。
const EDGE_WINDOW_TRADES = Number(process.env.EDGE_WINDOW_TRADES ?? "30");
const EDGE_MIN_SAMPLES = Number(process.env.EDGE_MIN_SAMPLES ?? "20");
// 売買が発生しないサイクルで AI 照会を省く (課金抑制)。SKIP_AI_WHEN_IDLE=false で無効化
const SKIP_AI_WHEN_IDLE = process.env.SKIP_AI_WHEN_IDLE !== "false";
const LIVE_BASE_TRADE_JPY = Number(process.env.LIVE_BASE_TRADE_JPY || 15000); // 1回あたり目安サイズ（ユーザ設定可能）
const LIVE_MAX_POSITION_JPY = Math.max(30000, LIVE_BASE_TRADE_JPY * 2); // ペアあたり最大ポジション
// 確信度閾値: 50 (2026-05-30 再設定、user 指示「自由に取引しろ」)
const PROFIT_MODE = process.env.PROFIT_MODE === '1' || process.env.PROFIT_MODE === 'true';
const LIVE_CONFIDENCE_THRESHOLD = PROFIT_MODE ? 42 : 50;

// DCA 無効化 (2026-05-31, user 指示「動作する形にしてくれればもうそれでよい」)。
// HOLD時に買い続ける構造が "売れない bot" の主因 + 損失加速の原因。
const DCA_ENABLED = false;
const DCA_AMOUNT_JPY = 1000;       // HOLD 時に積立する金額 (小さく開始)
const DCA_INTERVAL_CYCLES = 12;    // 12 cycle (60min) ごとに DCA 発火

// === Swing モード (2026-06-01) ===
// user pushback「retail 勝てない前提は研究にならない、動作する trader を作れ」を受け、
// 168h を 24h に緩和。日内 churn だけ防ぎ、AI が swing trade で勝てるか実検証可能にする。
const MIN_HOLD_HOURS = PROFIT_MODE ? 6 : 24;  // PROFIT_MODE でより頻繁にトレード可能に

// === Profit Config (UIで編集可能・販売版でコンスタント利益重視) ===
let _profitConfigCache: ProfitConfig | null = null;

async function getProfitConfig(): Promise<ProfitConfig> {
  if (_profitConfigCache) return _profitConfigCache;
  try {
    const saved = await loadData<ProfitConfig>("profit-config", DEFAULT_PROFIT_CONFIG);
    // env override still wins if explicitly set (for power users)
    const envTp = process.env.PROFIT_TP_PERCENT ? parseFloat(process.env.PROFIT_TP_PERCENT) : null;
    const envSl = process.env.PROFIT_SL_PERCENT ? parseFloat(process.env.PROFIT_SL_PERCENT) : null;
    const envDaily = process.env.DAILY_TARGET_PERCENT ? parseFloat(process.env.DAILY_TARGET_PERCENT) : null;
    _profitConfigCache = {
      dailyTargetPercent: envDaily ?? saved.dailyTargetPercent,
      tpPercent: envTp ?? saved.tpPercent,
      slPercent: envSl ?? saved.slPercent,
      minConfidence: saved.minConfidence,
    };
    return _profitConfigCache;
  } catch {
    return DEFAULT_PROFIT_CONFIG;
  }
}

// 同期的に使いたい場所向けのキャッシュ済み値（初回はデフォルト）
let _syncProfit: ProfitConfig = DEFAULT_PROFIT_CONFIG;
getProfitConfig().then(c => { _syncProfit = c; }).catch(() => {});

/**
 * レジーム適応 TP/SL: 相場タイプで利確/損切幅を変える。
 * - TRENDING_UP: 利を伸ばす (TP 広め, SL 標準)
 * - TRENDING_DOWN: 警戒 (TP 浅め, SL 浅め)
 * - VOLATILE: SL 広めにしないとノイズで切られる
 * - RANGING: scalp (TP 浅め, SL 浅め) — 何度も拾う
 */
async function regimeAdjustedTpSl(regime: MarketRegime): Promise<{ tp: number; sl: number }> {
  const cfg = await getProfitConfig();
  const baseTp = cfg.tpPercent;
  const baseSl = cfg.slPercent;

  // 販売版「コンスタント利益」ベースで調整
  // ユーザーの「毎日少しずつ確実に」のために、ベースを尊重しつつ相場で伸ばす
  switch (regime) {
    case "TRENDING_UP":   return { tp: Math.max(baseTp * 1.6, 3.5), sl: baseSl * 0.9 };
    case "TRENDING_DOWN": return { tp: baseTp * 0.9, sl: baseSl };
    case "VOLATILE":      return { tp: baseTp * 1.2, sl: baseSl * 1.4 };
    case "RANGING":       return { tp: Math.max(baseTp * 0.7, 1.2), sl: Math.max(baseSl * 0.6, 0.35) };
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
  /** 高速 TP/SL 監視ループ (AI を呼ばない) */
  fastMonitorId: ReturnType<typeof setInterval> | null;
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
  /**
   * ペアごとの直近の日足トレンド判定 (dashboard 表示用)。
   * 下降トレンド中は新規 BUY を出さない設計なので、「取引していない」が
   * 不具合ではなく判断の結果だと画面から分かるようにする。
   */
  trendByPair: Map<string, TrendState & { at: string }>;
  /**
   * ペアごとの直近価格。ポジション表示とリスク計算に使う。
   * これが無かったため getPositions() が常に currentPrice=0 / valueJPY=0 を返し、
   * 画面上のポジションが「評価額 ¥0」に見えていた (リスク計算も 0 で走っていた)。
   */
  lastPriceByPair: Map<string, { price: number; at: string }>;
  /**
   * コア保有 (売らない長期枠)。トレンドゲートで新規 BUY が止まっている間も
   * ここだけは目標比率まで積む。売却経路は必ずこの数量を残す。
   */
  coreHolding: CoreHoldingState;
  /** 執行コストの記録 (発注直前の中値と実約定値の差)。直近 MAX_COST_RECORDS 件 */
  executionCosts: ExecutionCost[];
  /** 直近サイクルで計算した ATR。高速監視がトレーリング SL を更新するのに使う */
  lastATRByPair: Map<string, number>;
  /** 直近サイクルで実測した総資産。リスク判定の資本基準に使う */
  lastNavJPY: number;
  /**
   * 取引所の約定履歴から出した実績。**確定損益はこちらを正とする**。
   * アプリ側の liveTrades から出した pnl は、建玉の取得単価に複数のバグが
   * あった (コア枠の混入 / 端数を分母にした発散) ため信用できない。
   * 実際、同じ画面に「決済188回 WR34% / -¥5,256」と
   * 「決済128回 WR38% / -¥11,583」が並んでいた。
   */
  exchangePnL: {
    realizedJPY: number;
    closedTrades: number;
    wins: number;
    losses: number;
    buyVolumeJPY: number;
    sellVolumeJPY: number;
    grossProfitJPY: number;
    grossLossJPY: number;
    /** 直近 EDGE_WINDOW_TRADES 件の決済損益 (実績連動の資金配分に使う) */
    recentCloses: number[];
    at: string;
  } | null;
  /** 画面から変更したコア設定 (env 既定に重ねる) */
  coreConfigOverride: CoreConfigOverride | null;
  /** 直近のコア積立判断 (画面に「なぜ積んでいないか」を出すため) */
  lastCoreSkip: (CoreSkip & { at: string }) | null;
}

const state: EngineState = {
  running: false,
  paperMode: true,
  intervalId: null,
  fastMonitorId: null,
  cycleCount: 0,
  lastCycleTimestamp: null,
  pairs: ["BTC/JPY", "ETH/JPY", "XRP/JPY"], // 実用性重視: 流動性高めの主要ペアのみ。MONA/XLM等は手動追加推奨
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
  trendByPair: new Map(),
  lastPriceByPair: new Map(),
  coreHolding: { lots: [], lastBuyAt: {} },
  executionCosts: [],
  lastATRByPair: new Map(),
  lastNavJPY: 0,
  exchangePnL: null,
  coreConfigOverride: null,
  lastCoreSkip: null,
};

/** env 既定 + 画面で保存した設定。コア関連は必ずここから読む。 */
function currentCoreConfig(): CoreHoldConfig {
  return mergeCoreConfig(loadCoreConfig(), state.coreConfigOverride);
}

/**
 * 売却可能数量。取引所の実残高からコア確保分を必ず差し引く。
 *
 * ⚠️ 売却系は全部ここを通すこと。`realPosition.free` を直接売ると長期枠ごと投げ売る。
 * (過去に「判断ロジックだけ直して発注経路が素通り」を踏んでいる)
 */
function sellableFree(pair: string, exchangeFree: number): number {
  return coreSellableAmount(state.coreHolding, pair, exchangeFree);
}

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
const MAX_COST_RECORDS = 2000;

/** 円の free 残高。全部込みコストの実測に使う。取れなければ NaN。 */
async function jpyFreeNow(exchange: import("../exchanges/types").IExchange): Promise<number> {
  try {
    const bal = await exchange.getBalance();
    return bal.find((b) => b.currency === "JPY")?.free ?? NaN;
  } catch {
    return NaN;
  }
}

/** 発注直前の中値。bid/ask が無ければ last で代用する。 */
async function refMidPrice(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
): Promise<number> {
  try {
    const t = await exchange.getTicker(pair);
    if (t?.bid && t?.ask && t.bid > 0 && t.ask > 0) return (t.bid + t.ask) / 2;
    return t?.price ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 執行コストを1件記録する。判断の良し悪しとは別に、
 * 「中値に対していくら払ったか」をここだけで持つ。
 */
async function recordExecutionCost(
  pair: string,
  side: "buy" | "sell",
  order: import("../types").OrderResult,
  refMid: number,
  viaMaker: boolean,
  lane: "core" | "tactical",
  jpyBefore?: number,
  jpyAfter?: number,
): Promise<void> {
  const fillPrice = order.price > 0 ? order.price : refMid;
  const amountBase = order.amount ?? 0;
  if (!(amountBase > 0) || !(fillPrice > 0) || !(refMid > 0)) return;
  const rec: ExecutionCost = {
    at: new Date().toISOString(),
    pair,
    side,
    amountBase,
    fillPrice,
    refMid,
    notionalJPY: amountBase * fillPrice,
    slippageJPY: slippageJPY(side, fillPrice, refMid, amountBase),
    viaMaker,
    lane,
    allInCostJPY:
      jpyBefore !== undefined && jpyAfter !== undefined
        ? allInCostJPY({ side, jpyBefore, jpyAfter, amountBase, fillPrice })
        : undefined,
  };
  state.executionCosts.push(rec);
  if (state.executionCosts.length > MAX_COST_RECORDS) {
    state.executionCosts = state.executionCosts.slice(-MAX_COST_RECORDS);
  }
  console.log(
    `[cost] ${pair} ${side} ${viaMaker ? "maker" : "taker"} 中値 ¥${refMid.toFixed(2)} → 約定 ¥${fillPrice.toFixed(2)} ` +
      `不利分 ¥${rec.slippageJPY.toFixed(1)} (${((rec.slippageJPY / rec.notionalJPY) * 100).toFixed(3)}%)` +
      (rec.allInCostJPY !== undefined
        ? ` / 実測コスト ¥${rec.allInCostJPY.toFixed(1)} (${((rec.allInCostJPY / rec.notionalJPY) * 100).toFixed(3)}%)`
        : " / 実測コスト 取得できず")
  );
  await saveData("execution-costs", state.executionCosts);
}

async function executeBuy(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
  amountJPY: number,
  lane: "core" | "tactical" = "tactical",
): Promise<{ order: import("../types").OrderResult; viaMaker: boolean }> {
  const refMid = await refMidPrice(exchange, pair);
  const jpyBefore = await jpyFreeNow(exchange);
  if (USE_MAKER_ONLY && exchange.limitBuyMakerOnly) {
    const makerOrder = await exchange.limitBuyMakerOnly(pair, amountJPY, MAKER_TIMEOUT_MS);
    if (makerOrder) {
      await recordExecutionCost(pair, "buy", makerOrder, refMid, true, lane, jpyBefore, await jpyFreeNow(exchange));
      return { order: makerOrder, viaMaker: true };
    }
    console.log(`[${pair}] maker BUY timeout → 成行フォールバック`);
  }
  const order = await exchange.marketBuy(pair, amountJPY);
  await recordExecutionCost(pair, "buy", order, refMid, false, lane, jpyBefore, await jpyFreeNow(exchange));
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
  lane: "core" | "tactical" = "tactical",
): Promise<{ order: import("../types").OrderResult; viaMaker: boolean }> {
  const refMid = await refMidPrice(exchange, pair);
  const jpyBefore = await jpyFreeNow(exchange);
  if (!forceMarket && USE_MAKER_ONLY && exchange.limitSellMakerOnly) {
    // メイカー指値で失敗しても売り自体を落とさない。ここで throw が抜けると
    // SL / 利確が発注されないまま終わる。
    try {
      const makerOrder = await exchange.limitSellMakerOnly(pair, amountBase, MAKER_TIMEOUT_MS);
      if (makerOrder) {
        await recordExecutionCost(pair, "sell", makerOrder, refMid, true, lane, jpyBefore, await jpyFreeNow(exchange));
        return { order: makerOrder, viaMaker: true };
      }
      console.log(`[${pair}] maker SELL timeout → 成行フォールバック`);
    } catch (e) {
      console.log(`[${pair}] maker SELL 失敗 (${e instanceof Error ? e.message : "unknown"}) → 成行フォールバック`);
    }
  }
  const order = await exchange.marketSell(pair, amountBase);
  await recordExecutionCost(pair, "sell", order, refMid, false, lane, jpyBefore, await jpyFreeNow(exchange));
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

/**
 * SL 発動ラインを「エントリーからの変動率」に変換する。
 *
 * ⚠️ 保存されている stopLossPercent は "エントリーから何 % 下か" を **正の数** で持つ仕様
 * (regimeAdjustedTpSl / position-style / discipline.ts が全てこの向き)。
 * 一方 PTP や trailing が利益側にロックした場合だけ負値になり「エントリーから何 % 上」を意味する。
 * したがって発動ラインは常に符号反転した値になる。
 *   保存 +0.35 → 変動が -0.35% 以下で損切り
 *   保存 -5.0  → 変動が +5.0% 以下に後退したら利確保護で決済
 *
 * 【重要】以前はここを反転せず `changePercent <= stopLossPercent` で比較していたため、
 * 変動 0% でも `0 <= +0.35` が成立し、買った次のサイクルでほぼ必ず "stop_loss" が発動していた。
 * 損切りが効かないのではなく「1時間後に相場がどこにいても投げる」動作になり、
 * -3% でも -5% でもそのまま損失確定していた (損失の 98% が 1.5% 超だった原因)。
 */
export function slTriggerPercent(storedStopLossPercent: number): number {
  return -storedStopLossPercent;
}

/**
 * TP/SL 決済の実行本体。メインサイクルと高速監視ループの両方から呼ぶ共通処理。
 * ペア単位ロックで二重売却を防ぐ (両ループが同時に同じポジションを売らないため)。
 */
const exitLocks = new Set<string>();

async function closeLivePositionAtExit(
  exchange: import("../exchanges/types").IExchange,
  pair: string,
  sellAmountBase: number,
  referencePrice: number,
  triggerType: "stop_loss" | "take_profit",
): Promise<boolean> {
  if (exitLocks.has(pair)) return false;
  exitLocks.add(pair);
  try {
    // ロック取得後に再確認 (待っている間に他方が決済済みかもしれない)
    const livePos = state.livePositions.get(pair);
    if (!livePos) return false;

    // SL は緊急性高い → 成行強制。TP は maker 試行 → timeout で成行フォールバック。
    const { order } = await executeSell(exchange, pair, sellAmountBase, triggerType === "stop_loss");
    // BitFlyer (ccxt) は order.average を 0 で返すことがある。参照価格で代替。
    const fillPrice = order.price > 0 ? order.price : referencePrice;
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
    // 負けトレードなら AI 振り返り → ルール抽出 (学習機能。消さない)
    triggerLossReflection(pair, pnl, pnlPercent, fillPrice, triggerType).catch(() => {});
    return true;
  } catch (e) {
    console.error(`[${pair}] LIVE ${triggerType.toUpperCase()} 失敗:`, e);
    return false;
  } finally {
    exitLocks.delete(pair);
  }
}

/**
 * 高速 TP/SL 監視ループ: 価格取得のみで AI を一切呼ばない (課金増やさない)。
 *
 * 【なぜ必要か】判断サイクルは 1 時間間隔だが、TP/SL もそこでしか評価されないと
 * SCALP の SL 0.6% は「1 時間に 1 回しか見ない損切り」になり全く機能しない。
 * 実績で 24h TP 0 回 / SL 6 回、損失の 98% が名目 0.6% を大きく超える 1.5%+ になっていた。
 * ここで分単位に監視することで、初めて損切り幅が設計値どおりに効く。
 */
async function monitorPositionsFast(): Promise<void> {
  if (!state.running || state.paperMode) return;
  if (state.livePositions.size === 0) return;

  const exchange = getExchange();
  try {
    await exchange.connect();
  } catch {
    return;
  }

  for (const [pair, livePos] of Array.from(state.livePositions.entries())) {
    if (exitLocks.has(pair)) continue;
    if (typeof livePos.stopLossPercent !== "number" || typeof livePos.takeProfitPercent !== "number") continue;
    try {
      const ticker = await exchange.getTicker(pair);
      if (!ticker?.price || ticker.price <= 0) continue;
      state.lastPriceByPair.set(pair, { price: ticker.price, at: new Date().toISOString() });

      // 【非対称性の解消】損切りは 1 分ごとに発火するのに、トレーリング SL の
      // 引き上げは通常サイクル (既定 1 時間) でしか走っていなかった。
      // 含み益が出ても次サイクルまで SL が動かないので、上振れ後に反落すると
      // ブレイクイーブンにできたはずの玉が元の SL まで落ちる。
      // 損失側だけ速い状態が、平均損失 > 平均利益を作る一因になっていた。
      const cachedATR = state.lastATRByPair.get(pair) ?? 0;
      if (cachedATR > 0 && typeof livePos.stopLossPercent === "number") {
        const trail = computeTrailingStop({
          entryPrice: livePos.entryPrice,
          currentPrice: ticker.price,
          atr: cachedATR,
          currentStopLossPercent: livePos.stopLossPercent,
          breakevenTriggerPercent: 1.0,
          trailFactor: 1.0,
        });
        if ((trail.movedToBreakeven || trail.trailing) && trail.newStopLossPercent !== livePos.stopLossPercent) {
          const oldSL = livePos.stopLossPercent;
          livePos.stopLossPercent = trail.newStopLossPercent;
          console.log(`[${pair}] 高速監視トレーリングSL: ${oldSL.toFixed(2)}% → ${trail.newStopLossPercent.toFixed(2)}% (${trail.reason})`);
          await saveData("live-positions", Array.from(state.livePositions.values()));
        }
      }

      const changePercent = ((ticker.price - livePos.entryPrice) / livePos.entryPrice) * 100;
      let triggerType: "stop_loss" | "take_profit" | null = null;
      if (changePercent <= slTriggerPercent(livePos.stopLossPercent)) triggerType = "stop_loss";
      else if (changePercent >= livePos.takeProfitPercent) triggerType = "take_profit";
      if (!triggerType) continue;

      // 部分利確が残っている場合はメインサイクルに任せる (段階利確ロジックを壊さない)
      const ptpRemaining =
        livePos.partialTakeProfits && livePos.partialTakeProfits.length > (livePos.ptpTriggeredCount ?? 0);
      if (triggerType === "take_profit" && ptpRemaining) continue;

      const balances = await exchange.getBalance();
      const base = pair.split("/")[0];
      // コア枠を除いた売却可能数量。長期枠は高速監視の SL/TP でも売らない。
      const free = sellableFree(pair, balances.find(b => b.currency === base)?.free ?? 0);
      if (!isSellableAmount(exchange, pair, free, ticker.price)) continue;

      console.log(`[${pair}] 高速監視 ${triggerType} 検知: ${changePercent.toFixed(2)}% (SL ${livePos.stopLossPercent}% / TP ${livePos.takeProfitPercent}%)`);
      await closeLivePositionAtExit(exchange, pair, free, ticker.price, triggerType);
    } catch {
      // 個別ペアの失敗で監視全体を止めない
    }
  }
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
      // コア保有 (売らない長期枠) を復元。ここが空だと全量が売却可能扱いになるので、
      // 再起動時に必ず読み直す。
      state.coreConfigOverride = await loadData<CoreConfigOverride | null>("core-config", null);
      state.executionCosts = await loadData<ExecutionCost[]>("execution-costs", []);
      if (!Array.isArray(state.executionCosts)) state.executionCosts = [];
      state.coreHolding = await loadData<CoreHoldingState>("core-holding", EMPTY_CORE_STATE);
      if (!state.coreHolding?.lots) state.coreHolding = { lots: [], lastBuyAt: {} };
      const coreLots = state.coreHolding.lots.length;
      if (coreLots > 0) {
        console.log(`[core] コア保有 ${coreLots} ロット復元`);
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
    // 日足は 250 本。MA200 を計算してトレンドゲート (evaluateTrend) に使う
    exchange.getOHLCV(pair, "1d", 250).catch(() => emptyBars),
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

  if (ticker?.price > 0) {
    state.lastPriceByPair.set(pair, { price: ticker.price, at: new Date().toISOString() });
  }

  // 日足トレンドは毎サイクル評価して保持する。BUY ゲートの判定と、
  // 「なぜ取引していないのか」を画面に出すための両方に使う。
  const dailyTrend = evaluateTrend(dailyBars);
  if (dailyTrend) {
    state.trendByPair.set(pair, { ...dailyTrend, at: new Date().toISOString() });
  } else {
    state.trendByPair.delete(pair);
  }
  console.log(`[${pair}] 日足トレンド: ${dailyTrend ? `${dailyTrend.upTrend ? "上昇" : "上昇でない"} (${dailyTrend.label})` : "判定不能"}`);

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
  //
  // 【コスト】MA ルール運用中 (ENTRY_MODE=trend) は、入る/出るの判断に AI を使わない。
  // それでも毎サイクル 5 ペア分の LLM を呼ぶと、判断に使わない出力に課金し続けることになる
  // (1 サイクル 5-15 回 × 24 サイクル/日)。運用コストはそのまま損益を削る。
  // そこで「MA ルールの結論が HOLD = 何もしない」サイクルでは AI 照会を省く。
  // 実際に売買するサイクルでは従来どおり呼び、監査ログと学習の材料を残す。
  // コア枠は「売らない長期枠」なので、MA ルールの保有判定には数えない。
  // 数えるとコアを積んだ瞬間に「保有あり」となり、戦術枠が新規に買えなくなる。
  const tacticalAmount = Math.max(0, position.amount - coreAmount(state.coreHolding, pair));
  const maPreview = ENTRY_MODE === "trend"
    ? decideByTrend(dailyTrend, tacticalAmount * ticker.price >= 500)
    : null;
  const skipAI = maPreview !== null && maPreview.action === "HOLD" && SKIP_AI_WHEN_IDLE;

  const useFull = signal.score >= -1 && signal.score <= 1; // borderline
  let decision: AIDecision;
  if (skipAI) {
    const stub: import("../types").EngineResult = {
      engine: "claude",
      status: "success",
      action: "HOLD",
      confidence: 50,
      summary: "MA ルール運用中かつ売買不要のサイクルのため AI 照会を省略 (課金抑制)",
      duration: 0,
    };
    decision = buildConsensus([stub], pair, "bitflyer", signal.score, fearGreed.value, state.paperMode);
  } else if (useFull) {
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

  // Orderbook microstructure (pro signal - 板の買い/売り圧力)
  let bookBias: { score: number; reason: string } | null = null;
  try {
    const liveEx = getExchange();
    const ob = await getOrderBookSignal(liveEx, pair, ticker.price);
    if (ob.available) {
      bookBias = { score: ob.score, reason: ob.reason };
    }
  } catch (e) {
    console.warn(`[${pair}] orderbook signal failed:`, e instanceof Error ? e.message : e);
  }

  // LLMの判断を「アドバイザーの1人」として、統計的シグナルと合議で最終判断
  const quantAnalysis = runQuantAnalysis(bars);

  // === Pro optimization: LLM pre-filter (コストとレイテンシ削減) ===
  // 明らかにエッジがない/強い場合は LLM フルコール前に早期決定
  const bookSig = bookBias ? bookBias.score : 0;
  const earlyScore = (quantAnalysis.compositeScore * 0.5) + (bookSig * 0.3) + (signal.score * 10 * 0.2);
  if (Math.abs(earlyScore) > 25 && Math.abs(bookSig) > 12) {
    // 強い合意 → 軽量 single engine だけで済ます (proでも十分なケース多数)
    console.log(`[${pair}] early strong signal (score=${earlyScore.toFixed(0)}), using single engine for cost`);
  }

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
    bookBias,
    scalpMode: PROFIT_MODE || regime === 'RANGING',  // PROFIT_MODE でより積極的に動く
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
  const bypassMtfCheck = false;

  // 2026-05-31: 底打ち override / aggressive reversal override は無効化。
  // 昨日 -60% drawdown の主因 (BTC を 14期間安値で 86% conf 連続 BUY = 落ちるナイフを掴む)。
  // 「落ちたら買う」は構造的に retail crypto では機能しないことが学術的にも確認済み。
  // 天井 SELL override のみ残す (利確側はリカバリー寄り)。
  if (bottomOp.fire) {
    console.log(`[${pair}] 🔻 底打ち検出 (${bottomOp.confidence}%) → override 無効化中 (swing モード)`);
  }
  if (reversalOp.fire) {
    console.log(`[${pair}] 📈 反転検出 (${reversalOp.confidence}%) → override 無効化中 (swing モード)`);
  }
  if (topOp.fire && decision.action !== "SELL") {
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
    // 2026-05-31: MTF 底値仕込み override も無効化 (落ちるナイフ問題)。
    // 天井利確 override のみ残す (利確はリカバリー寄り)。
    if (mtf.topTaking && decision.action !== "SELL") {
      console.log(`[${pair}] 🔝 MTF 天井利確 → SELL override: ${mtf.reason}`);
      decision.action = "SELL";
      decision.confidence = 80;
      decision.reason = `[MTF天井 ${mtf.consensus}] 短${mtf.short.label} 中${mtf.medium.label} 長${mtf.long.label}`;
    }
  }

  // === FX レバ (BTC/JPY のみ): 既存ポジションの TP/SL チェックのみ ===
  // 2026-05-31: 底打ち FX LONG エントリーは無効化 (swing モード、落ちるナイフ防止)
  if (pair === "BTC/JPY") {
    await checkFXPositionExit(ticker.price).catch(e => console.warn("[fx] check 失敗:", e));
  }

  // === 取引規律フィルタ群（Alpha Arena 教訓） ===
  // 勝ち取引の率を上げるため、期待値マイナスの取引を排除する
  const disciplineNotes: string[] = [];

  // === エントリー判断: MA ルール (ENTRY_MODE=trend、既定) ===
  //
  // 【根拠】2026-08-17 のバックテスト (3ペア × 3期間 = 9条件、手数料+スリッページ込み)。
  //   クオンツ + AI + F&G 一式 (V0)          平均 -17.5%  … 9条件すべてマイナス
  //   日足 MA50/200 だけ + SL8% (C+SL8)      平均 +23.7%
  // クオンツ側のエントリー信号にはエッジが確認できなかった (F&G 条件を外して
  // 順張り可にした V3 も -2.6%)。逆に MA ルールだけは 9条件中 6条件で buy&hold にも勝った。
  // したがって**入る/出るの判断は MA ルールに任せ**、クオンツ・AI・F&G は
  // エントリー判断から降ろす。学習系・監査ログ・リスクゲートはそのまま動かす。
  //
  // ⚠️ 「確実に勝つ」ものではない。同じ 9条件で最悪の年は -26.9%、
  //    MA を 30/150 にすると平均 -9.5% まで落ちる。頑健なエッジではなく
  //    「現行より確実にマシ」という位置づけ。だから SL とキルスイッチは残す。
  //
  // ENTRY_MODE=quant で元のクオンツ判断に戻せる。
  // 保有判定は取引所の実残高で見る (追跡漏れがあっても二重に買わないため)。
  // ただしダスト (< ¥500) は「保有」に数えない。数えると売れない残骸のせいで
  // そのペアが永久に買えなくなる (過去に ¥0.17 の XRP 残骸が発生している)。
  const holdsPosition = state.paperMode
    ? (state.paperTrader.getPosition(pair)?.amount ?? 0) > 0
    : tacticalAmount * ticker.price >= 500;
  const trendEntryOverride = ENTRY_MODE === "trend";
  if (trendEntryOverride) {
    const td = decideByTrend(dailyTrend, holdsPosition);
    decision.action = td.action;
    decision.reason = td.reason;
    if (td.action !== "HOLD") {
      decision.confidence = TREND_ENTRY_CONFIDENCE;
    }
    if (td.action === "BUY") {
      decision.suggestedStopLossPercent = TREND_ENTRY_SL_PERCENT;
      decision.suggestedTakeProfitPercent = TREND_ENTRY_TP_PERCENT;
    }
    disciplineNotes.push("[エントリー] MA ルール判断 (クオンツ/F&G/EV は参照のみ)");
  }

  // 1. 信頼度キャリブレーション: 過去の判断と実績から確信度を補正
  // (MA ルール判断のときは確信度が判断根拠ではないので補正しない)
  if (decision.action !== "HOLD" && !trendEntryOverride) {
    const allAudits = await getAudits(500).catch(() => []);
    const cal = calibrateConfidence(allAudits, decision.confidence);
    if (cal.calibrated !== cal.raw) {
      decision.confidence = cal.calibrated;
      disciplineNotes.push(`[補正] ${cal.reason}`);
    }
  }

  // 1.2. 日足トレンドゲート: 上位トレンドに逆らう新規 BUY を止める
  //
  // 【根拠】2026-08-17 のバックテスト実測 (3ペア × 3期間 = 9条件)。
  // 現行のクオンツ + F&G 逆張りは 9条件すべてマイナス (平均 -17.5%)、
  // BTC/JPY 直近1年は 7戦0勝7敗。エントリー理由は毎回「F&G 恐怖 → 逆張り買い」で、
  // 下降トレンドで落ちるナイフを掴み続けていた。
  // 同条件で「日足 MA50/200 が上向きの時だけロング」した対照群は平均 +24.1%。
  // ここは方向を直すゲートであって、サイズや TP/SL には触らない。
  //
  // TREND_GATE=false で無効化できる (検証・比較用)。
  // (MA ルール判断のときは同じトレンドで既に決めているので二重判定しない)
  if (decision.action === "BUY" && TREND_GATE_ENABLED && !trendEntryOverride) {
    const trend = dailyTrend;
    if (!trend) {
      // 日足が取れないときは判断材料が無い。既定は「見送り」で資金を守る。
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
      disciplineNotes.push(`[トレンド] 日足バー不足 (${dailyBars?.length ?? 0}本) で判定不能 → BUY 見送り`);
    } else if (!trend.upTrend) {
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
      disciplineNotes.push(`[トレンド] 日足が上昇トレンドでない (${trend.label}) → BUY 見送り`);
    } else {
      disciplineNotes.push(`[トレンド] 日足 上昇トレンド (${trend.label})${trend.degraded ? " ※簡易判定" : ""}`);
    }
  }

  // 1.5. F&G フィルタ 再有効化 (2026-05-30, user 指示「全 feature 動かす」)
  // BUY 時は Fear 帯 (≤35) を要求、SELL 時は Greed 帯 (≥65) を要求
  // ⚠️ この F&G 条件こそが「BUY には恐怖 (≤35) が必要」= 逆張り専用機の正体だった。
  //    上げ相場の F&G は 50-75 なので、上昇トレンドでは 1 本も買えなくなる。
  //    MA ルール判断のときは適用しない (参照として理由だけ残す)。
  if (decision.action !== "HOLD") {
    const sentimentCheck = checkSentimentEdge(fearGreed.value, decision.action);
    disciplineNotes.push(`[F&G] ${sentimentCheck.reason}${trendEntryOverride ? " (MAルールのため不適用)" : ""}`);
    if (!sentimentCheck.passed && !trendEntryOverride) {
      decision.action = "HOLD";
      decision.confidence = Math.min(decision.confidence, 40);
      disciplineNotes.push(`[F&G] フィルタで HOLD 化`);
    }
  }

  // 2. マルチタイムフレーム整合性: h1の判断がh4トレンドと逆なら見送り
  //    MTF は警告のみで block しない (旧設計: 下降トレンド逆張りを全部潰してた).
  //    判断は score 側 (Quant + Tech) に任せ、MTF は disciplineNotes に記録するのみ.
  //    例外: confidence 50% 未満 + MTF 不一致 = 弱い判断 → HOLD (両方妥当な場合のみ却下)
  if (decision.action !== "HOLD" && !trendEntryOverride) {
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
  // (MA ルールは勝率推定を前提にしないので適用しない。EV 式が要求する
  //  「確信度=勝率」という仮定が成り立たないため、掛けると常に落ちてしまう)
  if (decision.action !== "HOLD" && !trendEntryOverride) {
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
      let tradeAmount = state.riskManager.calculatePositionSizeJPY(
        decision.confidence,
        totalCapital,
        currentPositionJPY,
        PAPER_MAX_POSITION_JPY,
      ) * (decision.institutionalRisk?.sizeMultiplier ?? 1);

      // Paperでもコンスタント利益grindを適用
      const dailyForPaper = state.riskManager.getDailyPnL();
      const pcfg = _syncProfit;
      const pTarget = (dailyForPaper.startCapitalJPY || totalCapital) * pcfg.dailyTargetPercent / 100;
      const pProgress = pTarget > 0 ? dailyForPaper.realizedPnL / pTarget : 0;
      if (pProgress > 0.9) tradeAmount *= 0.25;
      else if (pProgress > 0.7) tradeAmount *= 0.5;
      else if (pProgress > 0.4) tradeAmount *= 0.8;

      if (tradeAmount > 0) {
        const trade = await state.paperTrader.executeBuy(pair, tradeAmount, ticker, decision);
        state.recentTrades.push(trade);
        console.log(`[${pair}] PAPER BUY: ¥${Math.round(tradeAmount).toLocaleString()}`);
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
    // コア枠 (売らない長期枠) を除いた、戦術枠として売却できる数量。
    // 以降の SELL / SL / TP / PTP は全てこの値を使う。取引所残高をそのまま売ると
    // 「上昇しないなら仮想通貨で持っておく」ために積んだ分まで投げてしまう。
    const sellableNow = sellableFree(pair, realPosition.free);
    const coreHeld = coreAmount(state.coreHolding, pair);
    const currentPositionJPY = Math.max(0, realPosition.amount - coreHeld) * ticker.price;

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
    const baseTpSl = await regimeAdjustedTpSl(regime);
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
    // ⚠️ ダスト (最小注文額未満の残骸) では再構築しない。
    //    起動時の reconcile が「dust → livePositions から除外」した直後に、ここが
    //    同じサイクルで作り直していたため、¥58 や ¥46 の残骸が毎サイクル復活し、
    //    画面には評価額 ¥0 のポジションとして並び、高速監視ループと緊急ロスカットが
    //    毎分それをポーリングして「売却可能数量未満」を出し続けていた。
    //    コアのみのペアも同様に戦術ポジションではないので作らない (sellableNow で控除済み)。
    if (
      !livePos &&
      realPosition.amount > 0 &&
      ticker.price > 0 &&
      isSellableAmount(liveExchange, pair, sellableNow, ticker.price)
    ) {
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

      // 取引所の約定履歴にはコア積立も混ざっている。コア台帳の数量と原価を
      // 差し引いて、戦術枠だけのポジションとして復元する。
      const basis = tacticalBasis({
        exchangeAmount: realPosition.amount,
        fifoAvgPrice: trueAvgPrice,
        coreAmountBase: coreAmount(state.coreHolding, pair),
        coreCostJPY: coreCostJPY(state.coreHolding, pair),
        minAmountBase: liveExchange.getMinOrderJPY
          ? (liveExchange.getMinOrderJPY(pair, ticker.price) / 1.1) / Math.max(ticker.price, 1e-9)
          : 0,
      });
      const reconstructed: LivePositionEntry = {
        pair,
        entryPrice: basis?.avgPrice ?? trueAvgPrice,
        amount: basis?.amount ?? realPosition.amount,
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
    // ズレ検知はコアを除いた戦術枠の数量どうしで比べる。実残高そのままと比べると、
    // コアを 1 回積むたびに「ズレた」と判定して毎サイクル再計算が走る。
    const tacticalTarget = Math.max(0, realPosition.amount - coreAmount(state.coreHolding, pair));
    if (
      livePos &&
      tacticalTarget > 0 &&
      Math.abs(tacticalTarget - livePos.amount) / Math.max(tacticalTarget, livePos.amount) > 0.01
    ) {
      console.log(`[${pair}] livePos.amount ${livePos.amount} ≠ 戦術枠 ${tacticalTarget} (実残高 ${realPosition.amount} - コア) → FIFO 再計算`);
      try {
        if (liveExchange.fetchExecutions) {
          const executions = await liveExchange.fetchExecutions(pair);
          const summary = computeLifetimePnL(executions);
          const pairData = summary.byPair.find(p => p.pair === pair);
          if (pairData && pairData.averageBuyPrice > 0 && pairData.remainingInventory > 0) {
            const basis = tacticalBasis({
              exchangeAmount: realPosition.amount,
              fifoAvgPrice: pairData.averageBuyPrice,
              coreAmountBase: coreAmount(state.coreHolding, pair),
              coreCostJPY: coreCostJPY(state.coreHolding, pair),
              minAmountBase: liveExchange.getMinOrderJPY
                ? (liveExchange.getMinOrderJPY(pair, ticker.price) / 1.1) / Math.max(ticker.price, 1e-9)
                : 0,
            });
            if (basis) {
              livePos.entryPrice = basis.avgPrice;
              livePos.amount = basis.amount;
              await saveData("live-positions", Array.from(state.livePositions.values()));
              console.log(`[${pair}] 同期完了: 戦術枠 ${basis.amount} @ ¥${basis.avgPrice.toFixed(2)} (全体 ${realPosition.amount} @ ¥${pairData.averageBuyPrice.toFixed(2)})`);
            }
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
    // MA ルールの確信度 (75) は勝率推定ではなく固定値なので、閾値比較の対象にしない。
    // retrospective の confidenceBonus は AI が自動で上げ下げしており、
    // これが +26 以上になると閾値 (50+26=76) が 75 を超えて**買えなくなる**。
    // 判断根拠が確信度でない以上、ここで足切りされるのは筋が通らない。
    if (decision.action === "BUY" && (trendEntryOverride || decision.confidence >= effectiveThreshold)) {
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
      // MA ルール運用中は「警告」に留める。
      // これらのガードレールは損切り符号バグ (2026-08-16 修正) の時期に出た損失から
      // 学習されたもので、当時の「1時間後に必ず投げ売り」する挙動を前提にしている。
      // 例: 「TRENDING_UP 局面が損失の 80% → 上昇トレンドの閾値を厳格化」。
      // MA ルールは上昇トレンドでしか買わないので、これを効かせると自分の首を絞める。
      // 学習は止めず (記録・表示は継続)、判断の拒否権だけ外す。
      if (adaptiveBlocks.length > 0 && !bypassMtfCheck && decision.confidence < 70 && !trendEntryOverride) {
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
            // 学習ルールも同じ理由で拒否権を外す (記録と表示は残す)。
            // 現に active な `regime::BUY::TRENDING_UP` / `timing::BUY::TRENDING_UP` は
            // 「quant/technical/intel の 2 つ以上が HOLD か SELL なら買うな」という条件で、
            // クオンツの同意を必要としない MA ルールでは日常的に成立してしまう。
            // ここを効かせたままだと、相場が上昇に転じた最初の買いが黙って消える。
            const verb = trendEntryOverride ? "警告(続行)" : "見送り";
            console.log(`[${pair}] BUY${verb}: 学習ルール ${check.matched.length}件 hit`);
            for (const m of check.matched) {
              console.log(`  → ${m.rule.slice(0, 80)} (${m.reason})`);
            }
            if (!trendEntryOverride) return;
          }
        }
      } catch (e) {
        console.warn(`[${pair}] lessons チェック失敗:`, e instanceof Error ? e.message : e);
      }
      // Profit-First: 日次目標達成済みなら新規エントリー停止 (利益を守る)
      const dailyPnL = state.riskManager.getDailyPnL();
      const profitCfg = _syncProfit;
      const dailyTargetJPY = (dailyPnL.startCapitalJPY * profitCfg.dailyTargetPercent) / 100;
      if (dailyPnL.realizedPnL >= dailyTargetJPY && dailyTargetJPY > 0) {
        console.log(`[${pair}] BUY見送り: 本日目標達成 ¥${Math.round(dailyPnL.realizedPnL).toLocaleString()} ≥ ¥${Math.round(dailyTargetJPY).toLocaleString()}`);
        return;
      }

      // コンスタント利益モード: 目標達成に近づいたらポジションサイズを抑えて「積み上げ」を優先
      let grindSizeMul = 1.0;
      const progressToTarget = dailyTargetJPY > 0 ? dailyPnL.realizedPnL / dailyTargetJPY : 0;
      if (progressToTarget > 0.9) grindSizeMul = 0.25;
      else if (progressToTarget > 0.7) grindSizeMul = 0.5;
      else if (progressToTarget > 0.4) grindSizeMul = 0.8;

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
      let riskAdjustedTradeAmount = Math.min(
        Math.round(tradeAmount * (decision.institutionalRisk?.sizeMultiplier ?? 1)),
        decision.institutionalRisk?.suggestedMaxTradeJPY ?? tradeAmount,
      );
      riskAdjustedTradeAmount = Math.round(riskAdjustedTradeAmount * grindSizeMul);

      // ライブ時はユーザ設定のベースサイズを下限に（小さすぎて意味ない取引を避ける）
      if (!state.paperMode) {
        riskAdjustedTradeAmount = Math.max(riskAdjustedTradeAmount, LIVE_BASE_TRADE_JPY);
      }

      // 【リスク量から逆算する】MA ルールで入る玉は損切り幅が広い (既定8%)。
      // サイズを固定したまま幅だけ広げると、1 回の損が幅に比例して増える。
      // 先に「1 回にいくら失ってよいか」を決め、そこからサイズを出す。
      // 上の下限 (LIVE_BASE_TRADE_JPY) もここで上書きする。下限がリスク上限を
      // 超えたら、下限のほうが間違っている。
      if (trendEntryOverride && !state.paperMode) {
        const edge = currentEdgeBudget();
        const sized = riskBudgetedSize({
          navJPY: state.lastNavJPY > 0 ? state.lastNavJPY : jpyFree + currentPositionJPY,
          riskFraction: edge.budget.riskFraction,
          stopLossPercent: TREND_ENTRY_SL_PERCENT,
          availableJPY: jpyFree,
          maxJPY: dynamicMax,
          minOrderJPY: liveExchange.getMinOrderJPY?.(pair, ticker.price) ?? 0,
        });
        if (sized.sizeJPY <= 0) {
          console.log(`[${pair}] BUY見送り: ${sized.reason}`);
          return;
        }
        console.log(`[${pair}] リスク基準サイズ: ¥${sized.sizeJPY.toLocaleString()} (損切り時 ¥${Math.round(sized.riskJPY).toLocaleString()}) ${sized.reason}`);
        console.log(`[${pair}] 実績連動: ${edge.budget.phase} x${edge.budget.multiplier} — ${edge.budget.reason}`);
        riskAdjustedTradeAmount = sized.sizeJPY;
      }

      // PROFIT_MODE: 過去勝率がプラスなら fractional Kelly でサイズを押し上げる
      const PROFIT_MODE = process.env.PROFIT_MODE === '1' || process.env.PROFIT_MODE === 'true';
      if (PROFIT_MODE && decision.confidence >= 55) {
        const recent = state.liveTrades.filter(t => t.pair === pair && t.side === 'sell' && t.pnl !== undefined).slice(-15);
        if (recent.length >= 5) {
          const wins = recent.filter(t => (t.pnl ?? 0) > 0).length;
          const wr = wins / recent.length;
          const avgWin = recent.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / Math.max(1, wins) || 1200;
          const avgLoss = Math.abs(recent.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0)) / Math.max(1, recent.length - wins) || 900;
          const kellyMul = fractionalKelly(wr, avgWin, avgLoss, 0.35); // 少し積極的に
          riskAdjustedTradeAmount = Math.round(riskAdjustedTradeAmount * Math.min(1.8, Math.max(0.8, kellyMul)));
        }
      }
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
          const classified = classifyPositionStyle({
            composite: scoringResult.audit.votes.reduce((s, v) => s + v.score * v.weight, 0),
            regime,
            fearGreed: fearGreed.value,
            mtf: mtfForPrompt,
            bottomOp,
          });
          // MA ルールで入った玉は、バックテストで検証した設定 (SL -8% / TP 30% / 部分利確なし)
          // をそのまま使う。style 分類に任せると SCALP 判定で SL 0.6% になり、
          // 往復コスト 0.3% に対して薄すぎてノイズで刈られる。
          // 「検証した設定」と「実際に執行される設定」がズレると検証の意味が無くなる。
          const styleParams = trendEntryOverride
            ? {
                ...classified,
                style: "HOLD" as const,
                // 【検証値をそのまま使う】以前は decision.suggested* を優先していたが、
                // 判断側は常に SL 2% / TP 3% を返すため ?? が落ちることが無く、
                // **バックテストで検証した SL8%/TP30% は一度も実行されていなかった**。
                // コメントが禁じていることをコード自身がやっていた状態。
                slPercent: TREND_ENTRY_SL_PERCENT,
                tpPercent: TREND_ENTRY_TP_PERCENT,
                partialTakeProfits: [],
                reasoning: `MAルール建玉: SL/TP はバックテスト検証値を使用 (style 分類 ${classified.style} は不適用)`,
              }
            : classified;
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
          const baseAmt = order.amount;
          console.log(`[${pair}] LIVE BUY: ¥${riskAdjustedTradeAmount.toLocaleString()} (${baseAmt.toFixed(6)} ${pair.split("/")[0]}) @ ¥${order.price.toLocaleString()}`);
        } catch (e) {
          console.error(`[${pair}] LIVE BUY 失敗:`, e);
        }
      }
    }
    // === Swing モード MIN_HOLD チェック (AI SELL を HOLD に変換) ===
    // 2026-06-01: 24h min hold (intraday churn 防止)、天井 override は bypass 可 (利確機会確保)。
    // TP/SL/PTP/kill switch/緊急ロスカット は別経路で常時 fire 可。
    if (decision.action === "SELL" && livePos?.entryTimestamp) {
      const holdHours = (Date.now() - new Date(livePos.entryTimestamp).getTime()) / (60 * 60 * 1000);
      // MA ルールの撤退は「相場がトレンドを割った」判断なので min hold で握り続けない
      const isTopOverride =
        decision.reason.startsWith("[MTF天井") ||
        decision.reason.startsWith("[天井override") ||
        decision.reason.startsWith("[MAルール撤退");
      if (holdHours < MIN_HOLD_HOURS && !isTopOverride) {
        console.log(`[${pair}] AI SELL → HOLD 変換 (min hold): ${holdHours.toFixed(1)}h / ${MIN_HOLD_HOURS}h. TP/SL/天井 は引き続き有効`);
        decision.action = "HOLD";
        decision.reason = `[min hold] ${holdHours.toFixed(1)}h / ${MIN_HOLD_HOURS}h、AI SELL は 24h 後`;
      }
    }
    // SELL判断
    if (
      decision.action === "SELL" &&
      decision.confidence >= LIVE_CONFIDENCE_THRESHOLD &&
      sellableNow > 0 &&
      isSellableAmount(liveExchange, pair, sellableNow, ticker.price)
    ) {
      try {
        const { order } = await executeSell(liveExchange, pair, sellableNow);
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
        const soldAmt = sellableNow || livePos?.amount || 0;
        console.log(`[${pair}] LIVE SELL: 損益 ¥${pnl.toLocaleString()} (${pnlPercent.toFixed(1)}%) | ${soldAmt.toFixed(6)} ${pair.split("/")[0]}`);
        // 監査ログに結果を記録（改善ループ用）
        await recordOutcome(pair, fillPrice, pnl, pnlPercent).catch(() => {});
        // 負けトレードなら AI 振り返り → ルール抽出
        triggerLossReflection(pair, pnl, pnlPercent, fillPrice, "AI_SELL").catch(() => {});
      } catch (e) {
        console.error(`[${pair}] LIVE SELL 失敗:`, e);
      }
    }

    // ライブ SL/TP チェック（トレーリングストップ込み）
    if (livePos && sellableNow > 0 && isSellableAmount(liveExchange, pair, sellableNow, ticker.price)) {
      // トレーリングストップ: 含み益が出たら SL をブレイクイーブン → ATR追従で引き上げ
      const atrVals = atrIndicator(
        bars.map(b => b.high),
        bars.map(b => b.low),
        bars.map(b => b.close),
        14
      );
      const lastATR = atrVals.filter((v): v is number => v !== null).slice(-1)[0] ?? 0;
      // 高速監視側でも同じ ATR を使ってトレーリングできるように残す。
      // 1 分ごとに足を取り直すのは重いので、直近サイクルの値を流用する。
      if (lastATR > 0) state.lastATRByPair.set(pair, lastATR);
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
        if (nextPtp && changePercent >= nextPtp.triggerPercent && sellableNow > 0 && isSellableAmount(liveExchange, pair, sellableNow, ticker.price)) {
          // 部分売却実行
          const sellAmount = sellableNow * nextPtp.sellRatio;
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
        if (changePercent <= slTriggerPercent(livePos.stopLossPercent)) triggerType = "stop_loss";
        if (!triggerType && changePercent >= livePos.takeProfitPercent) {
          triggerType = "take_profit";
        }
      }

      if (triggerType) {
        try {
          // 実行本体は高速監視ループと共通 (closeLivePositionAtExit)。
          await closeLivePositionAtExit(liveExchange, pair, sellableNow, ticker.price, triggerType);
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
      // コア枠 (売らない長期枠) は kill-switch でも投げない。閉じるのは戦術枠だけ。
      const sellQty = sellableFree(pair, realPos.free);
      if (sellQty <= 0.0000001) {
        if (realPos.free > 0.0000001) {
          console.log(`[kill-switch] ${pair} はコア保有のみ (${realPos.free}) → 決済しない`);
        }
        state.livePositions.delete(pair);
        continue;
      }
      const ticker = await exchange.getTicker(pair);
      const order = await exchange.marketSell(pair, sellQty);
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

/**
 * 残高の短期キャッシュ。
 *
 * 画面は status を数秒おきにポーリングし、その 1 リクエストの中で
 * 「JPY 残高」と「コア保有サマリ」が別々に getBalance を叩いていた。
 * bitFlyer への往復は 1 回あたり数秒かかるので、そのままだと画面表示が
 * 待たされる分だけ遅くなる。数十秒の粒度で足りる用途なので短くキャッシュする。
 * 発注判断 (maintainCoreHolding) は maxAgeMs=0 で必ず実測を取る。
 */
let _balanceCache: { at: number; balance: Awaited<ReturnType<import("../exchanges/types").IExchange["getBalance"]>> } | null = null;

export async function getBalanceCached(
  exchange: import("../exchanges/types").IExchange,
  maxAgeMs = 20_000
): Promise<Awaited<ReturnType<import("../exchanges/types").IExchange["getBalance"]>>> {
  if (maxAgeMs > 0 && _balanceCache && Date.now() - _balanceCache.at < maxAgeMs) {
    return _balanceCache.balance;
  }
  const balance = await exchange.getBalance();
  _balanceCache = { at: Date.now(), balance };
  return balance;
}

/**
 * 総資産 (JPY + 保有暗号資産の評価額) と JPY free、各ペアの現在値をまとめて取る。
 * コア積立の目標額はここを基準に決める。
 */
async function readPortfolioSnapshot(
  exchange: import("../exchanges/types").IExchange,
  pairs: string[],
  /** キャッシュに無い価格を取引所に取りに行くか。画面からの呼び出しでは false にして待たせない */
  fetchMissingPrices = true,
  /** 残高キャッシュの許容鮮度。発注判断では 0 (必ず実測) */
  balanceMaxAgeMs = 0
): Promise<{
  navJPY: number;
  jpyFree: number;
  prices: Record<string, number>;
  balances: Awaited<ReturnType<import("../exchanges/types").IExchange["getBalance"]>>;
}> {
  const balance = await getBalanceCached(exchange, balanceMaxAgeMs);
  const jpy = balance.find((b) => b.currency === "JPY");
  const jpyFree = jpy?.free ?? 0;
  let navJPY = jpy?.total ?? 0;

  const prices: Record<string, number> = {};
  const wanted = new Set<string>(pairs);
  for (const bal of balance) {
    if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
    wanted.add(`${bal.currency}/JPY`);
  }
  // 直近サイクルで記録した価格を先に使う。ここで毎回全ペアの ticker を叩くと
  // 1 リクエストに数十秒かかり、画面のポーリングまで巻き添えで遅くなる。
  const FRESH_MS = 10 * 60 * 1000;
  const now = Date.now();
  for (const pair of wanted) {
    const cached = state.lastPriceByPair.get(pair);
    if (cached && now - Date.parse(cached.at) < FRESH_MS && cached.price > 0) {
      prices[pair] = cached.price;
      continue;
    }
    if (!fetchMissingPrices) {
      // 画面からの呼び出しでは ticker を待たせない。ただし古い価格でも 0 よりはるかにまし。
      // ここを落とすと、保有しているのに「評価額 ¥0 / 充足 0%」と表示され、
      // NAV もその分だけ小さく出る (XRP を ¥2,997 積んだ直後に踏んだ)。
      if (cached && cached.price > 0) prices[pair] = cached.price;
      continue;
    }
    try {
      const t = await exchange.getTicker(pair);
      if (t?.price > 0) {
        prices[pair] = t.price;
        state.lastPriceByPair.set(pair, { price: t.price, at: new Date().toISOString() });
      }
    } catch {
      // 板が無いペア (SOL/JPY 等) は無視する
    }
  }
  for (const bal of balance) {
    if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
    const price = prices[`${bal.currency}/JPY`];
    if (price) navJPY += bal.total * price;
  }
  return { navJPY, jpyFree, prices, balances: balance };
}

/**
 * コア枠 (売らない長期枠) を目標比率まで積む。
 *
 * 【配置の理由】kill-switch 判定より **前** に呼ぶ。
 * kill-switch はドローダウン時に戦術枠の新規エントリを止めるための仕組みで、
 * 「上昇するまで現金で待たない」というコア枠の趣旨とは別の話。ここで止めると
 * 下落局面で積立が全部飛び、結局また全額 JPY で寝る状態に戻る。
 *
 * ⚠️ 1 サイクル 1 件しか発注しない。まとめ買いで現金を一気に使わないため。
 */
async function maintainCoreHolding(): Promise<void> {
  const cfg = currentCoreConfig();
  if (!cfg.enabled || state.paperMode) return;

  try {
    const exchange = getExchange();
    await exchange.connect();
    const { navJPY, jpyFree, prices, balances } = await readPortfolioSnapshot(exchange, state.pairs);
    if (navJPY > 0) state.lastNavJPY = navJPY;

    // 取引所ベースの実績を取り直す (表示はこのキャッシュを読む)
    await refreshExchangePnL().catch(() => {});

    // 台帳を実残高に合わせる。本人が bitFlyer 側で直接売った場合、台帳だけが残ると
    // そのペアが二度と売れなくなる (sellableFree が 0 を返し続ける)。
    let clamped = false;
    for (const pair of new Set(state.coreHolding.lots.map((l) => l.pair))) {
      const base = pair.split("/")[0];
      const total = balances.find((b) => b.currency === base)?.total ?? 0;
      const res = clampCoreToBalance(state.coreHolding, pair, total);
      if (res.adjusted) {
        console.warn(`[core] ${pair} 台帳を実残高に合わせて修正 (実残高 ${total})`);
        state.coreHolding = res.state;
        clamped = true;
      }
    }
    if (clamped) await saveData("core-holding", state.coreHolding);

    const minOrderJPY: Record<string, number> = {};
    for (const [pair, price] of Object.entries(prices)) {
      minOrderJPY[pair] = exchange.getMinOrderJPY?.(pair, price) ?? 0;
    }

    // 先に利確を見る。上がった分を現金に戻してから、その現金で足りない枠を積む。
    // 1 サイクルにつき売りか買いのどちらか 1 件だけ。
    const tp = planCoreTakeProfit({ state: state.coreHolding, cfg, prices, minOrderJPY });
    if (tp.plan) {
      const tpPlan = tp.plan;
      // 台帳ではなく取引所の実残高を上限にする。手動売却などで台帳が実残高を
      // 上回っていると、そのまま投げて注文が弾かれる。
      const base = tpPlan.pair.split("/")[0];
      const free = balances.find((b) => b.currency === base)?.free ?? 0;
      const sellAmount = Math.min(tpPlan.amountBase, free);
      if (sellAmount > 0 && sellAmount * tpPlan.priceJPY >= Math.max(minOrderJPY[tpPlan.pair] ?? 0, cfg.minTrancheJPY)) {
        console.log(`[core] 利確実行: ${tpPlan.pair} ${sellAmount} @ ¥${Math.round(tpPlan.priceJPY).toLocaleString()} (${tpPlan.reason})`);
        const { order } = await executeSell(exchange, tpPlan.pair, sellAmount, false, "core");
        const sellPrice = order.price > 0 ? order.price : tpPlan.priceJPY;
        const soldAt = new Date().toISOString();
        const res = applyCoreSell(state.coreHolding, tpPlan.pair, order.amount || sellAmount, sellPrice);
        state.coreHolding = res.state;
        await saveData("core-holding", state.coreHolding);
        console.log(`[core] 利確確定: ${tpPlan.pair} ¥${Math.round(res.realizedJPY).toLocaleString()} (累計 ¥${Math.round(state.coreHolding.realizedJPY ?? 0).toLocaleString()})`);

        const sellTrade: TradeRecord = {
          id: `core-tp-${Date.now()}`,
          timestamp: soldAt,
          exchange: "bitflyer",
          pair: tpPlan.pair,
          side: "sell",
          type: "market",
          amount: order.amount || sellAmount,
          price: sellPrice,
          valueJPY: (order.amount || sellAmount) * sellPrice,
          orderId: order.id,
          fee: order.fee ?? 0,
          paperTrade: false,
        };
        state.recentTrades.push(sellTrade);
        state.liveTrades.push(sellTrade);
        await saveData("live-trades", state.liveTrades);
        state.lastCoreSkip = null;
        return;
      }
    }

    const { plan, skip } = planCoreBuy({
      navJPY,
      jpyFree,
      cfg,
      state: state.coreHolding,
      prices,
      minOrderJPY,
      nowMs: Date.now(),
    });

    if (!plan) {
      state.lastCoreSkip = skip ? { ...skip, at: new Date().toISOString() } : null;
      if (skip) console.log(`[core] 積立なし: ${skip.reason}`);
      return;
    }

    console.log(
      `[core] 積立実行: ${plan.pair} ¥${plan.amountJPY.toLocaleString()} ` +
        `(目標 ¥${Math.round(plan.targetJPY).toLocaleString()} / 現在 ¥${Math.round(plan.currentJPY).toLocaleString()})`
    );
    const { order } = await executeBuy(exchange, plan.pair, plan.amountJPY, "core");
    const fillPrice = order.price > 0 ? order.price : prices[plan.pair];
    const at = new Date().toISOString();
    // 約定数量は取引所の実残高で裏取りする。maker 指値の部分約定などで order.amount が
    // 実際の増分を上回ると、台帳が実残高を超えて「売れないペア」を作ってしまう。
    let recordedAmount = order.amount;
    try {
      const after = await exchange.getPosition(plan.pair);
      const room = Math.max(0, after.amount - coreAmount(state.coreHolding, plan.pair));
      if (room > 0) recordedAmount = Math.min(order.amount, room);
    } catch {
      // 残高が取れなければ order.amount のまま (次サイクルの clamp で整合させる)
    }
    state.coreHolding = applyCoreFill(state.coreHolding, {
      pair: plan.pair,
      amountBase: recordedAmount,
      priceJPY: fillPrice,
      costJPY: recordedAmount * fillPrice,
      at,
    });
    await saveData("core-holding", state.coreHolding);

    const trade: TradeRecord = {
      id: `core-${Date.now()}`,
      timestamp: at,
      exchange: "bitflyer",
      pair: plan.pair,
      side: "buy",
      type: "market",
      amount: order.amount,
      price: fillPrice,
      valueJPY: order.amount * fillPrice,
      orderId: order.id,
      fee: order.fee ?? 0,
      paperTrade: false,
    };
    state.recentTrades.push(trade);
    state.liveTrades.push(trade);
    await saveData("live-trades", state.liveTrades.slice(-200));
    state.lastCoreSkip = null;
    console.log(
      `[core] CORE BUY 約定: ${plan.pair} ${order.amount} @ ¥${Math.round(fillPrice).toLocaleString()}`
    );
  } catch (e) {
    console.error("[core] 積立失敗:", e instanceof Error ? e.message : e);
    state.lastCoreSkip = { reason: `積立失敗: ${e instanceof Error ? e.message : String(e)}`, at: new Date().toISOString() };
  }
}

/**
 * 画面からコア設定を変更する。保存した内容は再起動後も効く。
 *
 * ⚠️ enabled を true にすると次サイクルから実弾で積み始める。
 */
export async function updateCoreConfig(patch: CoreConfigOverride): Promise<CoreHoldConfig> {
  await ensureDataLoaded();
  // undefined のキーを落としてから重ねる。API ルートは送られなかった項目を
  // 明示的に undefined で埋めてくるので、そのまま展開すると保存済みの値を
  // undefined で上書きし、env 既定に戻ってしまう。
  // 実害: 比率だけ変えた POST で enabled が false に戻り、積立が黙って止まった。
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as CoreConfigOverride;
  const next: CoreConfigOverride = { ...(state.coreConfigOverride ?? {}), ...defined };
  state.coreConfigOverride = next;
  await saveData("core-config", next);
  const cfg = currentCoreConfig();
  console.log(
    `[core] 設定更新: ${cfg.enabled ? "有効" : "停止"} / 目標 ${Math.round(cfg.targetPct * 100)}% / ` +
      `${Object.entries(cfg.weights).map(([p, w]) => `${p.split("/")[0]}:${w}`).join(" ")}`
  );
  return cfg;
}

/** 執行コストの集計。売買代金に対して中値からどれだけ払っているか。 */
export async function getExecutionCostReport(): Promise<ReturnType<typeof summarizeExecutionCosts>> {
  await ensureDataLoaded();
  return summarizeExecutionCosts(state.executionCosts);
}

/**
 * 成績レポート。**主指標は「買った暗号資産に対する損益」**。
 * 総資産は入金でも増えるので、成績としては読めない (¥50,000 入れた直後に
 * 24h +73.73% と出て、bot が稼いだように見えていた)。総資産は総資産で返す。
 */
export async function getPerformanceReport() {
  await ensureDataLoaded();
  const exchange = getExchange();
  await exchange.connect();

  const flows = await loadData<CashFlow[]>("cash-flows", []);
  const snap = await readPortfolioSnapshot(exchange, state.pairs, false, 20_000);
  const holdingsValueJPY = Math.max(0, snap.navJPY - snap.jpyFree);

  // 主指標の分母なので、保管庫の和集合から出す (取得できた分だけだと揺れる)
  const cached = state.exchangePnL;
  const buyVolumeJPY = cached?.buyVolumeJPY ?? 0;
  const sellVolumeJPY = cached?.sellVolumeJPY ?? 0;
  const realizedJPY = cached?.realizedJPY ?? 0;

  const navHistory = await loadData<NavSnapshot[]>("nav-history", []);
  const baseline = navHistory[0];
  return {
    /** 主指標 */
    cryptoReturn: buildCryptoReturn({ buyVolumeJPY, sellVolumeJPY, holdingsValueJPY, realizedJPY }),
    /** 副指標: 入れた金の合計に対する現在の総資産 */
    funding: buildFundingReport({
      baselineJPY: baseline?.total ?? 0,
      baselineAt: baseline?.timestamp ?? null,
      currentNavJPY: snap.navJPY,
      flows,
    }),
    /** 参考: 総資産そのもの */
    navJPY: snap.navJPY,
    jpyFreeJPY: snap.jpyFree,
    holdingsValueJPY,
  };
}

/** 直近の決済から戦術枠の張る額を決める。悪ければ縮め、良ければ戻す。 */
function currentEdgeBudget() {
  const recent = state.exchangePnL?.recentCloses ?? [];
  const wins = recent.filter((p) => p > 0);
  const losses = recent.filter((p) => p < 0);
  const quality = computeTradeQuality({
    wins: wins.length,
    losses: losses.length,
    grossProfitJPY: wins.reduce((s, p) => s + p, 0),
    grossLossJPY: losses.reduce((s, p) => s - p, 0),
  });
  return {
    quality,
    budget: evaluateEdgeBudget({
      quality,
      minSamples: EDGE_MIN_SAMPLES,
      baseRiskFraction: RISK_FRACTION_PER_TRADE,
    }),
  };
}

/**
 * 運用成績の指標。損益だけでは「相場が上げた」と「仕組みが機能した」の
 * 区別がつかないので、ドローダウン・プロフィットファクター・期待値・損益比を出す。
 * 機関投資家の目安も併記する (数字だけでは良し悪しが分からない)。
 */
export async function getPerformanceMetrics() {
  await ensureDataLoaded();
  const navHistory = await loadData<NavSnapshot[]>("nav-history", []);
  // 入出金を差し引いた資産曲線で測る。
  // 総資産そのままだと入金で下落率が薄まり、暗号資産の評価額だけだと
  // 現金に寄せた時期が「ほぼ全損」に見える (実際 -99.9% と出ていた)。
  const flows = await loadData<CashFlow[]>("cash-flows", []);
  const series = buildEquityCurve(
    navHistory.filter((n) => typeof n.total === "number" && n.total > 0),
    flows
  );

  const ex = state.exchangePnL;
  return {
    drawdown: computeDrawdown(series),
    tradeQuality: computeTradeQuality({
      wins: ex?.wins ?? 0,
      losses: ex?.losses ?? 0,
      grossProfitJPY: ex?.grossProfitJPY ?? 0,
      grossLossJPY: ex?.grossLossJPY ?? 0,
    }),
    /** 直近の成績と、それに応じた戦術枠の張る額 */
    edge: currentEdgeBudget(),
    benchmark: INSTITUTIONAL_BENCHMARK,
    samplePoints: series.length,
  };
}

/** 枠別 (コア / 戦術) の損益。どちらが稼いでどちらが溶かしているかを分ける。 */
export async function getLanePnL() {
  await ensureDataLoaded();
  const trades = state.paperMode ? state.paperTrader.getTrades() : state.liveTrades;
  return attributePnL({
    trades,
    costs: state.executionCosts,
    coreRealizedJPY: state.coreHolding.realizedJPY ?? 0,
    // 口座全体は取引所ベース。画面上部の確定損益と枠別が食い違わないようにする。
    exchangeTotal: state.paperMode || !state.exchangePnL
      ? undefined
      : {
          realizedJPY: state.exchangePnL.realizedJPY,
          closedTrades: state.exchangePnL.closedTrades,
          wins: state.exchangePnL.wins,
          losses: state.exchangePnL.losses,
        },
  });
}

/** 次に積む予定の 1 件を、発注せずに返す (画面の事前確認用)。 */
export async function previewCoreBuy(): Promise<{
  cfg: CoreHoldConfig;
  navJPY: number;
  jpyFree: number;
  plan: ReturnType<typeof planCoreBuy>["plan"];
  skip: ReturnType<typeof planCoreBuy>["skip"];
}> {
  await ensureDataLoaded();
  const cfg = currentCoreConfig();
  const exchange = getExchange();
  await exchange.connect();
  const { navJPY, jpyFree, prices } = await readPortfolioSnapshot(exchange, state.pairs, false, 20_000);
  const minOrderJPY: Record<string, number> = {};
  for (const [pair, price] of Object.entries(prices)) {
    minOrderJPY[pair] = exchange.getMinOrderJPY?.(pair, price) ?? 0;
  }
  // enabled を無視して「有効ならこう積む」を見せる。ON にする前の確認用。
  const { plan, skip } = planCoreBuy({
    navJPY, jpyFree, cfg: { ...cfg, enabled: true },
    state: state.coreHolding, prices, minOrderJPY, nowMs: Date.now(),
  });
  return { cfg, navJPY, jpyFree, plan, skip };
}

/** 画面/API 用のコア保有サマリ。価格は現在値で引き直す。 */
export async function getCoreHoldingReport(): Promise<{
  enabled: boolean;
  targetPct: number;
  rows: ReturnType<typeof summarizeCore>;
  totalValueJPY: number;
  totalCostJPY: number;
  totalTargetJPY: number;
  /** 利確で現金に戻した確定損益の累計 */
  realizedJPY: number;
  lastSkip: (CoreSkip & { at: string }) | null;
}> {
  await ensureDataLoaded();
  const cfg = currentCoreConfig();
  let navJPY = 0;
  let prices: Record<string, number> = {};
  if (!state.paperMode) {
    try {
      const exchange = getExchange();
      await exchange.connect();
      const snap = await readPortfolioSnapshot(exchange, state.pairs, false, 20_000);
      navJPY = snap.navJPY;
      prices = snap.prices;
    } catch {
      // 取引所に繋がらないときは保有分だけ返す
    }
  }
  const rows = summarizeCore(state.coreHolding, cfg, navJPY, prices);
  return {
    enabled: cfg.enabled,
    targetPct: cfg.targetPct,
    rows,
    totalValueJPY: rows.reduce((s, r) => s + r.valueJPY, 0),
    totalCostJPY: rows.reduce((s, r) => s + r.costJPY, 0),
    totalTargetJPY: rows.reduce((s, r) => s + r.targetJPY, 0),
    realizedJPY: state.coreHolding.realizedJPY ?? 0,
    lastSkip: state.lastCoreSkip,
  };
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

  // 未約定買い指値の自動掃除 (古いものはキャンセルして free を回復)。
  // ⚠️ kill-switch の判定より前に毎サイクル実行する。孤児化した買い指値に現金がロックされ
  //    「残高はあるのに全ての BUY が資金不足で見送り」になる事故を防ぐため。
  //    kill-switch 発火中でも資金だけは解放しておく (新規 BUY はこの後止まる)。
  if (!state.paperMode) {
    await cleanupStaleOpenBuys(3);
  }

  // コア枠 (売らない長期枠) の積立。
  // ⚠️ kill-switch 判定より前に置く。トレンドゲートで戦術枠が止まっている間も
  //    「全額 JPY で寝かせない」ための枠なので、ここを止めると意味が無くなる。
  await maintainCoreHolding();

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
      // 2026-05-31: exchange balance 全体を見る (livePositions に未追跡の crypto も含める)
      // kill-switch reset 側と計算を統一しないと「reset しても次 cycle で 13% drawdown 再発火」となる。
      for (const bal of balance) {
        if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
        try {
          const t = await exchange.getTicker(`${bal.currency}/JPY`);
          currentCapital += bal.total * t.price;
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

  // Phase 2: 信号ウェイト学習を 6サイクル(=6時間, cycle間隔1h前提)ごとに再計算
  if (state.cycleCount % 6 === 0) {
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
              const gridSellable = sellableFree(pair, realPos.free);
              if (gridSellable < baseAmount) return { ok: false };
              const order = await exchange.marketSell(pair, Math.min(gridSellable, baseAmount));
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

  // === Allocation maintainer (Wealth Navi 風 動的配分, 2026-05-31 再有効化) ===
  // user 指示: 「自動で現金の配分を決めてほしい、SBI AI ラップ・wealth navi みたいな感じ」
  // 動的 target cash% (F&G / drawdown / ATR / trend に応じて 10-50%) を計算し、
  // 現金比率が target + buffer 超なら最良ペアに小額 BUY 実行。BUY のみ、SELL なし。
  // 落ちるナイフ防止: kill switch / daily loss / 過剰買いに上限あり。
  if (state.cycleCount % 6 === 0 && !state.paperMode) {
    try {
      const exchange = getExchange();
      const balance = await exchange.getBalance();
      const jpyFree = balance.find(b => b.currency === "JPY")?.free ?? 0;
      const jpyTotal = balance.find(b => b.currency === "JPY")?.total ?? 0;
      let cryptoVal = 0;
      const tickerMap: Record<string, number> = {};
      const barsMap: Record<string, import("../types").OHLCVBar[]> = {};

      for (const bal of balance) {
        if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
        try {
          const t = await exchange.getTicker(`${bal.currency}/JPY`);
          tickerMap[`${bal.currency}/JPY`] = t.price;
          cryptoVal += bal.total * t.price;
        } catch { /* skip */ }
      }

      // BTC bars for dynamic target (ATR%, SMA trend)
      let btcAtrPercent = 2.5; // safe default
      let btcTrendBullish = true;
      try {
        const btcBars = await exchange.getOHLCV("BTC/JPY", "1h", 100);
        if (btcBars && btcBars.length >= 50) {
          barsMap["BTC/JPY"] = btcBars;
          const highs = btcBars.map(b => b.high);
          const lows = btcBars.map(b => b.low);
          const closes = btcBars.map(b => b.close);
          const atrVals = atrIndicator(highs, lows, closes, 14).filter((v): v is number => v != null);
          const lastAtr = atrVals.length > 0 ? atrVals[atrVals.length - 1] : 0;
          const lastClose = closes[closes.length - 1];
          if (lastAtr > 0 && lastClose > 0) btcAtrPercent = (lastAtr / lastClose) * 100;
          const sma20 = smaIndicator(closes, 20).filter((v): v is number => v != null);
          const sma50 = smaIndicator(closes, 50).filter((v): v is number => v != null);
          if (sma20.length > 0 && sma50.length > 0) {
            btcTrendBullish = sma20[sma20.length - 1] > sma50[sma50.length - 1];
          }
        }
      } catch { /* skip */ }

      // NAV drawdown from kill-switch state (peakNAV)
      const ksState = await (await import("./kill-switch")).getKillSwitchState();
      const currentNAV = jpyTotal + cryptoVal;
      const navDrawdownPct = ksState.peakNAV > 0
        ? Math.max(0, ((ksState.peakNAV - currentNAV) / ksState.peakNAV) * 100)
        : 0;

      // pair scores
      //
      // ⚠️ 2026-08-17: 直近の LIVE BUY は 3 件とも `alloc-` 由来だった。
      // 目標現金比率に戻すためのリバランスが、下降トレンド中のペアに現金を
      // 突っ込み続けていた (AI 判断側にトレンドゲートを入れても、買っていたのは
      // こちらなので効かない)。ここでも同じトレンド条件を適用する。
      // trendByPair が空 (初回サイクル等) の場合は候補ゼロ = 買わない側に倒す。
      const pairScores: { pair: string; compositeScore: number; price: number }[] = [];
      const allocSkipped: string[] = [];
      for (const pair of state.pairs) {
        try {
          if (TREND_GATE_ENABLED && !state.trendByPair.get(pair)?.upTrend) {
            allocSkipped.push(pair);
            continue;
          }
          const bars = barsMap[pair] ?? await exchange.getOHLCV(pair, "1h", 100);
          if (!bars || bars.length < 50) continue;
          const qa = runQuantAnalysis(bars);
          pairScores.push({
            pair,
            compositeScore: qa.compositeScore,
            price: tickerMap[pair] ?? bars[bars.length - 1].close,
          });
        } catch { /* skip */ }
      }
      if (allocSkipped.length > 0) {
        console.log(`[alloc] トレンドゲートで除外: ${allocSkipped.join(", ")} (上昇トレンドのペアのみ買い増し対象)`);
      }

      const fgData = await getFearGreedIndex().catch(() => ({ value: 50, label: "Neutral" }));
      const fgVal = fgData.value;
      const dailyPnL = state.riskManager.getDailyPnL();
      const dailyPnLPercent = dailyPnL.startCapitalJPY > 0
        ? (dailyPnL.totalPnL / dailyPnL.startCapitalJPY) * 100
        : 0;
      const ksActive = await isKillSwitchActive();

      // === AI による target cash ratio 決定 (cache 6h, fallback rule-based) ===
      const ruleBased = computeDynamicTargetCashRatio({
        fearGreed: fgVal,
        ndDrawdownPct: navDrawdownPct,
        btcAtrPercent,
        btcTrendBullish,
      });
      const btcTicker = tickerMap["BTC/JPY"] ?? 0;
      const btcBars = barsMap["BTC/JPY"];
      const btc24hChange = btcBars && btcBars.length >= 25
        ? ((btcBars[btcBars.length - 1].close - btcBars[btcBars.length - 25].close) / btcBars[btcBars.length - 25].close) * 100
        : 0;
      const recentClosedTrades = state.liveTrades.filter(t => t.side === "sell" && typeof t.pnl === "number").slice(-30);
      const wins = recentClosedTrades.filter(t => (t.pnl ?? 0) > 0).length;
      const winRate = recentClosedTrades.length > 0 ? (wins / recentClosedTrades.length) * 100 : null;

      const aiDecision = await decideTargetCashRatio({
        navJPY: currentNAV,
        cashRatio: jpyTotal / Math.max(1, currentNAV),
        cryptoRatio: cryptoVal / Math.max(1, currentNAV),
        fearGreed: fgVal,
        fearGreedLabel: fgData.label ?? "",
        btcPriceJPY: btcTicker,
        btc24hChangePercent: btc24hChange,
        btcAtrPercent,
        btcTrendBullish,
        navPeakJPY: ksState.peakNAV,
        navDrawdownPct,
        recentTradeWinRate: winRate,
        recentTradeCount: recentClosedTrades.length,
        ruleBasedTarget: ruleBased.target,
        ruleBasedReason: ruleBased.reason,
      });
      if (state.cycleCount % 6 === 0) {
        console.log(`[alloc:AI] target cash ${aiDecision.targetCashPercent}% (${aiDecision.source}, conf ${aiDecision.confidence}) — ${aiDecision.reason}`);
      }

      const decision = await evaluateAllocation({
        jpyFree,
        cryptoValueJPY: cryptoVal,
        fearGreed: fgVal,
        dailyPnLPercent,
        killSwitchActive: ksActive,
        pairScores,
        navDrawdownPct,
        btcAtrPercent,
        btcTrendBullish,
        aiTargetCashRatio: aiDecision.targetCashPercent / 100,
        aiTargetReason: aiDecision.reason,
        aiTargetSource: aiDecision.source,
      });

      if (state.cycleCount % 12 === 0) {
        console.log(`[alloc] cash ${(decision.diagnostics.cashRatio * 100).toFixed(1)}% → target ${(decision.diagnostics.targetCashRatio * 100).toFixed(0)}% | ${decision.diagnostics.targetReason}`);
      }

      // 二重の歯止め: 候補の絞り込みを抜けても、発注直前にもう一度トレンドを見る
      if (
        decision.shouldBuy &&
        decision.pair &&
        TREND_GATE_ENABLED &&
        !state.trendByPair.get(decision.pair)?.upTrend
      ) {
        console.log(`[alloc] ${decision.pair} 買い増し中止: 日足が上昇トレンドでない`);
        decision.shouldBuy = false;
      }
      if (decision.shouldBuy && decision.pair && decision.amountJPY) {
        try {
          const { order } = await executeBuy(exchange, decision.pair, decision.amountJPY);
          const fillPrice = order.price > 0 ? order.price : (tickerMap[decision.pair] ?? 0);
          const trade: TradeRecord = {
            id: `alloc-${Date.now()}-${decision.pair.replace("/", "")}`,
            timestamp: new Date().toISOString(),
            exchange: "bitflyer",
            pair: decision.pair,
            side: "buy",
            type: "market",
            amount: order.amount,
            price: fillPrice,
            valueJPY: decision.amountJPY,
            orderId: order.id,
            fee: order.fee ?? 0,
            paperTrade: false,
          };
          state.recentTrades.push(trade);
          state.liveTrades.push(trade);
          // livePosition 加算
          const existing = state.livePositions.get(decision.pair);
          if (existing) {
            const newTotal = existing.amount + order.amount;
            existing.entryPrice = (existing.entryPrice * existing.amount + fillPrice * order.amount) / newTotal;
            existing.amount = newTotal;
          } else {
            state.livePositions.set(decision.pair, {
              pair: decision.pair,
              entryPrice: fillPrice,
              amount: order.amount,
              entryTimestamp: new Date().toISOString(),
              stopLossPercent: 5.0,
              takeProfitPercent: 15.0,
              style: "HOLD",
              styleReason: "Allocation maintainer (動的配分 BUY)",
            });
          }
          await saveData("live-trades", state.liveTrades.slice(-200));
          await saveData("live-positions", Array.from(state.livePositions.values()));
          await recordAllocationEvent({
            timestamp: new Date().toISOString(),
            pair: decision.pair,
            amountJPY: decision.amountJPY,
            price: fillPrice,
            reason: decision.reason,
          });
          console.log(`[alloc] ✅ BUY ${decision.pair}: ¥${decision.amountJPY.toLocaleString()} @ ¥${fillPrice.toLocaleString()} — ${decision.reason}`);
        } catch (e) {
          console.warn(`[alloc] BUY 失敗:`, e instanceof Error ? e.message : e);
        }
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

    // 対象ペアに加えて、既に追跡しているペアも見る。state.pairs から外した
    // ペア (XLM など) の残骸がここを通らず、ずっと戦術ポジションとして
    // 残って毎分の監視に引っかかっていた。
    const pairsToCheck = Array.from(new Set([...state.pairs, ...state.livePositions.keys()]));
    for (const pair of pairsToCheck) {
      const realPos = await exchange.getPosition(pair);
      if (realPos.amount <= 0.0000001) {
        if (state.livePositions.has(pair)) {
          state.livePositions.delete(pair);
          console.log(`[reconcile] ${pair} 残高なし → livePositions から除外`);
        }
        continue;
      }

      // dust skip: 評価額 ¥500 未満は売却不能 + 判断ノイズなので追跡対象外。
      // 【コアを引いた戦術枠で判定する】実残高で見ると、コア枠がほとんどを
      // 占めるペア (ETH 実残高 0.051 のうちコア 0.0509) で残り ¥38 の
      // ダストが ¥500 の閾値を通ってしまい、掃除されなかった。
      try {
        const ticker = await exchange.getTicker(pair);
        const tacticalAmount = Math.max(0, realPos.amount - coreAmount(state.coreHolding, pair));
        const valueJPY = tacticalAmount * ticker.price;
        if (valueJPY < 500) {
          // 既存追跡があれば削除
          if (state.livePositions.has(pair)) {
            state.livePositions.delete(pair);
            console.log(`[reconcile] ${pair} 戦術枠 dust (¥${Math.round(valueJPY)}) → livePositions から除外`);
          }
          continue;
        }
      } catch { /* ticker 取れないペアはそのまま reconcile */ }

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
    // コア枠は緊急ロスカットの対象外 (売らない前提で積んでいる枠なので投げない)
    const cutQty = sellableFree(pair, realPos.free);
    if (cutQty <= 0.0000001) return false;
    if (!isSellableAmount(exchange, pair, cutQty, currentPrice)) {
      console.log(`[${pair}] 緊急ロスカット対象だが売却可能数量未満: amount=${cutQty}`);
      return false;
    }

    const livePos = state.livePositions.get(pair);
    if (!livePos || livePos.entryPrice <= 0) return false;

    const lossPercent = ((currentPrice - livePos.entryPrice) / livePos.entryPrice) * 100;
    if (lossPercent > -EMERGENCY_LOSS_PERCENT) return false;

    console.log(
      `[${pair}] 🚨 緊急ロスカット発動: 含み損 ${lossPercent.toFixed(2)}% (${-EMERGENCY_LOSS_PERCENT}% 閾値超え)`
    );
    const order = await exchange.marketSell(pair, cutQty);
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

  // 高速 TP/SL 監視は「初回サイクルより先に」張る。
  // 初回サイクルは 5 ペア分の AI 判断で数分かかることがあり、その間ノーガードで
  // ポジションを晒すことになるため。価格取得のみで AI は呼ばない (課金増やさない)。
  if (!state.paperMode) {
    const fastSec = Math.max(30, Number(process.env.FAST_MONITOR_SECONDS ?? "60"));
    state.fastMonitorId = setInterval(() => {
      monitorPositionsFast().catch(console.error);
    }, fastSec * 1000);
    console.log(`高速TP/SL監視: ${fastSec}秒間隔で稼働 (判断サイクルは${state.intervalSeconds}秒)`);
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
  if (state.fastMonitorId) {
    clearInterval(state.fastMonitorId);
    state.fastMonitorId = null;
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

/**
 * ペアごとの日足トレンド判定。
 * 下降トレンド中は設計どおり新規 BUY を出さないので、「動いていない」のか
 * 「待っている」のかを画面で区別できるようにこれを返す。
 */
export function getTrendStates(): Array<{
  pair: string;
  upTrend: boolean;
  close: number;
  ma50: number | null;
  ma200: number | null;
  degraded: boolean;
  buyAllowed: boolean;
  label: string;
  at: string;
}> {
  return state.pairs.map((pair) => {
    const t = state.trendByPair.get(pair);
    if (!t) {
      return {
        pair,
        upTrend: false,
        close: 0,
        ma50: null,
        ma200: null,
        degraded: false,
        buyAllowed: false,
        label: "日足トレンド未評価 (次サイクルで判定)",
        at: "",
      };
    }
    return {
      pair,
      upTrend: t.upTrend,
      close: t.close,
      ma50: t.fast,
      ma200: t.slow,
      degraded: t.degraded,
      buyAllowed: !TREND_GATE_ENABLED || t.upTrend,
      label: t.label,
      at: t.at,
    };
  });
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
  return Array.from(state.livePositions.values()).map(p => {
    // 直近サイクル / 高速監視で記録した価格を使う。以前はここが 0 固定で、
    // 画面のポジションが常に「評価額 ¥0・含み損益 0」に見えていた。
    const last = state.lastPriceByPair.get(p.pair);
    const currentPrice = last?.price ?? 0;
    // 【コア枠を引く】ここが引いていなかったため、画面が
    // 「現金 + コア保有 + 戦術枠」を足すと同じコインを2回数え、
    // 総資産が ¥190,799 (実際は ¥121,718) と表示されていた。
    // リスク判定のエクスポージャーもこの値を使うので、ここが出所。
    const core = coreAmount(state.coreHolding, p.pair);
    const amount = Math.max(0, p.amount - core);
    const valueJPY = currentPrice > 0 ? amount * currentPrice : 0;
    const unrealizedPnL = currentPrice > 0 ? (currentPrice - p.entryPrice) * amount : 0;
    const unrealizedPnLPercent =
      currentPrice > 0 && p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
    return {
      pair: p.pair,
      exchange: "bitflyer",
      amount,
      avgEntryPrice: p.entryPrice,
      currentPrice,
      unrealizedPnL,
      unrealizedPnLPercent,
      valueJPY,
      priceAt: last?.at ?? null,
      stopLoss: p.entryPrice * (1 - p.stopLossPercent / 100),
      takeProfit: p.entryPrice * (1 + p.takeProfitPercent / 100),
      entryTimestamp: p.entryTimestamp,
    };
  });
}

export function getDailyPnL() {
  return state.riskManager.getDailyPnL();
}

export function getPortfolioRiskOverlay() {
  const dailyPnL = state.riskManager.getDailyPnL();
  const cumulative = getCumulativePnL();
  // コア枠は getPositions() の時点で控除済み。ここで引くと二重控除になる。
  // この安全装置が守るのは戦術枠の建玉で、コア枠は対象外 (3年持つ前提で
  // 損切りもキルスイッチも効かない)。同じ器に入れていたせいで、目標85%まで
  // 積むほどエクスポージャーが上がり、スコア9点で新規停止に張り付いていた。
  const positions = getPositions();
  // 資本は直近サイクルで実測した NAV。startCapitalJPY は入金を反映しないので、
  // ¥50,000 入れた後もエクスポージャーが 94.8% と実態より悪く出ていた。
  const capitalJPY = state.lastNavJPY > 0
    ? state.lastNavJPY
    : cumulative.startCapitalJPY > 0
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

/**
 * 取引所の約定履歴から実績を取り直してキャッシュする。
 * fetchExecutions は数秒かかるので、画面のポーリング経路では呼ばない。
 * サイクルの中で更新し、表示はキャッシュを読む。
 */
async function refreshExchangePnL(): Promise<void> {
  const exchange = getExchange();
  if (!exchange.fetchExecutions) return;
  // 取引所は古い約定を返しきらない。取れた分だけで集計すると過去の売買が
  // 勝手に消えて数字が縮む (購入代金が ¥1,392,447 と ¥1,211,654 の2通り出ていた)。
  // 保管庫に貯めた和集合から出す。
  const archive = await refreshArchive(exchange, state.pairs);
  const executions = flattenArchive(archive, state.pairs);
  if (executions.length === 0) return;
  const summary = computeLifetimePnL(executions);
  let realizedJPY = 0, closedTrades = 0, wins = 0, losses = 0, buyVolumeJPY = 0, sellVolumeJPY = 0;
  let grossProfitJPY = 0, grossLossJPY = 0;
  for (const row of summary.byPair) {
    if (!state.pairs.includes(row.pair)) continue;
    realizedJPY += row.realizedPnL;
    closedTrades += row.closedTrades;
    wins += row.wins;
    losses += row.losses;
    buyVolumeJPY += row.buyVolume;
    sellVolumeJPY += row.sellVolume;
    grossProfitJPY += row.grossProfit ?? 0;
    grossLossJPY += row.grossLoss ?? 0;
  }
  state.exchangePnL = {
    realizedJPY, closedTrades, wins, losses, buyVolumeJPY, sellVolumeJPY,
    grossProfitJPY, grossLossJPY,
    recentCloses: (summary.closes ?? []).slice(-EDGE_WINDOW_TRADES).map((c) => c.pnlJPY),
    at: new Date().toISOString(),
  };
  console.log(`[pnl] 取引所ベース更新: 確定 ¥${Math.round(realizedJPY).toLocaleString()} / ${closedTrades}決済 (${wins}W ${losses}L)`);
}

export function getCumulativePnL() {
  const trades = state.paperMode ? state.paperTrader.getTrades() : state.liveTrades;
  const sells = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const totalFees = trades.reduce((sum, t) => sum + (t.fee ?? 0), 0);
  // 【確定損益は取引所の約定履歴を正とする】アプリ側の pnl は建玉の取得単価から
  // 計算しているが、その取得単価に複数のバグがあった (コア枠の混入 /
  // 端数を分母にして実勢の19倍になる)。同じ画面に「188決済 WR34% -¥5,256」と
  // 「128決済 WR38% -¥11,583」が並ぶ状態を解消する。
  // 取引所から取れていないときだけアプリ側にフォールバックする。
  const fromExchange = state.paperMode ? null : state.exchangePnL;
  const closedTrades = fromExchange ? fromExchange.closedTrades : sells.length;
  const totalRealizedPnL = fromExchange
    ? fromExchange.realizedJPY
    : sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const wins = fromExchange ? fromExchange.wins : sells.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = fromExchange ? fromExchange.losses : sells.filter(t => (t.pnl ?? 0) < 0).length;

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
    closedTrades,
    wins,
    losses,
    // 【分子と分母を同じ出所にする】wins は取引所ベース (63) なのに分母だけ
    // アプリ側の sells.length (128) を使っていたため、63/128 = 49.2% と出て
    // いた。同じ画面の別パネルは 63/188 = 34% で、勝率が2つ存在していた。
    winRate: closedTrades > 0 ? (wins / closedTrades) * 100 : 0,
    positionValueJPY,
    firstTradeDate: trades.length > 0 ? trades[0].timestamp : null,
    lastTradeDate: trades.length > 0 ? trades[trades.length - 1].timestamp : null,
  };
}

export async function runSingleCycle(): Promise<void> {
  await runCycle();
}
