"use client";

import { useState, useEffect } from "react";
import type { Position, Balance } from "@/lib/types";

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statusRes, balanceRes] = await Promise.all([
          fetch("/api/bot/status"),
          fetch("/api/exchange/balance"),
        ]);

        if (statusRes.ok) {
          const data = await statusRes.json();
          setPositions(data.positions || []);
        }
        if (balanceRes.ok) {
          setBalances(await balanceRes.json());
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <div className="text-center py-20 text-zinc-500">読み込み中...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">ポジション</h2>

      {/* Exchange Balances */}
      <div>
        <h3 className="text-sm font-medium text-zinc-400 mb-2">bitFlyer残高</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          {balances.map(b => (
            <div key={b.currency} className="flex justify-between px-4 py-3 border-b border-zinc-800 last:border-b-0">
              <span className="font-medium">{b.currency}</span>
              <div className="text-right">
                <div className="font-mono">{b.currency === "JPY" ? `¥${b.total.toLocaleString()}` : b.total.toFixed(8)}</div>
                {b.used > 0 && <div className="text-xs text-zinc-500">拘束: {b.used}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Paper Positions */}
      <div>
        <h3 className="text-sm font-medium text-zinc-400 mb-2">ペーパーポジション</h3>
        {positions.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-zinc-500">
            ポジションなし
          </div>
        ) : (
          <div className="space-y-2">
            {positions.map(pos => (
              <div key={pos.pair} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex justify-between items-center mb-2">
                  <div className="font-bold text-lg">{pos.pair}</div>
                  <div className={`text-lg font-mono font-bold ${pos.unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                    ¥{pos.unrealizedPnL.toLocaleString()}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm text-zinc-400">
                  <div>数量: {pos.amount.toFixed(8)}</div>
                  <div>平均取得: ¥{pos.avgEntryPrice.toLocaleString()}</div>
                  <div>現在価格: ¥{pos.currentPrice.toLocaleString()}</div>
                  <div>評価額: ¥{pos.valueJPY.toLocaleString()}</div>
                  {pos.stopLoss && <div className="text-red-400/60">SL: ¥{pos.stopLoss.toLocaleString()}</div>}
                  {pos.takeProfit && <div className="text-green-400/60">TP: ¥{pos.takeProfit.toLocaleString()}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
