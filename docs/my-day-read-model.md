# 我的一天：统一只读视图

读模型：`src/core/my-day.ts`；宿主适配：`src/core/personal-assistant-host.ts`（2026-09-23）。已把 API（`POST /v1/my-day`）、MCP（`friday_my_day`）和菜单“我的任务”接到宿主（见文末“宿主接入”）。它复用日历、Todos 和 Inbox，不新增汇总表、提醒账本或任务状态。

## 阅读合同

宿主绑定当前本人私聊、真实 Run 和本人私聊 scope；模型只能选择日期和条数，不能指定身份或读取范围。日期沿现有个人日历 API 的 `Asia/Shanghai` 时区，并明确返回；没有推测用户所在位置。默认当天、每节最多 100 条，可选 1–200，任何截断都标记。

日历显示实际个人日历事件和平台返回链接；待办按真实归属从跨空间记录选择，保留已核验出处、状态和确认标记，分为以前逾期、当天、以后、未定日期；待决断从本人的 Inbox 读取。没有自动推断负责人、优先级，没有创建提醒或将 Inbox 标为已提醒、已处理。

`owner=本人` 仅是候选查询，不能替代访问权。每条跨空间 Todo 和 Inbox 项须以当前本人重新核对来源；不能借用原创建者的权限。具体被拒条目的标题、内容和原空间不返回。日历未连接、缺 scope、资料拒绝、网络暂不可用分别作为局部缺口，其他可读节继续返回。未知异常保留原因并向上抛出，不吞成空列表。空且 `coverage.complete=true` 才能解释为本次范围确实没有条目。

## 宿主接线

实例化 `MyDayApplication` 时提供现有 `todos`、`inbox` 及以下适配：

- `binding(ref)`：当前本人私聊和 Run，包含独立 `assertCurrent`。不从 API 参数构造身份。
- `calendar(binding, range, guard)`：共用现有个人 scope 连接、`listMyEvents` 和来源记录；返回事件、完整性与真实 grant/Run 租约。只有已分类的平台失败可返回 typed `unavailable`。
- `authorizeTodo(binding, todo, provenance, guard)`：对当前查看者核验原空间和原资料，而不是复用原作者的身份。`recordTodoRead` 将实际允许的读取记入共同来源上下文。
- `authorizeDecision(binding, item, guard)`：按原空间与 kind/refId 对应领域核验真实待决断来源；可返回宿主核实的 `sourceLink`，没有链接时明确 unavailable。`recordDecisionRead` 同步记录真正读取的来源。

调用 `.read({sessionKey,runId},{date?,limit?})`；API/menu/delivery 在最后一次 await 后、展示之前调用 `.assertResultCurrent(result)`。原对象变更、决断被解决、Run 停止、换身份或源权限撤销都使旧视图不能发出。普通提醒计数变化不被误判成决断内容改变。

## 自动化证据

`test/my-day.test.ts` 使用真实 SQLite Todos/Inbox，平台与许可适配为合成响应。覆盖实际本人跨空间归属、其他人隔离、时间分类、原链接保留、局部权限失败、截断、撤权、输入身份变化、事项并发修改、未知错误和无业务写入。仍需真实宿主/MCP 接线及实际个人日历与跨群待办验收。

## 宿主适配（2026-09-23）

- `createMyDayApplication(deps)` 从当前 Run 和会话推出身份：Run 必须在运行，会话必须是私聊，Run 的执行人必须是会话发起人，也必须是该私聊空间的所有者。`createMyDayMenuReader(deps)` 供“我的任务”菜单使用，只接受认证过的菜单事件，不写来源上下文。
- 归属统一用 `responsibleOpenId`：本人私聊里只写了别人名字（“帮小王记”）的事项，不算本人的。
- 群待办按原群可见（用户已定）：空间仍启用；用应用身份实时查询的群成员里有本人；本人没有停止读取该群；按原群的受众过滤确认它出自该群自己的会话。不满足的只计入 `coverage.hidden`，不返回内容。原 Run 累计读过的其他资料不逐项复核。
- 待拍板：职责提案或授权提醒在原领域已经不再等待时，标记为 `stale`，不显示，也不算缺口。群里的事项附群 applink；议题有效性待拍板附原议题 URL。
- 日历经 `readCalendar` 端口读取，不等待授权卡；读取成功后才登记来源。
- `renderMyDay(result, { for: 'person' | 'model' })`：给本人的文本不带编号，给模型的保留 `[todo:n]`。
- 测试见 `test/personal-assistant-host.test.ts`。

## 宿主接入

- 构造在 `Orchestrator` 里，只在部署同时有 Todos 和 Inbox 时启用；API 依赖通过 `get myDay()` 取值。日历用 `src/core/my-day-calendar.ts`：没有个人连接或缺日历权限时直接返回 `unavailable`，不发授权卡、不等待；`listMyEventsPage` 按平台原始条数判断是否读全（达到 1000 条即 `complete=false`）。
- 来源登记：日历沿用现有个人外部来源（`calendar:<openId>:<start>:<end>`，`access: 'user'`）。别的群里的待办和待拍板事项登记为本次私聊执行的 `myDaySources` 回执（`src/core/personal-assistant-sources.ts`），内容摘要不含提醒计数。之后的投递（`DeliveryContextResolver`）和会话续接（`ExecutionSourceAccess`）都按原群当前的应用身份成员名单和原记录复核；这种回答只能投递到本人私聊。
- 读到别的群的事项后，这个执行上下文（同一会话的后续轮次）不再写入派生状态（待办、记忆等），与读日历、读别的群消息的现有规则一致；新开的工作会话不受影响。
- 菜单“我的任务”保留“进行中”和“定时任务”两节，中间换成我的一天的给本人版本；私聊空间还没有 chat_id 时用私聊空间编号作这次读取的标识。汇总被拒时回复“个人汇总只能在你和 Friday 的私聊里查看”，其他读取失败时说明“这不表示今天没有日程或待办”。
- 测试：`test/my-day-protocol.test.ts`、`test/my-day-host-wiring.test.ts`、`test/my-day-sources.test.ts`。
