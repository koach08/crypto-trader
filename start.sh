#!/bin/bash
# Railway用起動スクリプト: Next.js起動 → API経由でBot自動開始

PORT=${PORT:-8080}

# Next.jsをバックグラウンドで起動
npm run start -- --port "$PORT" &
NEXT_PID=$!

# サーバーが起動するまで待機（最大60秒）
echo "[start.sh] サーバー起動待機中 (port $PORT)..."
READY=false
for i in $(seq 1 60); do
  if curl -s --max-time 3 "http://localhost:$PORT/api/bot/status" > /dev/null 2>&1; then
    echo "[start.sh] サーバー起動完了 (${i}秒)"
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "[start.sh] ERROR: サーバー起動失敗"
  wait $NEXT_PID
  exit 1
fi

# 少し待ってから起動（モジュール初期化を確実にする）
sleep 3

# AUTO_START_LIVE=true ならAPI経由でライブBot開始
if [ "$AUTO_START_LIVE" = "true" ]; then
  PAIRS=${TRADING_PAIRS:-"ETH/JPY,XRP/JPY"}
  INTERVAL=${BOT_INTERVAL_SECONDS:-900}

  # ペアをJSON配列に変換
  PAIRS_JSON=$(echo "$PAIRS" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')

  echo "[start.sh] ライブBot起動: pairs=$PAIRS, interval=${INTERVAL}s"
  RESPONSE=$(curl -s --max-time 120 -X POST "http://localhost:$PORT/api/bot/start" \
    -H "Content-Type: application/json" \
    -d "{\"paperMode\": false, \"pairs\": $PAIRS_JSON, \"intervalSeconds\": $INTERVAL}")
  echo "[start.sh] Bot起動結果: $RESPONSE"

  # 起動確認
  sleep 5
  STATUS=$(curl -s --max-time 10 "http://localhost:$PORT/api/bot/status" 2>/dev/null)
  echo "[start.sh] Bot状態: $STATUS" | head -c 500
fi

echo "[start.sh] 常駐開始"

# Next.jsプロセスを待機（終了したらコンテナも終了）
wait $NEXT_PID
