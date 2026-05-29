#!/bin/bash
# Railway用起動スクリプト: Next.js起動 → API経由でBot自動開始

PORT=${PORT:-8080}

# Next.jsをバックグラウンドで起動
npm run start -- --port "$PORT" &
NEXT_PID=$!

# サーバーが起動するまで待機（最大30秒）
echo "[start.sh] Waiting for server (port $PORT)..."
for i in $(seq 1 30); do
  if node -e "fetch('http://localhost:$PORT/api/health').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[start.sh] Server ready (${i}s)"
    break
  fi
  sleep 1
done

# Bot起動はバックグラウ��ドで（ヘルスチェックをブロックしない）
if [ "$AUTO_START_LIVE" = "true" ]; then
  (
    sleep 5
    # SOL/JPY は BitFlyer に存在しない (BadSymbol エラーで毎サイクル失敗) ため除外
    PAIRS=${TRADING_PAIRS:-"BTC/JPY,ETH/JPY,XRP/JPY,XLM/JPY,MONA/JPY"}
    INTERVAL=${BOT_INTERVAL_SECONDS:-300}
    PAIRS_JSON=$(echo "$PAIRS" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')
    echo "[start.sh] Starting live bot: pairs=$PAIRS interval=${INTERVAL}s"
    node -e "
      fetch('http://localhost:$PORT/api/bot/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({paperMode: false, pairs: $PAIRS_JSON, intervalSeconds: $INTERVAL})
      }).then(r=>r.json()).then(d=>console.log('[start.sh] Bot result:', JSON.stringify(d))).catch(e=>console.error('[start.sh] Bot start error:', e))
    "
  ) &
fi

# Next.jsプロセスを待機
wait $NEXT_PID
