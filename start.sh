#!/bin/bash
# Railway用起動スクリプト: Next.js起動 → API経由でBot自動開始

PORT=${PORT:-8080}

# Next.jsをバックグラウンドで起動
npm run start -- --port "$PORT" &
NEXT_PID=$!

# Node.js fetch でサーバー待機 → Bot起動（curlが無い環境対応）
node -e "
const PORT = process.env.PORT || 8080;
const AUTO = process.env.AUTO_START_LIVE === 'true';

async function waitForServer() {
  console.log('[start] サーバー起動待機中 (port ' + PORT + ')...');
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://localhost:' + PORT + '/api/bot/status');
      if (r.ok) { console.log('[start] サーバー起動完了 (' + (i+1) + '秒)'); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function startBot() {
  const pairs = (process.env.TRADING_PAIRS || 'ETH/JPY,XRP/JPY').split(',');
  const interval = parseInt(process.env.BOT_INTERVAL_SECONDS || '900');
  console.log('[start] ライブBot起動: pairs=' + pairs.join(',') + ', interval=' + interval + 's');

  const res = await fetch('http://localhost:' + PORT + '/api/bot/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({paperMode: false, pairs, intervalSeconds: interval})
  });
  const data = await res.json();
  console.log('[start] Bot起動結果:', JSON.stringify(data));

  // 確認
  await new Promise(r => setTimeout(r, 5000));
  const status = await fetch('http://localhost:' + PORT + '/api/bot/status');
  const sd = await status.json();
  console.log('[start] Running:', sd.status?.running, '| PaperMode:', sd.status?.paperMode, '| Pairs:', sd.status?.activePairs);
}

(async () => {
  if (!await waitForServer()) { console.log('[start] ERROR: サーバー起動失敗'); process.exit(1); }
  if (AUTO) { await startBot(); }
  console.log('[start] 常駐開始');
})().catch(e => console.error('[start] Error:', e));
"

# Next.jsプロセスを待機
wait $NEXT_PID
