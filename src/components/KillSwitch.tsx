"use client";

import { useState } from "react";
import { OctagonX } from "lucide-react";

export default function KillSwitch() {
  const [loading, setLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);

  const handleKill = async () => {
    if (!confirm("緊急停止しますか？\nBotを停止し、全注文をキャンセルします。")) return;
    setLoading(true);
    try {
      await fetch("/api/bot/kill", { method: "POST" });
      setTriggered(true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleKill}
      disabled={loading || triggered}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
        triggered
          ? "bg-red-900 text-red-300 cursor-not-allowed"
          : "bg-red-600 hover:bg-red-500 text-white active:scale-95"
      }`}
    >
      <OctagonX size={16} />
      {loading ? "停止中..." : triggered ? "停止済み" : "緊急停止"}
    </button>
  );
}
