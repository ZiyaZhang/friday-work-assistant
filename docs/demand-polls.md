# 需求投票：宿主接线与验收边界

当前状态：领域、运行时、卡片和来源收据已接入候选代码的 Orchestrator、内部 API、MCP server、卡片回调与现有受跟踪定时器。真实宿主、ACP、MCP、签名 HTTP 和 SQLite/Delivery/Feedback 链路已通过合成平台回归。**尚未随这一批发布，也未做真实飞书多人验收。** 下文区分代码接线、自动测试与线上事实。

## 当前默认产品规则

负责人在原群提出完整问题及选项，用户本人点击原群卡片表达选择。首版默认具名单选、一人一票；关闭前可改选或撤回。省略截止时间或传 0 不自动截止，由负责人关闭；明确未来时间才自动截止。这是当前实现的默认规则，尚不是用户对所有投票场景的最终产品决策。

选项和问题发布后不可改写，以免旧票改变含义。重新提出不同问题属于另一条真实委托。卡片完整显示问题、选项和规则，按真实 create 请求体 30,000 字节、200 个嵌套 tag 验证；超限明确失败，不截断、不自动转文档。只提供创建、列表、读取、关闭工具，模型没有投票或撤票工具。

截止结果按原选项分组，保留实际姓名和数量。姓名无法核验时显示“姓名暂不可用的参与者”，内部仍按真实身份去重，不用原始 ID 或 ID 尾号充当姓名。结果不代表所有群成员，不自动执行获选选项、创建 Issue 或代替负责人作决定。

## 数据与统一底座

`Polls` 新增 `polls`、`poll_ballots` 和 `poll_read_snapshots` 三表。前两表保存投票业务事实；第三表只保存实际返回过的完整读取结果及摘要，不维护第二套计票状态。导出的 `ensurePollSchema(db)` 只初始化 schema，不访问平台、不恢复任务。原 Task/Run/Work、真实请求消息、原空间与受管资料 provenance 由宿主捕获，模型不能传入。相同真实消息的调用使用稳定操作键；更换 Run 重试不替换原来源，不新增投票。

普通读取返回 `asOfRevision`，表示当时观察到的票数。版本 2 的来源收据用 `snapshotDigest` 绑定不可变读取结果；同一次结果重复读取去重，旧结果不会因后续正常投票失去历史真实性。需要当前结果的领域操作重新读取计票状态。每份完整快照上限 256 KiB，超限明确拒绝，不截断返回。历史结果仍限定原群，原委托、空间、成员和资料权限均需重新核验；快照不是读取或发布许可。

发布使用现有 Delivery：先占位再发，实际发送 ACK 才开放投票。ACK 后进程退出，重复请求沿相同 Delivery key 恢复；发送未知不重发。截止和现有 Bugs/Feedback 关联在同一 SQLite 事务中完成，Feedback 记录有意的简短摘要、不可改的投票摘要引用及“待负责人决断”。完整问题、选项、具名结果仍保存在 Poll，并经现有 Delivery 向原群分段交付。某段发送未知，不继续发送后段，等待实际对账。

卡片点击必须来自认证后的平台事件，绑定原 messageId、chatId、内容 digest 和实际 operator。先 fresh 验证群成员；首次真实交互沿现有 `Spaces.touchMember` 登记 member，已有成员在等待期间被撤除不会补回。每次异步调用后检查当前身份、来源及空间绑定。投票事件使用平台的唯一 event_id 和微秒 create_time；旧事件、重复事件不能覆盖较新选择，撤回也保留最后事件，重启后不复活旧票。

这些字段来自飞书[卡片回调协议](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)的事件 envelope。当前 SDK 会将 header 与 event 展平，`CardAction.raw` 保留该 envelope；共享宿主挂点必须从认证后的 raw 取值，不能信任卡片 `value` 自报 event_id、时间或操作人。

## 已接入的宿主接口

1. `index.ts` 实例化 `Polls`，经 Orchestrator 创建 `PollHost`。迁移和证据检查需纳入上述三张空新表。`PollRuntime` 只复用现有 DB、Bugs、Spaces、Policy、Feishu；不新建任务队列。
2. `PollHost` 从宿主当前签名 Task Run 构造 `PollRuntimeBinding`：真实 `PollOrigin`、当时受管资料 provenance、带 stop/Work/会话/来源现时性检查的 `assertCurrent`。它进一步核对持久 Task/Run/Work、ACP、原真人 dispatch、主体、输入版本和空间。拒绝非 task stage、旧 Run、非当前 actor 和伪造空间，MCP body 不能指定 origin。
3. `authorizeSavedContext` 接统一 retained-source-access；`resolveDelivery(poll, ref | undefined, guard)` 接原群受众及完整来源发布门禁。原 Work 停止、源权限或绑定变化不恢复执行，也不将旧数据视为公开。运行时不会自行构造放宽的 DeliveryContext。
4. `participantName(openId)` 接结构化 `FeishuClient.userDisplayName`：`{status:'known', name}` 或 `{status:'unknown'}`。不将旧 `userName` 的 ID 派生 fallback 包装为真实姓名。
5. SourceContext 通过 `recordPollSource` 保留全部已读快照；ExecutionSourceAccess、DeliveryContextResolver、受管材料 lineage/consume 复用 `PollRuntime.checkSources`。来源证明核对原空间、群受众、投票 version、内容 digest 和不可变快照摘要。派生写再调用 `sourcesCurrent` 检查已获得的真实权限租约，不能只凭持久来源字段放行。新票/撤票不抹除历史读取；停止原委托或撤销来源权限仍立即拒绝。不能跨群或转为个人私有/公开来源。
6. `createPollRoutes({runtime, requireRun, assertCurrent, error})` 返回 `/v1/polls/{create,list,read,close}` 四条路由；读需 `polls:read`、创建/关闭需 `polls:write`，只签发给获准的当前 task。`registerPollTools(server, call, errorResult)` 注册四个工具；没有 vote/withdraw HTTP 接口。共享 API 仍需现有签名、请求取消、源结果守卫及调用账本。
7. `poll_ballot` 卡片回调校验 value 的 pollId/digest/optionId 后，实际 operator/chat/message 和 envelope eventId/eventTimeMicros 交给 `runtime.vote`。不让模型或卡片 value 注入身份。返回 toast；原卡不做异步计数 patch，避免迟到刷新覆盖新状态。即使原卡仍显示按钮，截止后宿主拒绝修改。
8. 在已有 tracked 30 秒定时器调用 `runtime.tick()`；关闭后全部结果已 ACK 则跳过，未知 ACK 等待现有对账，不能换 key 重发。所有挂点均属于主宿主生命周期，停机不能新增外发。

## 已验证与仍需验收

`test/polls.test.ts` 覆盖磁盘重开、相同原请求恢复、单选改票/撤票事件排序、0、真实截止、撤权事务回滚、关闭与反馈事务、旧卡拒绝，以及实际读取快照去重、容量限制、磁盘重开后历史证明。

`test/poll-runtime.test.ts` 使用真实 Work/Run、Spaces/Policy、Delivery/Bugs SQLite，覆盖原群完整发布、姓名分类、首次成员、来源/成员/姓名 await 后撤权、ACK 后 stop、未知发布、原受众约束、历史 revision 可复验、截止一次、卡片容量。平台和 retained-source 验证的外部依赖为合成 fixture。

`test/poll-protocol.test.ts` 使用真实 MCP Client 与签名 HTTP，通过独立路由工厂调用同一 Runtime，验证完整创建/改选/撤回/读取/关闭/Feedback，拒绝错误签名、旧 Run、缺 scope、伪 actor/source/approval 和模型代投。

`test/poll-host.test.ts` 经过具体 `PollHost` 核对真实宿主绑定；其中一例调用实际飞书 SDK `EventDispatcher` 再经过 `normalizeCardAction`，验证官方 envelope 展平后仍按真实操作人、原消息和事件顺序记票。该测试不代表真实网络回调认证验收。

`test/poll-orchestrator.test.ts` 从真实任务入站进入 Orchestrator/ACP，经已挂载的 MCP/签名 HTTP 创建、列出、读取及截止投票，并在创建 Run 结束后处理真人卡片回调。它验证同 Run 读取不同 revision 后仍保留两份来源、可按真实来源整理待办、截止关联 Feedback、结果只投递原群。模型输出和平台响应为合成数据，没有真实外发。

仍需发布后的真实群验收：两位用户改选/撤回、真实事件顺序、定时关闭、来源失权、重启后回执恢复、长结果分段交付。自动化通过不能替代这些真实平台事实。
