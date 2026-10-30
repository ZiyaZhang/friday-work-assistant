# B2：Task 工作根的窄存储契约

本片实现已有 Task 的稳定工作关联；不新增业务事项表、Run 表、执行权限或自动恢复入口。工作键为 `task:<rootTaskId>`，原 Task 的 ID、正文、状态和来源均保留。案件、职责、Issue/PR 仍使用现有领域记录；相同 Session、标题、案件或 message_id 不足以合并工作。

## 存储与接口

- `tasks` 追加可空 `work_root_task_id`。普通新 Task 指向自身；真实 `task_amendments` 后继继承原 Task 的工作根。
- `Registry.taskWork.get(taskId)` 返回 `{ key, rootTaskId }`，不存在或关系无法可靠解析时返回 `undefined`。它只读，不发起执行，也不代表调用人有权读取整个工作。
- `createTaskOnce` 增内部 `workFromTaskId`，供宿主已核实的精确 Question reply 使用。来源必须存在、同 Session、同非空发起人且拥有原 message_id 收据；系统 occurrence 收据不能代替真实入站。问题所属案件、回复人和平台锚点仍由 Question 应用操作核验，不能让模型直接指定此参数。
- `amendsTaskId` 与 `workFromTaskId` 同时出现时必须解析为同一根。绑定不能改变原 Task 的工作根；重复 dedup key 返回原 Task，不按重投参数重新绑定。
- 新 Task、工作根、receipt、amendment 和 dispatch 在现有可嵌套 SAVEPOINT 内提交。外层 Question/Reply 保存失败时整笔回滚；事务内没有模型或网络等待。

## 迁移与边界

构造器在短事务中追加列并按 Task ID 顺序回填。没有 amendment 关系的历史 Task 各自作为根，不按会话、案件或重复消息推断关联。已登记 amendment 仅在前项存在、ID 顺序合法、同 Session/真实发起人且其根可解析时继承；断裂或不一致保留空值，后续继承拒绝，不偷偷当成独立工作。显式 Question 工作根一经写入，重启不依赖再次推断关系。

迁移只填空的新列，不改旧 ID/字段、旧关系或已有根；再次构造必须幂等。新 Run、停止/waiting 状态、跨 Session 接管、运行凭据、来源清理和 GitHub/Delivery 的业务去重键均不在本片改变。`user_note` 或系统 Task 有可查询的根不等于获准执行，仍受原门禁约束。

## 验收

专测非空旧库的真实多级 amendment、无关系/重复消息、断裂关系和二次构造；同一 Session 中不同工作不合并；Question 来源继承而不伪造 amendment；跨人/跨 Session/系统收据和冲突根拒绝；新绑定、receipt/dispatch 与外层事务失败全部回滚。迁移 guard 在独立副本比较旧列与 ID 完整保留、二次全库幂等；不得用生产库直接试升级。最终结果补在本页，不以本片通过声称持久 Run 或真实飞书接续已完成。

2026-09-20 本地结果：`task-work` 15 项、`registry-receipts` 17 项、`task-handoff` 5 项、`database-migration-guard` 14 项，共 51/51 通过；typecheck、diff-check 通过。新测试通过真实迁移 guard 对非空旧格式合成数据库执行两次实际 Registry 构造器，旧列/ID 保留且第二次完整幂等。独立只读源码审查未发现阻断。本片未运行真实生产库升级、模型或飞书验收；Question 测试覆盖宿主已核实来源的存储入口，不冒充 Question 全链路接线。
