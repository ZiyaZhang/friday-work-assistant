# Issue 接单评估与执行交接

本领域只回答“是否适合接手”。它不创建 Issue、认领、写代码、发 GitHub 评论、发送飞书消息或插入待办。`recommend` 是持久建议，执行仍需真实用户授权与现有动作门禁。

## 根装配接口

新增表只有 `work_assessments`，构造器 `new WorkAssessments(registry.db)` 只建 schema，不恢复、不创建模型会话、不访问平台。启动在所属任务开始前调用一次 `recoverInterrupted()`，把未结评估标为 interrupted；不能在每次请求初始化时调用它。冻结迁移时须将该构造器纳入 schema-only adapter 和新增空表 allowlist。

```ts
const assessments = new WorkAssessments(registry.db)
const application = new IssueAssessmentApplication({
  registry, spaces, policy, github, assessments,
  minimumIdleMs: 24 * 3600_000, // host-owned rule; 0 disables all reads/evaluation
  assertSpaceCurrent,          // current deployment chat policy + real membership lease
  execution,                  // private managed execution adapter described below
})

const assessment = await application.assess({
  taskId: realOriginalTask.id,
  number: hostResolvedIssueNumber,
  intent: 'assess_only', // or a host-confirmed original execute_if_suitable instruction
  sources: { context: exactOriginalSourceContext, assertCurrent: originalSourceLease },
  signal,
})
```

`assess` 从 Registry 读取真实 Task、原入站、会话、Work 和当前 issue-watch 绑定；调用者不能传另一个 actor/repo/space 来覆盖它们。只接受同群已登记成员，绑定配置人必须仍有 owner/admin configure 权限；GitHub 当前 read allowlist、空间和平台成员 lease 同时生效。原任务必须是该 Work 的当前输入，未停止、暂停、归档或换绑。来源 context 的完整副本及其 digest 随评估持久保存，原控制 epoch/input sequence 不可被后来请求冒用。

仓库目标只来自真实 `issue-watch:<spaceId>` 配置。完整 Issue 正文、每页评论、每页时间线和前后元数据一致性沿用现有 `readIssueThread`。`WorkAssessmentSourceBroker` 只发 GET，安装 token 刷新后的实际请求前同样复查 lease。固定 commit 的源码读取通过 commit/tree/blob、类型/尺寸/内容 hash 核验；不读取工作副本、不跟随任意 URL 或符号链接。

宿主规则要求 open、无 assignee、无打开/已合入的关联 PR、标签匹配、绑定后仍有活动且满足等待窗口。规则不符保存完整快照和“不接”原因，不购买模型评估。无 assignee 不能证明无人工作：所有评论连同作者、时间交给模型作内容判断。资料读不全时返回来源错误，不伪造“无人认领”或“信息不足”的完整快照。

模型只输出 `recommend / need_info / not_suitable`、原因、具体缺失信息、逐字引用和受限行动建议；所有引用必须存在于本次快照，推荐必须有有效证据且不存在资料缺口。禁止模型输出授权字段。

## 独立执行适配器

`WorkAssessmentExecution` 是宿主与现有 Run/ExecutionSessions 的接线口，不是新 runtime：

- `prepare` 必须创建新的 routine-stage Run，`requireManaged:true`、`executionAllowed:false`、`mcpServers:[]`，不恢复普通执行会话。绑定持久 Run、session 和 ACP ID。
- `modeForSession` 必须读真实 runtime 映射；managed profile 本身禁 native 工具，不把空 MCP 列表当作 OS 隔离。
- `prompt` 必须调用既有 `promptRun`，保留 Run、来源、配额和排队后 beforeDispatch 检查。不得直接绕过宿主调用 runtime.prompt。
- 每个 await、排队后派发和清理结束都复查原 Work/绑定/来源；任何 tool_call、超长/非法输出、超时或非 end_turn 都终结失败。
- `finish` 只收尾该独立 Run，不向用户投递；宿主关闭的 Run 终态遵循既有 CAS 合同。

同一原 Task + repo + Issue + 绑定版本只准入一次，失败和进程中断也不自动重买评估；同一原请求可以评估不同 Issue。当前片不自动为线程变化再购买模型：交接时发现线程变化会拒绝，须由新真实输入形成新的评估。定时扫描的批次预算、触发归属和反馈展示由主流程按明确委托装配，不由本模块自行启动 timer。

### 同一个人再问（只读读取，不重买）

`WorkAssessments.latestForActor` 找同一个人在同一群、同一绑定版本下对同一 Issue 最近一条未过期（24 小时）且状态为 running/completed 的记录；宿主把它作为 `assess({ reuse })` 的候选。应用先照常重读完整线程，只有在快照 digest 逐字相同、请求方（人、群、chatType、绑定原文与版本、等待窗口）一致、且两次都是 `assess_only` 时才直接返回这条记录，不做新的准入、不开模型 Run；线程有任何变化就按新 Task 的准入重新评估。这条读取不产生任何执行租约：`execute` 仍要求原 Work 与原发起人。`get` 对同一个人在同群另一 Work 里产生的记录也只做只读呈现（`persistedForActor`），其他人的记录、别的群、换过的绑定、过期记录都拒绝。

## 执行交接

```ts
const handoff = await application.handoff({
  assessmentId: assessment.id,
  authorityTaskId: realAuthorizingTask.id,
  kind: 'human_confirmation', // explicit_request only for the original execute_if_suitable message
  sources: { context: assessment.request.origin!.sources, assertCurrent: originalSourceLease },
  signal,
  create: ({ key, assessment, authority }) => {
    // Synchronous only; application owns the encompassing SQLite savepoint.
    const next = new TaskEvents(registry).admit({
      key, kind: 'issue_assessment', domainId: assessment.id,
      sourceTaskId: realAuthorizingTask.id,
      targetSessionKey: originalSession.sessionKey,
      prompt: hostBuiltInstruction, // references exact assessment.id/snapshot.digest and the real authorization
    }).task
    return { taskId: next.id, dispatchKey: key }
  },
})
// Wake the existing queue only after handoff commits. Do not create ACP/network work inside create.
```

新确认必须是同 Work、同人、同会话的真实入站；仅“仍有效”、B7 有效性确认、模型建议或 Inbox 待决断记录都不能直接构造该授权。原请求已经明确要求修复时可使用 `explicit_request`，不强迫再次确认。member 的 `act:ask` 必须通过真实确认，不能因读权限自动升级。

交接前重读完整线程并要求相同 snapshot digest，重新核对当前规则、原来源、身份、空间、绑定原文、Work epoch 和输入序列。TaskEvents 创建明确系统事件：保留真实授权 Task 为来源，生成一致的 bot 信封、事件来源行和 dispatch，不伪造新的真人消息。Task、dispatch、评估状态同事务提交；漏 dispatch、错 Work、错 actor 或并发控制变化整笔回滚。幂等键为 `assessment:<id>:execute`。原来源和评估版本沿 request.origin/snapshot 交给执行宿主登记，不能把它们改称公开资料。

交接只授权开发该明确目标。GitHub 发表权限、PR 规则、外部动作收据与交付仍由现有动作/来源/发布门执行；本领域不授予任何额外写 scope。

## 验证

独立测试使用真实 Registry、Work、Spaces、Policy 与 SQLite，GitHub/runtime 为受控替身。覆盖多页评论/时间线、后页关联 PR、归属与权限变化、停止/新输入、只读模型、失败幂等、真实确认、同 Work 交接和事务回滚。叶子测试另覆盖固定 commit 文件、异常目录/blob、严格输出、工具尝试、超时及恢复。

宿主集成测试 `test/issue-assessment-host.test.ts` 用真实 Orchestrator、受控 ACP 运行时、内部 API、MCP 与 SQLite（GitHub 传输、飞书与模型为替身）证明：评估在独立 routine 阶段受控 Run 里进行且该 Run 的 ACP 会话没有任何 MCP 服务器；`work_assessments` 只有一行 completed 并绑定该 Run；GitHub 只有 GET、`github_issue_operations` 无新行、不向任何人发消息；同一 Task 内重复调用与同一个人在新 Task 里再问都返回同一条记录（不再开模型 Run），线程变化后重新评估；评估器尝试调用工具时评估判失败且同 Task 内不重买；绑定撤销、发起人已退群、私聊请求都被拒绝且不读 GitHub；评估中重启后记录为 interrupted 且不自动重跑。

## 根装配（P3-3a，只读评估）

已接入的挂点：

- `src/index.ts`：`new WorkAssessments(registry.db)` 无条件构造（表总是建，与迁移适配器一致）；在 `orchestrator.recoverRuns()` 之前调用一次 `assessments.recoverInterrupted()`；账本传给 Orchestrator；`createInternalApi` 参数里用 `get issueAssessment()` 取编排器上的运行时（取值时才读）。
- `src/core/orchestrator.ts`：只在 GitHub、账本和受控执行（`managed`）都配置时构造 `IssueAssessmentRuntime`；`minimumIdleMs` 取 `cfg.policy.issueUnclaimedMs`（`FRIDAY_ISSUE_UNCLAIMED_MS`，默认 24 小时；0 = 停用，此时 `assess` 直接拒绝）。执行适配器与 `assessIssueValidity` 同一种只读 Run：新会话 `issue-assessment:<spaceId>:<uuid>`、routine 阶段、`requireManaged:true`、`executionAllowed:false`、`mcpServers: () => []`、走既有 `promptRun`（模型选型用部署默认）、与原任务共用当日额度（`quotaParentRunId`）；原请求撤销或原任务停止都会结束评估 prompt；`finish` 只收尾该 Run、关闭 ACP 会话并归档会话。`executionIntent` 固定返回 `assess_only`。`captureSources`：新评估用当前 Run 的来源清单，已保存的评估用其 `origin.sources` 逐字副本；同时刷新一次真实群成员并要求发起人仍在群，有来源核验服务时再过一遍 `ExecutionSourceAccess.check`。`assertSpaceCurrent`：部署 `FRIDAY_ALLOWED_CHATS`、空间成员表、以及本次请求刷新的群成员租约（5 分钟内有效）。`recordRepositoryRead` 接 `noteRepositoryRead`。
- `src/internal/api.ts`：只挂 `POST /v1/github/assessment/assess` 与 `/get`。`requireActor` 要求 `github:read`、部署配置了 GitHub、群会话、当前 Run 为 `task` 阶段、发起人与空间存在，并从当前 Run 取 Task 编号；模型只能给 Issue 号或评估 id。
- `src/mcp/server.ts`：只注册 `github_assess_issue`、`github_get_assessment`。
- 迁移：`scripts/upgrade-schema-copy.mjs` 末尾 `new WorkAssessments(registry.db)`；guard 测试新增表清单含 `work_assessments`。

产品规则：评估只在用户明确要求时发生（群里“评估一下 #N 适不适合你接手”，由模型调用工具），30 分钟一次的 `sweepIssues` 不会自动发起接单评估（它仍只做三-6 的有效性核实并只问不接）；仓库只来自本群的 issue-watch 绑定且必须在 `FRIDAY_GITHUB_REPOS`；只读——不写 GitHub、不发评论、不发消息、不建待办；同一原 Task + 仓库 + Issue + 绑定版本只准入一次，失败与中断不自动重买。

已接（P3-3b，评估后交接执行）：`execute` 路由与 `github_execute_assessment` 工具已注册（api.ts / server.ts 传 `operations: ['assess', 'get', 'execute']`）。唯一的执行授权是原发起人在原会话、在宿主发出的确认卡上点「交给 Friday 做」：结论为 recommend 时宿主经投递账本（key `issue-assessment:<评估编号>:confirm`）回复发起人原消息发一张卡；点击由 `handleCardAction` 分派到 `IssueAssessmentRuntime.confirm`，核对点击人、会话、卡片消息 id、结论与状态，重读线程（摘要变化抛 `thread_changed`，卡片改为「线程有变化，请重新评估」），通过后以 `card:<卡片消息 id>` 记为 human_confirmation，在原 Work 建 `issue_assessment` 事件任务并标 `handed_off`，重复点击返回同一任务。模型直接调用 execute 而没有这次点击时被拒绝。交接任务在 `executeTask` 准入时经 `admitHandoffTask` 重新核验（评估、事件行、绑定原文、原来源租约），变化则取消（stopReason `assessment_changed`）；运行强制受控（不开原生工具），登记原 origin.sources 与被评估仓库的读取；GitHub 写入仍由 `FRIDAY_GITHUB_WRITE_REPOS` 与发布门单独决定。无迁移。

`IssueAssessmentRuntime` 位于 `src/core/issue-assessment-runtime.ts`。它持有真实 Registry、WorkAssessments 和 IssueAssessmentApplication；不发消息、不写远端仓库。父 Run 必须是当前真实人请求，关联原 Task、入站和 Work。

```ts
const runtime = new IssueAssessmentRuntime({
  registry, assessments, application,
  assertCurrent(actor), // sessionKey/runId/taskId/actorOpenId/spaceId 均由宿主提供
  captureSources(actor, previous), // previous 存在时核验其原 origin.sources
  executionIntent(actor, { repo, number, assessmentId }),
  recordRepositoryRead(actor, repo),
  wakeQueuedTask(taskId), // 仅提交后唤醒已有队列，不等待整段执行
})
```

`executionIntent` 是宿主真实输入或批准收据的解析结果：`assess_only / execute_if_suitable / human_confirmation`，每次解析后复验同 Task/Run。不能由 MCP 参数、评估输出、日期、中文关键词猜测授予。未有该证据就是 `assess_only`。原始修复授权允许评估推荐后直接交接；后续批准必须是同 Work 中新收到的真实输入。实际 `policy.act` 与仓库发表权限继续各自生效。

入口为 `assess(actor, number)`、`get(actor, assessmentId)`、`execute(actor, assessmentId)`。重复工具沿 `forTaskIssue` 查持久版本，不重新购买模型；同一个人的再问沿 `latestForActor` 与重读的线程摘要读取；交接用同一事务创建 Task/dispatch，并在提交后通过 `withoutRequestLease` 唤醒队列。唤醒失败时持久交接仍在，重新调用只唤醒同一个 Task。返回的 `handoff.taskStatus` 是该 Task 当前状态，不是 Issue 已修复的证明；返回的 `reused` 为 true 表示沿用了同一个人先前的记录（线程未变），`assessedAt` 是该记录的准入时间。

定时入口 `assessScannedIssue({actor?,number})` 复用同一 runtime。没有已经准入的真实委托时返回 `needs_authorization`，不伪造人消息或自动批准，不独立启动定时器。当前根装配没有把它接到任何定时器上。

`createIssueAssessmentRoutes` 位于 `src/internal/issue-assessment-routes.ts`，按 `operations` 提供 `POST /v1/github/assessment/{assess,get,execute}`，默认只有前两个。根必须在 `requireActor` 调统一 `need(cap,'github:read')`，校验当前 interactive stage/Run 并构造 actor；执行接口不能因“只读评估”绕过真实授权和后续 policy。`assertCurrent` 沿现有 HTTP 请求 lease 接入。模型只可提供 issue number 或 assessmentId；身份、repo、scope、intent、approved 等字段会被严格拒绝。

`registerIssueAssessmentTools` 位于 `src/mcp/issue-assessment-tools.ts`，按第四个参数注册 `github_assess_issue / github_get_assessment / github_execute_assessment`，默认只有前两个。工具正文包含持久评估与逐字证据，不含原始 SourceContext、授权收据载荷或令牌。

根在执行交接 Task 准入后使用 `assessments.forHandoff(taskId)` 取得原来源与固定评估快照，调用既有来源核验/登记入口；不能只将引用放进 prompt 而漏掉来源账本。该查询仅供宿主，不暴露未按 actor/Work 授权的原始记录给模型。
