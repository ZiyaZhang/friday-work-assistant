# GitHub 创建操作的只读核对（IssueReconciliation）

对应架构实施顺序第 2 项“原动作核对”的 GitHub 账本侧，与飞书投递侧的 `DeliveryReconciliation` 同一规则：只在平台给出证据时更新原收据，不重发，不编造编号。本文只写已实现和已验证的部分。

## 要解决的事实

`openIssue` 的 POST 超时或连接断开时，`github_issue_operations` 里那一行停在 `unknown`（进程在落状态前退出则停在 `planned`），没有编号。`hasUnresolvedCreation` 因此阻止同一事项（fingerprint）的一切新建，只允许在“恰好搜到一个同名 Issue”时补评论；旧行本身永远不会更新，“远端确实没有”也永远证明不了。

## 做了什么

`src/github/issue-reconciliation.ts` 的 `IssueReconciliation.reconcile(requestKey, { spaceId })`，输入是原操作的 requestKey 和计算指纹时用的空间；输出一份回执（结果、账本当前状态、编号、说明、核对时间）。它只读 GitHub、只改这一行：

| 平台看到什么 | 记录什么 | 对新建的影响 |
| --- | --- | --- |
| 搜索完整，恰好一个候选（同指纹、`user.login` 是本身份、未归属于其他创建操作），且按编号 GET 回读一致（编号、非 PR、标题指纹、创建者、链接路径） | 原行 `status=confirmed`，写入编号/URL/结果，`error` 清空；`github_issue_links` 记住该 Issue（已有链接指向别的编号时保留原链接，注记 `linkKept`） | 解除；同一事项的新请求按既有逻辑变成对该 Issue 的评论 |
| 搜索完整，零候选，且操作已满 `SEARCH_SETTLE_MS`（10 分钟） | 原行状态不变，`error='verified_absent'`，`reconciliation` 记录核对详情（含原 error 文本） | 解除；允许新 key 的新建。原 key 仍是 unknown，不会被重发 |
| 搜索完整，零候选，但操作不满 10 分钟 | `reconciliation` 记 `too_recent` | 不变（索引可能尚未包含刚才的 POST） |
| 两个及以上候选 | `reconciliation` 记 `ambiguous` 与候选编号 | 不变 |
| `incomplete_results` 为真、`total_count` 与读到的条数不符、超过 5 页仍未读完 | `reconciliation` 记 `incomplete` | 不变 |
| 身份/搜索/回读失败，或回读与候选不一致 | 不写任何东西，回执说明原因 | 不变 |
| `planned` 且不满 `IN_FLIGHT_GRACE_MS`（5 分钟） | 不读平台（请求可能仍在进行） | 不变 |
| `sent` / `confirmed`，或已有编号 | 不读平台，不改行 | 不变 |

搜索用 `GET /search/issues?q=repo:<repo> is:issue created:>=<since>`，`since` 是操作 `created_at` 往前 5 分钟（`CLOCK_SKEW_ALLOWANCE_MS`，本机时钟快于 GitHub 时不至于漏掉自己的 Issue），每页 100 条、最多 5 页，只有 `total_count` 全部读到才算完整。本身份登录名取 `GitHubIdentity.botLogin()`：PAT 模式是 `GET /user`，App 模式是 `GET /app` 得到 `<slug>[bot]`（installation token 调不了 `/user`），取一次缓存。登录名拿不到就不确认任何候选。

已归属判定：同仓库里其他 `created` 行已带的编号不再算作本操作的候选，所以“证明不存在后新建了 #102，之后再核对旧行”仍是 `verified_absent`，不会把 #102 记到旧行上。

调用者：`openIssue` 在发现未决创建时先对该指纹下每条未决行调用一次核对，再按更新后的账本决定——已确认则走 `existing` 补评论路径，已证明不存在则正常查重后新建，其余情况沿用原有的“恰好一个同名候选才补评论”核验。没有未决创建的请求不多一次网络调用。同 key 的重放路径没有改：unknown 行的原 key 仍返回“结果未知，不会自动重发”；它只会因别的请求触发的核对而变成 confirmed 并被重放。

## 什么仍是 unknown

- 不满 10 分钟的零结果、不完整的搜索、多个候选、任何读取失败：行不变，仍阻止新建。
- 证明不存在依赖搜索索引在 10 分钟内收录新 Issue。索引滞后超过这个窗口时会先放行新建、之后的核对再把旧 Issue 确认到旧行上，账本如实记录两个 Issue，但重复已经发生。这个窗口是常量，不是保证。
- 核对 `created` 与 `assigned`（见下节）。评论操作的 unknown 没有可比对的稳定标识，本片不处理。
- 一次判为 `verified_absent` 后，后续核对若不完整或有歧义，不撤销这个标记（与投递侧一致），只在 `reconciliation` 里记录最新观察；后续找到唯一候选则升级为 confirmed。
- 旧行没有指纹（未被任何同签名请求关联过）时无法比对标题，返回 `unavailable`。

## 指派操作（assigned）

2026-09-25 起，CODEOWNERS 唯一命中时网关在建单之后调用 `assignIssue`（`src/github/issues.ts`）写 GitHub assignee（只对这次新建的 Issue；同标题已有 Issue 只补评论时不指派），账本同表记 `action='assigned'`：`fingerprint` 列记 `assignee:<小写登录名>`（指派目标），`number`/`url` 是该 Issue，带 `origin_json`。状态：`planned` → `sent` → `confirmed`（回读的负责人里有他）或 `conflict`（请求被接受但回读没有他）；GitHub 明确拒绝（4xx，除 408/499）或请求没有发出记 `operation_failed`；发送后结果未知记 `unknown`。

`reconcile()` 对 `assigned` 行不搜索，只按编号 `GET /repos/<repo>/issues/<n>`，核对编号、不是 PR、链接落在本仓库的 issues 下：

| 看到什么 | 记录什么 |
| --- | --- |
| 负责人里有账本记下的目标 | `status=confirmed`，写入回读结果，`error` 清空，`reconciliation` 记核对详情（含原 error） |
| 没有，且操作已满 `IN_FLIGHT_GRACE_MS`（5 分钟） | 状态不变，`error='verified_absent'`，`reconciliation` 记核对详情 |
| 没有，但操作不满 5 分钟 | `reconciliation` 记 `too_recent` |
| 回读失败或与该 Issue 对不上 | 不写任何东西 |
| `planned` 且不满 5 分钟 | 不读平台 |
| `sent`、`confirmed`、`conflict`、`operation_failed` | 不读平台，不改行（`sent` 由同一请求的重放回读补齐） |

调用者：`assignIssue` 在发送后结果未知时立即调用一次；同一请求重放遇到 `planned`/`unknown` 行时再调用。都不重发 POST。

## 人数块操作（affected_count）

部署开关 `FRIDAY_ISSUE_AFFECTED_COUNT`（默认 off）。只对 Friday 自己建的 Issue（同表 `action='created'` 且 `status` 为 `sent`/`confirmed`）维护正文里唯一的人数块（`src/github/issue-affected-count.ts`）；账本同表记 `action='affected_count'`：

- 写入行：`request_key = affected-count:<小写仓库>#<编号>:<人数>:<上次确认写入的 key 摘要或 none>`，`fingerprint = affected:<小写仓库>#<编号>:<人数>`，`number`/`url` 是该 Issue，没有 `origin_json`（不是 Run 发起的）。状态 `planned` → `sent` → `confirmed`（回读的块内正好是写入的那一行，`result` 记 `{repo, number, url, count, block}`，是下次比对的“上次写入”）或 `conflict`（发出后回读不是，停止维护）；GitHub 明确拒绝（4xx，除 408/499）记 `operation_failed`；请求没有发出（例如换令牌失败）撤销占位、下一轮再试；发出后结果未知记 `unknown`。同一个 key（同一次变化）只发送一次。
- 停止行：`request_key = affected-count-stop:<小写仓库>#<编号>`，`status='conflict'`，`error` 写原因（人工已改 / 标记不成对或不止一处 / 已有非 Friday 写入的块），`result` 记看到的块内文字（截 200 字）。有这一行的 Issue 之后不读不写。

`reconcile()` 对 `affected_count` 行不搜索，只按编号 `GET /repos/<repo>/issues/<n>` 读正文：

| 看到什么 | 记录什么 |
| --- | --- |
| 唯一的人数块，块内正好是账本记下人数对应的那一行 | `status=confirmed`，`result` 写入回读结果，`error` 清空，`reconciliation` 记核对详情 |
| 不是，且操作已满 `IN_FLIGHT_GRACE_MS`（5 分钟） | 状态不变，`error='verified_absent'`：不再阻止这张 Issue 的新写入，但同一次变化不重发 |
| 不是，但操作不满 5 分钟 | `reconciliation` 记 `too_recent` |
| 回读失败或与该 Issue 对不上 | 不写任何东西 |
| `planned` 且不满 5 分钟 | 不读平台 |
| `sent`、`confirmed`、`conflict`、`operation_failed` | 不读平台，不改行（`sent` 由下一轮轮询回读补齐） |

调用者：轮询在发送后结果未知时立即调用一次；之后每轮先核对这张 Issue 的未决行，有结论（confirmed 或 verified_absent）之前不写新值。都不重发 PATCH。

## 不做什么

- 不 POST、不评论、不改 `sent`/`confirmed` 行、不改评论操作行；指派行与人数块行只改 `planned`/`unknown`。
- 不换正文、Run 或 requestKey 重发 unknown 的请求；解除阻止只对新的意图（新 key）生效。
- 不依赖原 Run 存在；调用方只需要账本和配置的 GitHub 身份。

## 存储与迁移

`github_issue_operations` 增加可空列 `reconciliation TEXT`，由 `IssueLinks` 构造器按 `PRAGMA table_info` 守卫追加，两遍构造幂等；`verified_absent` 写在既有 `error` 列，`hasUnresolvedCreation` 用 `error IS NOT 'verified_absent'` 排除。旧行不动。`scripts/upgrade-schema-copy.mjs` 目前不构造 `IssueLinks`，该列由应用启动时追加；真实旧库两遍迁移仍需在开发机独立副本上验证。

## 测试

`test/github-issue-reconciliation.test.ts`（26 条）：单候选确认与链接记住；只在完整结果且过沉淀窗口后判不存在；歧义/不完整/多页/搜索失败/身份失败/回读失败不改账本；回读与候选在标题、创建者、编号、PR 上任一不一致不确认；他人同名 Issue 不算本身份；已归属其他操作的编号不被抢占；sent/confirmed 行零读取零修改；planned 宽限期内不读；确认后重放不再读平台；证明不存在后重放结果一致；分页读完再判断；`openIssue` 集成（先阻止、证明不存在后新 key 可新建而旧 key 仍拒绝；旧 POST 实际创建了则评论到那张 Issue，旧 key 之后重放出确认结果；核对无法判定时沿用原候选核验；无未决创建的请求不多调用）。`test/github-issue-recovery.test.ts` 未改，原断言全部仍成立。

`test/github-issue-affected-count.test.ts`（18 条）：人数块首次追加与只写一次；同一人不重复计数、只替换块内一行（块外含 `\r\n` 原样保留）；非 Friday 建的单（别人建的、只补过评论的）不读不写；人工改块、删块、标记不成对、多块、Friday 没写过却已有块都只登记停止且之后不再读写；开关 off 不读库不调 GitHub；仓库不在写名单不读不写；结果未知（连接断开、502）只读核对、证明没生效后同一人数不重发；响应丢失但已生效时当场核对确认；403 记 `operation_failed` 不再试；发送前写门失效撤销占位；写后回读失败留在 `sent` 下轮只回读；`reconcile()` 对人数块行的确认、`in_flight`、`verified_absent`；人数口径（机器人、Friday 自己、无报告人、核实不了、报告人与发送者不符、union_id 都不算；私聊任务消息算）；多案件按人合并、已停止跟进的不算；每轮上限与间隔；空正文。
