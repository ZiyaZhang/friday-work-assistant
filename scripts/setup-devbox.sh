#!/usr/bin/env bash
# 在开发机上一键准备 Friday 运行环境（幂等，可重复执行）。
#   bash scripts/setup-devbox.sh
# 前置：能访问 npm registry / GitHub / open.feishu.cn；已把 .env 填好。
set -euo pipefail

FRIDAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$FRIDAY_DIR"

if [ -f .env ]; then
  set -a; . ./.env; set +a
else
  echo "!! 没有 .env，先 cp .env.example .env 并填好飞书凭证与模型 key" >&2
  exit 1
fi

FRIDAY_HOME="${FRIDAY_HOME:-$HOME/.friday}"
DSH_HOME="${DSH_HOME:-$FRIDAY_HOME/dsh}"
WS_ROOT="${FRIDAY_WORKSPACE_ROOT:-$FRIDAY_HOME/workspaces}"
DSH_VERSION="${DSH_VERSION:-0.1.6-alpha.2}"

step() { printf '\n==> %s\n' "$*"; }

step "检查 Node（需要 >= 22.13）"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<22||(maj===22&&min<13)) { console.error("Node 版本过低: "+process.version); process.exit(1) } console.log("node "+process.version)'

step "安装 dsh @deepseek-ai/dsh@$DSH_VERSION"
if ! command -v dsh >/dev/null 2>&1 || [ "$(dsh --version 2>/dev/null || true)" != "$DSH_VERSION" ]; then
  npm install -g "@deepseek-ai/dsh@$DSH_VERSION"
fi
dsh --version

step "安装 Friday 依赖并构建"
npm install
npm run build

step "准备目录 $FRIDAY_HOME"
mkdir -p "$FRIDAY_HOME" "$DSH_HOME" "$WS_ROOT/repos" "$WS_ROOT/chats" "$WS_ROOT/dm"

step "克隆 / 更新 deepseek-harness 到 $WS_ROOT/repos"
if [ -d "$WS_ROOT/repos/deepseek-harness/.git" ]; then
  git -C "$WS_ROOT/repos/deepseek-harness" pull --ff-only || echo "(pull 失败，保留现有版本)"
else
  git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git "$WS_ROOT/repos/deepseek-harness"
fi

step "生成 dsh profile 与 skills（friday --doctor 会做同样的事）"
node --no-warnings=ExperimentalWarning dist/index.js --doctor || true

step "检查沙箱能力（bwrap / Landlock）"
if command -v bwrap >/dev/null 2>&1; then
  echo "bwrap: $(bwrap --version 2>/dev/null || echo present)"
else
  echo "bwrap 未安装：dsh 会退化为 partial 沙箱（只靠 Landlock/权限），容器环境可能连 Landlock 也没有。"
  echo "  Debian/Ubuntu: sudo apt-get install -y bubblewrap"
fi

cat <<EOF

完成。接下来：
  1. 飞书开发者后台：开启机器人能力，勾选权限（见 README「飞书应用配置」），事件订阅选「长连接」，
     订阅 im.message.receive_v1，回调 card.action.trigger，发布版本，把 Friday 拉进目标群。
  2. 前台试跑：npm start
  3. 常驻：bash scripts/run.sh   （tmux）或   scripts/friday.service（systemd --user）
EOF
