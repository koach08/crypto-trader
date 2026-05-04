#!/bin/bash
# Live Trading Script - 24/7稼働用
# Macスリープ防止 + 自動再起動 + ヘルスチェック

PROJECT_DIR="$HOME/Desktop/アプリ開発プロジェクト/crypto-trader"
LOG_FILE="$PROJECT_DIR/data/live-trading.log"
PID_FILE="$PROJECT_DIR/data/server.pid"
CAFE_PID_FILE="$PROJECT_DIR/data/caffeinate.pid"
PORT=3004

cd "$PROJECT_DIR" || exit 1

mkdir -p data

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cleanup() {
  log "シャットダウン中..."
  # ボット停止
  curl -s -X POST "http://localhost:$PORT/api/bot/stop" > /dev/null 2>&1
  sleep 1
  # サーバー停止
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
  fi
  # caffeinate停止
  if [ -f "$CAFE_PID_FILE" ]; then
    kill "$(cat "$CAFE_PID_FILE")" 2>/dev/null
    rm -f "$CAFE_PID_FILE"
  fi
  log "=== Live Trading 停止 ==="
  exit 0
}
trap cleanup SIGINT SIGTERM

# 既存プロセスを停止
lsof -ti :$PORT | xargs kill -9 2>/dev/null
sleep 1

log "=== Live Trading 開始 ==="
log "資金: BitFlyer口座残高で自動運用"
log "ペア: ETH/JPY, XRP/JPY"
log "安全装置: サーキットブレーカー2%, SL/TP自動, 最小取引¥1,000"

# Macスリープ防止（電源接続時はリッドクローズでもスリープしない）
caffeinate -s &
CAFE_PID=$!
echo $CAFE_PID > "$CAFE_PID_FILE"
log "スリープ防止 有効 (caffeinate PID: $CAFE_PID)"

start_server() {
  log "プロダクションサーバー起動中 (port $PORT)..."
  npm run start -- --port $PORT >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo $SERVER_PID > "$PID_FILE"
  log "サーバー PID: $SERVER_PID"

  for i in $(seq 1 30); do
    if curl -s --max-time 3 "http://localhost:$PORT/api/bot/status" > /dev/null 2>&1; then
      log "サーバー起動完了 (${i}秒)"
      return 0
    fi
    sleep 1
  done
  log "ERROR: サーバー起動失敗 (30秒タイムアウト)"
  return 1
}

start_bot() {
  log "ライブトレーディングBot起動..."
  RESPONSE=$(curl -s --max-time 30 -X POST "http://localhost:$PORT/api/bot/start" \
    -H "Content-Type: application/json" \
    -d '{"paperMode": false, "pairs": ["ETH/JPY", "XRP/JPY"], "intervalSeconds": 900}')
  log "Bot起動レスポンス: $RESPONSE"
}

check_health() {
  RESPONSE=$(curl -s --max-time 10 "http://localhost:$PORT/api/bot/status" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    return 1
  fi
  echo "$RESPONSE"
  return 0
}

# メインループ
while true; do
  if ! start_server; then
    log "10秒後にリトライ..."
    sleep 10
    continue
  fi

  start_bot

  # ヘルスチェック (5分間隔)
  while true; do
    sleep 300
    STATUS=$(check_health)
    if [ $? -ne 0 ]; then
      log "ヘルスチェック失敗 - サーバー再起動..."
      kill "$(cat "$PID_FILE")" 2>/dev/null
      sleep 3
      break
    fi

    # ステータスをログに記録
    INFO=$(echo "$STATUS" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get("status", d)
    pnl = d.get("dailyPnL", {})
    print(f"cycle={s.get(\"cycleCount\",\"?\")}, running={s.get(\"running\",\"?\")}, pnl=¥{pnl.get(\"totalPnL\",0):,.0f}, trades={pnl.get(\"trades\",0)}, cb={s.get(\"circuitBreakerState\",\"?\")}")
except:
    print("parse error")
' 2>/dev/null)
    log "Health OK: $INFO"

    # caffeinate生存確認
    if ! kill -0 "$CAFE_PID" 2>/dev/null; then
      log "caffeinate再起動..."
      caffeinate -s &
      CAFE_PID=$!
      echo $CAFE_PID > "$CAFE_PID_FILE"
    fi
  done
done
