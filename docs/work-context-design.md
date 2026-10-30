# 薄工作生命周期（WorkContext）：第一片

对应架构实施顺序第 3 项的存储与准入部分；统一等待条件、跨入口条件唤醒、`run_stop` 暂停语义仍未实现，本文不宣称第 3 项完成。

## 做了什么

`src/core/work-contexts.ts` 在既有 Task 工作根（`task:<rootTaskId>`，见 [B2 工作根](task-work-design.md)）之上保存一段委托的生命周期事实，由 `Registry.workContexts` 持有：

| 字段 | 含义 | 写入者 |
| --- | --- | --- |
| `lifecycle` | `open / completed / cancelled` | 宿主控制操作；新的真实输入把 `completed` 重新打开，`cancelled` 不复活 |
| `revision` | 并发控制；`control()` 可带 `expectedRevision` | 每次控制 +1 |
| `controlEpoch` | 控制版本；准入时取得，之后的控制使旧准入过期 | 每次控制 +1 |
| `inputSeq` / `handledSeq` | 该工作内真实输入的单调序号 / 已被完成的 Run 消费到的序号 | Task 创建事务 / Run 收尾 |
| `work_pause_reasons` | 暂停原因集合 `(reason, causeRef)`：manual、run_stop、authorization、space_disabled、config_invalid、executor_unavailable | 控制操作；恢复只删除对应 `(reason, causeRef)` |
| `work_inputs` | `(seq, taskId, kind)`；kind 为 instruction / evidence / control | Task 创建事务 |

`running / stopping / queued / waiting / needs_attention / idle` 不落库：`view(workKey)` 在读取时从 `run_attempts`、`tasks.status`、`bug_questions.resolution` 和 `deliveries` 推导。

实际调用点（不是空接口）：

1. `Registry.createTaskInWork` 在 `create_task` SAVEPOINT 内调用 `registerTask`：新工作建 open 上下文，每个真实 Task 记一条输入。Task 创建回滚时上下文一并回滚（`test/work-contexts.test.ts`）。
2. `Orchestrator.runTask` 的 Run 领取 admit 内先 `claim(workKey)`：已取消、已完成、暂停中的工作不开始新 Run，Task 记为 `cancelled / work_<原因>`；与 Task/Run 领取同一短事务。职责工作（`routine:<id>`）仍由职责自己的生命周期管理，不经这里。
3. `Orchestrator.finishRun` 对正常结束（非停止）的 Task Run 调用 `markHandled`；被停止的 Run 不把输入标为已处理。
4. `FeedbackControl.stop` 在 `stop_feedback` SAVEPOINT 内把与案件相关的全部工作标为 `cancelled`（causeRef `feedback:<id>`）；迟到补充仍作为输入记录，不复活委托。
5. Console 执行记录每条任务附带工作事实：生命周期、推导活动、暂停原因、未处理输入数。

## 迁移

构造器为旧库中每个 `work_root_task_id` 建 open 上下文，输入按 Task ID 顺序编号，`handledSeq` 取最后一个已终态 Task 的序号；二次构造幂等。不改旧 Task 字段与 ID。真实旧库两遍迁移仍需在开发机独立副本上验证。

## 第二片

- **取消整段委托。** `Orchestrator.persistHumanWorkCancel`：授权同 `humanRunTarget`（空间/成员/私聊本人）外加操作者必须是 `authorityOpenId`；SAVEPOINT `cancel_work` 内 `control cancel`、排队输入 `requestQueuedStop`、运行中且 attempt 仍 running 的 Run `recordRunStop`；已在停止（stop/steer）的 Run 不再改写，由其收尾路径记录结果；`afterCommit` 复核后才 `signalRunStop`。Console `work.cancel` 必带 `expectedRevision`，回执 `version = revision`；执行视图给委托人 `canCancel`。
- **停止即暂停。** `recordRunStop`（聊天停止、Console `run.stop`）在同一 SAVEPOINT 给开放的委托加 `(run_stop, run:<runId>)` 暂停。排队输入在 `runTask` 领取时被 `claim` 以 paused 拒绝 → 不再取消，而是保持 queued 并停放（内存 `parked`；持久待续记录就是它的 `task_dispatches` 行，重启后 `recoverHandoffs` 重新排队并再次停放）。
- **恢复。** Console `work.resume`（reason + causeRef + revision CAS；不存在的暂停原因返回 `already_resumed`）或委托人的下一条真实指令（`registerTask` 对 instruction 输入删除全部 `run_stop` 暂停）解除暂停；提交后 `wakeParked` 按 Task 顺序重派，先停放的先跑。`authorization/space_disabled/…` 类暂停不因新输入解除。
- **派发前 epoch 校验。** Run 领取时记下 `controlEpoch`；`promptRun.beforeDispatch` 发现 epoch 变化抛 `WorkAdmissionStale`：不派发、attempt cancelled/work_paused、Task cancelled、发固定回执“准备期间被暂停…”。已开始的 Task 不重放（`run_attempts(trigger_key, stage)` 唯一），所以这条输入到此结束，恢复后由人再说一次。
- **进度回答。** `taskProgress` 附带委托状态（已取消 / 已暂停及原因）。`view().activity` 新增 `paused`。

## 明确没有做

- 没有 `work_waits` 表：等待条件 = 开放追问（Question）与暂停原因，待续记录 = 排队 Task + task_dispatches；两处求值分别在答复入库（同事务建 Task）和 Run 收尾/恢复（队列继续或 `wakeParked`）。不另存需要维护的副本。
- 暂停在准备期间发生时的输入不会自动重跑（见上），只回执。
- 一个 Run 只领取一个委托的约束沿用现有共享 Task 的“诚实拒绝”，未新增局部停止。
