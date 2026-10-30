# 职责 occurrence 的身份：逻辑执行窗口

对应[目标架构](target-architecture.md)第 ④ 节“当前 occurrence 唯一约束包含 routineId、scheduledAt、configVersion”一段与搭建顺序第 5 项中“改简报长度/模型不重复同窗口”一条。暂停原因拆分、独立学习消费者、派生依赖不在本片。

## 窗口键是什么

`routine_occurrences.window_key` = `new Date(scheduled_at).toISOString()`（`occurrenceWindowKey()`），即该次应执行时刻的 UTC 规范化毫秒时刻，例如 `2026-09-18T01:00:00.000Z`。daily 按调度器固定时区算出的时刻、interval 的到期时刻、once 的指定时刻都落到同一种键；不截断到分钟，两个不同的 `next_run_at` 一定是两个窗口。

occurrence 的身份是 `routine_id + window_key`。`config_version` 仍存在每一行上，但只是“这次执行实际使用的配置版本”快照，不再是身份的一部分。

约束：`CREATE UNIQUE INDEX idx_routine_occurrences_window ON routine_occurrences(routine_id, window_key) WHERE status <> 'cancelled' AND window_duplicate_of IS NULL`。一个 routine 的一个窗口最多一条未取消记录；取消的行不占窗口（新调度可以再次落到同一时刻）。

## 行为变化

| 场景 | 之前 | 现在 |
| --- | --- | --- |
| 只改指令 / 名字 / 发送约定（`update` 不带 schedule） | 取消所有 pending 和 running occurrence，routine 版本 +1 | pending 保留原行、原窗口，开始时把 `config_version` 改为开始那一刻的当前版本；running 仍按“配置已过期”取消（`职责配置已修改`），行不改写 |
| 改调度（`update` 带 schedule） | 同上 | 同一事务内取消尚未开始的旧窗口（`职责调度已修改`）并按新调度算 `next_run_at`；已开始的执行同样取消，行保留。取消写入失败时调度也不变 |
| 计划再次指向已有执行记录的窗口（如 once 在同一毫秒重新启用） | 用新 config_version 再插一行，同一时刻跑两次 | 不再产生第二行：`claimDueOccurrence` 看到该窗口已有未取消记录时只推进计划（once 因此停用为“一次性任务已执行”），返回 `undefined` |
| 手动 `/routine run` | `routine:<id>:manual:<message_id>` 触发身份，不建 occurrence | 不变；与任何窗口不冲突，也不推进计划或计数 |
| 暂停 / 删除 / 空间停用 / 反馈停止 / 授权过期 | 取消 pending（及 running） | 不变 |
| 开始前的检查 | 版本不一致即取消 | 只检查启用 / 状态 / 反馈仍有效；版本差异不是取消理由 |

执行键 `routine:<id>:occurrence:<occurrence id>:v<config_version>` 的生成方式不变（`execution-keys.ts` 未改）。因为编排器在 `startOccurrence` 之后重新读取 occurrence 再生成键，pending 期间的配置变化会体现在键里；开始之后 `config_version` 不再改写，键与行始终一致，`currentForExecution` 与 `requestQueuedStop` 里的版本比对照旧成立。

`routineProgress().latest_occurrence` 多返回 `window_key`。

## 迁移

构造 `RoutineStore` 时在 SAVEPOINT 内：

1. `ALTER TABLE routine_occurrences ADD COLUMN window_key TEXT` / `window_duplicate_of INTEGER`（以 `PRAGMA table_info` 判断，只加缺的列；新库的 `CREATE TABLE` 直接含这两列，列序一致）。
2. `UPDATE ... SET window_key = strftime(...) WHERE window_key IS NULL`：按整数毫秒 `scheduled_at` 推导，与 `occurrenceWindowKey()` 逐字相同（测试比对）。
3. 若身份索引尚不存在：旧身份允许同一窗口按 config_version 多行，把每组未取消行中除 id 最大者外的行标为 `window_duplicate_of = <该组最大 id>`，两行都保留，不删、不改号、不改 `config_version`；然后 `CREATE UNIQUE INDEX IF NOT EXISTS`。

旧行的 id、`scheduled_at`、`config_version`、状态、时间与错误文本不动，因此旧执行键与 `deliveries` 中的原键仍然一一对应；不重算键、不重跑旧窗口——计划若再指向旧窗口，只推进不再执行。二次构造不改 schema、不改任何行；列已存在但索引缺失、个别键为空的半完成状态再次构造后收敛到同一结果（测试覆盖）。

表级 `UNIQUE (routine_id, scheduled_at, config_version)` 保留：旧表无法不重建就去掉，新表沿用同一定义避免两套 schema。它不是身份；每一个能把 `next_run_at` 拨回旧时刻的操作（重新启用、改调度、重新授权）都会递增 `config_version`，所以它不会拒绝新身份允许的写入。若真被触发，`claimDueOccurrence` 现在用普通 `INSERT`，会抛错让当轮调度失败并记入日志，而不是静默跳过。

已验证：

- `test/routine-occurrences.test.ts`：同窗口跨版本去重、pending 跨配置改动保留并以新版本开始、running 不改写、改调度同事务取消并产生新窗口、取消行不占窗口、fresh 库二次构造无变化、旧格式库（含同窗口双 ok 行、cancelled+ok 同窗口、skipped 行、旧 deliveries 键）就地迁移并二次构造幂等、`scripts/database-migration-guard.py` 对旧格式库两遍升级（`old_business_rows.equal`、`second_upgrade_idempotent.equal`）通过，升级适配器用 `Registry` + `RoutineStore` 构造器模拟 `src/index.ts` 启动顺序。
- `test/routine-delivery.test.ts`：手动再执行不建 occurrence、不与调度窗口的投递键冲突、不推进计划。
- `test/routine-progress.test.ts`：进度查询返回 `window_key`。

## 未做与边界

- `scripts/upgrade-schema-copy.mjs` 不构造 `RoutineStore`，所以用它升级的候选副本不会出现 `window_key` 列；列在真实启动（`src/index.ts` 构造 `RoutineStore`）时追加。若要让 schema-only 升级也覆盖本列，需在该脚本中加入 `RoutineStore` 构造（该脚本不属于本片；注意 `test/database-migration-guard.test.ts` 的合成 `routine_occurrences` 表没有 `scheduled_at` 列，回填会失败，那张夹具表也要相应补列）。
- `test/routine-policy-store.test.ts` 的“policy-only 编辑使已领取 occurrence 失效”断言基于旧身份，与本片目标相反；该文件不属于本片，需要把期望从 `cancelled` 改为 `pending`（见交付报告）。
- 同一毫秒内“领取窗口 → 重新启用/重新授权 → 再领取”会被当作同一窗口而不再执行，once 会因此显示为已执行。真实调用链（人工完成 OAuth、人工恢复）不会在同一毫秒发生；测试用冻结时钟时需推进至少 1 ms。
- 窗口目前只在到期领取时创建；“预先登记下次窗口”“读取、提炼、待办生成、投递各有进度”“暂停原因分别恢复”仍未实现。
