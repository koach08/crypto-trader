"use client";

import { useState } from "react";
import { Play, Square, Zap } from "lucide-react";

export default function TradePage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const action = async (endpoint: string, method = "POST") => {
    setLoading(endpoint);
    setMessage(null);
    try {
      const res = await fetch(`/api/bot/${endpoint}`, { method });
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

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => action("start")}
          disabled={loading === "start"}
          className="flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white rounded-xl p-4 font-medium transition-colors disabled:opacity-50"
        >
          <Play size={20} />
          {loading === "start" ? "起動中..." : "Bot起動"}
        </button>
        <button
          onClick={() => action("stop")}
          disabled={loading === "stop"}
          className="flex items-center justify-center gap-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl p-4 font-medium transition-colors disabled:opacity-50"
        >
          <Square size={20} />
          {loading === "stop" ? "停止中..." : "Bot停止"}
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
          {["BTC/JPY", "ETH/JPY", "XRP/JPY", "XLM/JPY", "MONA/JPY"].map(p => (
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
