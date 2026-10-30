# 原生飞书任务生命周期同步

本片以本地 Todo 为业务事项，以 `feishu_task_links` 为精确原生对象关联。标题、详情、截止时间、完成与重开都比较双方上次确认的字段快照：仅本地变化就 PATCH 该字段，仅飞书变化就回写本地；不同字段可合并，同字段同时变化保留双方事实并显示冲突。提醒回执不参与 `todoTag`，不能让一次提醒使用户编辑失效。远端人的修改不会被“本地已完成”规则重新覆盖。

取消遵循用户明确选择：删除原生任务；以后明确重开，新建一个 generation。保留旧 GUID 和原 DELETE 回执，不复用旧创建键。精确 GET 确认任务在飞书被删除时，未改动的本地活跃事项进入 cancelled；已 done 的本地事项保持 done，不绕过 Todo 的状态机。两者以后只有明确重开才新建。若本地同时编辑，保留冲突，不按缺失强行取消或重建。

每次原生写先向 `feishu_task_operations` 占位，记录冻结的输入、原对象和 generation；成功回执与关联快照在一个 SQLite 事务中提交。旧 Promise 的 ACK 仍保存，但不覆盖新的本地修改。单实例 sweep 重入共享同一次 Promise，数据库唯一未决操作约束防止另一个同步实例再次发起同一事项的写。

创建 ACK 未知时不重新 POST。`reconcileCreation(todoId, guid)` 只读指定 GUID，必须匹配原操作写入的随机 `extra` 标识、原负责人和当前 Todo 锚点（空间、会话、创建时间），才绑定原生对象；之后负责人若已变化，按转交处理。人明确确认“飞书里没有这条”时，`abandonCreation` 把原操作记为 abandoned，下一轮才会新建。

修改、删除、成员操作的 ACK 未知时，按同一 GUID 读回判定：读回已是目标值就确认；同 GUID、同代、本地意图未变、远端仍是请求前的值，而且同一请求重复执行无害时，在同一操作行上重发，最多共 3 次、间隔至少 60 秒，`attempts` 递增；其余情况记为 `unknown_write` 等待。之后读回若显示迟到生效，自动确认；否则由人经 `resolveConflict` 选择以哪边为准，原操作记为 abandoned。读到旧值本身不证明请求没执行，所以本地意图变化后不会用旧请求覆盖新决定。DELETE 只有原 GUID 的官方 `1470404` 能证明对象不存在；资源拒绝 `1470403`、普通 HTTP 404、网络错误都不能证明删除。

权限拒绝按能力分开（读、写、删、成员）：`99991672` 只挡住需要该能力的操作，`99991663`（应用 token 失效）挡住全部。默认冷却五分钟，权限配置版本变化或 `resetPermissionBlock()` 可立即恢复检查。被挡住的事项标 `permission_required` 并排到队尾，其他事项照常读取、修改、创建。确切对象的权限拒绝不影响其他事项。错误日志只记操作种类、内部事项编号、结构化错误码和结果类别，不记录任务内容、SDK 请求或令牌。

远端删除和转交的补充规则：
- 读回返回 1470404 时，把没结的修改和成员操作按“目标已删除”结案。本地没改过就跟着取消；有新修改的，交给人决定：以飞书为准就取消本地，保留 Friday 的就建新一代任务。
- 转交时，Friday 自己加进去的成员记在 `transfer.ours`。负责人又变了就重新规划，事项被取消就直接删除任务，都不会留下两名负责人。
- 1470400、1470610、1470611 算明确拒绝；99991400 频控会让所有调用暂停 60 秒。

负责人只用 `responsibleOpenId`：有 open_id 的用 open_id；本人私聊里没点名他人的归本人；只有名字或群里无负责人的不猜，也不进入创建候选。改负责人时先 add_members 新负责人、读回，再 remove_members 原负责人、读回，两步各自记账；未完成时 `view()` 显示“转交中”。在飞书里直接改负责人视为冲突。`view(todo)` 给出不联网的状态说明，本地保存不等于原生成功。

## 官方合同和实际限制

- [Task v2 概述](https://open.feishu.cn/document/task-v2/overview)：同一 client_token 要求请求参数不变；不同 access_token 的去重隔离，成功后的有效期仅五分钟。因此不能将固定 todoId 哈希当作永久去重保证。
- [创建](https://open.feishu.cn/document/task-v2/task/create)：`extra` 是调用方自定义数据，在 GET 中原样返回；创建需 `task:task:writeonly` 或 `task:task:write`。
- [更新](https://open.feishu.cn/document/task-v2/task/patch)：`update_fields` 中列出的字段若未设置新值表示清空；`completed_at="0"` 表示重开。`due.timestamp`、`completed_at` 和 `updated_at` 为毫秒。
- [读取](https://open.feishu.cn/document/task-v2/task/get)：`1470404` 为不存在或已删除，`1470403` 为无资源访问权。
- [删除](https://open.feishu.cn/document/task-v2/task/delete)：需 `task:task:delete` 或 `task:task:write`，单独的 `task:task:writeonly` 不包含删除。

官方 PATCH schema 和当前 SDK 没有 If-Match、版本条件或其它 CAS 入参。当前实现能防止已读到的远端人工修改被覆盖，并复验每次 await 后的本地版本；不能声称消除了远端最后 GET 与 PATCH 之间的竞争窗口。不会捏造一个平台不支持的原子条件更新。

已存在的旧链接没有完整字段同步历史。迁移不编造历史，第一次回读双方一致才建立新基线；不一致显示 `legacy_conflict`。冲突需要人明确决定采用哪一边，不能靠重新跑同步猜答案。原生内容超过本地字段容量时显示 `invalid_remote`，不静默截断人的修改。

## 根装配所需工作

本片没有改共享 `index.ts`、API、MCP、Orchestrator、tokens 或迁移适配器。平台权限改为申请 `task:task:write`（或同时开通 read、writeonly、delete、`task:personnel:writeonly`）。

1. 原有 timer 已调用 `taskSync.sweep()`。构造参数应传 `cancellation: 'delete'`，符合本次用户选择；传 `assertCurrent` 检查宿主未关闭且当前部署仍允许同步。可传 `permissionVersion`，也可沿用五分钟重检。timer 的日志/状态应包含 updated、reopened、cancelled、conflicts、unknown，不能只看旧的三个计数。
2. 将 `ensureFeishuTaskSyncSchema(db)` 加入 schema-only adapter；迁移只新增空 `feishu_task_operations`，并给旧 `feishu_task_links` 追加 `snapshot_json TEXT NULL`、`generation INTEGER NOT NULL DEFAULT 0`、`deleted_at INTEGER NULL`、`issue_json TEXT NULL`。旧 GUID、URL、负责人、时间、完成字段不变，旧快照和旧收据不得回填。
3. 展示原生状态时，在现有 Todo 当前受众检查后调用 `status(todoId)`。`pending` 表示真实写结果待核对，`link` 仅是已知原生关联；本地保存成功不能改写成原生任务也成功。unknown create 的精确 GUID 核对入口同样需在请求前后复验当前 Todo 受众和宿主身份，不向模型开放任意 GUID 读取。
4. 原生写在后台同步发生，不能被归作当前 worker 已完成的写。若恢复/控制台聚合原生收据，需要同时读取未决 `feishu_task_operations`；不能仅凭 link 存在忽略后续未知 PATCH/DELETE。
5. 外部开放前需实际开通和发布原生 Task read、writeonly、delete 应用权限（或覆盖三者的 write），再验真实创建、内容编辑、完成、重开、取消删除、再次重开及权限拒绝恢复。本片无生产/网络写，不替代真实验收。

## 本地验证

新增 `test/feishu-task-lifecycle.test.ts` 使用真实 SQLite、TodoApplication 版本更新和 FeishuTasks wire adapter，provider 为合成 SDK：双向字段/完成/重开；冲突与独立字段合并；GET 等待期间新编辑；晚 PATCH ACK；删除与新 generation；创建/PATCH/DELETE 丢 ACK；重启不重写；权限版本和冷却恢复；精确原生归属；schema 两次升级不改变旧记录。

定向命令：`npm run typecheck`，`npx vitest run test/feishu-tasks.test.ts test/feishu-task-sync.test.ts test/feishu-task-lifecycle.test.ts test/todo-application.test.ts test/recovery-evidence.test.ts`。2026-09-22 当前结果为 5 文件、134 条通过；`git diff --check` 通过。

2026-09-23 修订后的定向结果：`test/feishu-task-lifecycle.test.ts` 共 47 条。新增的覆盖：缺删除权限、负责人不猜、创建途中取消、取消不依赖当前负责人、转交和转交做到一半、在飞书里改负责人、结果未知时有限重发、迟到的 ACK、人工选边、状态视图；以及独立审查后补的：修改没结时远端被删、转交途中又改负责人或被取消、恢复后重建结果未知时放弃重建且不挡住队列、明确拒绝与频控、超长内容选以 Friday 为准、取消冲突选以飞书为准，与 `feishu-tasks`、`feishu-task-sync`、`todo-application` 一起通过。数据库只给 `feishu_task_operations` 追加 `attempts INTEGER NOT NULL DEFAULT 1`。
