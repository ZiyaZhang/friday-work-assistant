#!/usr/bin/env bash
# 一次把 Worker 建起来：D1 → 建表 → 写 secret → 部署 → 自检。
# 重复跑是安全的：建过的不会重建，表用 IF NOT EXISTS。
#
# 先决条件只有一个：`npx wrangler login`（浏览器登录，只有你本人能做）。
set -euo pipefail
cd "$(dirname "$0")"

W="npx --yes wrangler@4"
NAME=friday-oauth

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1/5 确认登录"
$W whoami

step "2/5 D1 数据库"
DB_ID=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const h=l.find(x=>x.name===process.argv[1]);process.stdout.write(h?(h.uuid||h.database_id||""):"")}catch{}})' "${NAME}")
if [ -z "$DB_ID" ]; then
  echo "没有 ${NAME}，新建一个"
  $W d1 create "${NAME}" >/dev/null
  DB_ID=$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const h=l.find(x=>x.name===process.argv[1]);process.stdout.write(h?(h.uuid||h.database_id||""):"")})' "${NAME}")
fi
[ -n "$DB_ID" ] || { echo "拿不到 database_id，停"; exit 1; }
echo "database_id = $DB_ID"
# 把 id 填进 wrangler.toml（原来是 PLACEHOLDER）
node -e '
const fs=require("fs");const f="wrangler.toml";let s=fs.readFileSync(f,"utf8");
s=s.replace(/^database_id = ".*"$/m, `database_id = "${process.argv[1]}"`);
fs.writeFileSync(f,s);' "$DB_ID"

step "3/5 建表"
$W d1 execute "${NAME}" --file=schema.sql --remote --yes

step "4/5 RELAY_TOKEN"
if [ -n "${FRIDAY_OAUTH_RELAY_TOKEN:-}" ]; then
  printf '%s' "$FRIDAY_OAUTH_RELAY_TOKEN" | $W secret put RELAY_TOKEN
  echo "已写入（值来自环境变量，没有打印）"
else
  echo "环境里没有 FRIDAY_OAUTH_RELAY_TOKEN。生成一个并写进去："
  echo "  export FRIDAY_OAUTH_RELAY_TOKEN=\$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-40)"
  exit 1
fi

step "5/5 部署"
$W deploy

echo
echo "部署完了。自检："
echo "  curl -s https://${NAME}.your-subdomain.workers.dev/healthz"
echo
echo "还要你手动做一件事：把下面这个地址加进飞书开放平台"
echo "  安全设置 → 重定向 URL："
echo "  https://${NAME}.your-subdomain.workers.dev/oauth/callback"
