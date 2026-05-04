export async function register() {
  // サーバーサイドでのみ実行（edge runtimeでは実行しない）
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // AUTO_START_LIVE=true の場合、サーバー起動時にbotを自動開始
    if (process.env.AUTO_START_LIVE === "true") {
      const { startBot } = await import("@/lib/trading/engine");
      const pairs = (process.env.TRADING_PAIRS || "ETH/JPY,XRP/JPY").split(",");
      const interval = Number(process.env.BOT_INTERVAL_SECONDS || "900");

      console.log(`[Auto-Start] ライブBot起動中... ペア: ${pairs.join(", ")}, 間隔: ${interval}秒`);

      try {
        await startBot({
          paperMode: false,
          pairs,
          intervalSeconds: interval,
        });
        console.log("[Auto-Start] ライブBot起動完了");
      } catch (e) {
        console.error("[Auto-Start] Bot起動失敗:", e);
      }
    }
  }
}
