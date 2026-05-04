#!/bin/bash
# Overnight Paper Trading Script
# Starts production server + bot, auto-restarts on crash

PROJECT_DIR="$HOME/Desktop/アプリ開発プロジェクト/crypto-trader"
LOG_FILE="$PROJECT_DIR/data/overnight.log"
PID_FILE="$PROJECT_DIR/data/server.pid"
PORT=3004

cd "$PROJECT_DIR" || exit 1

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cleanup() {
  log "Shutting down..."
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# Kill any existing server on port
lsof -ti :$PORT | xargs kill -9 2>/dev/null
sleep 1

log "=== Overnight Paper Trading Start ==="

start_server() {
  log "Starting production server on port $PORT..."
  npm run start -- --port $PORT >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo $SERVER_PID > "$PID_FILE"
  log "Server PID: $SERVER_PID"

  # Wait for server to be ready
  for i in $(seq 1 30); do
    if curl -s --max-time 3 "http://localhost:$PORT/api/bot/status" > /dev/null 2>&1; then
      log "Server ready after ${i}s"
      return 0
    fi
    sleep 1
  done
  log "ERROR: Server failed to start within 30s"
  return 1
}

start_bot() {
  log "Starting paper trading bot..."
  RESPONSE=$(curl -s --max-time 30 -X POST "http://localhost:$PORT/api/bot/start" \
    -H "Content-Type: application/json" \
    -d '{"paperMode": true, "pairs": ["BTC/JPY", "ETH/JPY", "XRP/JPY"], "intervalSeconds": 900}')
  log "Bot start response: $RESPONSE"
}

check_health() {
  RESPONSE=$(curl -s --max-time 10 "http://localhost:$PORT/api/bot/status" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    return 1
  fi
  echo "$RESPONSE"
  return 0
}

# Main loop
while true; do
  if ! start_server; then
    log "Retrying in 10s..."
    sleep 10
    continue
  fi

  start_bot

  # Health monitoring loop (check every 5 min)
  while true; do
    sleep 300
    STATUS=$(check_health)
    if [ $? -ne 0 ]; then
      log "HEALTH CHECK FAILED - restarting server..."
      kill "$(cat "$PID_FILE")" 2>/dev/null
      sleep 3
      break
    fi
    log "Health OK: $(echo "$STATUS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"cycle={d.get(\"cycleCount\",\"?\")}, running={d.get(\"running\",\"?\")}")' 2>/dev/null || echo "$STATUS")"
  done
done
