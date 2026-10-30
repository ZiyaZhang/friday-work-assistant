# C2：群来源记忆的当前授权

已接通本人 DM 的真实消息/目录/附件来源采集、受管记忆保存与读取、暖 ACP 核验、来源失效和交付前复验。自动巡查提炼、自然语言直接确认和实机授权验收仍未完成。

本片交付目标：用户已允许把获授权群资料自动沉淀到本人的长期记忆，保留实际来源；来源失效后停止使用。复用 [C1b 上下文失效](memory-context-cutover-design.md) 和 [目标架构](target-architecture.md)，不新增业务事实源或平行权限体系。

## 1. 权威与范围

- `ChannelMemory` 保存候选、确认、替代、来源及修订；`MemoryApplication` 统一事务，`MemoryRuntime` 负责实际消费与提交后的停止。确认内容正确不等于获得来源访问权。
- 来源权继续由 `UserTokenStore`、飞书实际可读范围、现有 Space 绑定和 Policy 决定。已接受 watch 的 owner/runAs、配置版本及 occurrence 是本次委托；不能凭模型声明增加群或改收件人。
- C2a 开放当前本人私聊中已读取的获授权群材料保存到本人 DM 记忆，默认 candidate。现有 watch 后续要接独立提炼和 occurrence 幂等，不能把普通 MCP 保存算作自动学习。群/组织晋升、文档、仓库、日历及其他派生写仍维持原门禁，未接入的消费者继续排除 managed 记忆。
- 普通暂停 watch 停未来调度，不删除已有记忆；已有记忆仍受当前来源权约束。重新授权不复活手动暂停、已忘记笔记或旧 ACP。

## 2. 宿主记录来源

在 `internal/api.ts` 真实话题、群历史、消息搜索及文件列表返回消息之前，由宿主追加来源事实。`onCrossSpaceRead` 只记 chatId，不能直接生成 verified provenance。最终过滤、截断和缓存合并后的实际返回体才是摘要对象；缓存回填了更多消息，不等于模型消费了这些消息。

群目录与 `ability.groups` 共用读取入口；每条实际返回的目录项登记 `feishu-chat:chatId`，没有 messageId，不伪造消息。附件使用同一 user lease 下载，登记 `feishu-file:chatId:messageId` 和实际 bytes 的 SHA256，保留父消息撤回锚点。下载先暂存，等待后核验原 Run/身份/绑定，再同步发布完整文件；停止后的迟到 bytes 不进入工作目录。这些记录复用现有来源结构和群权限核验，不新增资源表。

记录复用 `MemorySourceReference`：tenant/app、原 Space（没有则 null）、真实 chat/message/thread/root、实际 user/app 读取身份、读取时间、覆盖范围和可用的内容摘要。必须绑定实际返回的消息和该次读取使用的 AsUser/token 快照；不得用后来换发的 token 或身份结果为旧缓存补造租户。不得使用模型提供的 source、当前 DM 身份去猜原消息租户，或将分页未读完记成 complete。消息缓存没有 tenant 字段；本次需要可信平台/身份结果补核验，缺失时不伪造。

来源累计到现有与 ACP 绑定的 source manifest；读取 managed 记忆时，其原来源也并入该 manifest。新写入取实际累计来源，并保留复制祖先的 id/revision，不用 replaces 推断全部血缘。模型正文仍是待确认候选，verified 仅表示宿主记录并核验了声明的来源，不表示所有原生文件输入已被完整追踪。

`PersonalMemoryContext.add` 只接受模型候选内容；目标本人空间、身份、来源和委托由宿主确定。写入前后验证当前 Run 和材料快照。更正目标的原来源、实际消费的受管记忆来源都要保留，不能用新正文洗掉旧来源。资料未完整登记时拒绝无来源派生写；群目录和文件本身可以正常阅读、分析。

watch 自动学习仍须实现：同一持久 occurrence/window 重投复用原 noteIds，失败不推进窗口游标，提炼结果和窗口事实共同提交；本片没有实现这一独立消费者。

## 3. 可重验的授权获取端口（本次实现）

```ts
type TokenAccessResult =
  | { status: 'available'; accessToken: string; isCurrent(): boolean }
  | { status: 'denied'; reason: 'not_connected' | 'invalid_grant' }
  | { status: 'unavailable'; reason: 'refresh_failed' | 'refresh_unavailable' | 'connection_changed' }

UserTokenStore.accessTokenResult(openId): Promise<TokenAccessResult>
UserTokenStore.accessTokenFor(openId): Promise<string | undefined> // 原兼容接口
```

`available` 只给可信网关持有。`isCurrent()` 同步重读该用户的完整授权快照与本地安全截止，供群列表/成员等外部 await 后复验；返回值及闭包不进入模型、HTTP 回执、日志或证据。`updatedAt` 只是本次快照字段，不充当持久授权代次。本片不改 schema。

旧 `expiresAt` 保存的是提前刷新的安全截止（通常比 provider TTL 提前 60 秒），不是原始到期事实。不能据此生成 denied/expired，也不对旧值加 60 秒猜测补齐。本片保留原保守可用窗口；安全截止之后且无法续期时只报告 unavailable。

三态判定：

| 情况 | 结果 |
| --- | --- |
| 没有本地连接 | denied/not_connected |
| access token 距本地安全截止超过原有 5 分钟刷新窗口 | available |
| 临近过期且可续期，刷新成功、原连接仍一致 | 保存新 token，available |
| 已进入刷新窗口，无 refresh token 或已超过其本地续期截止 | unavailable/refresh_unavailable；旧字段不足以证明实际过期或撤销 |
| 刷新网络故障、5xx、未知错误或不完整响应 | unavailable/refresh_failed；不删除连接或永久停用来源 |
| token endpoint 明确返回结构化 OAuth `error=invalid_grant` | denied/invalid_grant，仅表示当前 grant 不再可用 |
| 任一刷新 await 后连接已删除 | denied/not_connected，旧成功/失败结果都丢弃 |
| 任一刷新 await 后连接已被替换 | unavailable/connection_changed，不把旧错误用于新连接 |

选择保留原 wrapper 的保守刷新行为：有效期不足 5 分钟且续期不可用时仍返回 undefined，而不是暗中改用旧 token。C2 调用者必须使用三态端口区分原因。`invalid_grant` 的含义来自 [RFC 6749 §5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2)；不猜测飞书数字错误码，不按 HTTP 401/403、错误描述中的关键词判断个人授权撤销。HTTP 5xx、未知响应及 transport 异常均不可用。错误类只带固定原因，不保留 request、response、provider description 或 token。

同一 `UserTokenStore` 的同一用户、同一完整授权快照共享一个在途刷新请求，避免 refresh token 轮换使第二请求先得到 invalid_grant。授权快照包括 token、scope、期限及创建/更新时间；新授权不得加入旧请求，旧请求结束也不得清掉新授权的在途请求。进程重启不重放在途刷新，不把内存合并标记当成持久授权事实。

## 4. 来源检查与读取

```ts
PersonalMemoryAccess.check(
  actor: { spaceId: string; openId: string },
  sources: readonly MemorySourceReference[],
  assertRun: () => void,
): Promise<
  | { status: 'allowed'; assertCurrent(): void }
  | { status: 'denied'; reason: string; assertCurrent(): void }
  | { status: 'unavailable'; reason: string; assertCurrent(): void }
>
```

目标必须是现有、启用的本人 DM，精确 `dmSpaceId(openId)`、owner 和 Policy read/remember；auto/admin 不绕过此硬边界。来源只支持原本人 user 身份的群消息，app 来源首片返回 unavailable/unsupported_identity，不回退应用身份。来源声明原 Space 时核验它仍启用且绑定原群；没有本地 Space 时允许用本人 OAuth 实际范围核验，不创建 Space，也不要求本人曾向 Friday 发言而获得本地群成员行。来源群换绑只影响该来源。

每次用实际 token 调 fresh `whoAmI` 核 openId/tenant；appId 必须等于注入同一 FeishuClient/provider 的宿主配置（whoAmI 本身不返回 appId）。按[飞书获取历史消息的用户权限](https://open.feishu.cn/document/server-docs/im-v1/message/list)核验 `(im:message 或 im:message:readonly) 且 im:message.group_msg:get_as_user`。存储 scope 缺失或为空时是 unavailable；已有明确 scope 列表但缺所需权限才 denied。默认申请列表已补 group_msg:get_as_user，旧连接不被改写：需要重新授权及飞书应用后台开通/发布权限，这两项尚未实测。

所有外部 await 后重验 Run、本地 Space/Policy 快照及原 token lease。allowed 和 denied 都携带同一同步复验闭包：调用者若又等待其他来源，应用旧 deny 前仍须检查，避免断开重连后把旧撤权结果作用于新授权。结果不含 token、群名称或正文；这是本次读/入站授权凭据，不是长期可复用许可。

群列表使用 `listChatsResult(as, { fresh: true })` 的 `{ items, complete }`。只有明确 `has_more=false` 才确认结束；缺失/异常 items 或群 ID 抛固定错误，真实空数组才可表示空列表。缺席只有在列表完整时才能证明该来源不在当前读取范围；分页缺口、达到数量上限或读取异常时缺席属于 unavailable，不能据此永久停用记忆。列表中实际出现的目标仍可按该条身份和本地绑定继续核验。

`MemoryRuntime.prepare/search`：先查来源元数据，异步核权，再把获准条目集合用于 SQL 的 count/limit/FTS 过滤；同步复验并 `recordRead` 后才把正文返回。Builder 保持同步，接已准备材料。`RuntimeContexts.recordRead` 对 managed refs 要求本次宿主核验结果，不能只把 legacy 谓词放宽为 verified。未接入的 slash/报告/整理/后台消费者仍排除新来源记录，不泄露标题或数量。

模型 save 的窄来源入口与纯控制 forget 分开；来源污染不能阻止本人忘记。新来源随实际消费进入既有 Delivery 授权，个人记忆不抹掉原群披露边界。

## 5. 暖 ACP preflight 与失效

`ensureAcpSession` 在选择 resume 前，对旧 context 累计消费的 managed 来源 fresh 核验。检查失败的旧句柄不得先 resume 再补过滤。当前请求仍保留，使用不含该来源的新 ACP；业务 Session.cwd、WorkKey、案件/Question、Issue/PR 和 routine 游标保持。

已知撤销：`MemoryApplication.invalidateSources(selector)` 在短事务中标记匹配 provenance unavailable、增加 revision、写 memory_changes，并调用既有 RuntimeContexts 失效及精确 Run/Task/occurrence 停止；提交后 abort。复制品沿现有祖先关系失效。不可覆盖先前 user_requested 等停止原因，不取消独立补问、不重放 unknown Delivery。

暂时不可核验：保留笔记与来源状态，本次不注入、不发布，旧 ACP context 不再续用；可用清洁材料继续请求。不能把一次 5xx 写成永久失权，也不能用缓存允许结果继续带着旧正文执行。

已观察 `/disconnect`、明确 token 失权、来源 Space 停用/换绑或消息撤回，均接同一应用失效操作。当前 WS 没有人类退群订阅，外部退群在下一次 fresh 读取、prompt 或交付前发现；不承诺未接入事件的即时感知。重新授权后须重新读取并核验来源，不能自动恢复旧 context 或已忘记记录。

`PersonalConnectionApplication` 在同一外层事务提交原授权删除和相关记忆失效，提交后停止实际消费者。OAuth 错误主体与明确 invalid_grant 只作用于冻结且仍一致的 grant；迟到错误不能撤销新的连接。交付也使用结构化 token 结果：临时不可用拒绝本次发布而不永久停用记忆，存在个人授权或个人来源时不能退回应用身份发送。

运行中的核验凭据只存内存，并绑定 Run、实际 note/revision、原授权和当前空间。下一轮及进程重启必须重新核验，不能把数据库里的旧 verified 或 ACP 句柄当作现行许可。未取得当前许可时，从本轮凭据移除该条，避免继续使用先前成功快照。

## 6. 迁移与实际保证

- 旧记忆 ID、正文、status、confirmation、source、替代链、已有 revision 保留。旧 legacy_unverified 不伪升级；它的兼容读取行为不由本次端口变更暗中切换。
- OAuth 基础端口不新增字段、不删除 token 行，不回填假撤权。后续来源 JSON/失效存储变更须在保护副本运行真实构造器两次，精确比较旧字段与行。
- 非空 synthetic 另测 managed、复制、mixed source、临时故障、重连；真实生产副本缺少的类别单列为零样本，不能算已验证。
- C2 可在应用层闭合来源授权、消费登记与新 ACP。相同 UID 的 native 工具仍可能读取旧文件/DSH history；目录变化不是 OS 隔离。本片不以尚无 OS 隔离为由让每次更正后永久不可用，也不宣称原文件被擦除或任意 native 输入已全追踪。旧 `memory-invalidation-design.md` 的完整材料隔离开闸要求应按此范围更新，不作为逻辑授权实施的前置阻塞。

## 7. 完整 C2 退出验收与原 57 项

1. 真实 HTTP→宿主→SQLite：获准 watch 自动保存本人 candidate；模型伪造来源/confirmed、他人 DM 和组织共享无效。
2. 委托与重投：暂停/改配置不继续捕获；同一 occurrence/window 不重复写入，失败不推进游标；暂停不删除历史记忆。
3. 多来源读取：A+B 中 B 失权整条不可读，正文/标题/规则/总数一起过滤，不裁掉 B 标签继续返回正文。
4. await：刷新或 ACL 等待中断开/换绑/停止，旧结果不能提交、注入或发布；未知故障不永久撤权。
5. 暖历史与重启：失权后旧 ACP 和迟到工具/发送拒绝，新 ACP 保留工作与补问，unknown 不重发；重新授权不复活忘记与手动暂停。
6. 两遍旧库迁移与非空 synthetic：旧字段/ID 完整、schema/data 幂等，各样本边界单列。

主项 G19（记忆）、G20（本人关注群）、S08（跨群读取）、S10（受委托身份）；关联 G33/G39（停用与换绑）、S02/S03/S06（授权暂停、恢复、停止关注）。编号与剩余实机验收沿用 原 57 项映射。C2a 已有实际宿主与 HTTP 的非空回归，但模型/平台为替身；自动学习和真实平台授权尚未覆盖，完整 C2 不因此完成。

## 8. 基础端口的历史验证

`test/token-access.test.ts` 共 32 项，使用真实 UserTokenStore/SQLite 和 FeishuClient OAuth 方法，仅替换 provider/HTTP 传输边界；覆盖安全截止不能误判实际到期、同快照并发刷新、新旧连接在途交错、未知错误、显式 invalid_grant、断开/换绑、同步 lease 复验与错误脱敏。`test/feishu-chat-access.test.ts` 10 项用真实分页/缓存方法和 SDK 替身，覆盖完整分页、2000 上限、缺继续页 token、缺结束标志、缓存完整性和错误传播。`test/personal-memory-access.test.ts` 38 项使用真实 Space/Policy/UserTokenStore，覆盖本人边界、来源租户/身份/权限、分页缺口、临时故障与各 await 撤权，且验证不创建 Space、不伪造或提升已有授权、不写记忆。连同既有 oauth、oauth-resume、console-auth 共 6 文件 119 项通过；typecheck 与 diff-check 通过。没有真实平台授权/撤销操作，未迁移 schema、未提交或部署。

独立 review 的两个 OAuth 失败断言与列表缺结束标志失败断言均先复现后修复；首轮失败日志保留，不能用修后绿结果覆盖旧记录。端口专项不证明来源采集或 C2 managed 读取已经接通。
