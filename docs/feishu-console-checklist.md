# 飞书开放平台配置清单（Friday）



依据是仓库里**实际被调用的接口**（`src/feishu/*.ts` 的 SDK 调用点）和**实际报出的权限错误**，不是按功能设想列的。

> **配置完必须「版本管理与发布 → 创建版本 → 申请发布」，权限才真正生效。** 只在权限管理里勾上不发版，线上照样 403。敏感权限（`im:message.group_msg`）还要等管理员审批。

**搜权限用代码搜最准**：权限管理页的搜索框直接粘下面的代码（形如 `im:message`），中文名只是给你认的。

---

## A. 先补这个

后果：群成员在 Friday 眼里是 `用户(a1b2c3)`、`用户(d4e5f6)` 这种，解析不出真名，回复里就 **@ 不到人**，影响消息指向明确的责任人。

要两步，缺一不可：

1. 权限管理里开 `contact:user.base:readonly`
2. 「权限管理 → 数据权限 / 可访问的数据范围」把相关成员纳入范围

---

## B. 应用身份权限（机器人）

逐个粘进搜索框，勾选开通：

```
im:message
im:message:readonly
im:message.history:readonly
im:message.reactions:write_only
im:resource
im:chat:readonly
contact:user.base:readonly
docx:document
docx:document:readonly
docs:permission.member:create
bitable:app
wiki:wiki:readonly
```

**不要开 `drive:drive`。** 它是"查看、评论、编辑和管理云空间中所有文件"，范围大所以要审核；Friday 只需要"把你和群加成协作者"这一件事，专项权限是 `docs:permission.member:create`（飞书「增加协作者权限」接口文档列出的最窄选项）。

**`bitable:app` 一个就够**（创建多维表格、新增数据表、新增字段、增删改记录全覆盖）。如果你的后台只给细粒度的 `base:*`，那要勾这几个——注意 `base:site:*` 是 Base **站点**资源，**不是**建表权限，勾了没用：

```
base:app:create
base:table:create
base:record:create
base:record:update
base:record:delete
```

对照它们各自撑起什么：

| 代码 | 中文名 | 撑起什么 | 缺了会怎样 |
| --- | --- | --- | --- |
| `im:message` | 获取与发送单聊、群组消息 | 发消息、回话题、更新卡片、撤回 | 完全不能说话 |
| `im:message:readonly` | 获取单聊、群组消息 | 读单条消息 | 读不到被引用的消息 |
| `im:message.history:readonly` | 获取单聊、群组的历史消息 | 翻群历史、查旧资料 | 历史检索全废 |
| `im:message.reactions:write_only` | 发送、删除消息表情回复 | **「先贴表情」那个回执** | 收到消息没有任何反馈 |
| **`im:message.group_msg`** | 获取群组中所有消息 | **群里没 @ 也能收到消息 → 主动回复** | 只能被 @ 才动；**敏感权限，要审批 + 发版** |
| `im:resource` | 获取与上传图片或文件资源 | 下载用户发的图片/日志/视频，发文件出去 | 附件分析、发原型文件都不行 |
| `im:chat:readonly` | 获取群组信息 | 群名、群成员、机器人所在群列表 | 定位不到群，成员核验失败 |
| `contact:user.base:readonly` | 获取用户基本信息 | open_id → 真名 | 见 A 段 |
| `docx:document` | 云文档编辑 | `feishu_create_document` 建文档 | 建不了纪要/方案/导览文档 |
| `docx:document:readonly` | 云文档只读 | 读用户给的文档链接 | 读不了文档 |
| `docs:permission.member:create` | 添加云文档协作者 | 把你和群加成协作者 | 文档/表格建出来别人打不开 |
| **`bitable:app`** | 查看、评论、编辑和管理多维表格 | **`feishu_create_table` 建表**、PMO 看板 | 建表 403（报错会点名这个权限） |
| ~~`drive:drive`~~ | ~~云空间全部文件~~ | **不需要**，见上方说明 | — |
| `wiki:wiki:readonly` | wiki 只读 | 读知识库页面 | 读不了 wiki |

---

## C. 用户身份权限（「权限管理 → 用户身份」）

**2026-09-22 起改成分档**（`USER_SCOPE_TIERS`，`src/feishu/oauth.ts`）。原因很实在：
一个没开通的 scope 会让**整张授权页失败**（20027），所以把"必须后台开通"的那两项单独拆出去——
core 档不含它们，因此现在就能授权成功，不用等后台。

**core（默认申请，12 项；包含文档写权限，不能称为全部只读）**：

```
offline_access
contact:user.base:readonly
im:chat:readonly
im:message:readonly
search:message
docx:document:readonly
docx:document
im:resource
im:message.p2p_msg:get_as_user
wiki:wiki:readonly
wiki:node:read
drive:drive.metadata:readonly
```

**watch 档**（要后台开通才能加进去）：`im:message.group_msg:get_as_user`
**calendar 档**（开发者本人免审，别人用要后台开通）：`calendar:calendar:readonly`

**`im:message`（以用户身份发消息）已经从用户 scope 里整个删掉**：Friday 一律以自己的身份说话，
不借任何人的名义发消息——这是身份边界，不是省一个权限。

### 逐项对照：每一项解开什么、代码里谁在用

按 `src/feishu/client.ts` 里**实际以个人身份调的 API** 反推，不是照文档抄的。

| scope | 撑起什么 | 代码里的调用 | 缺了会怎样 |
| --- | --- | --- | --- |
| `offline_access` | token 不过期 | 刷新逻辑 | 每两小时要重新授权一次，等于不可用 |
| `contact:user.base:readonly` | open_id → 真名 | `contact.v3.user.get` | 群里只能显示一串 ou_ |
| `im:chat:readonly` | **列出你在的群**、群名、群主 | `im.v1.chat.list` / `chat.get` | "我能看到哪些群"答不出来；盯群没有候选 |
| `im:message:readonly` | 读单条消息 | `im.v1.message.get` | 读不到被引用的那条 |
| `im:message.p2p_msg:get_as_user` | 翻**单聊**历史 | `im.v1.message.list` | 私聊历史检索失效。⚠️ 用户身份**没有** `im:message.history:readonly` 这个 scope——那是应用身份那份的写法，对着应用实际可选清单核过 |
| `search:message` | 跨会话搜索 | `search.v2.message.create`（**只支持 user token**） | 按关键词找原消息做不到 |
| `im:resource` | 下载图片 / 文件 | `im.v1.messageResource.get`（`api.ts` 以读取身份调） | **盯群时读不到别人发的图和附件** |
| `docx:document:readonly` | 读你有权限的文档 | `docx.v1.document.rawContent` | 给个文档链接读不了 |
| `docx:document` | **以你的身份建文档**（归你所有） | `docx.v1.document.create`（私聊长回答落文档、日报归档） | **私聊里建文档会失败** |
| `wiki:wiki:readonly` + `wiki:node:read` | 读知识库 | `wiki.v2.space.getNode` | wiki 链接读不了 |
| `drive:drive.metadata:readonly` | 文档元信息 | 解析文档引用 | 判断不了链接指向什么 |

`im:resource`、`docx:document` 和 `im:message.p2p_msg:get_as_user` 已进入当前 core；旧授权不会自动获得新增权限，须核对飞书实际返回的 scope。

### 要审批的两项（单独申请，别混进 core）

| scope | 解开什么 | 为什么单独 |
| --- | --- | --- |
| `im:message.group_msg:get_as_user` | **盯群**：读你在、机器人不在的群 | 授权页实测 20027 失败。一个没开通的 scope 会让**整张授权页报错**，所以它必须独立成档 |
| `calendar:calendar:readonly` | 我的一天：读本人日程 | 开发者本人免审可调，别人用要后台开通 |

### 妙记：按需追加三项读取权限

`minutes:minutes.search:read`、`minutes:minutes.basic:read`、`minutes:minutes.artifacts:read` 当日已在本应用后台开通。个人请求读取妙记时仍须授权这些 scope。
搜索、基本信息、AI 纪要与行动项分别验收；没有 AI 产物不等于会议没有行动项。会议结束事件触发和自动创建待办尚不能视为已实现。
本人在私聊明确要求把妙记行动项记成待办时，宿主用上面的 basic、artifacts 两项个人权限重新读取，把所选行动项全文（含妙记标题、链接、时间）发到本人私聊并附确认卡；本人点「接受」后才写入待办并记妙记出处，「忽略」或 72 小时未确认则丢弃。不需要新增权限；读妙记的那次执行仍不能直接写待办。

几个要点：

- `offline_access` 用于取得可刷新授权；刷新仍可能过期或撤销，不能称为 token 永不过期
- **`im:message.group_msg:get_as_user` 是盯群的核心**——没有它，"帮我盯着 xx 群（它不在那个群）"根本做不到。
  **2026-09-21 的历史故障**是该权限导致 20027；2026-09-22 后台已显示用户身份开通，仍需个人同意和实际读取验收。
- `calendar:calendar:readonly` 开发者本人免审可调，别人用要在后台开通

---

## D. 事件订阅（「事件与回调」，长连接模式）

代码在 `src/feishu/ws.ts` 注册了这 8 个，缺一个就是对应功能静默失效：

```
im.message.receive_v1
card.action.trigger
application.bot.menu_v6
im.chat.member.bot.added_v1
im.chat.member.bot.deleted_v1
im.chat.disbanded_v1
im.message.recalled_v1
im.message.reaction.created_v1
```

| 事件 | 缺了会怎样 |
| --- | --- |
| `im.message.receive_v1` | 收不到消息 |
| **`card.action.trigger`** | **卡片按钮全部点不动**：个人授权卡的「完成授权」、待办勾选、提案「接受/忽略」、停止按钮、需求投票卡的「选择此项/撤回我的选择」、会议旁听的入会/离会确认卡「允许/拒绝」与会后纪要卡「接受并记录/暂不接受」 |
| `application.bot.menu_v6` | 私聊底部菜单点了没反应（见 F 段） |
| `im.chat.member.bot.added_v1` | 拉进群时不建空间、不冻结负责人、不发欢迎卡 |
| `im.chat.member.bot.deleted_v1` | 被踢出群后状态不更新 |
| `im.chat.disbanded_v1` | 群解散后空间不停用 |
| `im.message.recalled_v1` | 撤回的消息仍留在缓存里并被引用 |
| `im.message.reaction.created_v1` | 表情交互失效 |

---

## E. 重定向 URL 白名单（「安全设置 → 重定向 URL」）

个人授权必需，一字不差：

```
https://friday-oauth.example.workers.dev/oauth/callback
```

必须先添加飞书白名单，再启用网关中继配置；倒序可能产生 20029。
浏览器到 Cloudflare 公网回调，网关通过已配置的飞书代理领取并确认回调；
Worker 验证签名 state、加密保存短期回调并在网关确认后清除载荷；长期飞书凭据仍只在网关。
重启后的旧授权卡可能失效，请重新请求连接并使用新卡。是否连接成功以网关的实际授权状态为准，不能只看浏览器页面已打开。

以后 Console 上线还要加 `<HTTPS 地址>/console/auth/callback`，那是另一件事。

---

## F. 私聊底部菜单（「机器人 → 自定义菜单」）

代码已经支持，只差在后台配。`event_key` 必须**完全一致**（`src/core/orchestrator.ts` 的 `handleMenu`）：

| 菜单名（建议） | `event_key` | 点了会发生什么 |
| --- | --- | --- |
| 我的任务 | `my_tasks` | 发当前待办清单 |
| 关注的群聊 | `watched` | 发职责与关注的群 |
| 记忆 | `memory` | 发「知道的事」摘要 |
| 设置 | `settings` | 发空间设置、当前模型与授权状态 |
| 使用说明 | `help` | 发帮助卡片 |
| 个人授权 | `connect` | 发授权卡片（等同 `/connect`） |
| 重开会话 | `restart` | 归档当前私聊会话 |

配完这七项，私聊底部就是那一排菜单的形态。

---

## 不用去后台、但也要做的一件

私聊给 Friday 发一次：

```
/github <你的 GitHub 用户名>
```

不登记 GitHub 用户名就建不了 Issue。

---

## 配完怎么验

| 配了什么 | 怎么确认真生效 |
| --- | --- |
| A 段人名解析 | 群里 @Friday 问一句，看它回复开头能不能 @ 到真名，而不是 `用户(xxxxxx)` |
| `bitable:app` + `docs:permission.member:create` | 私聊说「把刚才这几条整理成一张表」，看有没有返回能打开的表格链接 |
| `im:message.group_msg` | 测试群里不 @ 它发几条，看主动回复是否触发（需同时开主动模式） |
| C 段用户权限 | 私聊 `/connect` 走完，看 Friday 回「已连接」；再说「帮我盯着 xx 群」 |
| D 段 `card.action.trigger` | 点授权卡上的「完成授权」按钮，看有没有反应 |
| F 段菜单 | 私聊底部逐个点一遍七项 |

---

## G. 需要审核的：建议一次性申请这三个，其余别申请

你问「其他需要审核的要不要一起申请」。我的判断是**只申请这两个**，因为它们对应的代码**已经写好了、只差权限**；其余需要审核的权限现在申请也用不上，反而放大授权面。

| 代码 | 身份 | 为什么值得走一次审核 |
| --- | --- | --- |
| `im:message.group_msg` | 应用 | **群里不 @ 也能收到消息**——这是主动型助手和普通机器人最本质的区别：它能自己判断该不该出手。Friday 的 `src/core/proactive.ts`、`signals.ts` 已实现整条判断链（窗口聚合 → 判据 → 决定回复/沉默） |
| `im:message.group_msg:get_as_user` | 用户 | **盯群**：读你在、机器人不在的群 |
| `minutes:minutes.search:read`、`minutes:minutes.basic:read`、`minutes:minutes.artifacts:read` | 用户 | 按你的请求查找会议妙记、阅读纪要和其中列出的待办 |
| `task:task:write`（或细分四项：`task:task:read`、`task:task:writeonly`、`task:task:delete`、`task:personnel:writeonly`） | 应用 | 把用户确认的待办创建到飞书任务，更新标题、说明、截止和完成状态并读回核验。取消会删除飞书里的原生任务，之后恢复会新建一条；改负责人时通过成员增删把原任务转给新负责人 |
| `vc:meeting.bot.join:write` | 应用 | 会议旁听：本人明确委托后，Friday 以应用机器人身份静默加入一场正在进行的会议（不开麦克风、不录制、不在会中发言），读取会议事件，会后把纪要和行动项先发到本人私聊确认，接受后才记成待办。据 lark-meeting 参考，入会、离会和应用身份的会议查询都用这一项 |

**明确不建议现在申请的**（代码零实现，申请了也调不动）：

| 场景 | 涉及的权限 | 为什么先不申请 |
| --- | --- | --- |
| 会中发言、发消息、倒计时、录制 | `vc:meeting.message:write`（会中发消息）、`vc:meeting.interaction:write`（会中倒计时）等 | 会议旁听只静默参会，入会权限见上表 `vc:meeting.bot.join:write`；会中发言、发消息、倒计时和录制都没有代码；**妙记不同，见上表** |
| 电子表格 | `sheets:spreadsheet` | 只用多维表格，没调 sheets |
| 云空间全量文件 | `drive:drive` | 有更窄的 `docs:permission.member:create` 顶替 |
| 通讯录全量 | `contact:contact:readonly` | 只需要 `contact:user.base:readonly` 做人名解析 |

