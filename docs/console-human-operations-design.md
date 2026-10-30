# E1b：网页上的人类操作

2026-09-20，暂停/恢复、指定 Run 停止、展示偏好与待办操作已实现；记忆写操作仍待上下文失效接通。证据见 E1b 验收。本文保留完整设计，不表示原 57 项目标已完成。承接 人类后台设计、[目标架构](target-architecture.md) 和 [记忆失效设计](memory-invalidation-design.md)。本文不新增工单、运行队列或通用 command 框架。

首片让人暂停/恢复已有职责、停止指定 Run、修改展示偏好、更新待办。记忆确认/更正/忘记接同一人类操作凭据，但其开放依赖下面的真实上下文失效关口；数据库更新不能冒充暖 ACP 已忘记。

## 1. 复用哪些操作

| 操作 | 当前可复用代码 | 最小提取或补充 |
| --- | --- | --- |
| 暂停/恢复职责 | `RoutineApplication.control/stop`，`routines.resumeState/resume/setEnabled/canManage` | 从 `routine-application.ts:126` 的事务和随后 abort 循环提取同步 `persistControl`；保留现有配置版本、once 与读取游标规则 |
| 停止指定 Run | `orchestrator.ts:2450–2480` 已分 `recordRunStop` / `signalRunStop`；`Registry.requestStop`、`RunAttempts.requestStop` | 窄宿主端口按稳定 runId 找当前句柄，核对 taskId/session/actor，再调用原持久逻辑；不向网页暴露 `RunningTask`，不复制 SQL |
| 修改偏好 | `applySpaceSetting` 的 brevity/ack 分支，`Spaces.patchConfig/defaultsFor` | 薄 `SpaceApplication.configurePresentation` 接收规范化值；聊天解析和网页表单都调用它。首片只开放 brevity、ack，不开放模型、仓库、角色、notes 或任意 config |
| 确认/更正/忘记记忆 | `ChannelMemory.confirm/remove/add(replaces)`；C1 revision、changes、tombstones、真实复制失效 | 薄 `MemoryApplication` 收真实人类凭据及 CAS；补精确 `getForAudience(id, audience)`，复用 E1a 源筛选；接可信上下文失效端口 |
| 更新待办 | `Todos.update/transition/confirm`、`listForAudience` | 薄 `TodoApplication.update`；精确可见性查询、受控字段摘要 CAS、组合更新事务。状态仍用原状态机 |

`SpaceLifecycle.stop` 已先持久后关 runtime，但空间停用/恢复不是本片按钮；不借此顺带开放换绑。GitHub Issue/PR 状态、Skill 管理、创建/删除职责、重新执行 once、OAuth 重连均不混入上述动作。

## 2. 真实身份、来源和版本先检查

网页 POST/PATCH 的顺序固定：

1. `ConsoleAuth.authenticate` + `requireMutation` 验证当前 cookie、Origin、JSON、CSRF；请求体读取前后再验原 session。Agent Bearer、模型提供的 openId/role/messageId 都不能代替它。
2. `HumanSpaceAccess.authorize` 做本人 DM / 当前群成员 fresh 检查。偏好用 `configure`；其余先 `read` 再做对应资源管理检查。所有外部 await 后调用原 grant 的 `assertCurrent()`，不能用重读的新绑定替代原目标。
3. 查精确资源，核 scope、chat/kind、DM 本人、旧来源可见性；范围不符统一 404，不先返回标题。**不能只因编号在本库存在就修改，也不能从 100 条列表里没找到推断不存在。** E1a 的 audience predicate 应抽成 store 内共享片段，用于单条与列表，不另写一个宽松 `get`。
4. 对人类控制不套 Agent 的 `canPersistDerivedState`：暂停/停止没有模型正文。网页记忆/待办正文来自当前经过 CSRF 的明确提交；不能因此放开 Agent 旧 Run/来源门禁。
5. 进入短同步事务后再次验 session/grant、资源归属及版本，再执行。数据库事务内无平台请求、模型运行、runtime close 或消息发送。

首片新修改仅针对 active Space；归档页仍只读，不能用 E1a 的 `allowArchived:true` 给写请求放行。已提交操作的回执只读重取可按归档读取权核验，不能借重取恢复职责或重做修改。

群成员保留原 `RoutineStore.canManage` 的同群职责管理能力；本人 DM 只管理自己。偏好需 owner 或已有当前群成员身份的部署 admin，并且 Policy.configure=allow。部署 auto/admin 不能绕过本人 DM 或当前群成员硬边界。Run 按本人实际执行身份管理，不增加群成员停任意其他人的 Run 的权限。

资源版本由宿主提供，浏览器只回传：职责 `configVersion`、记忆 `revision`、Run 不变 `runId+taskId`；偏好和 Todo 没有版本列，使用当前受控字段的规范化摘要 `expectedTag`，在同事务核对。不同对象不共用一个可随意覆写的“版本号”。

## 3. `console_operations` 只记一次真实点击

新增一个小 store `ConsoleOperations`，不建立待运行 command。建议表字段：

```text
id PRIMARY KEY                  服务端生成，不接受浏览器指定 operationId
session_id, actor_open_id        来自 ConsoleActor；session 可回查 appId/tenantKey
request_id                      浏览器为本次明确点击生成
space_id, operation, resource_id
input_digest                    对规范化动作、目标、expected version、显式 patch 做摘要
created_at, result_json          result 只含资源 ID/版本/实际转换等最小事实
UNIQUE(session_id, request_id)
```

不持久化 cookie、CSRF、UAT、模型正文、记忆正文或表单完整正文；否则“忘记”会在操作日志留下一份正文。认证后的 actor/operationId 从服务端传入领域应用，不从 JSON body 取。

一次新操作：外层 SAVEPOINT → 最后同步核权/CAS → 插入该操作身份 → 调用领域同步持久方法 → 写真实 result → RELEASE → afterCommit。失败整体回滚；不保留半条 pending 操作让重启自动执行。`result_json` 可在事务内暂为空，但 helper 未写回结果必须抛错，不能提交空结果。

同 key、同规范化输入：先重新核对当前 actor 与资源访问范围，再返回原事实，`replayed:true`，不再次写业务状态或重发任何平台消息。先查幂等回执再对新操作做 CAS，避免成功后重试因旧 expectedVersion 被误拒。同 key、不同目标/输入返回 409。新 session 不冒认旧 session 的 requestId；旧登录撤销后不能取回旧敏感回执。

回执区分“当时已应用”与“此刻状态”：返回 `operationId/appliedAt/appliedResult`，必要时附经过当前授权重读的 `current`。不能把原成功回执当成当前还启用/还存在。忘记后的相同请求可用同操作的资源 ID/原 scope 与 tombstone 核验，返回原删除事实；不重新要求原正文还存在。

afterCommit 不是另一个动作队列：只取消捕获的同一个 Run、退休同一个旧上下文。失败记录/返回 `runtimeCleanup:'pending'`，持久停用仍有效；同 key 重试最多再次尝试这个精确清理，不重新产生业务修改。进程在 commit 后、清理前崩溃，已有持久 stop/invalidated 门禁及启动恢复负责阻止旧执行，不重新派发它。纯网页操作只返回网页回执，不默认向群多发一条。

## 4. 各动作的具体接口和退出状态

### 4.1 暂停/恢复职责

建议共享接口：

```ts
RoutineApplication.persistControl(id, action: 'pause' | 'resume', expectedConfigVersion)
  -> { routine, changed, affectedRunIds, afterCommit(): void }
```

这是已有 `control` 的持久部分，不是新的授权入口；调用者先核精确 routine 的 `spaceId/chatId/chatType/ownerOpenId` 和 `canManage`。旧 `spaceId=null` 只允许现有同 chat/kind 范围，不借 null 跨空间。网页授权 await 后、事务里重读原 routine 与 configVersion。

- pause：复用 `setEnabled(false)` 的配置版本失效、occurrence 取消，以及原应用的真实活动 attempt 停止；外层事务保存操作回执后才 abort。已手动暂停的无变化调用应返回 `changed:false`，不无意义推进版本；正在执行的 once 即使 enabled=false 仍要按原 occurrence 状态取消，不能仅凭 enabled 判“早已暂停”。
- resume：复用 `resumeState/resume`；不直接写 enabled，不清空 cursor/lastRun，不造新的 once occurrence。已开始、interrupted、unknown 或已完成的 once 继续要求核对，不自动补发；被停止的 feedback 不被复活。返回实际下一时间及恢复原因。
- watch 仍检查原 `runAs` 的已有委托连接，不借网页登录 token 代替它。不在事务内刷新 token；如共享操作需要 `accessTokenFor`，在事务前完成，随后复验当前登录、原 Space、同一 routine/version 和当前 token，聊天也调用这条路径。缺授权返回原恢复理由，不能顺带进行 OAuth 或解除手动暂停。

当前组合 `RoutineApplication.stop()` 会在自身 RELEASE 后立即 abort；如果外面还有 console SAVEPOINT，它实际还没 commit。**必须先拆分后复用**，不能直接把旧组合函数塞进外层事务。

### 4.2 停止指定 Run

```ts
host.persistHumanRunStop({ actor, spaceId, runId, taskId })
  -> { result: 'stop_requested' | 'already_stopping' | 'already_finished', afterCommit(): void }
```

端口从 `RunAttempts.get(runId)` 和宿主当前 Map 定位 exact run/task/session，核 Task/Session 的当前 chat/kind 与当前人；不能按 session alias 找“现在那个 Run”。只支持执行页明确展示、归属本人且有 Task 的 Run；无 Task 的后台执行仍通过对应职责 pause 管理。

新停止在同事务复用 `recordRunStop`：Task.stop_reason + 同 attempt.stop_requested + 本 Task 的问题取消 + 仅本 occurrence 取消。afterCommit 调 `signalRunStop`，只能触碰捕获的同 runId；若 Run A 已结束、同 Session 的 Run B 已开始，不能转而停 B。已经终态不改成 cancelled，回真实现状；未知外部结果和旧 Delivery 收据保持。

停止当前 Run 不暂停 interval 的未来职责，不将 feedback 标成“停止未来跟进”，不关闭 GitHub Issue。回执说“已请求停止”，直至持久 Run 真正 cancelled 才显示“已停止”。

### 4.3 展示偏好

```ts
SpaceApplication.configurePresentation(spaceId, { brevity?, ack? }, { actorOpenId, expectedTag })
  -> { effective, tag, changed }
```

允许 `brevity=short|normal|detailed`、`ack=react|none`，拒绝未知键，不接受任意 config 对象。摘要覆盖这两个原始受控字段及 Space 绑定，不把 defaults 算成已保存字段。调用 `Spaces.patchConfig(id, patch, actorOpenId)`，保留“只继承此次明确个人偏好”的既有白名单。聊天把同义词转换为这些值后调用同方法；网页无需把表单伪造成 `/space set` 消息。

修改不重启 Run，不回溯重发 ACK。说明下次使用位置：brevity 影响后续构建的 prompt，ack 影响后续新任务反馈；正在执行的这轮不宣称已整体换成新行为。models/reflect/proactive/notes/repo 授权不在首片 patch。

### 4.4 确认、更正、忘记记忆

新增 `MemoryApplication.confirm/correct/forget`，调用共享单条 audience 查询、scope/CAS 和已有 store；不绕过 C1 legacy predicate，不允许网页拿 rawGet 操作来源不可见的正文。普通同群成员保留现有本群人工记忆权限，DM 仅本人。

人类证据有两个**宿主入口**：

```ts
type HumanMemoryEvidence =
  | { kind: 'message'; by: string; messageId: string }
  | { kind: 'console'; by: string; operationId: string }
```

现有 `MemoryConfirmation` JSON 保留 `{by,messageId,at}`；新增互斥 `{by,operationId,at}`。不造 `messageId='console:...'`。应用验证 operationId 是当前同事务登记的 session/actor/Space/动作/目标；store 格式检查仍拒同时有两种 ID、空凭据、私聊非本人确认。调整 `validConfirmation/toNote/promote/legacyPromotion` 的 proof 等价比较，不能只改 confirm 而在重启或复制时降回 candidate。MCP certainty/source.by 不能生成该凭据。

- confirm：`expectedRevision` 必填，复用原候选及 competing replacement 检查；变更记录沿用真实 at，失败不声称已确认。
- correct：明确“保存更正并确认”是一次授权；外层同事务 `add(replaces=id, expectedRevision)` + 宿主确认新条目，确认失败必须抛错回滚新候选，不能留半个更正。原条目/复制失效沿原 store；不改写原 ID 的正文。首片保留 kind，只改明确 title/body；超出 200/1500 上限直接 400，不借 store 截断尾部重要内容。
- forget：复用 remove 的 tombstone、变更日志和已知新副本失效；保留无正文操作回执。旧 legacy 分享没有真实祖先，不声称已找全所有副本，更不删除聊天原消息或外部文件。

**开放依赖：**上述事务还须接 C2 的可信同步 `invalidateMemoryReaders(changeRefs)`，持久标失效并阻止受影响旧 Run 的读写/发布；提交后关闭旧 ACP，下次由新的真实上下文重建，保留原 WorkKey/Task/业务修改目录。不能只更新 C1 revision、发一句“忘记了”，或把旧 ACP close 后按同 ID resume。`ensureAcpSession` 当前只有技能 digest 等已有旋转逻辑，尚无这个记忆失效端口。

若该端口、暖历史读取重建和材料边界未完成，E1b 可先完成 memory 应用/凭据/存储回归，但网页写按钮和 endpoint 必须保持未开放并标明待接入；不能用 stub 的成功回执验收。这不要求 E1b 自己搭建隔离平台；完整 C2、跨群个人沉淀及 native 旧材料不可达性仍按原设计验收，不能据新网页绕开。

### 4.5 更新待办

```ts
TodoApplication.update(id, audience, { expectedTag, patch }, actorOpenId)
  -> { todo, tag, changed }
```

共享单条 audience 查询与 E1a `listForAudience` 同一真实 session 来源判定；`scope/ownerOpenId/source` 由宿主核对，不能从浏览器修改成别人的范围。首片 patch 为 title/detail/dueMs/status/statusNote/confirm，暂不开放重新指派 owner。

tag 覆盖 ID、scope、sessionKey、title/detail/dueMs、status/statusNote、owner/ownerOpenId、confirmed；不包括后台 remindedAt 等无关游标，避免提醒刷新让正常编辑总冲突。同事务核 tag，再调用原 update/transition/confirm，组合输入任一失败整体回滚。重开、完成和取消严格走原状态机；不顺带关闭 Issue。长度/日期前置验证，不静默截断网页输入。没有真实 session 的旧记录保持 E1a 兼容，不能将此称已证明所有旧来源。

## 5. 最小实施顺序与验收

1. `console-operations.ts` + router mutation adapter：真实 CSRF、幂等回执、最后同步授权、原子回滚；先不新增平台出站。对真实非空旧库复制迁移两次，保留所有原业务行和 ID。
2. 拆职责/Run 的持久阶段与 afterCommit，聊天先改用同组合方法，再接两个网页按钮。随后加偏好和 Todo 的窄应用操作/CAS；保留原权限和状态机，不借迁移扩大 admin/auto。
3. 记忆 proof 双来源及 MemoryApplication、原 confirmation/复制/重启回归；与 C2 失效端口合验后才开放网页写，单纯存储通过不算该功能通过。

每步上线前必须实际覆盖：

| 用例 | 必须观察的事实 |
| --- | --- |
| POST body/成员/token await 中注销、退群、换绑、降角色 | 操作零提交，无新回执；已有资源名称不泄漏 |
| 相同请求两次/进程重启/HTTP ACK 丢失；同 key 改目标 | 一次业务转换，重复原事实；冲突 409；无重复通知 |
| 外层操作回执写入失败 | 所有领域变更回滚，零 abort/close；不能出现状态恢复但 worker 已被杀 |
| commit 后 abort/close 失败或立即重启 | 持久 stop/invalidated 仍有效，旧执行无法迟到发送；旧 unknown 不重放 |
| 暂停 running once、恢复 completed/interrupted once、反复 pause/resume | 原 occurrence 和 cursor 保留，未知结果不新建一次，不复活已停反馈 |
| 捕获 Run A → 授权等待 → A结束且同 Session 开始 B | 只能报告 A 已结束/目标已变化；B 不受影响 |
| 网页偏好与聊天并发更新 | 同应用方法，旧 tag 拒绝；只改明确字段，个人继承白名单不扩大 |
| 网页确认/更正、真实聊天确认、伪 operationId/MCP certainty | 前两者留下各自真实凭据，后二者拒绝；重启/分享不降级、不伪造 messageId |
| 两个更正竞争、忘记与更正竞争、忘记后重复同 key | CAS 拒旧版本；不留半更正；无正文回执，不重新泄漏被忘记内容 |
| 记忆变更后原暖 ACP、后台 reflect/routine、native 材料 | 实际消费者与输入被重新核验；未通过的 C2 部分明确未开放，不能只验 prompt 字符串 |
| 旧来源 memory/Todo、群他人 DM receipt | 使用 E1a 同源过滤；count 与 items 同过滤；只展示当前受众回执 |

原功能映射保持原编号：G11/G12/G31（后台与偏好）、G16（回复展示）、G21/G29/G35（职责控制与恢复）、G32/G34（精确执行停止与状态）、G19（记忆人工修改）、G22（待办管理相关部分）。E1b 不增加一组新“完成阶段”来替代这些功能；自然语言多轮、真实 UI/飞书和完整 C2 未验项目仍各自保留。
