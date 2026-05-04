"use client";

import { useState, useEffect } from "react";
import type { TradeRecord, AIDecision } from "@/lib/types";

export default function HistoryPage() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [decisions, setDecisions] = useState<AIDecision[]>([]);
  const [tab, setTab] = useState<"trades" | "decisions">("trades");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tradesRes, statusRes] = await Promise.all([
          fetch("/api/trades"),
          fetch("/api/bot/status"),
        ]);
        if (tradesRes.ok) {
          const data = await tradesRes.json();
          setTrades(data.trades || []);
        }
        if (statusRes.ok) {
          const data = await statusRes.json();
          setDecisions(data.recentDecisions || []);
        }
      } catch (e) {
        console.error(e);
      }
    };
    fetchData();
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">履歴</h2>

      <div className="flex gap-2">
        {(["trades", "decisions"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {t === "trades" ? `取引 (${trades.length})` : `AI判断 (${decisions.length})`}
          </button>
        ))}
      </div>

      {tab === "trades" ? (
        trades.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-zinc-500">取引履歴なし</div>
        ) : (
          <div className="space-y-2">
            {[...trades].reverse().map(t => (
              <div key={t.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-bold text-sm ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {t.side.toUpperCase()}
                    </span>
                    <span className="text-sm">{t.pair}</span>
                    {t.paperTrade && <span className="text-xs text-yellow-500">PAPER</span>}
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono">¥{t.price.toLocaleString()}</div>
                    {t.pnl !== undefined && (
                      <div className={`text-xs font-mono ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {t.pnl >= 0 ? "+" : ""}¥{t.pnl.toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  {new Date(t.timestamp).toLocaleString("ja-JP")} | {t.amount.toFixed(6)} | ¥{t.valueJPY.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        decisions.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-zinc-500">AI判断履歴なし</div>
        ) : (
          <div className="space-y-2">
            {[...decisions].reverse().map((d, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-bold text-sm ${
                      d.action === "BUY" ? "text-green-400" : d.action === "SELL" ? "text-red-400" : "text-zinc-500"
                    }`}>
                      {d.action}
                    </span>
                    <span className="text-sm">{d.pair}</span>
                  </div>
                  <span className="text-sm text-zinc-400">確信度 {d.confidence}%</span>
                </div>
                <div className="text-xs text-zinc-400 mt-1">{d.reason}</div>
                <div className="text-xs text-zinc-600 mt-1">
                  {new Date(d.timestamp).toLocaleString("ja-JP")} | スコア {d.technicalScore} | F&G {d.fearGreedIndex}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
