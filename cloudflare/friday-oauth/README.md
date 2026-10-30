# Friday 公网授权回调

网关部署在内网时，浏览器不能访问它的 localhost 或内网回调端口。Worker 接收飞书/GitHub 回调，网关经配置的 HTTPS 代理取回授权结果。应用密钥、token 交换和用户 token 始终留在网关。

`/github/token` 提供本人个人令牌配置页。网关生成十分钟有效的签名请求与一次性 RSA 公钥；浏览器使用 RSA-OAEP/SHA-256（state 作为 label）加密后 POST，Worker 不接收明文令牌。接收端校验同源、请求体上限、公钥签名与 state；相同请求不能重复覆盖。沿用加密 claim/ack 通道交给网关核验 GitHub `/user`，成功后更新本人连接卡。页面禁用缓存、Referrer、第三方资源和 iframe 嵌入。

流程：浏览器 → `/oauth/callback` → 加密写入 D1；网关 → `/relay/claim` → 换 token 并核验本人 → `/relay/ack` → 在私聊告知结果。

- 网关签发带 HMAC 的 state，10 分钟过期。无有效签名不能写入 D1。
- D1 只存加密结果。claim 不删除，避免网络丢包吃掉授权码；ack 清除密文并保留过期前的完成标记，防止重复回调。
- 网关在处理前占位，重试 ack 不重复换 token 或发消息。每 5 分钟清理过期记录。
- 页面不回显 code，不宣称已连接；不缓存、不传 Referrer。关闭 Worker 请求观测以免记录完整回调 URL。
- 核验授权人成功后才保存 token。身份不匹配、断开后的迟到回复、重复回调均不能覆盖有效授权。

## 配置

Worker：`wrangler.toml` 绑定 `friday-oauth` D1；`RELAY_TOKEN` 使用 Wrangler secret。首次创建库后填入 database_id，再执行 `schema.sql`。`deploy.sh` 可执行这些步骤，密钥由调用方安全提供，不要打印或提交。

飞书开放平台 → Friday → 安全设置 → 重定向 URL 添加：

`https://friday-oauth.example.workers.dev/oauth/callback`

网关环境同时配置：

```
FRIDAY_OAUTH_RELAY_URL=https://friday-oauth.example.workers.dev
FRIDAY_OAUTH_RELAY_TOKEN=<与 Worker 相同的 secret>
```

回调地址自动使用该公网 origin 的 `/oauth/callback`。如显式配置 `FRIDAY_OAUTH_REDIRECT_URI`，必须完全一致。出网使用 Friday 现有的 `FRIDAY_FEISHU_PROXY` 配置；代理变量的具体优先级见 `src/feishu/proxy.ts`。

Worker 与网关必须使用匹配协议的版本。按仓库既定迁移、隔离全量测试和部署流程发布网关；旧授权卡的 state 不会跨重启恢复，部署后重新发卡。

## 验证

`npx vitest run test/oauth-worker.test.ts test/oauth-relay.test.ts test/connect-completion.test.ts test/oauth-resume.test.ts`

测试使用真实 SQLite SQL，并覆盖回调重复、取码丢包、ack 丢包、身份不匹配、迟到回复和关注任务恢复。正式验收还需确认公网回调可达、网关代理取回成功、本人授权落库、用户身份 API 可用；仅 Wrangler 登录或 healthz 成功不代表授权已接通。
