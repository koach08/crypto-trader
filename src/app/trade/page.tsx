"use client";

import { useState, useEffect } from "react";
import { Play, Square, Zap } from "lucide-react";

export default function TradePage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<{ paperMode?: boolean; running?: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/bot/status").then(r => r.json()).then(d => setStatus(d.status)).catch(() => {});
  }, []);

  const action = async (endpoint: string, body?: any, method = "POST") => {
    setLoading(endpoint);
    setMessage(null);
    try {
      const res = await fetch(`/api/bot/${endpoint}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      setMessage(data.message || data.error || JSON.stringify(data));
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">Bot制御</h2>
      {status && (
        <div className={`text-sm px-3 py-1 rounded ${status.paperMode === false ? "bg-red-950 text-red-400 border border-red-700" : "bg-yellow-950 text-yellow-400 border border-yellow-800"}`}>
          現在: {status.running ? "実行中" : "停止中"} / {status.paperMode === false ? "🔴 LIVE 実取引モード" : "📝 PAPER モード"}
        </div>
      )}

      <div className="space-y-3">
        <div className="text-xs text-zinc-500">起動モードを選択（Paper = シミュレーション / Live = 実取引 bitFlyer）</div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => action("start", { paperMode: true })}
            disabled={loading === "start"}
            className="flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl p-4 font-medium transition-colors disabled:opacity-50"
          >
            <Play size={20} />
            {loading === "start" ? "起動中..." : "📝 Paperで起動"}
          </button>
          <button
            onClick={() => action("start", { paperMode: false })}
            disabled={loading === "start"}
            className="flex items-center justify-center gap-2 bg-red-700 hover:bg-red-600 text-white rounded-xl p-4 font-medium transition-colors disabled:opacity-50 border border-red-500"
            title="実弾モード: 実際のbitFlyerで注文を発行します"
          >
            <Play size={20} />
            {loading === "start" ? "起動中..." : "🔴 LIVEで起動 (実弾)"}
          </button>
        </div>
        <button
          onClick={() => action("stop")}
          disabled={loading === "stop"}
          className="w-full flex items-center justify-center gap-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl p-3 font-medium transition-colors disabled:opacity-50"
        >
          <Square size={20} />
          {loading === "stop" ? "停止中..." : "Bot停止"}
        </button>
        <button
          onClick={() => action("cleanup-orders", null, "POST")}
          disabled={loading === "cleanup-orders"}
          className="w-full flex items-center justify-center gap-2 bg-orange-700 hover:bg-orange-600 text-white rounded-xl p-2 text-sm font-medium transition-colors disabled:opacity-50"
          title="未約定買い指値をキャンセルして現金を解放"
        >
          {loading === "cleanup-orders" ? "掃除中..." : "未約定注文キャンセル (現金解放)"}
        </button>
      </div>

      <button
        onClick={() => action("cycle")}
        disabled={loading === "cycle"}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl p-4 font-medium transition-colors disabled:opacity-50"
      >
        <Zap size={20} />
        {loading === "cycle" ? "分析実行中..." : "1サイクル手動実行"}
      </button>

      {message && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300">
          {message}
        </div>
      )}

      <ProfitTargetCard />

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-400 mb-3">AI分析（単発）</h3>
        <AnalyzeButton />
      </div>
    </div>
  );
}

function AnalyzeButton() {
  const [pair, setPair] = useState("BTC/JPY");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const analyze = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair, fullConsensus: false }),
      });
      setResult(await res.json());
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select
          value={pair}
          onChange={e => setPair(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm flex-1"
        >
          {["BTC/JPY", "ETH/JPY", "XRP/JPY"].map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button
          onClick={analyze}
          disabled={loading}
          className="bg-purple-600 hover:bg-purple-500 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {loading ? "分析中..." : "分析"}
        </button>
      </div>

      {result && (
        <pre className="bg-zinc-800 rounded-lg p-3 text-xs overflow-auto max-h-80 text-zinc-300">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ProfitTargetCard() {
  const [cfg, setCfg] = useState<{ dailyTargetPercent: number; tpPercent: number; slPercent: number } | null>(null);
  const [daily, setDaily] = useState<any>(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/bot/profit-config").then(r => r.json()).then(setCfg).catch(() => {});
      fetch("/api/bot/status").then(r => r.json()).then(d => setDaily(d.dailyPnL)).catch(() => {});
    };
    load();
    const id = setInterval(load, 30000); // 30秒ごとに更新
    return () => clearInterval(id);
  }, []);

  if (!cfg) return null;

  const startCap = daily?.startCapitalJPY || 100000;
  const targetJPY = (startCap * cfg.dailyTargetPercent) / 100;
  const realized = daily?.realizedPnL || 0;
  const progress = targetJPY > 0 ? Math.min(100, Math.max(0, (realized / targetJPY) * 100)) : 0;
  const achieved = realized >= targetJPY;

  return (
    <div className="bg-zinc-900 border border-emerald-800/60 rounded-xl p-4 text-sm">
      <div className="flex justify-between items-center mb-1">
        <div className="text-emerald-400 font-medium">コンスタント利益目標</div>
        <div className="text-[10px] text-zinc-500">本日進捗</div>
      </div>

      <div className="mb-2">
        <div className="flex justify-between text-xs mb-0.5">
          <span>¥{Math.round(realized).toLocaleString()} / ¥{Math.round(targetJPY).toLocaleString()}</span>
          <span className={achieved ? "text-emerald-400" : "text-zinc-400"}>{progress.toFixed(0)}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded overflow-hidden">
          <div className="h-2 bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div>
          <div className="text-zinc-500">日次目標</div>
          <div className="text-emerald-400 font-semibold">+{cfg.dailyTargetPercent}%</div>
        </div>
        <div>
          <div className="text-zinc-500">TP / SL</div>
          <div className="font-medium">{cfg.tpPercent}% / {cfg.slPercent}%</div>
        </div>
        <div>
          <div className="text-zinc-500">状態</div>
          <div className={achieved ? "text-emerald-400" : "text-yellow-400"}>
            {achieved ? "目標達成" : "積み上げ中"}
          </div>
        </div>
      </div>

      <div className="text-[10px] text-zinc-500 mt-2">毎日小さく確実に。勝ちを伸ばし、損は小さく。目標到達で新規エントリー抑制。</div>
    </div>
  );
}
