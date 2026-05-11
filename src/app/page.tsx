"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import type { BotStatus, Position, DailyPnL, AIDecision, TickerData, TradeRecord } from "@/lib/types";
import { BITFLYER_PAIRS } from "@/lib/types";

interface StatusData {
  status: BotStatus;
  positions: Position[];
  dailyPnL: DailyPnL;
  cumulativePnL: {
    startCapitalJPY: number;
    totalRealizedPnL: number;
    unrealizedPnL: number;
    totalPnL: number;
    totalPnLPercent: number;
    totalFees: number;
    netPnL: number;
    totalTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    positionValueJPY: number;
  };
  recentDecisions: AIDecision[];
}

interface OHLCVBar {
  timestamp: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  body?: string;
  categories?: string[];
}

interface PnLSnapshot {
  timestamp: string;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  trades: number;
}

interface LifetimeSummary {
  totalRealizedPnL: number;
  totalFees: number;
  netRealizedPnL: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalBuyVolumeJPY: number;
  totalSellVolumeJPY: number;
  byPair: {
    pair: string;
    realizedPnL: number;
    closedTrades: number;
    wins: number;
    losses: number;
    totalFees: number;
    remainingInventory: number;
    averageBuyPrice: number;
  }[];
  firstTradeTimestamp: number | null;
  lastTradeTimestamp: number | null;
  executionCount: number;
}

interface LifetimeResponse {
  summary: LifetimeSummary;
  cachedAt: string;
  fetchedNow: boolean;
}

interface NavSnapshot {
  timestamp: string;
  jpy: number;
  cryptoValueJPY: number;
  total: number;
  positions?: Record<string, { amount: number; price: number; valueJPY: number }>;
}

interface NavDelta {
  total: number;
  percent: number;
  fromTimestamp: string;
}

interface NavResponse {
  current: NavSnapshot | null;
  first: NavSnapshot | null;
  delta24h: NavDelta | null;
  delta7d: NavDelta | null;
  delta30d: NavDelta | null;
  deltaLifetime: NavDelta | null;
  history: NavSnapshot[];
}

interface DiagnosticsResponse {
  window: number;
  byAction: { BUY: number; SELL: number; HOLD: number };
  filters: { rejectedByMTF: number; rejectedByEV: number; calibrationApplied: number };
  byPair: Record<string, { total: number; buy: number; sell: number; hold: number }>;
  hasOpenPosition?: boolean;
  sample: { timestamp: string; pair: string; action: string; confidence: number; reason: string }[];
}

interface LearningResponse {
  active: Record<string, number>;
  summary: {
    baseline: Record<string, number>;
    learned: Record<string, number>;
    perSignal: { name: string; total: number; correct: number; accuracy: number; weightMultiplier: number }[];
    totalAudits: number;
    completedAudits: number;
    ready: boolean;
  };
}

interface TimingAnalysis {
  days: number;
  fng: {
    avg: number;
    extremeDays: number;
    fearDays: number;
    greedDays: number;
    history: { value: number; classification: string; date: string }[];
  };
  pairs: {
    pair: string;
    days: number;
    firstClose: number;
    lastClose: number;
    changePercent: number;
    regimes: Record<string, number>;
  }[];
  botActivity: { totalTrades: number; buys: number; sells: number; realizedPnL: number };
  buyHoldAvgReturnPercent: number;
  verdicts: string[];
}

const ACCENT = { green: "#22c55e", red: "#ef4444", blue: "#3b82f6", purple: "#8b5cf6", amber: "#f59e0b", cyan: "#06b6d4" };
const PIE_COLORS = [ACCENT.blue, ACCENT.purple, ACCENT.cyan, ACCENT.amber, ACCENT.green];

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}時間前`;
  return `${Math.floor(hrs / 24)}日前`;
}

export default function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [priceHistory, setPriceHistory] = useState<Record<string, OHLCVBar[]>>({});
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [pnlHistory, setPnlHistory] = useState<PnLSnapshot[]>([]);
  const [lifetime, setLifetime] = useState<LifetimeResponse | null>(null);
  const [lifetimeLoading, setLifetimeLoading] = useState(false);
  const [nav, setNav] = useState<NavResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [learning, setLearning] = useState<LearningResponse | null>(null);
  const [timing, setTiming] = useState<TimingAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePair, setActivePair] = useState("ETH/JPY");

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, tradesRes, ...tickerResults] = await Promise.all([
        fetch("/api/bot/status"),
        fetch("/api/trades"),
        ...BITFLYER_PAIRS.map(pair =>
          fetch(`/api/exchange/ticker?pair=${encodeURIComponent(pair)}`).catch(() => null)
        ),
      ]);

      if (statusRes.ok) setData(await statusRes.json());
      if (tradesRes.ok) {
        const t = await tradesRes.json();
        setTrades(Array.isArray(t) ? t : []);
      }

      const newTickers: Record<string, TickerData> = {};
      for (let i = 0; i < BITFLYER_PAIRS.length; i++) {
        const res = tickerResults[i];
        if (res && res.ok) {
          const t = await res.json();
          if (!t.error) newTickers[BITFLYER_PAIRS[i]] = t;
        }
      }
      setTickers(newTickers);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 価格履歴・ニュース・PnL履歴は低頻度で取得
  const fetchSlowData = useCallback(async () => {
    try {
      const pairs = ["ETH/JPY", "XRP/JPY"];
      const results = await Promise.all([
        ...pairs.map(p =>
          fetch(`/api/exchange/ohlcv?pair=${encodeURIComponent(p)}&timeframe=1h&limit=48`).then(r => r.ok ? r.json() : []).catch(() => [])
        ),
        fetch("/api/news").then(r => r.ok ? r.json() : { articles: [] }).catch(() => ({ articles: [] } as { articles: NewsItem[] })),
        fetch("/api/data/pnl-history").then(r => r.ok ? r.json() : []).catch(() => []),
      ]);

      const hist: Record<string, OHLCVBar[]> = {};
      pairs.forEach((p, i) => { hist[p] = results[i]; });
      setPriceHistory(hist);
      const newsData = results[pairs.length];
      setNews(Array.isArray(newsData?.articles) ? newsData.articles : []);
      const pnlData = results[pairs.length + 1];
      setPnlHistory(Array.isArray(pnlData) ? pnlData : []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const fetchLifetime = useCallback(async (refresh = false) => {
    setLifetimeLoading(true);
    try {
      const res = await fetch(`/api/bot/lifetime${refresh ? "?refresh=1" : ""}`);
      if (res.ok) {
        const data = (await res.json()) as LifetimeResponse;
        setLifetime(data);
      }
    } catch (e) {
      console.error("lifetime fetch失敗:", e);
    } finally {
      setLifetimeLoading(false);
    }
  }, []);

  const fetchNav = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/nav");
      if (res.ok) {
        const data = (await res.json()) as NavResponse;
        setNav(data);
      }
    } catch (e) {
      console.error("nav fetch失敗:", e);
    }
  }, []);

  const fetchDiagnostics = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/diagnostics");
      if (res.ok) {
        const data = (await res.json()) as DiagnosticsResponse;
        setDiagnostics(data);
      }
    } catch (e) {
      console.error("diagnostics fetch失敗:", e);
    }
  }, []);

  const fetchLearning = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/learning");
      if (res.ok) {
        const data = (await res.json()) as LearningResponse;
        setLearning(data);
      }
    } catch (e) {
      console.error("learning fetch失敗:", e);
    }
  }, []);

  const fetchTiming = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/timing-analysis");
      if (res.ok) {
        const data = (await res.json()) as TimingAnalysis;
        setTiming(data);
      }
    } catch (e) {
      console.error("timing fetch失敗:", e);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchSlowData();
    fetchLifetime();
    fetchNav();
    fetchDiagnostics();
    fetchLearning();
    fetchTiming();
    const fast = setInterval(fetchData, 15000);
    const slow = setInterval(fetchSlowData, 300000); // 5分ごと
    const navInt = setInterval(fetchNav, 60_000); // 1分ごと
    const diagInt = setInterval(fetchDiagnostics, 60_000); // 1分ごと
    const learnInt = setInterval(fetchLearning, 5 * 60_000); // 5分ごと
    const timingInt = setInterval(fetchTiming, 60 * 60_000); // 1時間ごと
    const lifeInt = setInterval(() => fetchLifetime(), 30 * 60 * 1000); // 30分ごと
    return () => { clearInterval(fast); clearInterval(slow); clearInterval(navInt); clearInterval(diagInt); clearInterval(learnInt); clearInterval(timingInt); clearInterval(lifeInt); };
  }, [fetchData, fetchSlowData, fetchLifetime, fetchNav, fetchDiagnostics, fetchLearning, fetchTiming]);

  if (loading) {
    return <div className="text-center py-20 text-zinc-500">読み込み中...</div>;
  }

  const pnl = data?.dailyPnL;
  const cum = data?.cumulativePnL;
  const status = data?.status;

  // ポートフォリオ構成データ: NAV API (全currency集計済み) から構築。
  // 旧コードは state.livePositions (state.pairs限定) しか出してなかった
  const balanceData: { name: string; value: number }[] = [];
  if (nav?.current) {
    if (nav.current.jpy > 0) {
      balanceData.push({ name: "JPY", value: Math.round(nav.current.jpy) });
    }
    for (const [pair, p] of Object.entries(nav.current.positions ?? {})) {
      if (p.valueJPY > 0.01) {
        balanceData.push({ name: pair.split("/")[0], value: Math.round(p.valueJPY) });
      }
    }
  }

  // 価格チャート用データ
  const chartBars = (priceHistory[activePair] || []).map(b => ({
    time: new Date(b.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }),
    price: b.close,
    volume: b.volume,
  }));

  // トレード損益チャート用データ
  const tradeChartData = trades
    .filter(t => t.side === "sell" && t.pnl !== undefined)
    .map(t => ({
      time: new Date(t.timestamp).toLocaleDateString("ja-JP", { month: "short", day: "numeric", timeZone: "Asia/Tokyo" }),
      pnl: Math.round(t.pnl ?? 0),
    }));

  // 生涯損益の判定（BitFlyer 確定 + 現在の含み損益）
  const lifetimeUnrealized = lifetime?.summary.byPair.reduce((sum, p) => {
    const t = tickers[p.pair];
    if (!t || p.remainingInventory <= 0 || p.averageBuyPrice <= 0) return sum;
    return sum + (t.price - p.averageBuyPrice) * p.remainingInventory;
  }, 0) ?? 0;
  const lifetimeRealized = lifetime?.summary.netRealizedPnL ?? 0;
  const lifetimeTotalPnL = lifetimeRealized + lifetimeUnrealized;
  const daysSinceFirst = lifetime?.summary.firstTradeTimestamp
    ? Math.max(1, Math.floor((Date.now() - lifetime.summary.firstTradeTimestamp) / (1000 * 60 * 60 * 24)))
    : 0;
  // 現在の運用元本推定: 累計買付金額 - 累計売却金額 + 残在庫の取得原価 = 投じた純額
  const lifetimeNetInflow =
    (lifetime?.summary.totalBuyVolumeJPY ?? 0) - (lifetime?.summary.totalSellVolumeJPY ?? 0);
  // verdict ラベルは削除。色 (緑/赤) と数字でだけ表現する

  return (
    <div className="space-y-5">
      {/* ステータスバー */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${
          status?.running ? "bg-green-900/50 text-green-400" : "bg-zinc-800 text-zinc-400"
        }`}>
          <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-zinc-600"}`} />
          {status?.running ? "稼働中" : "停止"}
        </span>
        {!status?.paperMode && status?.running && (
          <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-400 font-medium">LIVE</span>
        )}
        {status?.circuitBreakerState === "TRIGGERED" && (
          <span className="px-2 py-0.5 rounded text-xs bg-red-900/50 text-red-400 font-medium">CB発動</span>
        )}
        <span className="text-xs text-zinc-600 ml-auto">Cycle #{status?.cycleCount ?? 0}</span>
      </div>

      {/* 累計損益バナー: 色だけで判定、文言は中立 */}
      {lifetime ? (
        <div className={`rounded-2xl p-5 border-2 ${
          lifetimeTotalPnL > 0 ? "border-green-500/40 bg-gradient-to-br from-green-950/40 to-zinc-950" :
          lifetimeTotalPnL < 0 ? "border-red-500/40 bg-gradient-to-br from-red-950/40 to-zinc-950" :
          "border-zinc-700 bg-gradient-to-br from-zinc-900 to-zinc-950"
        }`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  累計損益
                </span>
                <span className="text-[10px] text-zinc-600">
                  BitFlyer全期間 (確定 + 含み)
                </span>
              </div>
              <div className={`text-4xl font-black font-mono leading-tight ${
                lifetimeTotalPnL >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {lifetimeTotalPnL >= 0 ? "+" : ""}¥{Math.round(lifetimeTotalPnL).toLocaleString()}
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                確定 <span className={lifetimeRealized >= 0 ? "text-green-400" : "text-red-400"}>
                  {lifetimeRealized >= 0 ? "+" : ""}¥{Math.round(lifetimeRealized).toLocaleString()}
                </span>
                <span className="mx-1.5 text-zinc-700">/</span>
                含み <span className={lifetimeUnrealized >= 0 ? "text-green-400" : "text-red-400"}>
                  {lifetimeUnrealized >= 0 ? "+" : ""}¥{Math.round(lifetimeUnrealized).toLocaleString()}
                </span>
                {daysSinceFirst > 0 && (
                  <>
                    <span className="mx-1.5 text-zinc-700">/</span>
                    {daysSinceFirst}日経過
                  </>
                )}
              </div>
            </div>
            <div className="text-right text-[11px] text-zinc-500 leading-snug">
              <div>純投入額: <span className="font-mono text-zinc-300">¥{Math.round(lifetimeNetInflow).toLocaleString()}</span></div>
              <div>決済 {lifetime.summary.closedTrades}回 (<span className="text-green-400">{lifetime.summary.wins}W</span> <span className="text-red-400">{lifetime.summary.losses}L</span>) WR {lifetime.summary.winRate.toFixed(0)}%</div>
              <div>手数料 ¥{Math.round(lifetime.summary.totalFees).toLocaleString()}</div>
            </div>
          </div>

          {/* 総資産推移 — このアプリが意味あるかどうかの最重要指標 */}
          {nav?.current && (() => {
            const lifetime = nav.deltaLifetime;
            const lifetimeUp = (lifetime?.total ?? 0) >= 0;
            const navChartData = (nav.history ?? []).map((h) => ({
              t: new Date(h.timestamp).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }),
              total: Math.round(h.total),
            }));
            const startDateStr = nav.first ? new Date(nav.first.timestamp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" }) : "-";
            return (
              <div className={`mt-4 pt-4 border-t-2 ${lifetimeUp ? "border-green-700/60" : "border-red-700/60"}`}>
                <div className="text-[10px] text-zinc-400 uppercase tracking-wider mb-2 font-bold">📊 総資産推移 (参考)</div>
                <div className="flex items-baseline gap-2 flex-wrap mb-1">
                  <span className="text-2xl font-bold font-mono text-zinc-100">
                    ¥{Math.round(nav.current.total).toLocaleString()}
                  </span>
                  {lifetime && (
                    <span className={`text-sm font-mono ${lifetimeUp ? "text-green-400/70" : "text-red-400/70"}`}>
                      {lifetimeUp ? "▲+" : "▼"}¥{Math.round(lifetime.total).toLocaleString()} ({lifetimeUp ? "+" : ""}{lifetime.percent.toFixed(1)}%)
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-amber-500/70 mb-2 leading-snug">
                  ⚠ この差額は <strong>入金/出金 + 暗号通貨の値動き + bot 取引</strong> の合計。bot 単体成績は上の「累計損益」を見る。
                </div>
                {nav.first && (
                  <div className="text-[11px] text-zinc-500 mb-2">
                    開始 {startDateStr} ¥{Math.round(nav.first.total).toLocaleString()} → 現在 ¥{Math.round(nav.current.total).toLocaleString()}
                    <span className="text-zinc-600 ml-2">
                      (JPY ¥{Math.round(nav.current.jpy).toLocaleString()} + 暗号通貨 ¥{Math.round(nav.current.cryptoValueJPY).toLocaleString()})
                    </span>
                  </div>
                )}
                {navChartData.length >= 2 && (
                  <div className="h-24 mb-3 -mx-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={navChartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                        <defs>
                          <linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={lifetimeUp ? "#22c55e" : "#ef4444"} stopOpacity={0.5} />
                            <stop offset="100%" stopColor={lifetimeUp ? "#22c55e" : "#ef4444"} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <YAxis hide domain={["dataMin - 100", "dataMax + 100"]} />
                        <Tooltip
                          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 11 }}
                          labelStyle={{ color: "#a1a1aa" }}
                          formatter={(v) => [`¥${Number(v).toLocaleString()}`, "総資産"]}
                        />
                        {nav.first && (
                          <CartesianGrid strokeDasharray="2 4" stroke="#52525b" vertical={false} horizontalCoordinatesGenerator={() => []} />
                        )}
                        <Line type="monotone" dataKey="total" stroke={lifetimeUp ? "#22c55e" : "#ef4444"} strokeWidth={1.5} dot={false} />
                        <Area type="monotone" dataKey="total" stroke="none" fill="url(#navGrad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  {[
                    { key: "delta24h", label: "24h", d: nav.delta24h },
                    { key: "delta7d", label: "7日", d: nav.delta7d },
                    { key: "delta30d", label: "30日", d: nav.delta30d },
                    { key: "deltaLifetime", label: "全期間", d: nav.deltaLifetime },
                  ].map(({ key, label, d }) => {
                    if (!d) {
                      return (
                        <div key={key} className="px-2 py-1 rounded bg-zinc-900/60 border border-zinc-800 text-[10px] text-zinc-600">
                          {label}: 履歴不足
                        </div>
                      );
                    }
                    const up = d.total >= 0;
                    return (
                      <div
                        key={key}
                        className={`px-2.5 py-1 rounded border text-xs font-mono flex items-center gap-1 ${
                          up
                            ? "border-green-500/30 bg-green-950/30 text-green-300"
                            : "border-red-500/30 bg-red-950/30 text-red-300"
                        }`}
                      >
                        <span className="text-[10px] opacity-70">{label}</span>
                        <span>{up ? "▲" : "▼"}</span>
                        <span className="font-semibold">{up ? "+" : ""}¥{Math.round(d.total).toLocaleString()}</span>
                        <span className="opacity-70">({up ? "+" : ""}{d.percent.toFixed(2)}%)</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="rounded-2xl p-5 border-2 border-zinc-800 bg-zinc-950/40 text-center text-zinc-500 text-sm">
          {lifetimeLoading ? "BitFlyer履歴から損益を計算中..." : "BitFlyer履歴未取得"}
        </div>
      )}

      {/* サマリーカード */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div className="bg-zinc-900 rounded-xl p-3 border border-zinc-800">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">稼働状況</div>
          <div className="text-lg font-bold font-mono text-zinc-100">
            {status?.cycleCount ?? 0}
            <span className="text-xs text-zinc-500 ml-1 font-sans">サイクル</span>
          </div>
          <div className="text-[10px] text-zinc-500">
            決済 {cum?.closedTrades ?? 0}回 / <span className="text-green-400">{cum?.wins ?? 0}W</span> <span className="text-red-400">{cum?.losses ?? 0}L</span>
            {cum && cum.closedTrades > 0 && ` (WR${cum.winRate.toFixed(0)}%)`}
          </div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-3 border border-zinc-800">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">本日損益</div>
          <div className={`text-lg font-bold font-mono ${(pnl?.totalPnL ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            ¥{(pnl?.totalPnL ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[10px] text-zinc-500">{pnl?.wins ?? 0}W {pnl?.losses ?? 0}L</div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-3 border border-zinc-800">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">累計損益</div>
          <div className={`text-lg font-bold font-mono ${(cum?.totalPnL ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            ¥{(cum?.totalPnL ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[10px] text-zinc-500">{cum?.closedTrades ?? 0}回決済 WR{(cum?.winRate ?? 0).toFixed(0)}%</div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-3 border border-zinc-800">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">運用資金</div>
          <div className="text-lg font-bold font-mono">
            ¥{(pnl?.startCapitalJPY ?? 0).toLocaleString()}
          </div>
          <div className="text-[10px] text-zinc-500">リスク使用 {pnl && pnl.startCapitalJPY > 0
            ? `${Math.abs((Math.min(0, pnl.realizedPnL) / pnl.startCapitalJPY) * 100).toFixed(1)}%`
            : "0%"} / 5%</div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-3 border border-zinc-800">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">手数料合計</div>
          <div className="text-lg font-bold font-mono text-zinc-300">
            ¥{(cum?.totalFees ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[10px] text-zinc-500">純利益 ¥{(cum?.netPnL ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
      </div>

      {/* 価格チャート */}
      <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-zinc-400">価格推移 (48h)</h2>
          <div className="flex gap-1">
            {["ETH/JPY", "XRP/JPY"].map(p => (
              <button key={p} onClick={() => setActivePair(p)}
                className={`px-2 py-0.5 rounded text-xs font-medium ${activePair === p ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>
                {p.split("/")[0]}
              </button>
            ))}
          </div>
        </div>
        {chartBars.length > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartBars}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={ACCENT.blue} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={ACCENT.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#71717a" }} interval="preserveStartEnd" />
              <YAxis domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: "#71717a" }} width={65}
                tickFormatter={(v) => `¥${(Number(v) / 1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [`¥${Number(v).toLocaleString()}`, "価格"]} />
              <Area type="monotone" dataKey="price" stroke={ACCENT.blue} fill="url(#priceGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center text-zinc-600 text-sm py-10">データ取得中...</div>
        )}
      </div>

      {/* PnL推移 + ポートフォリオ構成 */}
      <div className="grid grid-cols-2 gap-3">
        {/* 損益推移 */}
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-400 mb-2">損益推移</h2>
          {pnlHistory.length > 0 ? (
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={pnlHistory.map(p => ({
                time: new Date(p.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }),
                pnl: Math.round(p.totalPnL),
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#71717a" }} />
                <YAxis tick={{ fontSize: 9, fill: "#71717a" }} width={40} />
                <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 11 }} />
                <Line type="monotone" dataKey="pnl" stroke={ACCENT.green} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-zinc-600 text-xs py-8">データ蓄積中...</div>
          )}
        </div>

        {/* ポートフォリオ */}
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-400 mb-2">ポートフォリオ</h2>
          {balanceData.length > 0 ? (
            <div className="space-y-1.5">
              {balanceData.map((d, i) => {
                const total = balanceData.reduce((s, x) => s + x.value, 0);
                const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : "0";
                return (
                  <div key={d.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-xs text-zinc-300 w-10">{d.name}</span>
                    <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    </div>
                    <span className="text-[10px] text-zinc-500 w-16 text-right">¥{d.value.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center text-zinc-600 text-xs py-8">ポジションなし</div>
          )}
        </div>
      </div>

      {/* トレード損益バー */}
      {tradeChartData.length > 0 && (
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-400 mb-2">取引損益</h2>
          <ResponsiveContainer width="100%" height={100}>
            <BarChart data={tradeChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#71717a" }} />
              <YAxis tick={{ fontSize: 9, fill: "#71717a" }} width={40} />
              <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="pnl" fill={ACCENT.green} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* BitFlyer 生涯損益（取引所側の全約定履歴ベース） */}
      <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-200">Bot 取引履歴 損益 (BTC/ETH/XRP)</h2>
            <div className="text-[10px] text-zinc-600">
              取引所APIの全約定履歴からFIFO計算。Bot対象ペア限定 (XLM/MONA等の口座保有は別)
            </div>
          </div>
          <button
            onClick={() => fetchLifetime(true)}
            disabled={lifetimeLoading}
            className="px-2.5 py-1 text-[10px] rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300"
          >
            {lifetimeLoading ? "更新中..." : "BitFlyer再取得"}
          </button>
        </div>
        {lifetime ? (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="bg-zinc-950/40 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500">確定損益 (決済済み)</div>
                <div className={`text-lg font-bold font-mono ${lifetime.summary.netRealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {lifetime.summary.netRealizedPnL >= 0 ? "+" : ""}¥{Math.round(lifetime.summary.netRealizedPnL).toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">
                  決済 {lifetime.summary.closedTrades}回 (<span className="text-green-400">{lifetime.summary.wins}W</span> <span className="text-red-400">{lifetime.summary.losses}L</span>) WR {lifetime.summary.winRate.toFixed(0)}%
                </div>
              </div>
              <div className="bg-zinc-950/40 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500">含み損益 (残在庫)</div>
                <div className={`text-lg font-bold font-mono ${lifetimeUnrealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {lifetimeUnrealized >= 0 ? "+" : ""}¥{Math.round(lifetimeUnrealized).toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">現在価格で評価</div>
              </div>
              <div className="bg-zinc-950/40 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500">合計 (確定+含み)</div>
                <div className={`text-lg font-bold font-mono ${lifetimeTotalPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {lifetimeTotalPnL >= 0 ? "+" : ""}¥{Math.round(lifetimeTotalPnL).toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">
                  手数料 ¥{Math.round(lifetime.summary.totalFees).toLocaleString()} / 約定 {lifetime.summary.executionCount}件
                </div>
              </div>
            </div>
            {lifetime.summary.byPair.length > 0 && (
              <div className="space-y-1">
                {lifetime.summary.byPair.map((p) => {
                  const t = tickers[p.pair];
                  const unrealized = t && p.remainingInventory > 0 && p.averageBuyPrice > 0
                    ? (t.price - p.averageBuyPrice) * p.remainingInventory
                    : 0;
                  const investedJPY = p.remainingInventory * p.averageBuyPrice;
                  const currentJPY = t && p.remainingInventory > 0 ? p.remainingInventory * t.price : 0;
                  return (
                    <div key={p.pair} className="bg-zinc-950/40 rounded px-3 py-1.5 text-xs">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-zinc-300 w-12 shrink-0">{p.pair.split("/")[0]}</span>
                        <span className="text-zinc-500 text-[10px] w-20 shrink-0">{p.closedTrades}回 ({p.wins}W{p.losses}L)</span>
                        <span className="text-zinc-300 flex-1 text-right">
                          残 <span className="font-mono">{p.remainingInventory.toFixed(4)}</span>
                          {p.remainingInventory > 0 && (
                            <span className="text-zinc-500 ml-1.5">
                              (投入 <span className="font-mono text-zinc-300">¥{Math.round(investedJPY).toLocaleString()}</span>
                              {currentJPY > 0 && (
                                <span> → 評価 <span className={`font-mono ${currentJPY >= investedJPY ? "text-green-400" : "text-red-400"}`}>¥{Math.round(currentJPY).toLocaleString()}</span></span>
                              )})
                            </span>
                          )}
                        </span>
                        <span className={`font-mono w-20 text-right text-[11px] ${p.realizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                          確定 {p.realizedPnL >= 0 ? "+" : ""}{Math.round(p.realizedPnL).toLocaleString()}
                        </span>
                        <span className={`font-mono w-20 text-right text-[11px] ${unrealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                          含み {unrealized >= 0 ? "+" : ""}{Math.round(unrealized).toLocaleString()}
                        </span>
                      </div>
                      {p.remainingInventory > 0 && (
                        <div className="text-[10px] text-zinc-600 ml-14">
                          単価: 平均 ¥{Math.round(p.averageBuyPrice).toLocaleString()}/{p.pair.split("/")[0]}
                          {t && (<span> · 現在 ¥{Math.round(t.price).toLocaleString()}/{p.pair.split("/")[0]}</span>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="text-[10px] text-zinc-700 mt-2">
              キャッシュ: {new Date(lifetime.cachedAt).toLocaleString("ja-JP")}
              {lifetime.summary.firstTradeTimestamp && (
                <span className="ml-2">| 初取引: {new Date(lifetime.summary.firstTradeTimestamp).toLocaleDateString("ja-JP")}</span>
              )}
            </div>
          </>
        ) : (
          <div className="text-center text-zinc-600 text-xs py-4">
            {lifetimeLoading ? "BitFlyerから取得中..." : "未取得"}
          </div>
        )}
      </div>

      {/* 判断パイプライン診断 */}
      {diagnostics && diagnostics.window > 0 && (
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-200">判断パイプライン診断</h2>
            <span className="text-[10px] text-zinc-600">直近{diagnostics.window}判断</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-zinc-950/40 rounded-lg p-2 text-center">
              <div className="text-[10px] text-zinc-500">BUY</div>
              <div className="text-lg font-bold text-green-400 font-mono">{diagnostics.byAction.BUY}</div>
            </div>
            <div className="bg-zinc-950/40 rounded-lg p-2 text-center">
              <div className="text-[10px] text-zinc-500">SELL</div>
              <div className="text-lg font-bold text-red-400 font-mono">{diagnostics.byAction.SELL}</div>
            </div>
            <div className="bg-zinc-950/40 rounded-lg p-2 text-center">
              <div className="text-[10px] text-zinc-500">HOLD</div>
              <div className="text-lg font-bold text-zinc-400 font-mono">{diagnostics.byAction.HOLD}</div>
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 space-y-1 mb-3">
            <div className="flex justify-between">
              <span>MTFフィルタで HOLD化</span>
              <span className="font-mono text-yellow-400">{diagnostics.filters.rejectedByMTF}回</span>
            </div>
            <div className="flex justify-between">
              <span>EVゲートで HOLD化</span>
              <span className="font-mono text-yellow-400">{diagnostics.filters.rejectedByEV}回</span>
            </div>
            <div className="flex justify-between">
              <span>確信度キャリブレーション適用</span>
              <span className="font-mono text-zinc-400">{diagnostics.filters.calibrationApplied}回</span>
            </div>
          </div>
          {diagnostics.byAction.SELL === 0 && diagnostics.byAction.HOLD > 10 && diagnostics.hasOpenPosition && (
            <div className="text-[10px] text-yellow-300/80 bg-yellow-950/20 border border-yellow-800/30 rounded p-2 mb-2">
              ⚠️ ポジション保有中なのに SELL 判断ゼロ。緊急ロスカット番兵 (-5%) のみ売却の可能性あり。
            </div>
          )}
          {diagnostics.byAction.SELL === 0 && diagnostics.byAction.HOLD > 10 && !diagnostics.hasOpenPosition && (
            <div className="text-[10px] text-zinc-500 bg-zinc-950/40 border border-zinc-800/50 rounded p-2 mb-2">
              ℹ️ ポジション無 + HOLD連発 = エッジ無し局面で待機中（仕様通り、F&G中立帯 or 一致度不足）
            </div>
          )}
          <div className="space-y-1">
            {diagnostics.sample.slice(0, 6).map((d, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px] bg-zinc-950/30 rounded px-2 py-1">
                <span className="text-zinc-600 shrink-0 font-mono">
                  {new Date(d.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}
                </span>
                <span className="text-zinc-400 shrink-0 w-12">{d.pair.split("/")[0]}</span>
                <span
                  className={`shrink-0 font-bold w-12 ${
                    d.action === "BUY" ? "text-green-400" : d.action === "SELL" ? "text-red-400" : "text-zinc-500"
                  }`}
                >
                  {d.action}
                </span>
                <span className="text-zinc-600 shrink-0 w-10">{d.confidence}%</span>
                <span className="text-zinc-500 truncate">{d.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 市場環境タイミング分析: 「タイミング悪かったか」を客観評価 */}
      {timing && (
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-200">市場環境タイミング分析 (直近{timing.days}日)</h2>
            <button
              onClick={fetchTiming}
              className="px-2 py-0.5 text-[10px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
            >
              更新
            </button>
          </div>

          {/* F&G + Buy&Hold + Bot活動 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <div className="bg-zinc-950/40 rounded-lg p-2">
              <div className="text-[10px] text-zinc-500">F&G 平均</div>
              <div className={`text-lg font-bold font-mono ${
                timing.fng.avg < 30 ? "text-green-400" :
                timing.fng.avg > 70 ? "text-red-400" : "text-zinc-300"
              }`}>{timing.fng.avg.toFixed(0)}</div>
              <div className="text-[10px] text-zinc-600">
                Fear {timing.fng.fearDays}日 / Greed {timing.fng.greedDays}日
              </div>
            </div>
            <div className="bg-zinc-950/40 rounded-lg p-2">
              <div className="text-[10px] text-zinc-500">エントリー機会</div>
              <div className={`text-lg font-bold font-mono ${
                timing.fng.extremeDays >= 5 ? "text-green-400" : "text-orange-400"
              }`}>{timing.fng.extremeDays}日</div>
              <div className="text-[10px] text-zinc-600">F&G extreme日数</div>
            </div>
            <div className="bg-zinc-950/40 rounded-lg p-2">
              <div className="text-[10px] text-zinc-500">Buy&amp;Hold 平均</div>
              <div className={`text-lg font-bold font-mono ${
                timing.buyHoldAvgReturnPercent > 0 ? "text-green-400" :
                timing.buyHoldAvgReturnPercent < 0 ? "text-red-400" : "text-zinc-300"
              }`}>
                {timing.buyHoldAvgReturnPercent > 0 ? "+" : ""}{timing.buyHoldAvgReturnPercent.toFixed(1)}%
              </div>
              <div className="text-[10px] text-zinc-600">3通貨平均</div>
            </div>
            <div className="bg-zinc-950/40 rounded-lg p-2">
              <div className="text-[10px] text-zinc-500">Bot 取引</div>
              <div className="text-lg font-bold font-mono text-zinc-300">
                {timing.botActivity.totalTrades}回
              </div>
              <div className="text-[10px] text-zinc-600">
                <span className="text-green-400">B{timing.botActivity.buys}</span> / <span className="text-red-400">S{timing.botActivity.sells}</span>
                {timing.botActivity.realizedPnL !== 0 && (
                  <span className={`ml-1 ${timing.botActivity.realizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                    ¥{timing.botActivity.realizedPnL.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ペア別レジーム分布 */}
          <div className="space-y-1.5 mb-3">
            {timing.pairs.map(p => {
              const total = (p.regimes.TRENDING_UP ?? 0) + (p.regimes.TRENDING_DOWN ?? 0) + (p.regimes.RANGING ?? 0) + (p.regimes.VOLATILE ?? 0);
              const upPct = total > 0 ? ((p.regimes.TRENDING_UP ?? 0) / total) * 100 : 0;
              const downPct = total > 0 ? ((p.regimes.TRENDING_DOWN ?? 0) / total) * 100 : 0;
              const rangePct = total > 0 ? ((p.regimes.RANGING ?? 0) / total) * 100 : 0;
              const volPct = total > 0 ? ((p.regimes.VOLATILE ?? 0) / total) * 100 : 0;
              return (
                <div key={p.pair} className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-zinc-300 w-12 shrink-0">{p.pair.split("/")[0]}</span>
                  <span className={`font-mono w-16 shrink-0 ${
                    p.changePercent >= 0 ? "text-green-400" : "text-red-400"
                  }`}>
                    {p.changePercent >= 0 ? "+" : ""}{p.changePercent.toFixed(1)}%
                  </span>
                  <div className="flex-1 flex h-3 rounded overflow-hidden bg-zinc-800/50">
                    {upPct > 0 && <div className="bg-green-500/60" style={{ width: `${upPct}%` }} title={`上昇${p.regimes.TRENDING_UP}日`} />}
                    {rangePct > 0 && <div className="bg-zinc-500/60" style={{ width: `${rangePct}%` }} title={`レンジ${p.regimes.RANGING}日`} />}
                    {volPct > 0 && <div className="bg-yellow-500/60" style={{ width: `${volPct}%` }} title={`高ボラ${p.regimes.VOLATILE}日`} />}
                    {downPct > 0 && <div className="bg-red-500/60" style={{ width: `${downPct}%` }} title={`下降${p.regimes.TRENDING_DOWN}日`} />}
                  </div>
                  <span className="text-[10px] text-zinc-600 w-24 text-right">
                    上{p.regimes.TRENDING_UP ?? 0}/下{p.regimes.TRENDING_DOWN ?? 0}/横{p.regimes.RANGING ?? 0}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 結論 */}
          <div className="border-t border-zinc-800 pt-2 space-y-1">
            <div className="text-[10px] text-zinc-500 font-semibold uppercase mb-1">結論</div>
            {timing.verdicts.map((v, i) => (
              <div key={i} className="text-xs text-zinc-300 flex gap-2">
                <span className="text-purple-400 shrink-0">▸</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase 2 自己改善: シグナル別の実勝率と学習ウェイト */}
      {learning && (
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-zinc-200">シグナル学習状態</h2>
              <div className="text-[10px] text-zinc-600">
                {learning.summary.ready
                  ? `学習適用中 (完了取引${learning.summary.completedAudits}件)`
                  : `データ蓄積中 (完了取引${learning.summary.completedAudits}件 / シグナル毎30件以上で発動)`}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            {learning.summary.perSignal.map((s) => {
              const baseline = learning.summary.baseline[s.name] ?? 1.0;
              const active = learning.active[s.name] ?? baseline;
              const changed = Math.abs(active - baseline) > 0.01;
              return (
                <div key={s.name} className="flex items-center gap-2 text-xs bg-zinc-950/40 rounded px-3 py-1.5">
                  <span className="font-medium text-zinc-300 w-32 shrink-0">{s.name}</span>
                  <span className="text-zinc-500 w-20 shrink-0 font-mono">{s.correct}/{s.total}</span>
                  <span
                    className={`w-14 shrink-0 font-mono ${
                      s.total < 30 ? "text-zinc-600" :
                      s.accuracy > 0.55 ? "text-green-400" :
                      s.accuracy < 0.45 ? "text-red-400" : "text-zinc-400"
                    }`}
                  >
                    {s.total > 0 ? `${(s.accuracy * 100).toFixed(0)}%` : "—"}
                  </span>
                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-zinc-600 text-[10px]">基準 {baseline.toFixed(1)}</span>
                    <span className="text-zinc-700">→</span>
                    <span
                      className={`text-[10px] font-mono ${
                        changed ? (active > baseline ? "text-green-400" : "text-orange-400") : "text-zinc-500"
                      }`}
                    >
                      実効 {active.toFixed(2)}
                      {changed && (active > baseline ? " ▲" : " ▼")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {!learning.summary.ready && (
            <div className="text-[10px] text-zinc-700 mt-2">
              監査ログが各シグナル30件以上溜まると自動的に重み調整が発動します。それまでは baseline ウェイトで運用。
            </div>
          )}
        </div>
      )}

      {/* 市場価格 */}
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-2">市場価格</h2>
        <div className="grid grid-cols-2 gap-2">
          {BITFLYER_PAIRS.slice(0, 4).map(pair => {
            const t = tickers[pair];
            if (!t) return null;
            const isUp = t.changePercent24h >= 0;
            return (
              <div key={pair} className="bg-zinc-900 rounded-lg px-3 py-2 border border-zinc-800">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{pair.split("/")[0]}</span>
                  <span className={`text-xs font-mono ${isUp ? "text-green-400" : "text-red-400"}`}>
                    {isUp ? "+" : ""}{t.changePercent24h.toFixed(1)}%
                  </span>
                </div>
                <div className="font-mono text-sm mt-0.5">¥{t.price.toLocaleString()}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* アクティブポジション */}
      {data?.positions && data.positions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-2">ポジション</h2>
          <div className="space-y-1.5">
            {data.positions.map(pos => (
              <div key={pos.pair} className="bg-zinc-900 rounded-lg px-3 py-2 border border-zinc-800 flex justify-between items-center">
                <div>
                  <span className="font-medium text-sm">{pos.pair.split("/")[0]}</span>
                  <span className="text-xs text-zinc-500 ml-2">{pos.amount.toFixed(6)}</span>
                </div>
                <div className={`font-mono text-sm ${pos.unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                  ¥{pos.unrealizedPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI判断 */}
      {data?.recentDecisions && data.recentDecisions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-2">AI判断</h2>
          <div className="space-y-1">
            {data.recentDecisions.slice(-6).reverse().map((d, i) => (
              <div key={i} className="flex items-start gap-2 text-xs bg-zinc-900/50 rounded-lg px-3 py-1.5">
                <span className={`font-mono font-bold shrink-0 ${
                  d.action === "BUY" ? "text-green-400" : d.action === "SELL" ? "text-red-400" : "text-zinc-500"
                }`}>{d.action}</span>
                <span className="text-zinc-400 shrink-0">{d.pair.split("/")[0]}</span>
                <span className="text-zinc-600 shrink-0">{d.confidence}%</span>
                <span className="text-zinc-500 truncate">{d.reason?.slice(0, 60)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ニュースフィード */}
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-2">暗号通貨ニュース</h2>
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {news.length > 0 ? news.map((n, i) => (
            <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
              className="block bg-zinc-900/50 rounded-lg px-3 py-2 border border-zinc-800/50 hover:border-zinc-700 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-200 line-clamp-2">{n.title}</div>
                  {n.body && <div className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{n.body}</div>}
                </div>
                <div className="text-[10px] text-zinc-600 shrink-0 text-right">
                  <div>{n.source}</div>
                  <div>{timeAgo(n.publishedAt)}</div>
                </div>
              </div>
              {n.categories && n.categories.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {n.categories.slice(0, 3).map(c => (
                    <span key={c} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{c}</span>
                  ))}
                </div>
              )}
            </a>
          )) : (
            <div className="text-center text-zinc-600 text-sm py-6">ニュースなし</div>
          )}
        </div>
      </div>
    </div>
  );
}
