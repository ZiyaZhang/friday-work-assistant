# Friday

Friday 是连接飞书与 DeepSeek Harness（DSH）的助手。群聊中，它在对应空间里处理团队任务；私聊和 DSH 中，它帮助本人管理事项、准备工作、使用已授权的外部工具，并继续同一段个人对话。

本仓库包含 Friday 服务端、DSH 插件、中转与执行服务、部署脚本和测试。DSH 引擎是独立依赖；运行凭据、个人授权及生产数据库由部署环境提供，不属于源码。

```
飞书长连接 ──► Friday 网关 ──► 控制面（线程↔会话 / 串行队列 / 频道笔记）
                                   │  ACP (JSON-RPC over stdio)
                                   ▼
                          dsh --profile friday（一进程多 session）
                                   │  MCP stdio
                                   ▼
                          friday-lark-mcp ──► 网关内部 API ──► 飞书
```

## 从哪里开始读

| 模块 | 代码入口 | 职责 |
| --- | --- | --- |
| 服务启动 | [`src/index.ts`](src/index.ts) | 组装配置、存储、平台连接与后台任务 |
| 工作与权限 | [`src/core/`](src/core/) | 工作生命周期、空间、来源核验、事项与收集进度 |
| 飞书接入 | [`src/feishu/`](src/feishu/) | 消息、卡片、授权与个人入口 |
| 桌面应用接口 | [`src/personal/desktop-application.ts`](src/personal/desktop-application.ts)、[`desktop-bridge.ts`](src/personal/desktop-bridge.ts) | 请求校验、设备身份、加密中转及执行回执 |
| DSH 插件 | [`integrations/dsh/`](integrations/dsh/) | 界面、设备配对、请求恢复与本机工作 |
| 个人 MCP | [`src/personal/mcp-connections.ts`](src/personal/mcp-connections.ts) | 工具连接、逐次确认、长时间等待与结果回执 |
| Gmail | [`src/gmail/`](src/gmail/) | 本人邮箱授权、读取、草稿与确认发送 |
| 中转与执行服务 | [`cloudflare/`](cloudflare/)、[`services/friday-executor/`](services/friday-executor/) | OAuth/设备中转，以及独立执行服务 |
| 部署与回归 | [`scripts/`](scripts/)、[`test/`](test/) | 环境准备、服务管理、迁移校验和行为回归 |

使用 DSH 入口见 [插件安装与配对](integrations/dsh/README.md)。修改代码前先阅读 [空间与权限](docs/spaces.md)、[工作上下文](docs/work-context-design.md)；当前验证边界见 [稳定性与真实流程验收](docs/friday-stability-acceptance.md)。历史设计文档可能包含尚未落地的方案，不能代替当前源码和验收记录。

本地开发检查：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

设备加密协议的源文件是 `src/personal/device-crypto.ts`；修改后运行 `node scripts/build-dsh-plugin.mjs` 更新插件中的生成文件。DSH 浏览器入口使用现有模块加载器，Host 模块修改后的重载方式见插件说明。

## 快速开始

```bash
cp .env.example .env        # 填 FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY
bash scripts/setup-devbox.sh   # 装 dsh、构建、建目录、clone deepseek-harness、生成 profile
npm start                   # 前台试跑；常驻用 bash scripts/run.sh
```

`npm run doctor` 只做体检（dsh、profile、飞书凭证、工作区），不连长连接。

## 受限环境部署

在没有 sudo、systemd、cron，且只能经 HTTP 代理出网的容器里也能运行。Friday 对这些约束的处理：

- 飞书 API 与长连接经 `FRIDAY_FEISHU_PROXY`（只挂在 Friday 自己的 axios/ws 实例上，见 `src/feishu/proxy.ts`）；dsh 子进程默认剥掉所有代理变量，`FRIDAY_DSH_PROXY=1` 才注入并自动补 `NO_PROXY` 内网白名单。
- `DEEPSEEK_BASE_URL` 直接透传给 dsh 的 llm-deepseek（它默认走 Messages 协议，根要以 `/anthropic` 结尾；`npm run doctor` 会用 1 个 token 探一次端点，区分 key 错、路径错、通了）。
- `bash scripts/run.sh`：有 tmux 用 tmux，没有就 `setsid nohup` + 自动重启循环；`status` / `logs` / `restart` / `stop`。
- `bash scripts/deploy-loop.sh start`：每 60 s 检查 `origin/master`（`DEPLOY_BRANCH` 可改），目标未部署成功时执行 `reset --hard` → 按需 `npm ci` → 构建 → 重启。tracked 文件有未提交修改时拒绝 reset。成功以 `$FRIDAY_HOME/deploy-success.sha` 为记录，不以 checkout HEAD 代替；安装、构建、重启或检查失败都会在下次重试。日志在 `$FRIDAY_HOME/logs/deploy.log`。

部署检查沿用单实例与 `run.sh` 的 node 启动命令：旧 PID 必须退出，恰好一个新 PID 连续两轮通过配置的 `FRIDAY_API_HOST` / `FRIDAY_API_PORT` 的 `/healthz` 检查，才记录成功；这只证明网关基本存活，飞书与模型仍需实测。首次没有成功记录时，即使 HEAD 已相同也会安装、构建和重启一次。尝试前使旧记录失效，失败后保守重装依赖；构建失败不主动重启，但原地变更依赖和产物不等于旧运行环境完整保留。升级此脚本后须 `stop` 再 `start` 部署循环以加载新逻辑；手动 `once` 前先停循环，避免并发部署。

## 飞书应用配置

1. 开发者后台创建企业自建应用，开启「机器人」能力。
2. 权限管理 → 「批量导入/导出权限」：下面是群聊基础能力的应用身份权限示例，不是所有功能的完整权限清单。个人功能还需要本人的用户授权，新增应用权限也需发布生效：

   ```json
   {"scopes":{"tenant":[
     "im:message","im:message.p2p_msg:readonly","im:message.group_at_msg:readonly","im:resource",
     "im:chat:readonly","im:chat.members:read","contact:user.base:readonly",
     "docx:document:readonly","wiki:wiki:readonly","wiki:node:read",
     "im:message.group_msg","im:message.reactions:write_only","im:chat.members:bot_access",
     "cardkit:card:read","cardkit:card:write","drive:drive.metadata:readonly"
   ],"user":[]}}
   ```

   要让 Friday **建文档**（`feishu_create_document`），再加 `docx:document`（创建/编辑文档）和 `drive:drive`（给发起人/群加协作者）——这两条是否免审以后台提示为准；不开的话工具会明确报"没有创建文档的权限"，私聊里做了个人授权仍可用本人身份建。
   前 10 个是必需的（收发消息、群历史、附件、群/成员、人名、文档/知识库）；`im:message.group_msg` 让 Friday 不被 @ 也收到群消息（群聊记忆的来源，标"敏感"，请告知群成员）；其余可选。`contact:user.base:readonly` 开通后还要在「可访问的数据范围」里配成全员，否则查不到人名。
3. 事件与回调：订阅方式选「使用长连接接收事件」（需要先把 Friday 跑起来再点「验证」），事件加 `im.message.receive_v1`，回调加 `card.action.trigger`。
4. 版本管理与发布 → 创建版本 → 可用范围 → 申请发布。可用范围很小、且所有权限都在飞书《小范围使用免审权限列表》里时，版本页会显示"本次发布免审核"，否则进管理员审批。数据权限范围里把飞书人事等无关模块设为"无"。
5. 把 Friday 拉进要用的群。要让它读某篇文档，把文档分享给 Friday 应用；知识库让管理员把 Friday 加为知识空间成员。

## 用法

| 你做的 | Friday 做的 |
| --- | --- |
| 群里 `@Friday 总结一下最近三天关于发布的讨论` | 用表情反馈状态，完成后在话题里回复结果；较长回答折叠，超长回答放进文档并给链接 |
| 在同一话题里直接回复 | 续接同一会话（需要 `im:message.group_msg`；否则再 @ 一次） |
| 它还在做上一条时你又发了一条（纠偏 / 补充） | **插话**：打断当前轮，不发半截答案，带着新消息在同一个 dsh 会话里继续，保留已读内容和工具结果 |
| "等他回复了再看 / 下周三回来检查实验数据" | 模型用 `friday_schedule_followup` 给自己安排一次跟进（一次性，≥1 分钟、≤90 天，每个会话最多 5 个待执行）；到点回到**同一个话题、同一个会话**继续做，结果照常回到话题里。`!routines` 里显示为「跟进」，`!routine rm <id>` 取消 |
| `@Friday !stop` / `!restart` / `!status` / `!whoami` / `!help` | 中止 / 重开会话 / 查看状态 / 我是谁（open_id、可信、授权、GitHub）/ 说明 |
| 私聊 Friday | 每人一个长期会话，笔记按人隔离；可以问"项目群上周聊了什么"（只限你也在的群） |
| 让它"把结果私聊发我" | 通过 `feishu_send_dm` 只发给任务发起人 |
| （自动）| 收到任务先在原消息贴"在做了"表情，完成换 ✅、失败换 ❌（`FRIDAY_REACTIONS` 可改或关掉） |
| `@Friday 把陆知行发的那份 SKILL.md 发我看看` | `feishu_find_files` → 下载 → `feishu_send_file` 把文件发回话题/私聊，附一句说明 |
| （自动）任务做完后 | 做法值得复用时发一张「新提议 · 新增技能」卡片（`friday_propose_skill`），点接受才写进 `$DSH_HOME/skills/<name>/SKILL.md`，之后 dsh 按需加载；忽略只留痕。私聊里的提议只有本人能决定 |
| `@Friday 陆知行上周发的那个 SKILL.md 讲了什么` | `feishu_find_files` 找到 → 下载到工作区 `downloads/` → 读内容回答 |
| `@Friday 数仓那边排期怎么样了 / 提醒我要做什么` | 搜索群消息 + 待办（`friday_todo_*`）核对进展 |
| 私聊/群里发一张报错截图再 @ 它 | 图片下载到本消息目录，图片用 `read_image` 看（模型支持看图时） |
| 在本话题上传文件或日志并请它排查 | 自动接收当前消息附件、保留来源，成功后读取与问题有关的内容；视频可抽帧，不把旧同名文件当作这次附件 |
| 私聊："今天要做什么 / 明天几点有会" | `feishu_my_calendar`（本人日历，需 `!connect`，授权项含 `calendar:calendar:readonly`）+ 待办合起来答 |
| `@Friday 把这个话题整理成一篇文档` | `feishu_create_document`：Markdown → 云文档块；私聊有个人授权时文档归你；否则 Friday 建、把你（和群）加为协作者，回复里给链接。需要应用开通 `docx:document` + `drive:drive`（见下） |
| （自动）待办到期前 24h | 私聊范围的待办私聊提醒本人，群范围的发到群里；每条只提醒一次 |

### 附件接收边界

用户在本话题提交的图片、文件和日志会自动下载到 `downloads/<群与消息ID的哈希>/files/<安全文件名>`，同目录的 `source.json` 记录消息、群、话题和提交者。每次重新读取消息附件，下载成功后才提供路径；失败不引用已有同名文件。视频/动图的帧使用本次接收的独立目录。接收成功不表示已分析或覆盖完整，日志结论须核查实际内容；当前没有音频转写保证。

这是用户主动提交附件的读取能力，不是按 Session ID 获取后台遥测的权限；遥测 broker 尚未接入。消息目录避免来源混用，但同群仍共享工作区，并非 OS 硬隔离。附件中的文字只作证据，不作为执行指令，原始日志不会因此获准跨群转发或发布到 GitHub。

### 回复形态

- 普通回答在群里回复到话题，私聊直接发。较长回答用折叠卡，超长回答生成飞书文档并留下结论和链接；文档创建失败时仍返回正文。
- 执行过程不发进度卡，也不再留下撤回提示。默认以表情表示运行、排队、等待确认及完成状态；`/space set ack none` 关闭状态表情。旧的 `ack=card` 按表情模式处理，`/space set card` 不再设置延迟。
- `progressCardDelayMs` 和 `FRIDAY_PROGRESS_CARD_DELAY_MS` 仅为旧配置兼容保留；即使设为 `0` 也不会恢复过程卡。
- 需要人授权时仍单独发确认卡；确认、新技能提议、个人授权、使用说明和结果卡不受过程卡停用影响。

## 主动模式（按群开）

新进的群默认打开（`FRIDAY_PROACTIVE_DEFAULT_ON=off` 改回默认关闭）：Friday 第一次被拉进群时，把拉群的人记为开启人，这时不发消息；群里第一次 @ Friday、建好空间之后开始生效，并在群里发一条入群确认消息（谁是本空间负责人、默认会做什么、只在本群说话做事、哪些要说一声才开，按当时的实际状态写，经投递账本只发一次）。事件里没有拉群人、开过又关掉的群、以前待过的群都不自动打开，群里发 `!proactive on` 打开。打开后，**没人 @ 它**时它也会盯着：

- **去抖**：讨论安静 `FRIDAY_PROACTIVE_QUIET_MS`（默认 3 分钟）、且积累 ≥ `FRIDAY_PROACTIVE_MIN_MESSAGES`（默认 3）条新消息，才起一个**只读**的临时会话看一眼；
- **判断**：有人问了没人答、而它能靠记忆/历史/文档给出确定答案 → 回到那条消息下面；出现决定、排期、截止日、封版 → 默默记进记忆/里程碑，不出声；其他一律 `NOTHING`（沉默）。
- **不打扰**：每群每小时最多 `FRIDAY_PROACTIVE_MAX_PER_HOUR`（默认 2）次主动发言；连续 `FRIDAY_PROACTIVE_DORMANT_AFTER`（默认 5）次巡检没事可做就**自我休眠**，@ 它一下立刻醒（"annoying agent is worse than unhelpful"）。
- **权限**：巡检会话拿的是 `PROACTIVE_SCOPES`——只读 + 记笔记/待办，没有发私聊、发文件、开 PR、跑命令的能力；只看开启之后、上次巡检之后的新消息，绝不回头翻旧账。
- **点赞**：巡检时模型可以用 `@@like <message_id> <理由>` 提名本轮消息里明确有用的人类消息（给出 know-how、修好 bug、做完功能、给出确定答案），宿主核对后贴一个表情（`FRIDAY_KUDOS_EMOJI`，默认 THUMBSUP）。不赞提问、求助、没解决的报错和 Friday 接过的任务消息；每群每天最多 `FRIDAY_KUDOS_MAX_PER_DAY`（默认 3）个，同一条只赞一次，理由只记在 `message_kudos` 账本和日志里。点赞不占每小时发言次数。`!space set kudos off` 关掉本群的点赞。
- `!proactive` 看状态（开/关、是否休眠、这小时剩几次），`!proactive off` 关。

## 定时任务与关注群聊（routines）

容器里没有 cron，网关自己每分钟扫一次：

| 你说的 | Friday 做的 |
| --- | --- |
| 私聊："每天早上 9 点把研发群昨天的讨论总结发我" | 模型调 `friday_routine_add` 登记；到点在一个全新的 dsh 会话里执行，结果私聊发给你 |
| 私聊："帮我关注 项目群里关于发布排期的讨论" | `friday_watch_add`：默认每天 18:00 读该群自上次以来的新消息，有相关内容才发一张折叠摘要卡（「关注群聊 · 群名」· 一句话），没有就安静 |
| 群里 `@Friday 每周五 18:00 发本周回顾` | 群里建的只能读本群、结果发回本群 |
| `!routines` / `!routine rm 3` / `!routine off 3` / `!routine on 3` / `!routine run 3` | 列出 / 删除 / 停用 / 启用 / 立刻跑一次 |

规则：routine 继承创建者的作用域（私聊 = 创建者也在的群，群 = 本群），不存在跨作用域的"超级任务"；私聊里建的只能由本人在私聊里管理；到期先推进下次时间再执行（进程重启不重复跑）；宕机超过 6 小时错过的那次直接跳过；连续失败 3 次自动停用并记原因；每人/每群最多 20 个。

**职责提案**：没人要求、但 Friday 自己发现某件事每次都要做（连着几周有人问同样的进展、每次发版都要核对同一个清单），它会用 `friday_responsibility_propose` 提一条常驻职责——发一张卡片，**人点「接受」才生效，并且以点的人的身份运行**（`run_as`）。72 小时没人处理自动作废，同一个地方最多 3 条待处理提案。没有 `run_as` 的职责（无主自动化）只拿只读权限：能读、能记笔记，不能发私聊、发文件、写 GitHub。`!routines` 里能看到生效中的和待处理的。

**夜间整理**（`FRIDAY_CONSOLIDATE_HOUR`，默认凌晨 3 点，`off` 关）：每天挑个空闲时段，按空间把攒下来的"待确认"记忆过一遍——合并重复的、删掉没价值的、把值得长期记住的挑出来让人点确认，结果发一张折叠卡片。**只动模型自己推断的 candidate，人确认过的一概不碰**（照 Anthropic 那套"模型提修改、人复核"的做法）。

## 机器人菜单（私聊底部：我的任务 / 关注的群聊 / 记忆 / 设置）

私聊底部菜单配置：开发者后台 → 应用能力 → 机器人 → 「自定义菜单」（主菜单最多 3 个）：「我的任务」→ 推送事件 `my_tasks`，「关注的群聊」→ `watched`，「更多」下挂子菜单「记忆」`memory`、「设置」`settings`、「使用说明」`help`、「个人授权」`connect`、「重开会话」`restart`；事件订阅里加 `application.bot.menu_v6`；发一版，5 分钟内生效（2026-09-18 已配好，版本 1.0.4）。点菜单 Friday 会私聊回：我的任务（进行中 / 待办 / 定时任务）、关注的群聊、记忆（私聊范围的笔记与常驻要求）、设置（`!whoami` 的内容）、授权卡片、重开会话。

## 空间（Space）：一个群 / 一个私聊 = 一个空间

Friday 以空间为配置、记忆、职责、成员和执行记录的共同边界，通过统一的空间身份关联各模块。

- 空间 id 和会话解耦：群空间是随机的 `sp_<8hex>`，私聊空间是 `sp_dm_<open_id>`（人即空间，永不换绑）。
- **角色**：第一个在这里和 Friday 说话的人成为**负责人**（owner），之后 `!space owners @某人` 可以加；在这个空间里和 Friday 说过话的人是**成员**（member）。改配置、换绑、把记忆晋升到联盟层只有负责人能做，全局管理员（`FRIDAY_ADMINS`，不填则沿用 `FRIDAY_TRUSTED_USERS`）通吃。
- **行为偏好**：`/space` 看本空间的身份和配置；`/space set brevity short|normal|detailed`（回答长度）、`/space set ack react|none`（表情反馈或仅发结果）、`/space set reflect on|off`（轮末整理）、`/space set proactive on|off|<每小时次数>`、`/space set criteria <什么该主动回>`；`/space note <一句话>` 原样进 prompt，`/space note rm <序号>` 删除。这些只存与部署默认值不同的部分。
- **换绑**：`!space rebind <目标群 chat_id>` 把整个空间（记忆、常驻要求、行为偏好、成员）挪到另一个群——"先在小群把它调教好，再换绑到正式群上场"。老群从此是一个空白空间。`!space archive` 停用本空间（数据留着，不再挂在这个群上）。

## 联盟（Circle）：让几个群互通

默认群会话只读本群（回答全群可见，不能把别的群的私下讨论带进来）。一个项目散在产品群、研发群、运营群时，在每个群里发 `@Friday !circle join <联盟名>`（比如 `harness`），同联盟的群就互通：在研发群里能问"产品群昨天定了什么"，也能 `friday_watch_add` 关注同联盟的群。`!circle` 看本群在哪个联盟，`!circle leave` 退出，私聊里 `!circle` 列出所有联盟；改联盟要空间负责人。

联盟只影响"眼睛"，不影响"手和嘴"——Friday 永远只在自己所在的空间说话做事。prompt 头会告诉模型当前能读哪些群。

## 身份与权限：群用机器人身份，私聊用你自己的身份

群 = 服务账号身份，私聊 = 个人账号和个人连接：

| 会话 | 身份 | 能读什么 | 结果给谁 |
| --- | --- | --- | --- |
| 群里 @Friday | 机器人（应用身份） | 只读本群的历史、分享给 Friday 的文档、`repos/` | 全群可见 |
| 私聊（未授权） | 机器人 | Friday 和你都在的群 | 只有你 |
| 私聊（`!connect` 个人授权后） | **你自己**（user_access_token） | 你所在的所有群（不管 Friday 在不在）、你的单聊、你有权限的文档/知识库；`feishu_search_messages` 不指定群时走飞书本人搜索（含单聊） | 只有你 |
| 定时任务 / 关注群聊 | 继承创建者 | 私聊建的 = 创建者的范围；群里建的 = 本群 | 私聊 / 本群 |

个人授权流程：私聊发 `!connect` → 卡片按钮打开飞书授权页 → 同意后浏览器跳到 `FRIDAY_OAUTH_REDIRECT_URI`（网关 `GET /oauth/callback` 换 token）；开发机没有内网域名、页面打不开时，把地址栏里的地址贴回私聊，网关从里面取 code（state 必须是本人发起的）。token 只存在网关 SQLite（access 2h 自动续，refresh 30d），模型和 dsh 拿不到；`!disconnect` 解除。要在开发者后台：① 权限管理 → 用户权限里开通 `FRIDAY_USER_SCOPES`（默认 `offline_access contact:user.base:readonly im:chat:readonly im:message:readonly im:message search:message docx:document:readonly wiki:wiki:readonly wiki:node:read drive:drive.metadata:readonly calendar:calendar:readonly`；`search:docs:read` 可能需要管理员审核，可以先不申请）；② 安全设置 → 重定向 URL 登记回调地址；③ 发一版。

消息缓存按群存、按会话可读范围查：群会话只查本群，私聊查"你在的群"；用本人身份拉到的消息也进同一缓存，但只有该群成员的会话能查到它。

## GitHub 身份（App 身份，token 不进沙箱）

私聊使用本人的 GitHub App 用户授权：打开「账号连接」登录，核实账号后，用个人权限读取评审请求、指派的 Issue 和本人 PR。填写用户名不算连接，也不会回退使用部署账号的私有仓库权限。账号切换或断开会使旧读取和旧执行结果失效。当前个人入口支持读取、评审准备和回复草稿，代码写入仍需后续接入本人执行身份。配置与验收见 [个人 GitHub 接入](docs/personal-github-connections.md)。

群聊继续使用已配置的团队 GitHub App / 过渡 PAT 和仓库白名单；读取与写入范围分开。团队安装权限不授予个人访问。配置见 `.env.example` 的 GitHub 段。

**修复者（写侧）**：模型说"我来修"时，`github_start_change` 让网关把仓库镜像缓存（`FRIDAY_GIT_CACHE`，默认 `$FRIDAY_HOME/git`，用 installation token 经代理 fetch）本地 clone 到会话工作区 `work/<name>` 并开分支 `friday/<slug>`；副本的 remote 是无凭证地址，沙箱里只能改文件、跑测试。改完 `github_open_pr`：网关先发确认卡给发起人（标题、改动文件清单），同意后以 `<app>[bot]` 身份 commit、推分支（token 走 `GIT_CONFIG_*` 环境变量，不进命令行）、开 draft PR。可信用户也要点这一下——对外的写操作不自动放行。

为什么不用你个人的 `gh`：群里的所有动作都记在服务账号名下（私聊里才用个人账号），审计清楚、不会把某个人的凭证放到共用开发机上，App token 一小时过期且按仓库/权限限定；机器人的 PR 不能给自己 approve，正好逼着有人 review。

## 工作状态与周报：`!status` / `!report`

`!status` 在聊天里一眼看完这里的工作状态：逾期、7 天内到期的节点（截止 / 封版 / 上线 / 会议）、在跟的事项、本周完成的、本周新确认的决定、生效中的常驻职责、等人处理的提案。`!report` 把**同一份事实**整理成一篇飞书文档（群里建的给本群编辑权限，私聊建的给本人），末尾写明口径。

关键是这两个都只读**读者本来就能看到的那几层**（本空间 → 所在联盟 → 企业），作用域由网关按身份算好再传进去，所以周报不可能把别的群的事漏出来；文档末尾会把"这份报告取了哪几层"写出来，让人一眼知道边界。要每周自动出，跟它说"每周五下午 5 点出一份周报"即可（`friday_routine_add`）。

`!status session` 才是老的会话调试信息（dsh session、轮次、队列）。

## 交接：`!handover`

换人接手一个空间时发 `!handover`，Friday 出一篇文档：是什么 / 不是什么 → 当前状态快照（成员角色、各层记忆条数、待确认多少、事项分布、职责几条）→ **6 步接手清单** → 每条常驻职责的原文定义（可直接复制重建）→ 事项明细 → 状态游标。

两条硬规则：**不含任何密钥**（凭证只在网关里，交接的是状态不是身份）；**身份不转移**——职责是"以某个人的身份运行"的，接手清单第一条就是"把职责删了让接手人自己重建，不要沿用前任的身份"，第三条是让接手人自己 `!connect`。最后一条是首轮验收：跑一次 `!status` 和 `!why`，状态对得上、读的层和你以为的一致，才算交接完成。

## `!why`：这一轮用了什么、没用什么

B2B 的 Agent 最该有、也最容易漏的东西：人问"你怎么知道的"和"你为什么看不到 X"时，答案必须来自**真实发生过的检索**，不能是模型的复述。所以网关在组装每一轮时如实记一份 ContextReceipt——读了哪几层记忆、每层带了几条常驻要求、按这次的问题命中了哪几条（编号和标题）、带没带话题历史和附件、本空间有几条行为偏好、以及**明确没取的来源和原因**（"本群不在任何联盟里，我只能读本群""别人的私聊空间群会话永远读不到"）。`!why` 把它讲给人听；模型碰不到这份回执。

配套的是**披露**：这一轮如果读了别的会话（同联盟的其他群），回答末尾会自动带一行"（本条回答引用了「产品群」的内容）"。跨空间的内容不该悄悄出现在群里。

## PR review 与自检

**PR review**：说"review 一下 #123"，Friday 用 `github_pr_diff` 拿改动，按 skill `pr-review` 的顺序走——先看已有 review 别重复别人说过的，再去 `repos/` 里 grep 核实上下文（diff 只有改动行，判断对错几乎总要看周围的代码），最后只报**能说清"什么输入会导致什么后果"**的问题。先给一句结论（可以合 / 建议改完再合 / 有阻塞问题），再列要改和可以不改；没问题就痛快说没问题。结论默认只回聊天里，人明确说"发到 PR 上"才贴过去。

**自检**（`/selfcheck [天数]`，默认 7 天）：统计当前群的任务，或当前私聊中本人的任务，列出失败、中止、短时间追问和耗时情况。执行记录含请求正文与错误，不是无敏感内容的全局遥测；未提供会话范围时不读取记录。全局定期自检和自动写入企业级教训已停用。

## 从群聊到 GitHub Issue

已绑定群内的 issue 跟进会先读完整正文、评论和时间线，再用无工具的 managed 运行评估是否需要人工核实；不会按天数关闭 issue。需要核实时，只在原群请开启关注的负责人向提出者核实。负责人点确认卡，或直接回复该卡片“已核实：仍有效”，重新核验通过后才进入其待决断清单；不自动接单、指派或评论。身份目录目前不足以严格证明提出者的飞书身份，因此不宣称已自动联系原作者。确认七天有效，绑定、线程、权限变化会失效；发送回执未知不自动重发。此候选功能需要 managed 运行时，真实平台验收尚未完成。

群里聊出一个明确的 bug 或需求，说一句"提个 issue 跟一下"，Friday 就把它变成正式 Issue。写入操作遵守以下规则：

- **写前查重**：先按"空间 + 仓库 + 标题"的指纹查本地映射，再去 GitHub 按标题搜一遍。命中已有的 Issue 就**改成补一条评论**，不会开第二张。标点和大小写不影响判重。
- **确认卡**：写之前发给发起人点，卡片上写清楚要写什么、以谁的身份写（App 身份 vs 个人 token）。
- **写后回读**：写完再 GET 一次，回报真实编号、状态、链接，不拿请求体当结果。
- **证据不足就留空**：不猜负责人、不猜标签，返回里明说"还需要人处理"，让人自己认领。指派没生效（对方不是协作者）也会如实报出来。
- **只追加不覆盖**：`github_comment_issue` 只加评论，永远不改别人写过的正文。
- **带出处**：正文末尾自动加一行"由 Friday 从群「X」的讨论整理（提出人：Y）"，人点开 Issue 能追回聊天。

需要的权限：GitHub App 的 **Issues: Read & write** + **Metadata: Read**（开 PR 另需 Contents 和 Pull requests 读写）。过渡期也可以用个人 token（`GITHUB_TOKEN`），但那样所有动作都会显示成那个人做的，确认卡片上会写明这一点。

## 工作项状态机与 PMO 看板

事项有状态：**进行中 → 阻塞 / 待验收 → 已完成**，另有已取消；合法迁移写死在状态机里（已完成的只能"重开"，不能直接改回待验收）。聊天里说"卡在等权限了""提测了""验收通过""这个砍了"，Friday 就调 `friday_todo_update` 改状态并记下原因；阻塞原因会出现在提醒和 `!status` 里，催的话也跟着变（阻塞的催"解开了说一声"，待验收的催"验收完说一声"）。

在群里用 `/pmo init` 新建独立多维表格，或 `/pmo bind <表格链接>` 绑定已有表格；建表、绑定和 `/pmo sync` 都需要本空间负责人或管理员。只导出**当前群空间自己的事项**，不包含私聊、其他群、联盟和企业层。网关每 5 分钟按各群的独立绑定同步，复核配置者权限，内容没变的行不重写。

**权威状态在 Friday 库里**，表格是单向投影，改表不会改回 Friday。不同群不能共用一个多维表格 base；记录映射按 base、子表和事项编号隔离，重绑不会复用另一张表的行号。旧版全局绑定停止同步，旧配置和数据保留，不能直接重新绑定给某个群。Friday 没有验证外部表格的全部读者或已有内容，访问权限仍由负责人管理。

## 个人 Wiki：`!wiki`

`!wiki` 把这里沉淀下来的**已确认**内容整理成一篇飞书文档：常驻要求、按项目 / 人物 / 事件主线分好组的记忆、在跟的事项、最近完成的，末尾写明边界。私聊里就是你的个人 wiki，群里就是这个空间的。

两条硬规则让它不会长歪：**正文只来自库里的条目**——模型只决定分组、排序和每组一句话，条目的标题和时间都由网关从库里取，模型引用了不存在的编号直接丢掉，所以 wiki 里不会出现没人说过的事；**链接不变**——文档建一次，之后每次 `!wiki` 在同一篇上整篇重写（`rewriteDocument`），可以收藏、可以钉在群里。没人确认的推断（candidate）不进 wiki。

## 记忆：空间 / 联盟 / 企业 三个作用域 + 常驻要求

| 层 | 存什么 | 作用域 | 谁写 | 谁读 |
| --- | --- | --- | --- | --- |
| 原始群聊（`messages`） | Friday 在的群的每条消息 + 按 API 回填的历史 | 按群 | 网关自动 | 群会话读本群（联盟内互通）；私聊读你在的群 |
| 记忆（`memory_notes`） | 问答历史（`qa`）、事实/决定/职责偏好/经验（`fact`/`decision`/`profile`/`lesson`）、常驻要求（`rule`） | `space:<空间 id>`、`circle:<名>`、`org` | 模型保存与自动整理默认候选；网关记录人的显式确认；共享不升级确认状态 | 普通执行轮按当前可读作用域组装：每层最多 12 条已确认 rule，最多 6 条相关非 rule；候选 QA 仅供显式历史检索，不自动注入 |
| 待办 / 里程碑（`todos`） | 承诺、排期、**截止日 / 封版 / 上线 / 会议**（`kind`） | 按群 / 按人 | 模型 `friday_todo_add` / `friday_todo_update` | `friday_todo_list`、菜单"我的任务"、到期自动提醒 |

写入时打作用域，读取时按会话身份取，不做推断：私聊空间只有本人可见；群空间只在本群；联盟层同联盟的群共享；企业层全员可读，但**写入要晋升**——`!memory share <编号> circle` 要空间负责人，`!memory share <编号> org` 要全局管理员，模型的 `share=circle|org` 走同一个 Policy 判定。晋升是复制一份（来源里记 `promotedFrom`），原条目不动。

模型保存与自动整理的记忆默认 `candidate`，引用原话也不自动确认。`!memory confirm <编号>` 由网关记录操作人、确认消息和时间后变为 `confirmed`。更正已确认事实时，旧项保留至新候选被确认；原目标已删除或被另一条更正替代时拒绝过期确认。旧项标 `superseded` 后不再注入或检索，保留替代链。`!memory` 分层列出，`!forget <编号>` 删本层记录；删除新项不会恢复旧项。详见 确认与迁移契约。

**轮末记忆整理**（`FRIDAY_REFLECT=on`，默认开）：每轮答完（用了工具或答得长）后，网关在同一个 dsh 会话里追加整理轮，先检索再维护候选，不能修改或删除已确认记忆。模型提取的承诺、排期待本人确认。整理输出不发给人，新消息到达会打断让位；整理轮运行命令一律拒绝。

**里程碑提醒**：截止日 / 封版 / 上线 提前 3 天、1 天、2 小时各一次，过期再一次；会议提前 1 天、1 小时；普通待办提前 1 天、过期一次。发到事项所在的群（负责人有 open_id 就 @ 他）或本人私聊；模型从"争取周五给"推断出来的先是"待确认"，提醒里会标出来，负责人说"确认 #编号"才算承诺。改期后提醒节点重算。

常驻要求是“以后遇到 xx 都要 yy”这类规矩。模型保存为 `kind=rule` 候选，确认后才进入允许作用域的常驻要求。群话题保留连续会话；私聊当前每人复用会话，可用 `/new` 另开。原话题历史可能仍包含旧答案，不等于已确认知识；跨案件上下文与文件隔离仍待完成。

## 群聊记忆（P1a）

- Friday 所在群的每条消息（有没有 @ 它都算，需要 `im:message.group_msg`）进网关 SQLite（`messages` 表 + FTS5 trigram，中文友好）；按 API 拉过的历史也进缓存，并记录每个群已覆盖的时间窗口，下次只回填缺口。
- 模型侧工具：`feishu_list_chats`、`feishu_read_chat_history`（缓存优先、分页）、`feishu_search_messages`（关键词 / 发言人 / 类型 / 时间）、`feishu_find_files` + `feishu_get_message_file`（附件下载到会话工作区）、`friday_todo_add/list/done`。
- 跨群规则：群会话只能读本群（回答全群可见）；私聊会话可读 Friday 和发起人都在的群。私聊不缓存。
- 翻记录的套路写在 `skills/feishu-history-dig/`，dsh 按需加载。

## 目录

```
src/
  index.ts              入口：网关 + 控制面 + dsh 运行时
  config.ts             环境变量 → 配置
  acp/runtime.ts        ACP client：spawn dsh、session new/resume/prompt/cancel、update 分发
  feishu/               client（API 封装，支持以用户身份调用）、ws（长连接、菜单事件）、mention（@ 判定/命令/线程键）、cards（卡片）、content（消息解析）、docblocks（Markdown → 文档块）
                        oauth（个人授权：授权链接、code 换 token、token 库、自动续期）、proxy（出网代理）
  core/                 registry（SQLite）、queue（串行）、orchestrator（编排）、memory（频道笔记）、prompt（每轮 prompt）
                        message-cache（消息缓存 + FTS + 覆盖窗口）、messages（缓存优先的历史/搜索服务）、todos（待办）
                        routines（定时任务 / 关注群聊：存储、调度、下次运行时间）、skills（技能提议：落库、接受即安装）
                        permissions（工具按名字归类、rawInput 摘要、沙箱升级字段——权限请求只带 toolCallId 时靠它找回命令）、space / policy / circles（空间、六类动作判定、联盟）
  internal/             api（本机内部 API）、tokens（capability token）
  github/identity.ts    GitHub App 身份（JWT → installation token，自动续）或过渡期 PAT；模型只能经内部 API 读
  github/changes.ts     修复者写侧：镜像缓存 → 工作区可写副本 → 确认后以 App 身份 commit/push/draft PR
  mcp/server.ts         friday-lark-mcp：挂在每个 dsh 会话上的工具服务器
profiles/friday/cordis.patch.yml   dsh profile 补丁（人设、模型、关遥测）
skills/                 dsh-codebase-explainer（讲解 dsh 代码库）、feishu-history-dig（翻群聊记录）；同步到 $DSH_HOME/skills
scripts/                setup-devbox.sh、run.sh（tmux/nohup）、deploy-loop.sh（push 即部署）、friday.service（systemd --user）
test/                   vitest：单测 + 进程内假 dsh 的端到端测试
```

## 公开部署的执行范围

`FRIDAY_PUBLIC_MODE` 默认 `false`，保留现有内部部署的运行方式。对外部署必须显式设为 `true`；配置只接受 `true/false/1/0`，拼写错误会拒绝启动。

公开模式默认不设每日任务上限（`FRIDAY_PUBLIC_DAILY_TASKS=unlimited`）。以后可配置非管理员每天启动任务的上限，按北京时间零点更新；`0` 暂停新任务，正整数为每日上限。后台任务计入委托人，同 Run 的收尾和轮末反思不重复计数。配额在派发前持久占位，失败或未知结果不退回，重启不能重置次数；超限需要次日重新发起或由管理员调整，不自动排到次日。查看进度和停止不受这项限制。管理员沿用自己账户的已有限制；任务次数不等于 token 或费用上限。

启用后，普通用户的交互任务，以及所有无人值守任务（定时职责、自动跟进、主动巡检、夜间整理、轮末记忆整理）只允许 `managed`。管理员的交互任务仍遵循 `FRIDAY_DEFAULT_EXECUTION=workspace|managed`（默认 `workspace`）。宿主每次按当前身份重新判定，不接受模型声明的管理员身份；管理员身份撤销后，旧工作区上下文不可继续使用。

启动时会准备并校验受控 profile，工作轮按实际模式路由到对应 ACP 运行时。`managed` 只提供当前 Run 获准的 Friday MCP 工具，不提供原生 shell、文件工具或其他 MCP；profile 校验失败会阻止启动，受控运行时不可用时任务失败，均不会回落到 `workspace`。模式改变后创建新执行上下文，再按来源权限重建可见材料。

公开模式当前明确限制两条旧路径：历史批量 Wiki 缺少逐项来源与受众证明，因此拒绝执行；管理员工作区任务的原生读取没有完整来源账本，因此不对其历史自动做轮末记忆整理。普通用户受控任务的轮末整理仍可执行。这些限制不会自动关闭内部模式已有能力。

`managed` 是宿主控制的工具与配置范围，不是 OS 隔离。没有容器或独立进程身份时，不能承诺安全运行跨空间的不可信任意代码；物理隔离边界见下文。

## 沙箱边界

在内核较旧、用户命名空间被禁、没有 bwrap 或 Apptainer 的环境里，不能建立文件系统或网络级沙箱。DSH 子进程按环境白名单启动，默认不继承网关飞书/GitHub 凭据；受控外部调用经网关验证 capability。环境白名单与工具审批不能阻止同一 Unix 用户下所有原生文件访问，不能保证凭据在任意执行路径都不可达。工作目录分开和 `repos/` 符号链接也不提供 OS 隔离。需要执行隔离时，应使用独立进程身份或容器边界，并做实际越权测试。

没有沙箱后端时 dsh 的实际行为：`workspace-write` 下 bash 先被拒，携带 `sandbox_permissions=danger-full-access` 和理由的重试会触发 ACP `session/request_permission`。Friday 在网关内保存工具输入，按 `toolCallId` 找回命令和理由，供权限判定及确认卡展示；过程不再发布为任务卡。需要确认时发起人收到独立审批卡，超时按拒绝。自动授权仍须遵守当前执行轮的权限边界，不能用部署偏好放宽记忆整理等受限轮次。

## 关键约束（P0）

- dsh 0.1.6-alpha.2，走 `--profile acp`；dsh 的 SDK 线没有 cancel / 审批回传 / 跨重启 resume，所以不用。
- 群和私聊分别使用 `<root>/chats/<chat_id>`、`<root>/dm/<open_id>`；获准空间挂载的 `repos/` 链接指向共享、可读写的代码检出，不是只读挂载。`AGENTS.md` 由 Friday 生成，属于操作指引，不是访问控制。
- 记忆分三层：消息缓存（原始群聊，`messages`）、频道笔记（`memory_notes`，每轮自动记一条问答 + 模型主动存的事实/决定）、待办（`todos`）；都在网关 SQLite（FTS5 trigram）里，模型经 MCP 工具读写。
- DSH 经 MCP 使用按会话签发的 capability；群会话不能借此任意跨群读取。子进程环境白名单默认不传网关凭据，但同 Unix 用户的文件可读范围仍是未解决的边界。

## 开发

```bash
npm test          # 不需要飞书或模型 key
npm run typecheck
npm run dev       # tsx 直接跑 src
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
