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
  const [openOrders, setOpenOrders] = useState<any[]>([]);
  const [lockedJPY, setLockedJPY] = useState(0);
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

  const cancelOrder = async (orderId: string, pair: string) => {
    if (!confirm(`注文 ${orderId} (${pair}) をキャンセルしますか？`)) return;
    try {
      await fetch("/api/exchange/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, pair }),
      });
      await fetchData(); // refresh
    } catch (e) {
      alert("キャンセル失敗: " + String(e));
    }
  };

  const cancelAllBuyOrders = async () => {
    const buys = openOrders.filter((o: any) => o.side === 'buy');
    if (buys.length === 0) return;
    if (!confirm(`${buys.length}件の買い指値を全部キャンセルしますか？\nJPYが free に戻ります。`)) return;

    for (const o of buys) {
      try {
        await fetch("/api/exchange/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: o.id, pair: o.pair }),
        });
      } catch {}
    }
    await fetchData();
  };

  const fetchData = useCallback(async () => {
    try {
      const [balanceRes, configRes, openRes, ...tickerResults] = await Promise.all([
        fetch("/api/exchange/balance"),
        fetch("/api/wallet/config"),
        fetch("/api/exchange/open-orders"),
        ...BITFLYER_PAIRS.map(pair =>
          fetch(`/api/exchange/ticker?pair=${encodeURIComponent(pair)}`).catch(() => null)
        ),
      ]);

      if (balanceRes.ok) setBalances(await balanceRes.json());
      if (configRes.ok) {
        const c = await configRes.json();
        if (c.allocationTargets) setConfig(c);
      }
      if (openRes.ok) {
        const o = await openRes.json();
        setOpenOrders(o.orders || []);
        setLockedJPY(o.totalLockedJPY || 0);
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

      {/* Always-visible JPY lock warning */}
      {lockedJPY > 0 && (
        <div className="bg-amber-950 border border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-300">
          ⚠️ 現在 ¥{lockedJPY.toLocaleString()} の JPY が「未約定の買い指値」でロックされています。
          これが「現金60kあるのに free が18kしか使えない」理由です。
          （約定してないので、どの暗号資産の残高にも反映されていません）
          <button onClick={() => setTab("distribute")} className="ml-2 underline">注文一覧を見てキャンセルする</button>
        </div>
      )}

      {tab === "overview" && (
        <>
          {/* Total - make it clearer */}
           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center">
             <div className="text-xs text-zinc-500 mb-1">総資産（現在価値）</div>
             <div className="text-3xl font-bold font-mono">¥{totalJPY.toLocaleString()}</div>
             <div className="text-[10px] text-zinc-400 mt-1">
               = 現金 { (balances.find(b => b.currency === 'JPY')?.total || 0).toLocaleString() }円 + 暗号資産評価額
             </div>
           </div>

           {/* Big obvious cancel button for unfilled buys */}
           {openOrders.filter((o: any) => o.side === 'buy').length > 0 && (
             <div className="bg-red-950 border border-red-700 rounded-xl p-4 text-center">
               <div className="text-red-400 text-sm mb-2">未約定の買い指値が {openOrders.filter((o: any) => o.side === 'buy').length} 件あり、JPYをロック中</div>
               <button
                 onClick={cancelAllBuyOrders}
                 className="bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold text-lg"
               >
                 全未約定買い指値をキャンセルして現金を解放
               </button>
               <div className="text-xs text-red-300 mt-2">これで free JPY が増えます</div>
             </div>
           )}

            {/* JPY Free/Total breakdown in overview */}
            {(() => {
              const jpy = balances.find(b => b.currency === "JPY");
              if (!jpy) return null;
              return (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-sm">
                  <div className="flex gap-4">
                    <div>JPY Total: <span className="font-mono">¥{jpy.total.toLocaleString()}</span></div>
                    <div>Free: <span className="font-mono text-green-400">¥{jpy.free.toLocaleString()}</span></div>
                    <div>Used: <span className="font-mono text-amber-400">¥{jpy.used.toLocaleString()}</span></div>
                  </div>
                  {lockedJPY > 0 && (
                    <div className="mt-1 text-xs text-red-400">
                      → この Used の大半は「未約定の買い指値」でロック中
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Super simple explanation for "未約定" */}
            <div className="bg-zinc-950 border border-zinc-700 rounded p-3 text-xs text-zinc-300">
              <div className="font-bold mb-1">「未約定」って何？（cryptoの場合）</div>
              <div>
                ボットが置いた「この価格で買う」指値が、まだ成立してない状態。<br />
                指値出すと即JPYがused（予約）される。<br />
                <strong>いつまで？</strong> → 価格がピッタリ合うまで。合わなければ**何時間も何日も**待つ。永遠に未約定のままになることも普通。<br />
                株式と違って流動性が低いから、待ってる間に機会は逃げる。
              </div>
              <div className="mt-1 text-amber-400">→ だから「現金63kあるのに動かせない」になる。</div>
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
              {items.length === 1 && items[0].currency === "JPY" && (
                <div className="text-[10px] text-amber-400 px-1">
                  現在、暗号資産の残高は 0 です（どの通貨も買った記録がありません）。
                </div>
              )}

              {/* Pending buys from open orders */}
              {openOrders.filter((o: any) => o.side === 'buy').length > 0 && (
                <div className="mt-2 p-3 bg-zinc-950 border border-zinc-700 rounded text-xs">
                  <div className="font-medium text-blue-400 mb-1">未約定の買い予定（これが約定したら追加される）</div>
                  {openOrders
                    .filter((o: any) => o.side === 'buy')
                    .slice(0, 5)
                    .map((o: any, i: number) => {
                      const estCrypto = o.amount || ((o.lockedJPY || 0) / (o.price || 1));
                      return (
                        <div key={i} className="flex justify-between py-0.5">
                          <span>{o.pair} @ ¥{Math.round(o.price).toLocaleString()}</span>
                          <span className="text-blue-300">≈ {estCrypto.toFixed(6)} 購入予定</span>
                        </div>
                      );
                    })}
                  <div className="text-[10px] text-zinc-500 mt-1">
                    これらの注文がまだ生きている → JPYが used になって free が減っている
                  </div>
                </div>
              )}
            </div>

           {/* Why is "Used" high even though no crypto is held? */}
           {lockedJPY > 0 && (
             <div className="bg-zinc-900 border border-amber-700 rounded-xl p-4 text-sm">
               <div className="font-medium text-amber-400 mb-1">JPYの "Used" はこれです</div>
               <div className="text-xs text-zinc-300 mb-2">
                 未約定の <strong>買い指値注文</strong> で拘束されている金額です。
                 まだ約定していないので、暗号資産の残高には一切反映されていません。
               </div>
               <div className="text-xs">
                 ロック額合計: <span className="font-mono text-red-400">¥{lockedJPY.toLocaleString()}</span>
               </div>
                <div className="mt-1 text-[10px] text-zinc-500">
                  → これをキャンセルすれば free に戻り、配分可能額が増えます。
                </div>
                <button
                  onClick={cancelAllBuyOrders}
                  className="mt-3 w-full bg-red-700 hover:bg-red-600 text-white text-sm py-2 rounded font-medium"
                >
                  全未約定買い注文をキャンセル（現金解放）
                </button>
              </div>
            )}
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
           {/* Current JPY - clear free vs total */}
           {(() => {
             const jpyBal = balances.find(b => b.currency === "JPY") || { free: 0, used: 0, total: 0 };
             const reservePct = config.reservePercent;
             const afterReserve = Math.floor(jpyBal.free * (100 - reservePct) / 100);
             return (
               <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center space-y-1">
                 <div className="text-xs text-zinc-500">Bitflyer JPY残高</div>
                 <div className="text-xl font-mono">
                   Total: <span className="font-bold">¥{jpyBal.total.toLocaleString()}</span>
                 </div>
                 <div className="text-sm text-zinc-400">
                   Used: ¥{jpyBal.used.toLocaleString()}　/　Free: <span className="text-green-400 font-mono">¥{jpyBal.free.toLocaleString()}</span>
                 </div>
                 <div className="pt-1 border-t border-zinc-800 text-xs">
                   配分可能 (freeからリザーブ{reservePct}%控除後): <span className="font-bold text-green-400">¥{afterReserve.toLocaleString()}</span>
                 </div>
                 <div className="text-[10px] text-zinc-500">
                   ※ Free = 今すぐ新規注文に使える金額（open orderでロック分はUsed）
                 </div>
               </div>
             );
           })()}

           {/* Open orders locking JPY */}
           {openOrders.length > 0 && (
             <div className="bg-red-950/30 border border-red-900 rounded-xl p-4">
               <div className="flex justify-between items-center mb-2">
                 <div>
                   <div className="text-sm font-medium text-red-400">オープン指値（JPYロック中）</div>
                   <div className="text-xs text-red-300">¥{lockedJPY.toLocaleString()} が拘束されています</div>
                 </div>
                 <div className="text-xs text-zinc-400">{openOrders.length}件</div>
               </div>
               <div className="space-y-1 text-xs">
                  {openOrders.slice(0, 6).map((o: any, i: number) => {
                    const ageMin = o.timestamp ? Math.floor((Date.now() - o.timestamp) / 60000) : 0;
                    return (
                      <div key={i} className="flex justify-between bg-zinc-950/60 px-2 py-1 rounded text-[10px]">
                        <span>{o.side} {o.pair} @ ¥{Math.round(o.price).toLocaleString()}</span>
                        <span className="text-red-300">lock ¥{o.lockedJPY?.toLocaleString() || 0} ({ageMin}分経過)</span>
                        <button
                          onClick={() => cancelOrder(o.id, o.pair)}
                          className="text-red-400 hover:text-red-200 underline"
                        >
                          取消
                        </button>
                      </div>
                    );
                  })}
                 {openOrders.length > 6 && <div className="text-[10px] text-zinc-500">...他 {openOrders.length - 6}件</div>}
               </div>
                 <div className="text-[10px] text-red-400 mt-2">
                   未約定は「価格が合うまで無期限待つ」。自動で期限切れにならない。キャンセルするまでロック。
                   これが「Total 63kなのに Free が少ない」主な原因。
                 </div>
                <button
                  onClick={cancelAllBuyOrders}
                  className="mt-3 w-full bg-red-700 hover:bg-red-600 text-white rounded px-3 py-2 text-sm font-medium"
                >
                  全未約定買い指値をキャンセルして現金を解放
                </button>
              </div>
            )}

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
                     <div>Free残高: ¥{distributeResult.jpyFree?.toLocaleString()}</div>
                     <div>リザーブ控除: ¥{distributeResult.reserveJPY?.toLocaleString()}</div>
                     <div>実際の配分上限: ¥{distributeResult.distributableJPY?.toLocaleString()}</div>
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
