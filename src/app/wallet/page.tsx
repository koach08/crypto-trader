"use client";

import { useState, useEffect, useCallback } from "react";
import type { Balance, TickerData, WalletConfig, WalletAllocation } from "@/lib/types";
import { BITFLYER_PAIRS } from "@/lib/types";
import { ArrowDownToLine, Settings2, Play } from "lucide-react";

interface WalletItem {
  currency: string;
  amount: number;
  valueJPY: number;
  percent: number;
}

interface DistributeResult {
  pair: string;
  targetJPY: number;
  currentJPY: number;
  buyAmountJPY: number;
  order?: { id: string };
  error?: string;
  skipped?: string;
}

interface DistributeResponse {
  dryRun: boolean;
  jpyFree: number;
  reserveJPY: number;
  distributableJPY: number;
  results: DistributeResult[];
  error?: string;
}

export default function WalletPage() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"overview" | "config" | "distribute">("overview");

  // Config state
  const [config, setConfig] = useState<WalletConfig>({
    totalCapitalJPY: 0,
    allocationTargets: [
      { pair: "BTC/JPY", targetPercent: 50, maxPositionJPY: 100000 },
      { pair: "ETH/JPY", targetPercent: 30, maxPositionJPY: 60000 },
      { pair: "XRP/JPY", targetPercent: 20, maxPositionJPY: 40000 },
    ],
    reservePercent: 20,
  });
  const [configSaved, setConfigSaved] = useState(false);

  // Distribute state
  const [distributeResult, setDistributeResult] = useState<DistributeResponse | null>(null);
  const [distributing, setDistributing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [balanceRes, configRes, ...tickerResults] = await Promise.all([
        fetch("/api/exchange/balance"),
        fetch("/api/wallet/config"),
        ...BITFLYER_PAIRS.map(pair =>
          fetch(`/api/exchange/ticker?pair=${encodeURIComponent(pair)}`).catch(() => null)
        ),
      ]);

      if (balanceRes.ok) setBalances(await balanceRes.json());
      if (configRes.ok) {
        const c = await configRes.json();
        if (c.allocationTargets) setConfig(c);
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

  useEffect(() => { fetchData(); }, [fetchData]);

  // Wallet items calculation
  const items: WalletItem[] = balances
    .filter(b => b.total > 0)
    .map(b => {
      let valueJPY = b.total;
      if (b.currency !== "JPY") {
        const pair = `${b.currency}/JPY`;
        const price = tickers[pair]?.price ?? 0;
        valueJPY = b.total * price;
      }
      return { currency: b.currency, amount: b.total, valueJPY, percent: 0 };
    });

  const totalJPY = items.reduce((sum, item) => sum + item.valueJPY, 0);
  for (const item of items) {
    item.percent = totalJPY > 0 ? (item.valueJPY / totalJPY) * 100 : 0;
  }
  items.sort((a, b) => b.valueJPY - a.valueJPY);

  const colors = ["bg-blue-500", "bg-green-500", "bg-yellow-500", "bg-purple-500", "bg-red-500", "bg-cyan-500"];

  const saveConfig = async () => {
    await fetch("/api/wallet/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
  };

  const updateTarget = (index: number, field: keyof WalletAllocation, value: number) => {
    const updated = [...config.allocationTargets];
    updated[index] = { ...updated[index], [field]: value };
    setConfig({ ...config, allocationTargets: updated });
  };

  const addTarget = () => {
    const usedPairs = config.allocationTargets.map(t => t.pair);
    const available = BITFLYER_PAIRS.filter(p => !usedPairs.includes(p));
    if (available.length === 0) return;
    setConfig({
      ...config,
      allocationTargets: [
        ...config.allocationTargets,
        { pair: available[0], targetPercent: 10, maxPositionJPY: 20000 },
      ],
    });
  };

  const removeTarget = (index: number) => {
    setConfig({
      ...config,
      allocationTargets: config.allocationTargets.filter((_, i) => i !== index),
    });
  };

  const runDistribute = async (dryRun: boolean) => {
    setDistributing(true);
    try {
      const res = await fetch("/api/wallet/distribute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, exchangeId: "bitflyer" }),
      });
      setDistributeResult(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setDistributing(false);
    }
  };

  if (loading) return <div className="text-center py-20 text-zinc-500">読み込み中...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">ウォレット</h2>

      {/* Tabs */}
      <div className="flex gap-2">
        {([
          ["overview", "残高"],
          ["config", "配分設定"],
          ["distribute", "振り分け"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === key ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          {/* Total */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center">
            <div className="text-xs text-zinc-500 mb-1">総資産</div>
            <div className="text-3xl font-bold font-mono">¥{totalJPY.toLocaleString()}</div>
          </div>

          {/* Allocation Bar */}
          {totalJPY > 0 && (
            <div className="h-4 rounded-full overflow-hidden flex bg-zinc-800">
              {items.map((item, i) => (
                <div
                  key={item.currency}
                  className={`${colors[i % colors.length]} transition-all`}
                  style={{ width: `${item.percent}%` }}
                  title={`${item.currency}: ${item.percent.toFixed(1)}%`}
                />
              ))}
            </div>
          )}

          {/* Breakdown */}
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={item.currency} className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
                <div className={`w-3 h-3 rounded-full ${colors[i % colors.length]}`} />
                <div className="flex-1">
                  <div className="font-medium">{item.currency}</div>
                  <div className="text-xs text-zinc-500">
                    {item.currency === "JPY" ? `¥${item.amount.toLocaleString()}` : item.amount.toFixed(8)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono">¥{Math.round(item.valueJPY).toLocaleString()}</div>
                  <div className="text-xs text-zinc-500">{item.percent.toFixed(1)}%</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "config" && (
        <div className="space-y-4">
          {/* Reserve */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Settings2 size={16} className="text-zinc-400" />
              <span className="text-sm font-medium text-zinc-300">JPYリザーブ率</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0} max={50} step={5}
                value={config.reservePercent}
                onChange={e => setConfig({ ...config, reservePercent: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="text-lg font-mono font-bold w-16 text-right">{config.reservePercent}%</span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              常にJPY残高の{config.reservePercent}%をキャッシュとして保持
            </div>
          </div>

          {/* Allocation Targets */}
          <div className="space-y-2">
            {config.allocationTargets.map((target, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <select
                    value={target.pair}
                    onChange={e => {
                      const newPair = e.target.value;
                      setConfig(c => ({
                        ...c,
                        allocationTargets: c.allocationTargets.map((t, j) =>
                          j === i ? { ...t, pair: newPair } : t
                        ),
                      }));
                    }}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    {BITFLYER_PAIRS.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeTarget(i)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    削除
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-zinc-500">配分率 (%)</label>
                    <input
                      type="number"
                      min={0} max={100} step={5}
                      value={target.targetPercent}
                      onChange={e => updateTarget(i, "targetPercent", Number(e.target.value))}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500">上限 (¥)</label>
                    <input
                      type="number"
                      min={0} step={10000}
                      value={target.maxPositionJPY}
                      onChange={e => updateTarget(i, "maxPositionJPY", Number(e.target.value))}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm mt-1"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={addTarget}
              className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg py-2 text-sm"
            >
              + 通貨ペア追加
            </button>
            <button
              onClick={saveConfig}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 text-sm font-medium"
            >
              {configSaved ? "保存済み" : "設定を保存"}
            </button>
          </div>
        </div>
      )}

      {tab === "distribute" && (
        <div className="space-y-4">
          {/* Current JPY */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
            <div className="text-xs text-zinc-500 mb-1">配分可能 JPY残高</div>
            <div className="text-2xl font-bold font-mono text-green-400">
              ¥{(balances.find(b => b.currency === "JPY")?.free ?? 0).toLocaleString()}
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              リザーブ{config.reservePercent}%控除後に各通貨へ自動配分
            </div>
          </div>

          {/* Config summary */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="text-sm font-medium text-zinc-400 mb-2">配分ルール</div>
            {config.allocationTargets.map((t, i) => (
              <div key={i} className="flex justify-between text-sm py-1">
                <span>{t.pair}</span>
                <span className="text-zinc-400">{t.targetPercent}% (上限¥{t.maxPositionJPY.toLocaleString()})</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => runDistribute(true)}
              disabled={distributing}
              className="flex items-center justify-center gap-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl p-3 text-sm font-medium disabled:opacity-50"
            >
              <ArrowDownToLine size={16} />
              {distributing ? "計算中..." : "シミュレーション"}
            </button>
            <button
              onClick={() => {
                if (!confirm("実際に購入を実行しますか？\n配分ルールに基づき成行注文を発注します。")) return;
                runDistribute(false);
              }}
              disabled={distributing}
              className="flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white rounded-xl p-3 text-sm font-medium disabled:opacity-50"
            >
              <Play size={16} />
              {distributing ? "実行中..." : "実行（本番）"}
            </button>
          </div>

          {/* Results */}
          {distributeResult && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-300">
                  {distributeResult.dryRun ? "シミュレーション結果" : "実行結果"}
                </span>
                {distributeResult.dryRun && (
                  <span className="text-xs text-yellow-400 bg-yellow-900/30 px-2 py-0.5 rounded">DRY RUN</span>
                )}
              </div>

              {distributeResult.error ? (
                <div className="text-red-400 text-sm">{distributeResult.error}</div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 text-xs text-zinc-500">
                    <div>JPY残高: ¥{distributeResult.jpyFree?.toLocaleString()}</div>
                    <div>リザーブ: ¥{distributeResult.reserveJPY?.toLocaleString()}</div>
                    <div>配分額: ¥{distributeResult.distributableJPY?.toLocaleString()}</div>
                  </div>

                  {distributeResult.results?.map((r, i) => (
                    <div key={i} className="border-t border-zinc-800 pt-2">
                      <div className="flex justify-between items-center">
                        <span className="font-medium">{r.pair}</span>
                        {r.skipped ? (
                          <span className="text-xs text-zinc-500">{r.skipped}</span>
                        ) : r.error ? (
                          <span className="text-xs text-red-400">{r.error}</span>
                        ) : r.order ? (
                          <span className="text-xs text-green-400">約定 ID:{r.order.id}</span>
                        ) : (
                          <span className="text-xs text-blue-400">¥{r.buyAmountJPY.toLocaleString()} 購入予定</span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        目標: ¥{r.targetJPY.toLocaleString()} | 現在: ¥{r.currentJPY.toLocaleString()} | 差額: ¥{r.buyAmountJPY.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
