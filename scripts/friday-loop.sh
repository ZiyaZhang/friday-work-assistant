#!/usr/bin/env bash
# Friday 常驻循环：进程退出 5 秒后拉起。由 run.sh 放进 tmux 会话（或 nohup）里跑。
# 单独成文件是为了不把 node 启动命令写进 tmux server 的命令行（见 run.sh stop 的注释）。
set -uo pipefail
FRIDAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$FRIDAY_DIR" || exit 1
set -a; . ./.env; set +a
# tmux 里不是登录 shell，开发机上的 node 装在 ~/.local（devbox-bootstrap），要自己补 PATH
export PATH="$HOME/.local/node-v22.19.0/bin:$HOME/.local/bin:$PATH"
FRIDAY_HOME="${FRIDAY_HOME:-$HOME/.friday}"
LOG_DIR="${LOG_DIR:-$FRIDAY_HOME/logs}"
mkdir -p "$LOG_DIR"
while true; do
  node --no-warnings=ExperimentalWarning dist/index.js 2>&1 | tee -a "$LOG_DIR/friday.log"
  echo "friday 退出，5 秒后重启" | tee -a "$LOG_DIR/friday.log"
  sleep 5
done
