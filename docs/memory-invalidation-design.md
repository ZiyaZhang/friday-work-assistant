# C：个人记忆来源与上下文失效

对应 [目标架构第⑤层、学习生效与阶段 C](target-architecture.md)。

## C1 实施边界

第一片只增加条目版本、宿主来源、复制血缘、无正文删除标记与原子变更记录。旧库全部条目保持原 ID、正文、确认与替代语义，登记为 `legacy_unverified`；迁移不伪造已核验来源或历史变更事件。现有旧来源入口暂时保持兼容。新 `verified/unavailable` 来源条目在所有旧读入口的 limit/count 之前排除，完整授权读取服务接入前不向旧消费者开放。

新复制品保留祖先 ID/版本；原条目忘记或版本变化使依赖副本停用。更正的目标不是新内容的祖先，不能把旧值失效传播到已确认的新值。CAS 冲突和记账失败整笔回滚。规则的使用清单也保留 ID/版本。

这是存储迁移步骤，不能据此开放跨群自动学习，或承诺暖 ACP 历史与已有文件已经忘记。后续 C2 必须把实际来源检查、上下文代际、消费者及材料访问一起接入，再切换 legacy 未核验条目的使用策略。当前开发机的同 UID 原生工具不能提供完整文件隔离，实际探测见 执行隔离。

最小交付：获授权群资料可以沉淀到本人的长期记忆，保留来源；之后失去来源权限，该记忆立即不能读取或用于新交付。用户确认更正或忘记后，携带旧材料的 ACP 句柄失效，后续回答从有效材料重建。仅更新新一轮 prompt、换 MCP token 或换 ACP ID 都不足以单独完成这一承诺。

本片不建立向量库、通用依赖图或另一套事项平台；不顺手开放文档、日历、仓库内容到所有记忆层的沉淀。个人待办、职责学习与技能版本复用同一来源契约后另行接入，不能把本片完成写成整个 C 完成。

## 1. 已有能力与缺口

以下引用以文件与符号为准，行号为本次审计位置。

| 现有代码／证据 | 已实现 | 本片必须补的部分 |
| --- | --- | --- |
| `src/core/memory.ts:17–35,122–143,222–253` | candidate/confirmed/superseded、真实确认凭据、更正关系；`remove` 物理删除笔记与 FTS | 没有条目版本、可用状态、来源授权与会话失效。确认正文正确不等于取得来源传播权。 |
| `memory.ts:256–265` 的 `promote` | 分享保留原条目与确认状态 | 新 source 只保留 promotedFrom/noteId/by；必须保留原材料来源并集及祖先记忆引用，否则复制会切断撤权和忘记传播。 |
| `memory.ts:153–221,275–309` | 查询按 scope/status；候选 QA 不自动注入，确认规则常驻 | 查询没有来源检查；`used.notes` 只列命中笔记，漏掉已经进入 prompt 的 rule ID。搜索、规则、总数、候选列表、周报都须使用同一可用性过滤。 |
| `src/core/context-builder.ts` 的 `TurnContextBuilder.build`；`test/context-builder.test.ts:57,140` | 每轮读最新记忆；附件 await 后重取当前 scope；保留旧累计来源门禁 | 新 prompt 不带旧条目不代表暖 ACP 历史已清除。Builder 不负责外部 ACL 检查，应接收已授权的记忆材料及使用清单。 |
| `src/internal/api.ts:1116–1178` 的 memory/search/save/forget | API 验本轮 Run，模型只能写 candidate | source 只有当前 by/chatId，不能证明正文实际来自哪个群；save/forget 仍直接调用底层存储。 |
| `src/core/orchestrator.ts:287–354,4158–4233` | `delivery-sources:<sessionKey>` 累计聊天/作用域/仓库来源；本人 DM 发布前 fresh 查群可访问性；跨来源派生写保守拒绝 | 没有消息修订、记忆版本、规则 ID、文件来源及完整 native 读取清单；发布前校验不能代替把资料送入模型前的校验。 |
| `orchestrator.ts:3526–3570` 的 `ensureAcpSession` | B2 每 Run close/resume 重新绑定 MCP 能力；保留历史来源 | 同 ID resume 保留旧历史；未知来源时 newSession 仍用旧 cwd。必须引入明确的上下文代际与材料重建。 |
| `orchestrator.ts:4441` 的 `prepareWorkspace` | 普通群/DM 使用基础目录，显式独立 work 才有子目录 | 新会话仍可能读到旧附件、摘要或生成文件。旧目录不能挂入失效后的新执行。 |
| `src/feishu/oauth.ts:151–181`；`src/core/policy.ts:60–98` | 刷新个人令牌、断开；空间角色与 remember/promote 策略 | 令牌存在、连接健康、管理员角色均不证明某条来源仍可读。OAuth disconnect 没有让既有记忆或 ACP 历史失效。 |
| `src/core/run-attempts.ts` | 持久 Run、当前性检查、requestStop/finish；旧 token 不借新 Run | 可复用来同步阻断旧执行，不另建 Run 系统。WorkKey 继续表示同一工作，重建上下文不改变案件或事项身份。 |

安装版 DSH 的独立协议探针已证明：close → 同 ID/cwd resume 会替换 MCP 进程、工具与凭据，但保留上轮用户消息和工具结果。这是 B2 重绑定依据，也是 C 不能继续 resume 污染句柄的直接证据。

## 2. 用户语义与授权边界

- **记录到本人**：当前真实 actor 的私聊空间可记录其获准读取的群资料。模型抽取默认 candidate，授权范围来自本次请求或已接受职责的允许来源。关注列表约束自动读取目标，不能把 OAuth 可见全部群当成自动学习委托。
- **重新使用**：保存时可读不代表永久可读。查询、模型输入、再次派生与发布分别检查当前权限；记忆中的原群来源继续加入本轮来源并集。
- **更正**：候选更正不提前撤销已确认事实；本人明确确认更正后，旧版本失效。更正操作提交与失效标记同一事务；模型 `certainty` 或正文中的“用户确认了”不是确认凭据。
- **忘记**：不再检索、注入、复制或从原旧历史自动提炼同一条记忆。保留无正文的最小删除标记，以识别已经装载旧条目的会话及已有复制品。重新授权、重启、旧提案确认不能复活它。
- **暂停关注**：停未来读取/调度，不默认删除已保存记忆；历史记忆仍受当前来源权约束。明确撤销来源使用授权则立即停用；不能把普通 pause 等同 forget，也不能因重新授权恢复手动暂停。
- **分享**：存到本人不是允许转发到群。联盟/企业晋升仍需现有角色和受众校验，并保留来源与祖先记忆引用；不以已确认 status 绕过来源门禁。

C 第一片只接受能由宿主记录的飞书群材料与现有有效记忆。存在未追踪文件/native 输入、未知旧历史，或混入尚未接入本契约的仓库/外部资源时，不把来源标为 complete；保留当前派生写拦截。不能只删 `canPersistDerivedState` 的跨群条件来开放功能。

## 3. 最小应用接口

新增一个具体 `MemoryApplication`，复用 ChannelMemory、Registry/RunAttempts、Spaces、UserTokenStore、FeishuClient 与下面的小型上下文存储。HTTP、命令、未来自然语言控制调用同一操作。模型不能提供 actor、scope、来源证明或确认人的字段。

```ts
// 参数名为提案；不是已经存在的 API。
remember(runId, { kind, title, body, replaces?, expectedRevision? })
  -> { note, replacement: 'applied' | 'pending_confirmation' | 'none' }

confirm(intent: HumanMemoryIntent)
  -> { note, invalidatedContextIds }

forget(intent: HumanMemoryIntent)
  -> { forgotten: true, invalidatedContextIds }

readForContext(runId, { query, limit })
  -> { text, notes: { id, revision }[], sources, coverage }

prepareRuntimeContext(runId)
  -> { reuseContextId } | { rebuildFromCurrent: true, invalidatedContextIds }
```

`runId` 回读 B2 不可变身份、空间、WorkKey 和 stage。`HumanMemoryIntent` 是宿主内部从真实入站生成的凭据，含 messageId、actor、当前空间、动作、明确 noteId 与应用前读到的 expectedRevision；这些字段不是可由 MCP 参数自报的授权。现有 slash 在创建普通 Task 前处理，`memoryCommand` 直接使用真实 messageId/actor（`orchestrator.ts` 的 `case 'memory'`、`memoryCommand`）；不得为确认或忘记强制造一个模型 Task。自然语言已有 Task 时可关联真实 receipt，但还须确定用户指向的同一对象。明确指令可以直接应用，不重复要求人工确认；对象不明确时才澄清。

忘记是本人对既有记录的控制操作，不是把当前模型正文写入记忆。它应核对当前身份、条目管理权和明确意图，不应因先读过其他群就被 `needSafeDerivedState` 一并拦住。若该操作使当前 Run 也失效，事务提交后由宿主投递不含旧正文的固定事实回执；不放行旧模型继续输出或写入。

`remember` 的来源取**该上下文代际已看过的可信来源并集**，不只取最近一个工具或模型声称引用的几条。如果宿主需要更窄来源，必须从当前获准材料新建一个无其他输入的提炼执行；不能在暖会话中减掉旧来源。记忆内容是模型产物，来源清单是宿主事实，两者分别提交。

`readForContext` 先做来源授权和生命周期过滤，再排名/limit；规则也返回实际 ID/版本。API 搜索、记忆概览、候选清单、周报复用这一读规则。无权看正文时标题、命中数和总数同样不能泄露；未能完整校验数量时返回未知/覆盖不全，不拿物理总数冒充可读总数。底层 `get` 仅供应用内部事务使用，不直接暴露给模型或用户。

后台实现可以分片，读取边界不能后补。当前 `consolidateScope` 直接调用 `memory.candidates`，用普通 worker/shared cwd 运行并直接发整理卡；其 `memoryWritePolicy` 只限制候选 ID，不证明来源或投递权限。reflect、自动 QA、rules、候选管理、报告与分享也不能用旧入口读取或复制新来源笔记。第一片须让这些消费者接同一已授权材料入口，或在查询层排除尚未接入的来源笔记（过滤在 limit/count 前）；排除时说明未纳入范围，不把它说成没有记录。不得等夜间整理先读走、丢失来源后再依赖普通写门禁补救。

TurnContextBuilder 保持同步组装：宿主先取得 PreparedMemory，在所有外部 await 后复验 Run/本地授权版本，再由 Builder 同时渲染正文与 receipt。不能先渲染、后来给 receipt 补一个没有对应正文的来源清单。

## 4. 必要的持久数据（提案）

只保存现有记忆与上下文的依赖，不造通用节点/边服务。

| 变更 | 最小内容／用途 |
| --- | --- |
| `memory_notes.revision` | 整数版本。内容、生效状态、替代关系变更递增；candidate/confirmed/superseded 和 confirmation 保留原语义。 |
| `memory_provenance`，每 note 一行 | `note_id`、可信 `origin_run_id`、版本化 `sources_json`、`ancestor_notes_json`、`state=verified/legacy_unverified/unavailable`、无敏感正文的 reason。来源只能由宿主写；祖先 ID 集合随复制展开继承，足以使已复制记忆停用，不建任意业务依赖图。 |
| `memory_tombstones` | `note_id/scope/revision/forgotten_at`，不保存被忘记的标题或正文。保留当前物理删除与 FTS 删除行为，同时识别旧版本、复制品与过期确认。 |
| `runtime_contexts` | 上下文代际 ID、逻辑 session/WorkKey、runtime 类型、ACP ID、宿主生成的 materialCwd、active/invalidated、原因、可信累计 manifest JSON；manifest 含记忆 ID/版本（含 rules）、来源、祖先引用和覆盖缺口。materialCwd 不覆盖业务 Session.cwd；文件来源只在实际接入时加入，不预建通用文件图。只存引用与摘要，不存隐藏思考。 |
| `run_attempts.context_id` | Run 使用哪一代实际上下文。不能仅看 session 当前 alias 判断旧 Run 是否有效。 |

来源引用至少包含平台 tenant/app/chat、message/thread/root 与实际读取身份（个人或应用）、可取得的 revision/内容摘要、读取时间和覆盖。历史分页记录实际返回消息引用与缺口，未读页不是“没有后续”。记忆来源集合中出现另一条记忆时保留其 ID/版本与展开后的原来源。需要证明材料未变时回读或比对平台版本；没有平台版本不得编造“最新”。

本地撤权/来源绑定变化的单调版本可先复用 Registry KV，由对应应用操作递增；它不是模型字段，也不能拿 OAuth `updatedAt` 替代（正常 token refresh 同样会更新该值）。未接入该版本的改变仍须读真实当前状态，不能宣称有完整撤权事件推送。

在同一短事务里：核对 expectedRevision 与本地权限版本 → 更新/删除记忆 → 更新复制品可用状态 → 标记受影响 runtime_contexts → 对关联活动 Run `requestStop`。提交后再 abort/close。数据库失效标记是安全边界，abort 成功不是提交前提；没有 await 占住事务。另一个会话若没有消费该条目/来源，不必失效。

## 5. 当前授权失效如何检查

复用现有本人投递门禁的来源判断，但把检查前移到读取与 resume 之前。不能把 DeliveryContext 当成可永久保存的读取授权。

1. 从 B2 Run 取得 actor、DM 空间与 current 状态；目标必须是本人的活跃私聊空间。来源若绑定 Friday Space，则校验 active、原 spaceId/chatId 未换绑；未初始化 Friday 的群不因缺 Space 自动拒绝本人已获准读取。
2. 个人读取用 `accessTokenFor(actor)` 后 fresh 查询当前可访问群；应用读取用实际当前群成员与机器人读取能力。不能只检查本地 member、isConnected 或有 token。授权查询失败与明确退群分别记录，但两者都不向模型释放旧正文。
3. 沿**原来取得材料的身份**重验；个人连接失效不能静默改成机器人身份来续用旧资料。以后若支持切换读取身份，必须产生新的明确来源证明，不继承旧证明。
4. 在来源新读取、个人沉淀提交、每次上下文复用、最终发布前重验；await 后复验原 Run 与本地权限版本。多个群来源中任意一项失效，该合成笔记整体不可用；不能裁掉来源标签后留下混合正文。
5. 已观察到 disconnect、群/空间停用、绑定变化或明确撤销时，同步使相关上下文失效；源消息撤回/删除使相应证据不可用。既有消息召回只删缓存，需追加此连接点。无来源细化的历史记录采用更保守范围。
6. 临时平台失败只表示当前不可用，不物理删笔记或声称永久失权。重新授权后重新检查来源存在性、身份与范围；源文已变时旧摘要不直接恢复为最新事实。明确忘记的条目及其旧复制品永不随 reauth 自动恢复。

外部 ACL 与本地事务不能原子提交。此方案保证在每个实际读取/提交/发布检查点按最新可得平台结果判定，并在观察到撤权后立即本地阻断；不承诺平台刚撤权的同一毫秒、尚未收到任何事件时即全局可见。fresh 查询不能使用失败后“沿用上次允许”的降级。

## 6. 更正／忘记后的真实会话重建

普通 B2 Run 换 token 时可以 resume；以下任一成立则必须 newSession：消费过已更正/忘记/失权的记忆或来源；manifest 缺失/版本不识别；旧历史或文件来源无法证明完整。

重建顺序：

1. 先持久 invalidated，令旧 Run 的读/写/发布检查失败；在途已发送的 POST 只按原动作记 late ACK/unknown，不复制到新 Run、不重发。
2. 有界关闭旧 ACP，使用**新 ACP ID 与新 context generation 的材料目录**。保留逻辑 Session、WorkKey、案件/Issue 身份，不把业务工作新建一遍。close 失败不能继续用旧句柄。runtime 的 materialCwd 与业务工作区分别登记，不直接改逻辑 Session.cwd：`ChangeManager.validate` 目前要求登记 cwd 与调用 cwd 完全相同、修改目录仍在该 cwd 内（`src/github/changes.ts` 的 `validate`），`list` 也按 cwd 查登记。否则一次记忆更正会让同 PR 追加提交报“不属于当前会话”。第一片保留 GitHub 工作区与绑定；需要接续代码时另取经过授权的业务材料，不能为保住旧目录而恢复污染历史。
3. 只从当前获准记录组装：本次真实消息、现有领域最新状态、有效记忆、经重验的必要材料。不得 resume 旧 transcript，也不得载入旧压缩摘要、全部旧聊天、旧工具结果或递归复制旧 cwd。
4. 历史用户请求、amendment、Question/reply、案件原文可能也含被忘记内容。没有能逐段证明安全的元数据时，失效后的第一次重建不自动回灌受影响工作旧原文；只保留授权允许的 ID/状态与明确安全材料。若缺少继续所必需的请求，请用户补最小信息，不能让模型自己“忽略”已经重新读进来的旧值。用户在新消息主动再次给出的资料属于新输入，不等于系统复活旧记忆。
5. 旧文件保留为受限历史证据，不挂入新 cwd；附件需从当前允许来源重新取得，未知来源产物不搬迁。已完成代码变更等业务产物不得直接删除；重用须有可验证来源与当前授权，否则保留原处并说明当前不能接续。
6. 新 manifest 从实际输入产生。旧 manifest 保留在旧 context，不能简单清空 `delivery-sources` 后继续用同一 history/cwd。重启也只使用已验证 active generation；缺元数据的旧句柄全部要求重建。

**实际边界**：新目录不是 OS 沙箱。同 UID 原生 shell/read 仍可能绝对路径访问旧 cwd、DSH 历史、共享 skills 或缓存。因此不能把“换目录且普通问题没复述旧词”算成强隔离验收。C 必须验证选用 runtime/profile 的真实工具面和可达材料；原生任意读取未收口的执行不能自报 provenance complete，也不能据此开放跨来源自动沉淀。可先在确实限制了原生读取的独立提炼/记忆回答执行上开放；不能只传空 MCP 列表或写一条禁止读取提示来达到这一条件。具体平台级沙箱仍属 F。

**现有 DSH 的可实施方式**：Friday 的 `AcpRuntime.newSession/resumeSession` 只传 cwd 与 mcpServers，当前 ACP 没有每会话 profile/native 工具屏蔽参数。采用同一个 Node 宿主管理的小型专用 `AcpRuntime` 子进程，复用 `createIngressClassifier` 的配置方式：独立 DSH_HOME、sdk-minimal 唯一 bundle、禁用 native 工具 producer、不复制用户 skills/补丁；不要把普通 worker 的空 MCP 列表当成无工具执行。`profiles/friday-router` 已有这套配置形态，但其分类 prompt/输出解析不直接复用为记忆产品。

专用执行只接宿主重新取出、授权后的材料及来源清单，不能接普通暖 worker 提交的自由正文当作“干净来源”。提炼结果由宿主存候选，记忆问答由宿主经过既有 DeliveryService 交付；普通 worker 最多接不含资料正文的操作事实，不回注新记忆正文、摘要、提炼工具结果或完整问答。涉及普通编码/文件能力的任务保持原 runtime 与 GitHub 绑定，不为启用记忆全局关掉这些能力。

专用 runtime 只证明自己的输入与工具面受控。若同 UID 的普通 worker 仍能读其历史、产物或旧材料绝对路径，仍未证明跨 runtime 的撤权闭环。C1/C2 可以先部署关闭功能开关的基础能力并做受控验收；只有实际可达性测试也满足承诺，才开放完整能力。否则明确标为专用记忆执行的有限试用，不称“所有 Friday 会话已忘记”。这项边界不能靠新 token、目录命名或模型不主动读取来消除。

技能中若已有从私有材料写出的内容，也属于预载来源；无法追踪时不得复制进新上下文。内置无用户材料的代码技能可按版本绑定。空间技能安装/版本刷新另片处理，本文不宣称已解决共享 `$DSH_HOME/skills` 的边界。

## 7. 旧数据迁移与上线顺序

需要迁移，不能靠新代码运行时猜来源。沿用 旧库副本迁移验收 的在线 backup、独立候选副本与两次实际构造器验证；不直接拷活动 db，不在生产副本验证时执行调度恢复。

- 保留原记忆 ID、title/body、scope、status、confirmation、source、createdAt、supersededBy。新增 revision=1；不重跑“模型 confirmed 降级”的旧迁移，更不能把不完整来源升级为本人确认。
- 旧来源一律先为 `legacy_unverified`。仅能从可信宿主记录重建来源集合的记录才升级 verified；`source.by/chatId`、现有 confirmed 或模型声明都不够。现在粗粒度 session manifest 最多提供保守来源并集，不能证明精确材料或不存在 native 输入。
- `legacy_unverified` 不自动注入/分享；有权的管理入口可显示“来源待核验”的记录标识，正文仍须通过可读性判定。迁移前出数量预览与备份，明确旧记忆可能暂不可用；不无声丢数据，也不为了兼容假装全部可用。用户可以从当前获准材料重新确认/重建，不能通过点击一次确认抹掉未知外部来源。
- 新增上下文表为空，旧 ACP 没有合格 generation，第一次使用必须重建。旧 tasks、Run、案件、职责游标、暂停原因和 Delivery unknown 保持；不得把切换 runtime 当成重跑旧工作的授权。
- 两次迁移后旧列/ID 摘要一致，第二次 schema/全数据幂等；合成旧库加入已确认规则、候选更正、已晋升复制、旧 QA、无来源记录和 unknown Delivery。不能因为真实旧样本没有某类数据就计为验证过。
- 回滚只能回退应用代码并继续保留“失效上下文不可复用”的门禁；直接恢复旧数据库/旧进程会复活已忘记内容，不能当作普通无损回滚。上线前明确回退策略。

实施分为两个可审查提交，但**功能开闸必须两者同时完成**：C1 可信来源/版本/读取过滤与应用事务；C2 runtime generation、材料重建、持久失效与实际 DSH 验证。之后才让指定来源的个人 memory/save 走新路径；其他派生写继续原门禁。职责/reflect/consolidate/proactive、个人 todo 和 Skill 变更逐个接入；未接入的消费者必须排除新来源记忆，不能只保持其现有写门禁。

最小纵切限定为“已委托关注群 A → 宿主取得本轮真实材料 → 专用执行生成本人 candidate → 本人确认 → 专用问答读回 → 失去 A 的读取权后不可再读/写派生/交付”。先支持当前请求和已接受 watch 的真实来源，不增加任意资料选择器或通用依赖服务。复用现有 RunAttempts、SerialQueue 和 DeliveryService，记忆应用仅新增来源过滤、条目变更事务与 context 绑定；不另建任务/审批/发送系统。更正和忘记沿同一条路径使消费过旧条目的 context 失效，未完成的业务 Task/Issue/PR 不因此新建或重跑。

唯一需要产品取舍的是：若跨 runtime 材料可达性尚未封住，是否接受清楚标注边界的专用记忆试用。默认不开完整能力；不会以此为理由关闭普通用户现有代码与文件能力。选择试用也不改变来源校验、禁止回注与旧消费者排除要求。

## 8. 验收入口与现有证据强度

本次只读，没有新增或运行以下测试。下面是实施必须补的可判定案例。

| ID／入口 | 输入与必验事实 |
| --- | --- |
| C01，真实 HTTP + SQLite | 本人 DM 已授权读群 A，再记候选；保存准确来源/actor/Run，status=candidate。读回时群 A 来源进入上下文与发布门禁。模型假造 chat/source/confirmed 字段无效。 |
| C02，同 fixture 负向 | 保存到另一个 DM、群/企业层，或混入未接入外部来源时拒绝；数据库零新增。记忆已有 sources A+B，B 撤权不得仅剩 A 标签仍返回原混合正文。 |
| C03，fresh ACL hook | 先成功读 A，再移出群/OAuth 断开/来源 Space archive 或换绑；所有 search/rules/overview/周报均无旧正文、标题或可推断总数。平台 5xx 返回读取缺口，不能返回空记忆或沿用旧允许。 |
| C04，await 竞态 | 来源检查等待时 Run 更换、disconnect 或本地授权版本变；旧请求不能 commit/inject/publish。已发 POST 晚 ACK 只更新原 Delivery。 |
| C05，更正事务 | 已确认旧值 → 更正候选，旧值仍有效；明确确认新值后旧 revision 失效、关联 context invalidated、在途 Run 停止。并发确认/忘记以 expectedRevision 拒绝过期提交。 |
| C06，忘记与复制 | 忘掉原条目后正文/FTS 删除，已晋升/派生副本停用；重开 SQLite、重新授权或旧提案确认均不复活。其他无关条目与上下文保持。 |
| C07，规则与 limit | 旧 rule 已注入但没出现在普通 hits：依然被 manifest 记录并触发失效；30 条不可用命中不能挤掉 1 条有效结果，统计仅反映实际已校验范围。 |
| C08，真实 ACP/MCP 协议 | 首轮把合成 canary 放进工具结果与暖历史，确认更正/忘记后第二轮用新 ACP ID、新 cwd；实际模型请求输入、恢复历史与预载材料不含旧 canary，新值确实出现。用 scripted adapter 可验证实际协议输入，但不能标自然语言质量通过。 |
| C09，真实材料可达性 | 首轮产生包含 canary 的文件/压缩摘要；失效后新执行不能由自动挂载或允许工具读回。额外尝试旧绝对路径、共享技能与 DSH history；仍可读取即隔离失败，不能以普通回答没提旧词代替。 |
| C10，真实自然语言与 UI | 暖私聊“记住合成规则 A”→明确更正 B→新问题→忘记→新问题，记录实际工具/ACP 代际/SQLite/最终可见答复；再用受控测试群移除权限复测。同名材料、重启和无引用接续不泄漏旧值。合成值，不用生产聊天做 canary。 |
| C11，既有入口与消费者 | slash 无普通 Task 仍能按真实入站确认/忘记；先读其他群再明确忘记不会被派生写门禁误拒。未接入的整理、reflect、rules、候选列表、报告不读取新来源笔记或泄露其标题/数量；整理不能生成失去来源的副本。 |
| C12，业务兼容与 runtime 选择 | 同 PR 修改目录与 session.cwd 在更正前后保持；专用执行不加载普通 cwd/skills/transcript，其正文不返回普通 worker。正常代码任务仍走既有权限与修改目录；尝试从普通 native worker 读取受保护材料的结果单独记录，失败关闭条件未满足时不得计完整 C 通过。 |

复用现有测试，而非将旧测试改名为 C 通过：

- `test/memory-confirmation.test.ts:23–154` 覆盖确认、更正、迁移与分享状态，未覆盖来源撤权与 runtime 历史。
- `test/context-builder.test.ts:57,108,122,140` 覆盖当前 prompt、覆盖缺口和 scope 时序，未证明真正暖 ACP 失忆。
- `test/delivery-orchestrator.test.ts:306,317,333,346,365,411` 覆盖累计来源、重启、个人权限撤销及出站拦截；FakeACP 新建/旧 cwd 不能替代 C08/C09。
- `test/api-run-capability.test.ts` 覆盖旧 token 与 await 换 Run；接入记忆应用后继续保留。

工程测试、真实 DSH 协议、真实模型与真实飞书四层分开记录。任一层没有做，保留待验；既有模型或 UI 失败不因新增 mock 绿测消失。

## 9. 原 57 项能力映射

| 原 ID | 本片关系／完成边界 |
| --- | --- |
| G19 知道的事／记忆更正 | 本片直接交付：来源、确认后的版本失效、忘记、暖会话重建；既有存储成功不能代表此链完成。 |
| G20 私聊关注无 bot 的群；S08 跨群／私聊搜索；S10 受委托身份 | 复用个人读取授权，允许本人记忆并保留实际身份；不扩大自动关注范围或跨群发布。 |
| G15 自动整理；G37 组织全局上下文 | 后续消费者必须经过同应用与来源过滤；本片不提前开放跨来源 reflect 或组织晋升。 |
| G22 待办自动提取；S04 待办来源 | 后续复用来源/失效契约；未接入前继续现有保守派生写门禁，不宣称已实现群材料生成本人待办。 |
| S02 授权失效暂停；S03 两步授权恢复；S06 停止关注 | 来源失效不止暂停调度，也阻断历史记忆与旧上下文；重新授权不解除手动暂停、不复活忘记。 |
| G01 群/DM 工作形态；S14 共享状态 | Run 与 WorkKey 不变；只替换失效执行上下文。共享数据库与目录分开都不是跨人 OS 隔离。 |

第一片成功回执应按事实说“已更正；后续会用新内容”或“已忘记这条记忆”。内部 generation、来源门禁与迁移术语留在可展开证据中。尚不能保证旧执行材料失效时，不发送上述完成回执冒充全链完成。
