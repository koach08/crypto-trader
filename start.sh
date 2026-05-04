#!/bin/bash
# Railway用起動スクリプト: Next.js起動 → Bot自動開始

PORT=${PORT:-8080}

# Next.jsをバックグラウンドで起動
npm run start -- --port "$PORT" &
NEXT_PID=$!

# サーバーが起動するまで待機
echo "[start.sh] サーバー起動待機中..."
for i in $(seq 1 60); do
  if curl -s --max-time 3 "http://localhost:$PORT/api/bot/status" > /dev/null 2>&1; then
    echo "[start.sh] サーバー起動完了 (${i}秒)"
    break
  fi
  sleep 1
done

# AUTO_START_LIVE=true ならライブBot自動開始
if [ "$AUTO_START_LIVE" = "true" ]; then
  PAIRS=${TRADING_PAIRS:-"ETH/JPY,XRP/JPY"}
  INTERVAL=${BOT_INTERVAL_SECONDS:-900}

  # ペアをJSON配列に変換
  PAIRS_JSON=$(echo "$PAIRS" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')

  echo "[start.sh] ライブBot起動: pairs=$PAIRS, interval=${INTERVAL}s"
  RESPONSE=$(curl -s --max-time 60 -X POST "http://localhost:$PORT/api/bot/start" \
    -H "Content-Type: application/json" \
    -d "{\"paperMode\": false, \"pairs\": $PAIRS_JSON, \"intervalSeconds\": $INTERVAL}")
  echo "[start.sh] Bot起動結果: $RESPONSE"
fi

# Next.jsプロセスを待機（終了したらコンテナも終了）
wait $NEXT_PID
