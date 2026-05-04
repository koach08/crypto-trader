"use client";

import { useState, useEffect } from "react";
import type { BotStatus } from "@/lib/types";

export default function SettingsPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);

  useEffect(() => {
    fetch("/api/bot/status")
      .then(r => r.json())
      .then(d => setStatus(d.status))
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">設定</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <h3 className="font-medium text-zinc-300">取引所</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-zinc-500">取引所</div>
          <div>bitFlyer</div>
          <div className="text-zinc-500">APIキー</div>
          <div className="font-mono text-xs text-zinc-400">
            {process.env.NEXT_PUBLIC_EXCHANGE_ID || "設定済み (.env.local)"}
          </div>
          <div className="text-zinc-500">通貨ペア</div>
          <div>{status?.activePairs?.join(", ") || "BTC/JPY, ETH/JPY, XRP/JPY"}</div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <h3 className="font-medium text-zinc-300">リスク管理</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-zinc-500">1日最大損失</div>
          <div>2.0%</div>
          <div className="text-zinc-500">デフォルトSL</div>
          <div>2.0%</div>
          <div className="text-zinc-500">デフォルトTP</div>
          <div>3.0%</div>
          <div className="text-zinc-500">最低確信度</div>
          <div>60%</div>
          <div className="text-zinc-500">分析間隔</div>
          <div>15分（900秒）</div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <h3 className="font-medium text-zinc-300">Bot状態</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-zinc-500">稼働状態</div>
          <div className={status?.running ? "text-green-400" : "text-zinc-400"}>
            {status?.running ? "稼働中" : "停止"}
          </div>
          <div className="text-zinc-500">モード</div>
          <div className={status?.paperMode ? "text-yellow-400" : "text-red-400"}>
            {status?.paperMode ? "ペーパー（模擬）" : "リアル（実取引）"}
          </div>
          <div className="text-zinc-500">サーキットブレーカー</div>
          <div className={status?.circuitBreakerState === "ACTIVE" ? "text-green-400" : "text-red-400"}>
            {status?.circuitBreakerState || "ACTIVE"}
          </div>
          <div className="text-zinc-500">サイクル数</div>
          <div>{status?.cycleCount ?? 0}</div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <h3 className="font-medium text-zinc-300">AIエンジン</h3>
        <div className="text-sm text-zinc-400 space-y-1">
          <div>Claude (Anthropic) - メイン判断</div>
          <div>GPT-4o (OpenAI) - セカンダリ</div>
          <div>Gemini (Google) - サード</div>
          <div>Grok (xAI) - 補助</div>
          <div>Perplexity - リアルタイム情報</div>
        </div>
        <div className="text-xs text-zinc-600">
          通常: Claude単体 / ボーダーライン時: 5エンジンコンセンサス
        </div>
      </div>
    </div>
  );
}
