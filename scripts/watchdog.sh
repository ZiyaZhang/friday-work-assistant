#!/usr/bin/env bash
# 独立看门狗：每分钟跑一次 dist/watchdog.js（只读数据库和 /healthz；Friday 停摆时私聊 ~/.friday/watchdog/config.json 里的负责人）。
# 和网关、部署循环是分开的进程：网关挂了它还在。整机或容器停了它也会停，需要外部监控另外覆盖。
#   bash scripts/watchdog.sh start    后台启动（已在跑则提示）
#   bash scripts/watchdog.sh stop     停止
#   bash scripts/watchdog.sh status   看状态和最近一次结论
#   bash scripts/watchdog.sh once     只跑一次（前台）
set -euo pipefail
FRIDAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRIDAY_HOME="${FRIDAY_HOME:-$HOME/.friday}"
PID_FILE="$FRIDAY_HOME/watchdog.pid"
LOG="$FRIDAY_HOME/logs/watchdog.log"
INTERVAL="${FRIDAY_WATCHDOG_INTERVAL:-60}"
export PATH="$HOME/.local/node-v22.19.0/bin:$HOME/.local/bin:$PATH"
mkdir -p "$FRIDAY_HOME/logs"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
once() { cd "$FRIDAY_DIR" && node --no-warnings=ExperimentalWarning --env-file=.env dist/watchdog.js; }
loop() {
  while true; do
    once >>"$LOG" 2>&1 || true
    sleep "$INTERVAL"
  done
}

case "${1:-status}" in
  start)
    if running; then echo "看门狗已在运行（pid $(cat "$PID_FILE")）"; exit 0; fi
    setsid nohup bash "$FRIDAY_DIR/scripts/watchdog.sh" __loop >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    echo "看门狗已启动（pid $(cat "$PID_FILE")），日志 $LOG"
    ;;
  stop)
    if running; then kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "看门狗已停止"; else echo "看门狗没有在运行"; fi
    ;;
  status)
    if running; then echo "看门狗运行中（pid $(cat "$PID_FILE")）"; else echo "看门狗没有在运行"; fi
    tail -n 3 "$LOG" 2>/dev/null || true
    ;;
  once) once ;;
  __loop) loop ;;
  *) echo "用法：bash scripts/watchdog.sh start|stop|status|once" >&2; exit 64 ;;
esac
