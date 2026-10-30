# 静默参会到本人确认行动项

本模块实现会议平台适配、持久参会事实、会议来源、宿主运行时、签名 API/MCP 和会后草稿应用层。共享入口将这些模块装配到现有 Work、Run、Approvals、Delivery 和 Todos。只有取得真实飞书回执后，才能称为平台能力可用；SDK 存在接口不代表本应用已经获得灰度资格。

## 产品行为

用户明确要求 Friday 加入一场会议，宿主把真实请求或审批与会议号绑定后，才允许调用 `join`。单独提供会议号、查询会议内容、只想读妙记，都不构成入会授权。入会让机器人对其他参会人可见；本实现只加入正在进行的会议，不发起会议，不打开录制、麦克风，不发送会中消息、邀请或结束整场会议。

平台接受请求只记录 `awaiting_admission`。实际参与必须由平台返回机器人本人的入会事件，或同一应用身份的活跃会议正证确认。没有结果不能解释为未参会；会议结束或机器人离开也必须有真实回执或事件。`121003` 可能涉及会议未开始、密码、等候室或其他准入条件，不能机械要求个人重新 OAuth。

会前上下文只在宿主保存，不发进会议；其来源权限随后的每次读取和投递仍需复验。会议事件里的共享文档链接只是线索，不赋予读取该文档的权限。系统不通过设备录音补足缺失转写。

会后先把完整纪要及行动项发到发起人本人的私聊审阅。确认绑定正文摘要、卡片、本人和私聊。确认前没有 Todo；确认后同一个 SQLite 事务记录决定及 Todo，重复点击不重复创建。修订中的新草稿使旧卡片失效。已经确认的行动项，后续通过既有待办管理修改，不重新审批一份同义草稿制造第二批待办。给其他人标明负责人不代表那些人已经接受承诺。

## 文件与契约

| 文件 | 责任 |
| --- | --- |
| `src/feishu/meetings.ts` | 实际 SDK `vc.bot.join/leave/events/userActiveMeeting`；应用身份；固定错误归因；不把平台错误原文或凭据传播给模型 |
| `src/core/meeting-sessions.ts` | `meeting_sessions` 和 `meeting_drafts`；保留真实 meetingId、动作授权、事件游标、完整性、版本、来源快照和审阅收据 |
| `src/core/meeting-source.ts` | 会议事件精确摘要与原本人受众的来源凭据；同步核验，不伪装成公开或个人 OAuth 来源 |
| `src/core/meeting-application.ts` | 授权→调用→保存回执→复验；同步事件→原 Work 新执行→完整审阅→事务确认 |
| `src/core/meeting-runtime.ts` | 真实 Task/Run 绑定、既有审批、逐条来源 lease、完整 Delivery、本人确认后 Todo；使用宿主事件入队桥 |
| `src/internal/meeting-routes.ts` | 严格工具参数；仅可信签名 Run 可调用；区分应用配置、平台条件、来源和网络失败 |
| `src/mcp/meeting-tools.ts` | 六个实际工具；模型不能传收件人、审批、来源或决定草稿 |

宿主必须实现 `MeetingApplicationDeps`：

- `resolveRun`：真实 Run、actor、原请求和当前空间；会后私聊目的地来自宿主解析。模型不能选收件人或自报权限。
- `authorizeAction`：原始明确入会/离会请求，或完整审批回执。绑定动作、会议号、actor、消息和稳定 key；调用参数中的 boolean 不能作为证据。
- `authorizeSession`：当前 owner/space/control 及保存的会前 SourceContext/记忆版本。返回的同步 lease 在每次 await 后与最终返回前重查。生命周期拥有独立持久准入，不继承已经结束的 HTTP/Run。
- `recordSource`：将 `MeetingSourceReceipt` 登记到现有 SourceContext；执行历史、材料派生、记忆、外发参数和投递均须保留并复验它。`verifyMeetingSource` 只证明精确存储事实和原本人 DM；不能替代前一项的当前权限检查。
- `deliverDraft`：沿 DeliveryService 先占位，完整正文各段都确认发出后，才发送绑定 digest 的确认卡。未知回执不得返回 `complete:true`。
- `commitActions`：同步使用既有 Todos/Work，在同一数据库事务内提交，并给每条行动项保留确切创建来源。本接口不允许异步网络副作用。
- `queueDraft`：用稳定 key 将已结束且事件完整的会议交给既有 Work 执行；不是直接在定时器里启动模型。入队必须持久且幂等。

生产装配使用 `MeetingRuntime` 实现上述应用回调。会后事件由 `TaskEvents.admit` 写入既有 Tasks 和 dispatch，`task_event_sources` 只保存原委托关系；入站明确标记为 bot 系统事件，不伪造真人请求。同私聊沿原 Work，原请求在群里时由宿主派生本人私聊 Work 并保留父 Work。父委托停用或暂停时不得重新启动它。生命周期轮询由宿主统一追踪，不建立另一套定时器或队列。

API 所需能力为 `meetings:read` 和 `meetings:write`，均只接受当前 Task Run；巡检不获得它们。首次入会和离会通过现有 Approvals 绑定精确目标；当前没有可靠原意凭据，不用关键词或模型 boolean 代替确认。同一次真实请求重复工具调用复用已有动作事实，不再发起平台动作。MCP 没有接受草稿工具，只有真实本人卡片回调能决定。

完整草稿按文本分段通过 Delivery 逐段送达后，再发固定大小确认卡。接受前再次核验原会前来源及写稿过程中实际新增的资料，确认中只写同一个 SQLite 事务的待办和决定。会议事件保留在 Todo 的宿主 provenance 中，系统事件不会被包装成原用户消息。只有真实委托人可按 open_id 绑定负责人；其他参与人的名字仍为候选，不借本人点击向对方发送提醒。

API/MCP 可调用 `join`、`leave`、`sync`、`read`、`proposeDraft`。`decideDraft` 只接真实本人卡片回调。`refresh(sessionId, assertCurrent)` 供宿主已经追踪的生命周期使用；一轮最多读取十页，保留真实下一页游标，未到末页不会将来源称为完整。生命周期应恢复未结束会议，也要恢复尚未持久安排草稿的已结束会议，避免在结束证据与新 Work 入队之间丢任务。

## 回执与取消

所有 join/leave 在调用平台前持久保留动作，且使用现有 `RunApiCalls.capture`。请求取消不等于远端没执行：有效 ACK 先存，之后才对调用者报取消。网络失败、响应不全和进程退出留下的未知动作不自动重放，只通过平台正证核对。迟到失败不能覆盖已经观察到的会议结束事实。

平台明确的应用配置或入会条件拒绝记为 `join_rejected` / `leave_rejected`，不是“可能已入会”。原请求不自动重试；问题修正后，新本人委托可重新审批。旧拒绝记录保留，不能用一次失败把后续同号会议永久锁死。

原 `meetingId` 一旦取得必须沿用。暂时没有 ID 的未知入会只能查该请求指定的会议号，多个结果不擅自选择；目录缺席不作否定结论。宿主应保证原委托仍有效，不能把失效或被替换的会议请求用于新一次同号会议。

会后留存事件的查看依据是原明确委托、实际参会证据、精确留存版本和当前本人受众，不要求机器人为读取旧纪要重新入会。停止或撤销委托后不得继续读取、安排草稿或投递；是否离开会议由真实离会授权处理，不能把数据库停用状态冒充平台已离会。

## 验证与尚待真实验收

本片定向测试使用真实 SDK 参数形状、SQLite 数据库重开、DeliveryService 和 Todos；平台网络传输由明确 fixture 替代。覆盖无授权不入会、ACK 与实际参与区别、分页与重启、未知动作不重放、等待期间撤权、取消后 ACK 落账、仅本人私聊、全文审阅、旧卡失效、重复确认和事务回滚。

仍需真实应用验证：灰度能力与 `vc:meeting.bot.join:write` 开通/发布/数据范围；主持人等候室；实际 bot 参与事件及转写覆盖；后台结束发现；完整草稿呈现；本人确认后的真实待办来源与重复点击。没有转写不能宣称听完会议，join 成功不等于已经参会，也不等于取得妙记。

官方依据：安装的 `@larksuiteoapi/node-sdk` 类型与端点；Lark 官方 CLI `shortcuts/vc/vc_meeting_join.go`、`vc_meeting_events.go`、`vc_meeting_leave.go` 及 `lark-meeting` 场景说明。开放平台接口入口：[join](https://open.feishu.cn/api-explorer?project=vc&resource=bot&apiName=join&version=v1)、[events](https://open.feishu.cn/api-explorer?project=vc&resource=bot&apiName=events&version=v1)、[leave](https://open.feishu.cn/api-explorer?project=vc&resource=bot&apiName=leave&version=v1)。
