# C1b：记忆变更与执行上下文切换

本片落实目标架构的上下文、执行与学习生效契约。

## 产品行为

用户确认新值替代旧值，或删除一条记忆后，消费旧版本的运行上下文失效。正在执行的旧 Run 停止；下次合法请求使用新 ACP 会话和当前有效记忆。案件、补问、原文、Issue/PR、业务工作目录和职责配置保留，不因换模型上下文被新建或删除。

未确认的新候选不会替代已确认事实。与本次工作无关的记忆变化不影响当前执行。因记忆变化取消的 Task 可以接受指向它的后续补充，并继承原 WorkKey；用户明确停止的 Task 不因此自动恢复。

逻辑上下文切换可以独立上线。它不宣称旧文件、平台消息或模型原生工具可读目录已经被擦除。当前开发机的 OS 隔离限制见 执行隔离探针。

## 模块与接口

| 模块 | 职责与输入输出 |
| --- | --- |
| `RuntimeContexts` | 保存实际 ACP 消费过的记忆 ID/revision；绑定原 Run；检查是否可恢复；失效后不可重新有效。无正文副本、无新工作状态。 |
| `MemoryApplication` | 复用 ChannelMemory 的 add/confirm/remove/promote。短事务内提交记忆、复制品失效、context 失效和 Run 停止；返回实际结果及受影响的精确 Run ID。 |
| `MemoryRuntime` | 连接应用与宿主。同步停止对应 Task/occurrence，提交后只取消相同 ID 的活动执行；准备并登记实际 prompt 记忆。 |
| `TurnContextBuilder` | 使用已登记的 PreparedMemory，正文与回执同源。重建时移除旧助手消息，保留人类原文、覆盖缺口、案件、amendment 与 Question。 |
| `memory-receipt` | 若删除或更正导致发起 worker 自身失效，由宿主投递固定操作事实；旧 worker 不能继续生成回复。 |
| `memory-consolidation` | 将模型的完整候选整理计划一次提交；与投递占位共用外层事务，提交后再停止旧 context。 |

只有两张新增表，旧表不加列、不回填消费历史：

- `runtime_contexts`：acp_id 主键、session_key、notes_json、valid/invalidated、reason、时间。一个 ACP 属于一个逻辑 Session，可以服务多个顺序 Run。
- `run_contexts`：run_id 主键/Run 外键、acp_id 外键。每个 Run 只绑定一个 ACP context。

```ts
contexts.canResume(sessionKey, acpId): boolean
contexts.bind(runId, sessionKey, acpId): RuntimeContext
contexts.recordRead(runId, notes: readonly { id: number; revision: number }[]): void
contexts.invalidate(changes): string[] // 精确活动 Run ID
contexts.isEligible(runId, requireBound?): boolean

application.add / confirm / remove / promote(...)
  -> { value, invalidatedRunIds }
```

实际身份来自宿主绑定，不能从模型 body 中传入。`bind` 要求 Run 已通过现有 RunAttempts 绑定同一 ACP 且仍 running；`recordRead` 在返回正文或发送 prompt 前复验版本。未绑定阶段只允许准备，Gate 和工具身份必须已绑定。没有历史登记的旧 ACP 首次使用换新句柄，不猜测旧历史读过哪些资料。

来源、技能和模型仍复用已有的来源记录、SkillApplication pin、RunModels，不在新表重建一套并行权限模型。本片保留旧 `legacy_unverified` 查询兼容，不把它标成来源已核验。managed 来源记忆仍被旧消费者排除；关注群长期记忆的保存、重读、来源授权失效需要下一片授权读取服务，不依赖模型自报。

## 提交与状态转换

1. 原入口校验操作者、scope、候选/确认要求与版本。删除是已有条目的控制操作，新增/分享继续校验派生来源。
2. MemoryApplication 在同一短事务调用原存储操作，读取这次产生的变更，失效所有实际消费旧版本的 contexts，包括有明确血缘的复制品。
3. 将对应活动 Run 标记 stop_requested；同事务同步 Task 与 occurrence。已有 user_requested 等停止原因保持，不覆盖为记忆原因。不取消 Question，不暂停长期职责，不删 pending 入站。
4. 顶层提交后 MemoryRuntime 才取消相同 Run 的活动句柄。应用层本身不执行 abort；外层事务回滚时，记忆/context/stop 全部回滚，零运行时副作用。
5. 之后任何旧运行的 Gate、API、工具身份、发布与自动 QA 都会复验 context。不能依赖取消信号及时到达。

`valid → invalidated` 不可逆。后续有效请求创建新的 context；旧 Task/Run 保留取消结果，新的入站 Task 继承原工作关联。更正不会重放已经开始的外部动作，旧 planned/unknown 保留原键和待核对状态。

### 派生内容继续保留依赖

首轮真实模型验收发现：原 profile 更正后旧 ACP 已换新，但旧自动 QA 没有祖先记录，仍能由搜索重新进入新 ACP。因此仅失效模型会话不够。

`MemoryRuntime.addDerived(runId, input)` 取实际 ACP 消费过的记忆版本，`ChannelMemory` 在写入事务中复验并展开这些依赖，保存到已有 provenance.ancestors。自动 QA、普通工具保存及反思提炼共用此入口；API/MCP 不接受模型传入的依赖。原事实变更时，派生条目沿既有 unavailable 和 memory_changes 路径停用，消费它的 Run 同样停止。

更正的 `replaces` 是替代关系。先展开完整依赖，再排除被替代项及依赖它的旧派生项，保留仍有效的其他祖先；否则新更正会在自己的事务里失效，或误丢其他来源。被排除的条目必须与原条目具有相同的来源及实际 Session 受众，不能借更正消除另一群的来源边界。新条目保留原 Session、chatId 和 promotedFrom；本次更正人的消息另记审计，旧来源缺失也不能补成已核验。确认是否属于跨 scope 复制改用实际 `copied` 变更记录判断，不能拿“有祖先”当复制标志。

夜间合并在修改任何原条目前，提取各输入已有祖先。每组只能消费本组同源条目；如果依赖另一合并组或单独 remove 准备修改的上游，整批拒绝，两种排列顺序结果一致。本组原条目仍记在 consolidatedFrom 审计字段，外部依赖继续参与失效。同组替代可能先让待删除派生项的 revision 增加：整个原快照已经在同步事务内复验，后续删除使用该事务内的当前 revision，不把内部失效误报为并发更改。未登记血缘的历史 QA 不伪造依赖、不批量改写旧库；不能把新入口验收解释成所有旧问答已完成血缘补录。

本片网页记忆仍只读；将来开放 Console 写入时，必须由 ConsoleOperations 顶层提交后执行清理，不能在 SAVEPOINT RELEASE 时提前 abort。

## 所有消费者一起接入

| 入口 | 检查与恢复 |
| --- | --- |
| 普通请求、职责 | ensureAcpSession 检查可恢复性；bind 后读取/登记 PreparedMemory；Gate 实际派发前复验。业务 cwd 不变。 |
| memory/search | 读取结果返回前登记；实际 HTTP 回包前再次检查。旧 Run 不得借下一 Run 的身份读取。 |
| memory/save、forget | 必须走宿主应用，没有存储回退路径。save 返回的新条目也登记消费，不能只登记搜索或 prompt；成功提交的控制结果可以返回，但失效 worker 后续操作被拒绝。 |
| 主动判断、候选整理、Wiki 分组 | 登记实际 notes，再调用共用 promptRun；模型结束后检查上下文，不能发布失效结果。Wiki 固定材料在各次外部写入前重验版本。 |
| reflect | 父上下文已经失效时不进入反思；正常反思沿有效 context 和原阶段权限。 |
| status、report、handover、why | 能力入口传递真实 Run ID；实际返回的记忆也登记。异步取名/文档请求后复验，旧报告不能作为异常回退正文发出；why 不展示旧标题。 |

已发出的远端 POST 无法靠本地停止撤销。记忆变化后不再分发它的旧正文；远端既有结果按原执行和动作账本保留，不自动删除用户产物，也不换键重试。

## 控制回执

删除了发起 worker 已消费的记忆时，宿主发送固定文本“已删除记忆 #N。”，不包含旧标题/正文。使用 `memory:forget:<id>:v<revision>` 稳定键和原消息位置，经 DeliveryService 的权限与受众检查；群成员必须实时核验，等待成员请求后再检查空间是否仍活动且绑定相同群。

删除已经提交与回执投递成功是两件事。远端结果未知保留 unknown，相同操作重试不再发送。旧 worker 不因要解释删除结果而重新获得权限。未删到条目返回未找到，不能口头确认删除。

更正候选导致本轮失效时，同样由宿主发送“更正已保存为候选记忆 #N，待你确认。”，键为 `memory:correct:<id>:v<revision>`。候选保存与人类确认分开，不把更正建议说成已经确认的事实。

`changedScope` 验证被修改的条目；`spaceId` 从真实 Session 绑定决定原消息受众，两者分开。org/circle 更正也回原话题，只报告编号与操作事实；等待成员核验后重新检查当前 Circle，不能把其他空间正文带进回执。

## 夜间候选整理

保留原来的批量合并、删除和推荐确认能力。模型收到最多 40 条候选的完整正文和版本，仅产生 `{merges, remove, review}` 计划；该运行只授予技能读取，不授予额外记忆搜索或写入。执行发起人固定为原空间创建者，仍须是 owner 和实际群成员；不能临时借用另一位管理员。

应用在同步事务中复验整个快照，所有计划 ID 必须来自快照、不得重复或交叉操作。新合并结果仍为 candidate；旧来源 `chatId` 和 `promotedFrom` 必须一致并保留。原记录真实 Session 的群/私聊及私聊本人边界也须一致，缺失来源不能与已知来源混合；同群的不同 Session 可以合并。结果保留原 Session 引用，不把整理所在群改写成内容来源，避免换绑后扩大可见受众。原 ID、revision、Session 和引用保存在 `consolidatedFrom` 中。

记忆修改与 Delivery planned 占位在同一外层事务提交。占位失败则全部回滚，零 abort；提交后统一取消受影响的旧执行，再发送不含模型正文的简短事实卡片。首次模型工具写入不会再提前终止剩余整理。发送未知保留原 key，当日不重新整理或重发；空计划保持安静。

## 验收与迁移

对应主项 G19，兼顾 G01/G24/G28 连续工作；G09/G15/G17/G29 各记忆消费者；G33/G37/G39、S02/S08/S10 来源和身份；G34/G35、S11 恢复与迁移。原编号与未验状态见 原 57 项工程表。

验收至少包括：

- 确认 B 替代 A 后，已消费 A 的旧 context 失效；候选 B 未确认时 A 仍有效；无关条目不打断当前工作。
- 删除/更正在运行中、Gate 排队、工具回包或文档请求期间发生：旧 prompt/正文不得继续，已提交停止在 signal 前也生效。
- 同案连续补充、Question 等待与答复、同 PR 工作目录仍保留；旧助手历史不回注，人类补充不能整类删掉。
- self-invalidating forget 仅发固定回执；成员变化/空间归档拒发；unknown 不重发；原明确停止原因不被覆盖。
- 真实受保护旧库副本运行所有实际构造器两遍：旧 schema/字段/行/ID 全等，新 context 表为空，二次幂等，原备份 SHA 不变。真实零样本与非空合成例分别记。
- 真实 DSH 输入探针、真实模型连续问答、原生飞书截图分别记录；SDK 对端通过不等于这三项通过。

回退不能启动忽略 context 失效的旧代码并恢复旧 ACP，也不能恢复旧数据库伪装无损回滚。若需回退，先停止派发，再使用仍理解失效记录的兼容代码。
