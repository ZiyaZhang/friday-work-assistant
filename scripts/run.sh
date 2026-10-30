#!/usr/bin/env bash
# 常驻 Friday：有 tmux 用 tmux 会话，没有就 nohup + 自动重启循环（容器里常常没有 systemd/cron）。
#   bash scripts/run.sh          启动（已在跑则提示）
#   bash scripts/run.sh restart  重启
#   bash scripts/run.sh stop     停止
#   bash scripts/run.sh status   看状态
#   bash scripts/run.sh logs     看日志
set -euo pipefail
FRIDAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="friday"
# .env 里可能改了 FRIDAY_HOME，先读一下再定日志目录（只在本脚本进程内生效）
if [ -f "$FRIDAY_DIR/.env" ]; then set -a; . "$FRIDAY_DIR/.env"; set +a; fi
FRIDAY_HOME="${FRIDAY_HOME:-$HOME/.friday}"
LOG_DIR="$FRIDAY_HOME/logs"
PID_FILE="$FRIDAY_HOME/friday-loop.pid"
mkdir -p "$LOG_DIR"

LOOP="bash scripts/friday-loop.sh"

have_tmux() { command -v tmux >/dev/null 2>&1; }
loop_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if have_tmux; then
    if tmux has-session -t "=$SESSION" 2>/dev/null; then
      echo "friday 已在 tmux 会话 $SESSION 里运行；tmux attach -t $SESSION 查看"
      return
    fi
    tmux new-session -d -s "$SESSION" -c "$FRIDAY_DIR" "$LOOP"
    echo "已启动（tmux）：tmux attach -t $SESSION"
  else
    if loop_running; then
      echo "friday 已在后台运行（pid $(cat "$PID_FILE")）"
      return
    fi
    (cd "$FRIDAY_DIR" && LOG_DIR="$LOG_DIR" setsid nohup $LOOP >/dev/null 2>&1 & echo $! > "$PID_FILE")
    echo "已启动（nohup，pid $(cat "$PID_FILE")）：日志 $LOG_DIR/friday.log"
  fi
}

stop() {
  # "=" 强制精确匹配，免得 friday 误杀 friday-deploy 之类前缀相同的会话
  if have_tmux && tmux has-session -t "=$SESSION" 2>/dev/null; then
    tmux kill-session -t "=$SESSION" && echo "已停止 tmux 会话"
  fi
  if loop_running; then
    pkill -TERM -P "$(cat "$PID_FILE")" 2>/dev/null || true
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "已停止后台进程"
  fi
  # 只杀 node 本体：pattern 必须锚定行首。不锚定的话会连 tmux server 一起杀掉——tmux server 的命令行
  # 是第一次 new-session 时那整条命令（里面就有这串 node 启动命令），server 一死所有会话（含 friday-deploy）全没了。
  pkill -f '^node --no-warnings=ExperimentalWarning dist/index.js' 2>/dev/null || true
}

status() {
  if have_tmux && tmux has-session -t "=$SESSION" 2>/dev/null; then echo "tmux 会话 $SESSION：运行中"; fi
  if loop_running; then echo "nohup 循环：运行中（pid $(cat "$PID_FILE")）"; fi
  pgrep -af '^node --no-warnings=ExperimentalWarning dist/index.js' || echo "没有 friday 进程"
}

case "${1:-start}" in
  start) start ;;
  restart) stop; sleep 1; start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 100 -f "$LOG_DIR/friday.log" ;;
  *) echo "用法: $0 [start|restart|stop|status|logs]"; exit 1 ;;
esac
