#!/usr/bin/env bash
# push 即部署：常驻循环，每 DEPLOY_INTERVAL 秒 fetch 一次远端分支，远端有新提交就
#   git reset --hard → npm ci → npm run build → scripts/run.sh restart
# 容器里没有 systemd/cron，使用常驻循环跟踪部署。
#
#   bash scripts/deploy-loop.sh start    # 后台常驻（有 tmux 用 tmux 会话 friday-deploy，没有就 nohup）
#   bash scripts/deploy-loop.sh stop
#   bash scripts/deploy-loop.sh status
#   bash scripts/deploy-loop.sh once     # 前台跑一轮检查（手动部署 / 调试）
#   bash scripts/deploy-loop.sh run      # 前台循环（tmux/nohup 内部用）
#
# 环境变量：DEPLOY_BRANCH（默认 master）、DEPLOY_INTERVAL（默认 60）、DEPLOY_REMOTE（默认 origin）。
# 依赖：仓库已配置好 origin（HTTPS + ~/.git-credentials 里的 token，或 SSH）；.env 不在 git 里，不会被覆盖。
set -uo pipefail
FRIDAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$FRIDAY_DIR/.env" ]; then set -a; . "$FRIDAY_DIR/.env"; set +a; fi
FRIDAY_HOME="${FRIDAY_HOME:-$HOME/.friday}"
LOG_DIR="$FRIDAY_HOME/logs"
LOG="$LOG_DIR/deploy.log"
PID_FILE="$FRIDAY_HOME/deploy-loop.pid"
SUCCESS_FILE="$FRIDAY_HOME/deploy-success.sha"
SESSION="friday-deploy"
BRANCH="${DEPLOY_BRANCH:-master}"
REMOTE="${DEPLOY_REMOTE:-origin}"
INTERVAL="${DEPLOY_INTERVAL:-60}"
mkdir -p "$LOG_DIR"
# 开发机上 node 不在默认 PATH（devbox-bootstrap 装在 ~/.local）
export PATH="$HOME/.local/node-v22.19.0/bin:$HOME/.local/bin:$PATH"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

# 与 run.sh 相同的单实例启动命令。旧进程未退出、多个实例或仅有旧 API 应答都不算成功。
gateway_pids() { pgrep -f '^node --no-warnings=ExperimentalWarning dist/index.js' 2>/dev/null || true; }

# 新网关会在 /healthz 报出自己启动时的提交；报了却不是这次部署的提交，就不算部署成功（旧构建不报版本时不拦）。
api_healthy() {
  node --input-type=module - "${FRIDAY_API_HOST:-127.0.0.1}" "${FRIDAY_API_PORT:-7788}" "${1:-}" <<'NODE'
let [host, port, expected] = process.argv.slice(2)
if (host === '0.0.0.0') host = '127.0.0.1'
if (host === '::') host = '::1'
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
try {
  const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  const body = await response.json()
  const versionOk = !expected || typeof body.version !== 'string' || body.version === expected
  process.exit(response.ok && body.ok === true && versionOk ? 0 : 1)
} catch { process.exit(1) }
NODE
}

wait_healthy() {
  local old_pids="$1" expected="${2:-}" current stable_pid="" attempt
  # 最多 15 轮；同一新 PID 连续两轮存活，API 必须返回 ok:true。
  for ((attempt = 0; attempt < 15; attempt++)); do
    current="$(gateway_pids)"
    if [[ "$current" =~ ^[0-9]+$ ]] && ! grep -Fxq "$current" <<< "$old_pids" && api_healthy "$expected"; then
      if [ "$stable_pid" = "$current" ]; then return 0; fi
      stable_pid="$current"
    else
      stable_pid=""
    fi
    sleep 2
  done
  return 1
}

check_once() {
  cd "$FRIDAY_DIR" || return 1
  if ! git fetch -q "$REMOTE" "$BRANCH" 2>>"$LOG"; then
    log "fetch 失败（网络或凭证），下次再试"
    return 1
  fi
  local local_sha remote_sha deployed_sha="" old_pids
  local_sha="$(git rev-parse HEAD)" || return 1
  remote_sha="$(git rev-parse "$REMOTE/$BRANCH")" || return 1
  if ! git diff --quiet || ! git diff --cached --quiet; then
    log "!! 工作副本有未提交的 tracked 修改（或无法检查），拒绝 reset；请先处理"
    return 1
  fi
  if [ -f "$SUCCESS_FILE" ]; then deployed_sha="$(cat "$SUCCESS_FILE")"; fi
  if [[ ! "$deployed_sha" =~ ^[0-9a-f]{40}$ ]]; then deployed_sha=""; fi
  if [ "$local_sha" = "$remote_sha" ] && [ "$deployed_sha" = "$remote_sha" ]; then return 0; fi
  log "开始部署 ${remote_sha:0:7}（checkout ${local_sha:0:7}；上次验证 ${deployed_sha:-无}）"
  # 从此刻起 checkout/依赖可能变化；失败后不能用旧成功记录跳过重试或回退。
  if ! rm -f "$SUCCESS_FILE"; then log "!! 无法使旧部署记录失效"; return 1; fi
  git log --oneline "$local_sha..$remote_sha" | sed 's/^/    /' | tee -a "$LOG"
  if ! git reset -q --hard "$remote_sha"; then log "!! git reset 失败"; return 1; fi
  if [ -n "$deployed_sha" ] && [ -d node_modules ] && git cat-file -e "$deployed_sha^{commit}" 2>/dev/null && git diff --quiet "$deployed_sha" "$remote_sha" -- package.json package-lock.json; then
    log "依赖没变，跳过 npm ci"
  else
    log "依赖变化或安装未验证，npm ci"
    if ! npm ci --no-audit --no-fund >>"$LOG" 2>&1; then log "!! npm ci 失败，未重启；下次重试"; return 1; fi
  fi
  if ! npm run build >>"$LOG" 2>&1; then log "!! 构建失败，未重启；下次重试"; return 1; fi
  old_pids="$(gateway_pids)"
  if ! bash scripts/run.sh restart 2>&1 | tee -a "$LOG"; then log "!! 重启失败；下次重试"; return 1; fi
  if ! wait_healthy "$old_pids" "$remote_sha"; then log "!! 新网关未通过存活检查（或报出的版本不是 ${remote_sha:0:7}）；下次重试"; return 1; fi
  if ! printf '%s\n' "$remote_sha" > "$SUCCESS_FILE.tmp.$$" || ! mv -f "$SUCCESS_FILE.tmp.$$" "$SUCCESS_FILE"; then
    rm -f "$SUCCESS_FILE.tmp.$$"
    log "!! 无法保存部署记录；下次重新验证"
    return 1
  fi
  log "部署完成：$(git log -1 --format='%h %s')"
}

run_loop() {
  log "deploy-loop 启动：$REMOTE/$BRANCH，每 ${INTERVAL}s 检查一次"
  while true; do
    check_once || true
    date +%s > "$FRIDAY_HOME/deploy-loop.heartbeat"
    sleep "$INTERVAL"
  done
}

have_tmux() { command -v tmux >/dev/null 2>&1; }
loop_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if have_tmux; then
    if tmux has-session -t "=$SESSION" 2>/dev/null; then echo "deploy-loop 已在 tmux 会话 $SESSION 里运行"; return; fi
    tmux new-session -d -s "$SESSION" -c "$FRIDAY_DIR" "bash scripts/deploy-loop.sh run"
    echo "已启动（tmux）：tmux attach -t $SESSION；日志 $LOG"
  else
    if loop_running; then echo "deploy-loop 已在后台运行（pid $(cat "$PID_FILE")）"; return; fi
    (cd "$FRIDAY_DIR" && setsid nohup bash scripts/deploy-loop.sh run >/dev/null 2>&1 & echo $! > "$PID_FILE")
    echo "已启动（nohup，pid $(cat "$PID_FILE")）：日志 $LOG"
  fi
}

stop() {
  if have_tmux && tmux has-session -t "=$SESSION" 2>/dev/null; then tmux kill-session -t "=$SESSION" && echo "已停止 tmux 会话 $SESSION"; fi
  if loop_running; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; echo "已停止后台 deploy-loop"; fi
}

status() {
  if have_tmux && tmux has-session -t "=$SESSION" 2>/dev/null; then echo "tmux 会话 $SESSION：运行中"; fi
  if loop_running; then echo "nohup 循环：运行中（pid $(cat "$PID_FILE")）"; fi
  [ -f "$FRIDAY_HOME/deploy-loop.heartbeat" ] && echo "上次心跳：$(date -d "@$(cat "$FRIDAY_HOME/deploy-loop.heartbeat")" '+%F %T')"
  cd "$FRIDAY_DIR" && echo "checkout 版本：$(git log -1 --format='%h %ci %s' 2>/dev/null || echo '不是 git 仓库')"
  if [ -f "$SUCCESS_FILE" ]; then echo "部署验收记录：$(cat "$SUCCESS_FILE")"; else echo "部署验收记录：尚未完成或上次尝试失败"; fi
  [ -f "$LOG" ] && tail -n 5 "$LOG"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  once) check_once ;;
  run) run_loop ;;
  *) echo "用法: $0 [start|stop|status|once|run]"; exit 1 ;;
esac
