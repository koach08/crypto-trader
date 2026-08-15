import { getExchange } from "../src/lib/exchanges/factory";

async function main() {
  const exchange = getExchange();
  await exchange.connect();

  const pairs = ["BTC/JPY", "ETH/JPY", "XRP/JPY", "SOL/JPY"];
  let canceled = 0;

  console.log("未約定の買い指値を検索中...");

  for (const pair of pairs) {
    try {
      const orders = await exchange.getOpenOrders(pair);
      for (const order of orders) {
        if (order.side === "buy") {
          console.log(`キャンセル: ${pair} ${order.id} @ ¥${order.price} (amount: ${order.amount})`);
          const ok = await exchange.cancelOrder(order.id, pair);
          if (ok) {
            canceled++;
            console.log("  → キャンセル成功");
          } else {
            console.log("  → キャンセル失敗");
          }
        }
      }
    } catch (e) {
      console.error(`Error for ${pair}:`, e);
    }
  }

  console.log(`\n完了: ${canceled} 件キャンセル`);
  console.log("walletページをリロードして free JPY を確認してね。");
}

main().catch(console.error);
