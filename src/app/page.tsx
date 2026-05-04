"use client";

import { useState, useEffect, useCallback } from "react";
import type { BotStatus, Position, DailyPnL, AIDecision, TickerData } from "@/lib/types";
import { BITFLYER_PAIRS } from "@/lib/types";

interface StatusData {
  status: BotStatus;
  positions: Position[];
  dailyPnL: DailyPnL;
  recentDecisions: AIDecision[];
}

export default function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, ...tickerResults] = await Promise.all([
        fetch("/api/bot/status"),
        ...BITFLYER_PAIRS.map(pair =>
          fetch(`/api/exchange/ticker?pair=${encodeURIComponent(pair)}`).catch(() => null)
        ),
      ]);

      if (statusRes.ok) {
        setData(await statusRes.json());
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

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (loading) {
    return <div className="text-center py-20 text-zinc-500">読み込み中...</div>;
  }

  const pnl = data?.dailyPnL;
  const status = data?.status;

  return (
    <div className="space-y-6">
      {/* Bot Status */}
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${
          status?.running ? "bg-green-900/50 text-green-400" : "bg-zinc-800 text-zinc-400"
        }`}>
          <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-zinc-600"}`} />
          {status?.running ? "稼働中" : "停止"}
        </span>
        {status?.paperMode && (
          <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400 font-medium">
            ペーパーモード
          </span>
        )}
        {status?.circuitBreakerState === "TRIGGERED" && (
          <span className="px-2 py-0.5 rounded text-xs bg-red-900/50 text-red-400 font-medium">
            サーキットブレーカー発動
          </span>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="text-xs text-zinc-500 mb-1">本日損益</div>
          <div className={`text-xl font-bold ${(pnl?.totalPnL ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            ¥{(pnl?.totalPnL ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {pnl ? `${pnl.wins}勝 ${pnl.losses}敗` : "0勝 0敗"}
          </div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="text-xs text-zinc-500 mb-1">サイクル</div>
          <div className="text-xl font-bold">{status?.cycleCount ?? 0}</div>
          <div className="text-xs text-zinc-500 mt-1">
            {status?.activePairs?.length ?? 0}ペア稼働
          </div>
        </div>
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div className="text-xs text-zinc-500 mb-1">リスク使用</div>
          <div className="text-xl font-bold">
            {pnl && pnl.startCapitalJPY > 0
              ? `${Math.abs((Math.min(0, pnl.realizedPnL) / pnl.startCapitalJPY) * 100).toFixed(1)}%`
              : "0%"}
          </div>
          <div className="text-xs text-zinc-500 mt-1">上限2%</div>
        </div>
      </div>

      {/* Live Prices */}
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-2">市場価格</h2>
        <div className="space-y-2">
          {BITFLYER_PAIRS.map(pair => {
            const t = tickers[pair];
            return (
              <div key={pair} className="flex items-center justify-between bg-zinc-900 rounded-lg px-4 py-3 border border-zinc-800">
                <div>
                  <div className="font-medium">{pair.split("/")[0]}</div>
                  <div className="text-xs text-zinc-500">{pair}</div>
                </div>
                <div className="text-right">
                  {t ? (
                    <>
                      <div className="font-mono font-medium">¥{t.price.toLocaleString()}</div>
                      <div className="text-xs text-zinc-500">Vol: {t.volume24h.toFixed(1)}</div>
                    </>
                  ) : (
                    <div className="text-zinc-600">--</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Active Positions */}
      {data?.positions && data.positions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-2">アクティブポジション</h2>
          <div className="space-y-2">
            {data.positions.map(pos => (
              <div key={pos.pair} className="bg-zinc-900 rounded-lg px-4 py-3 border border-zinc-800">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-medium">{pos.pair}</span>
                    <span className="text-xs text-zinc-500 ml-2">{pos.amount.toFixed(6)}</span>
                  </div>
                  <div className={`font-mono ${pos.unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                    ¥{pos.unrealizedPnL.toLocaleString()} ({pos.unrealizedPnLPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent AI Decisions */}
      {data?.recentDecisions && data.recentDecisions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-400 mb-2">最新AI判断</h2>
          <div className="space-y-1.5">
            {data.recentDecisions.slice(-5).reverse().map((d, i) => (
              <div key={i} className="flex items-start gap-2 text-sm bg-zinc-900/50 rounded-lg px-3 py-2">
                <span className={`font-mono font-bold shrink-0 ${
                  d.action === "BUY" ? "text-green-400" : d.action === "SELL" ? "text-red-400" : "text-zinc-500"
                }`}>
                  {d.action}
                </span>
                <div className="min-w-0">
                  <span className="text-zinc-400">{d.pair}</span>
                  <span className="text-zinc-600 ml-1">確信度{d.confidence}%</span>
                  <div className="text-xs text-zinc-500 truncate">{d.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
