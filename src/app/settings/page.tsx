"use client";

import { useState, useEffect } from "react";
import type { BotStatus, ProfitConfig } from "@/lib/types";

export default function SettingsPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [profit, setProfit] = useState<ProfitConfig>({
    dailyTargetPercent: 0.15,
    tpPercent: 2.5,
    slPercent: 0.9,
    minConfidence: 50,
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/bot/status")
      .then(r => r.json())
      .then(d => setStatus(d.status))
      .catch(console.error);

    // Load current profit config (consistent profit settings)
    fetch("/api/bot/profit-config")
      .then(r => r.json())
      .then((cfg: ProfitConfig) => setProfit(cfg))
      .catch(() => {});
  }, []);

  const saveProfit = async (preset?: Partial<ProfitConfig>) => {
    setSaving(true);
    setSaveMsg(null);
    const body = preset ? { ...profit, ...preset } : profit;
    try {
      const res = await fetch("/api/bot/profit-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setProfit(data.config || body as ProfitConfig);
        setSaveMsg("保存しました。次サイクルから反映されます。");
      }
    } catch (e) {
      setSaveMsg("保存失敗: " + String(e));
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  const applyGrindPreset = () => {
    const preset: ProfitConfig = {
      dailyTargetPercent: 0.13,
      tpPercent: 2.0,
      slPercent: 0.8,
      minConfidence: 48,
    };
    setProfit(preset);
    saveProfit(preset);
  };

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
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-zinc-300">コンスタント利益モード（販売版推奨）</h3>
            <div className="text-xs text-emerald-400">利益をコンスタントに上げ続けるための設定</div>
          </div>
          <button
            onClick={applyGrindPreset}
            className="text-xs px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded-lg"
          >
            コンスタント利益プリセット適用
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <label className="text-zinc-500">日次利益目標 (%)</label>
          <input
            type="number"
            step="0.01"
            value={profit.dailyTargetPercent}
            onChange={e => setProfit({ ...profit, dailyTargetPercent: parseFloat(e.target.value) || 0.1 })}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-right"
          />

          <label className="text-zinc-500">ベース TP (%)</label>
          <input
            type="number"
            step="0.1"
            value={profit.tpPercent}
            onChange={e => setProfit({ ...profit, tpPercent: parseFloat(e.target.value) || 1.5 })}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-right"
          />

          <label className="text-zinc-500">ベース SL (%)</label>
          <input
            type="number"
            step="0.1"
            value={profit.slPercent}
            onChange={e => setProfit({ ...profit, slPercent: parseFloat(e.target.value) || 0.5 })}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-right"
          />

          <label className="text-zinc-500">最低確信度 (%)</label>
          <input
            type="number"
            step="1"
            value={profit.minConfidence}
            onChange={e => setProfit({ ...profit, minConfidence: parseFloat(e.target.value) || 45 })}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-right"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => saveProfit()}
            disabled={saving}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium"
          >
            {saving ? "保存中..." : "この設定でコンスタント利益を狙う"}
          </button>
        </div>

        {saveMsg && <div className="text-xs text-emerald-400">{saveMsg}</div>}

        <div className="bg-zinc-950 border border-zinc-800 rounded p-2 text-xs">
          <div className="text-emerald-400 mb-0.5">複利シミュレーション（目安・20営業日）</div>
          <div className="font-mono">
            日次 {profit.dailyTargetPercent}% → 月次約 <span className="text-emerald-400 font-semibold">
              {((Math.pow(1 + profit.dailyTargetPercent / 100, 20) - 1) * 100).toFixed(1)}%
            </span>（手数料・ドローダウン考慮前）
          </div>
        </div>

        <div className="text-xs text-zinc-500">
          これらの値は保存され、次回のサイクルから bot が使用します。<br />
          小さく確実に積み上げる設定がデフォルト。プリセットは特に「毎日少しずつ」を重視した値です。
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <h3 className="font-medium text-zinc-300">リスク管理（参考）</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-zinc-500">1日最大損失</div>
          <div>2.0%</div>
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
        <h3 className="font-medium text-zinc-300">AIエンジン (現在有効)</h3>
        <div className="text-sm text-zinc-400 space-y-1">
          <div>Claude (Anthropic) - メイン判断</div>
          <div>GPT-4o (OpenAI)</div>
          <div>Gemini (Google)</div>
        </div>
        <div className="text-xs text-zinc-500">
          Grok / Perplexity はコスト・成功率のため無効化中。3エンジンでコンセンサス。
        </div>
        <div className="text-xs text-emerald-400">→ 変更したい場合は engines.ts を編集</div>
      </div>
    </div>
  );
}
