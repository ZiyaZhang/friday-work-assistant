# B2 执行身份与工具凭据

2026-09-20，实施设计。Task 根与真实补充关系提供 `task:<rootId>`；职责沿用 `routine:<id>`。RunAttempt 只记录一次实际执行的身份、触发、主体、Session、ACP 和终态，不复制案件、GitHub 或职责状态。无 Task 的整理/巡查使用其已有一次性 Session 标识，不能按负 Task ID 推导业务身份。

Run 领取与 Task 从 queued 到 running 在同一 SQLite 短事务完成，ACP 和网络在提交后执行。一次触发不能因为重启生成第二次执行。停止先记录 stop_requested，再发取消；收尾不能覆盖已记录的停止。启动将未收尾 attempt 标为 interrupted，继续只恢复 B1 证明从未开始的交接。等待信息来自 Question/Reply 当前事实，不将已经排队的答复改回等待，也不在本片自动重放已开始工作。

每个 MCP 凭据签入不可变 runId。API 验证签名、当前执行身份、主体、空间和能力；旧凭据即使在新 Run 已开始后才到达，也不能借用新的身份。请求进入后继续使用原绑定，在受管副作用前重验。模型不提供 runId。

DSH 的 active session 不能原地变更 MCP 配置；已用 DSH 0.1.6-alpha.2 验证 close → 同 ID/cwd resume 更新 MCP 进程和目录且保留历史。宿主每轮重新绑定，旧进程凭据立即因 Run 终态失效；resume 失败不回退到旧凭据。会话历史及材料来源保持原有约束，不随凭据更新清空。记忆失效、材料重建及 native 读取限制是 C 的独立门槛。

普通、职责、巡查、Wiki、整理和反思都必须有明确 attempt，才能开启生产 API 的强制绑定。现有 Task/occurrence、投递键、Issue/PR 操作键保持不变。逐项接入时检查停止、权限等待、迟到调用和 unknown；旧历史不补造 attempt。

验收包括：Task/Run 原子领取失败回滚；同触发不可重复开始；同 Session 不并行两次；停止与晚完成竞态；重启后旧 token 失效；真实 DSH 同 ID 换 MCP；API 收到旧 Run token 时拒绝（不仅请求已入站之后才切换的情形）；原投递未知状态和旧库所有原字段保持。

实现与证据分层见 B2 验收。这次只闭合执行身份，不代表完整工作生命周期或模型行为已经通过。
