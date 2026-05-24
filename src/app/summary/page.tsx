"use client";

import { useEffect, useState, useCallback } from "react";

interface BotStatusResp {
  status: {
    running: boolean;
    paperMode: boolean;
    lastCycleTimestamp: string;
    nextCycleTimestamp: string;
    circuitBreakerState: string;
    activePairs: string[];
    cycleCount: number;
  };
  positions: Array<{
    pair: string;
    amount: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    valueJPY: number;
  }>;
  dailyPnL: { realizedPnL: number; trades: number; wins: number; losses: number };
  cumulativePnL?: { netPnL: number; totalTrades: number; winRate: number; totalRealizedPnL: number };
}

interface PolicyResp {
  current: {
    tier: "JUNIOR" | "MID" | "SENIOR" | "MASTER";
    cashBufferPercent: number;
    convictionBoost: number;
    metrics: { totalTrades: number; winRate: number; totalPnL: number; sharpe: number; maxDrawdownPercent: number };
    reasoning: string;
  };
  limits: { maxDeployPercent: number; perPairMaxPercent: number; maxConvictionBoost: number; bufferMinPercent: number; bufferMaxPercent: number };
}

interface KillSwitchResp {
  peakNAV: number;
  triggered: boolean;
  lastNAV: number;
  triggeredAt?: string;
  triggeredDrawdownPct?: number;
}

interface IntelResp {
  totalScore: number;
  verdict: string;
  sourcesAvailable: number;
  categories: {
    speculation: { score: number; available: boolean };
    utility: { score: number; available: boolean };
    macro: { score: number; available: boolean };
  };
  components: Record<string, { score: number; available: boolean; details?: string[]; interpretation?: string }>;
}

const TIER_COLORS: Record<string, string> = {
  JUNIOR: "bg-zinc-700 text-zinc-200",
  MID: "bg-blue-700 text-blue-100",
  SENIOR: "bg-purple-700 text-purple-100",
  MASTER: "bg-amber-600 text-amber-50",
};

const NEXT_TIER_CRITERIA: Record<string, { trades: number; wr: number; sharpe: number; dd: number; nextTier: string } | null> = {
  JUNIOR: { trades: 30, wr: 0.50, sharpe: 0, dd: 10, nextTier: "MID" },
  MID: { trades: 100, wr: 0.53, sharpe: 0.8, dd: 8, nextTier: "SENIOR" },
  SENIOR: { trades: 300, wr: 0.55, sharpe: 1.2, dd: 6, nextTier: "MASTER" },
  MASTER: null,
};

function scoreColor(s: number): string {
  if (s >= 30) return "text-green-400";
  if (s >= 10) return "text-green-500";
  if (s > -10) return "text-zinc-400";
  if (s > -30) return "text-orange-400";
  return "text-red-400";
}

function pctFmt(n: number, signed = true): string {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function yenFmt(n: number, signed = false): string {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}¥${Math.round(n).toLocaleString()}`;
}

export default function SummaryPage() {
  const [status, setStatus] = useState<BotStatusResp | null>(null);
  const [policy, setPolicy] = useState<PolicyResp | null>(null);
  const [killSwitch, setKillSwitch] = useState<KillSwitchResp | null>(null);
  const [intel, setIntel] = useState<IntelResp | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const load = useCallback(async () => {
    const [s, p, k, i] = await Promise.all([
      fetch("/api/bot/status").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/bot/policy").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/bot/kill-switch").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/bot/intel").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    setStatus(s);
    setPolicy(p);
    setKillSwitch(k);
    setIntel(i);
    setUpdatedAt(new Date().toLocaleTimeString("ja-JP"));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!status || !policy || !killSwitch || !intel) {
    return <div className="py-20 text-center text-zinc-500">読み込み中...</div>;
  }

  const currentNAV = killSwitch.lastNAV;
  const peakNAV = killSwitch.peakNAV;
  const dd = peakNAV > 0 ? ((peakNAV - currentNAV) / peakNAV) * 100 : 0;
  const ddColor = dd >= 10 ? "text-red-400" : dd >= 5 ? "text-orange-400" : "text-zinc-400";

  const pol = policy.current;
  const lim = policy.limits;
  const crit = NEXT_TIER_CRITERIA[pol.tier];

  return (
    <div className="pb-24 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold">Bot サマリ</h2>
        <span className="text-xs text-zinc-500">更新 {updatedAt}</span>
      </div>

      {/* Health */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status.status.running ? "bg-green-400 animate-pulse" : "bg-zinc-600"}`} />
            <span className="text-sm font-semibold">{status.status.running ? "稼働中" : "停止中"}</span>
            <span className="text-xs text-zinc-500">cycle #{status.status.cycleCount}</span>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded ${
            status.status.circuitBreakerState === "ACTIVE" ? "bg-green-900/40 text-green-400"
            : status.status.circuitBreakerState === "WARNING" ? "bg-orange-900/40 text-orange-400"
            : "bg-red-900/40 text-red-400"
          }`}>
            CB: {status.status.circuitBreakerState}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase text-zinc-500">NAV (現在)</div>
            <div className="text-lg font-mono">{yenFmt(currentNAV)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Peak NAV</div>
            <div className="text-lg font-mono">{yenFmt(peakNAV)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Drawdown</div>
            <div className={`text-lg font-mono ${ddColor}`}>{pctFmt(-dd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Kill 閾値</div>
            <div className="text-lg font-mono text-zinc-400">-15.0%</div>
          </div>
        </div>
        {killSwitch.triggered && (
          <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
            🚨 KILL SWITCH 発火中 ({killSwitch.triggeredAt?.slice(0, 16)}, DD {killSwitch.triggeredDrawdownPct?.toFixed(1)}%)
            <br />全 close 済、reset 必要
          </div>
        )}
        <div className="text-xs text-zinc-500">
          次サイクル {status.status.nextCycleTimestamp?.slice(11, 16)} UTC | pairs: {status.status.activePairs.join(", ")}
        </div>
      </section>

      {/* Capital Policy */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300">Capital Policy</h3>
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${TIER_COLORS[pol.tier]}`}>
            {pol.tier}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase text-zinc-500">投入上限</div>
            <div className="text-lg font-mono">{lim.maxDeployPercent}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">現バッファ</div>
            <div className="text-lg font-mono">{pol.cashBufferPercent}%</div>
            <div className="text-[10px] text-zinc-600">枠 {lim.bufferMinPercent}-{lim.bufferMaxPercent}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Boost</div>
            <div className="text-lg font-mono">{pol.convictionBoost.toFixed(2)}x</div>
            <div className="text-[10px] text-zinc-600">上限 {lim.maxConvictionBoost}x</div>
          </div>
        </div>
        <div className="text-xs text-zinc-400">
          実績: {pol.metrics.totalTrades}件 / WR {(pol.metrics.winRate * 100).toFixed(0)}%
          / PnL {yenFmt(pol.metrics.totalPnL, true)}
          / Sharpe {pol.metrics.sharpe.toFixed(2)}
        </div>
        {crit && (
          <div className="text-xs border-t border-zinc-800 pt-2">
            <div className="text-zinc-500">次の昇進 → <span className="text-zinc-300 font-semibold">{crit.nextTier}</span></div>
            <div className="text-zinc-400 mt-1">
              条件: 取引 {pol.metrics.totalTrades}/<span className={pol.metrics.totalTrades >= crit.trades ? "text-green-400" : "text-zinc-400"}>{crit.trades}</span>件
              {" · "}WR {(pol.metrics.winRate * 100).toFixed(0)}%/<span className={pol.metrics.winRate >= crit.wr ? "text-green-400" : "text-zinc-400"}>{(crit.wr * 100).toFixed(0)}%</span>
              {" · "}Sharpe {pol.metrics.sharpe.toFixed(2)}/<span className={pol.metrics.sharpe >= crit.sharpe ? "text-green-400" : "text-zinc-400"}>{crit.sharpe.toFixed(1)}</span>
              {" · "}DD {pol.metrics.maxDrawdownPercent.toFixed(1)}%/<span className={pol.metrics.maxDrawdownPercent <= crit.dd ? "text-green-400" : "text-zinc-400"}>≤{crit.dd}%</span>
            </div>
          </div>
        )}
      </section>

      {/* Intel */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300">市場 Intel</h3>
          <span className="text-xs text-zinc-500">{intel.sourcesAvailable}/8 稼働</span>
        </div>
        <div className="text-center py-2">
          <div className={`text-3xl font-mono font-bold ${scoreColor(intel.totalScore)}`}>
            {intel.totalScore > 0 ? "+" : ""}{intel.totalScore}
          </div>
          <div className="text-xs text-zinc-400">{intel.verdict}</div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="bg-zinc-800/50 rounded p-2">
            <div className="text-[10px] uppercase text-zinc-500">投機</div>
            <div className={`text-lg font-mono ${scoreColor(intel.categories.speculation.score)}`}>
              {intel.categories.speculation.score > 0 ? "+" : ""}{intel.categories.speculation.score}
            </div>
          </div>
          <div className="bg-zinc-800/50 rounded p-2">
            <div className="text-[10px] uppercase text-zinc-500">実需</div>
            <div className={`text-lg font-mono ${scoreColor(intel.categories.utility.score)}`}>
              {intel.categories.utility.score > 0 ? "+" : ""}{intel.categories.utility.score}
            </div>
          </div>
          <div className="bg-zinc-800/50 rounded p-2">
            <div className="text-[10px] uppercase text-zinc-500">マクロ</div>
            <div className={`text-lg font-mono ${scoreColor(intel.categories.macro.score)}`}>
              {intel.categories.macro.score > 0 ? "+" : ""}{intel.categories.macro.score}
            </div>
          </div>
        </div>
        <div className="space-y-1 text-xs border-t border-zinc-800 pt-2">
          {Object.entries(intel.components).map(([k, v]) => (
            <div key={k} className="flex items-start gap-2">
              <span className="text-zinc-500 w-20 shrink-0">{k}</span>
              {v.available ? (
                <>
                  <span className={`font-mono w-12 shrink-0 ${scoreColor(v.score)}`}>
                    {v.score > 0 ? "+" : ""}{v.score}
                  </span>
                  <span className="text-zinc-400 truncate">
                    {v.interpretation ?? v.details?.[0] ?? ""}
                  </span>
                </>
              ) : (
                <span className="text-zinc-600 italic">未稼働</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* PnL & Positions */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-300">損益 & ポジション</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase text-zinc-500">本日損益</div>
            <div className={`text-lg font-mono ${status.dailyPnL.realizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
              {yenFmt(status.dailyPnL.realizedPnL, true)}
            </div>
            <div className="text-[10px] text-zinc-600">{status.dailyPnL.trades}件 (W{status.dailyPnL.wins}/L{status.dailyPnL.losses})</div>
          </div>
          {status.cumulativePnL && (
            <div>
              <div className="text-[10px] uppercase text-zinc-500">累計純損益</div>
              <div className={`text-lg font-mono ${status.cumulativePnL.netPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                {yenFmt(status.cumulativePnL.netPnL, true)}
              </div>
              <div className="text-[10px] text-zinc-600">{status.cumulativePnL.totalTrades}件 / WR {(status.cumulativePnL.winRate * 100).toFixed(0)}%</div>
            </div>
          )}
        </div>
        {status.positions.length > 0 && (
          <div className="space-y-1 text-xs border-t border-zinc-800 pt-2">
            <div className="text-zinc-500 mb-1">保有ポジション {status.positions.length}件</div>
            {status.positions.map(p => (
              <div key={p.pair} className="flex justify-between font-mono">
                <span>{p.pair}</span>
                <span className="text-zinc-400">{p.amount.toFixed(6)} @ ¥{p.avgEntryPrice.toLocaleString()}</span>
                <span className={p.unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}>
                  {p.unrealizedPnL !== 0 ? yenFmt(p.unrealizedPnL, true) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
