# 群功能卡与简报（2026-09-30）

新群首次 @ Friday 发一张功能卡。勾选即保存，取消即停止，成功只更新原卡；未勾选的功能不自动启用。已有群的设置不迁移。已有群可通过群设置重新打开卡片。

- 主动答疑与点赞：沿用主动巡检、安静时段和点赞限额。
- 每日早报：北京时间工作日 09:00，本群过去 24 小时与已登记待办。
- 待办汇总：北京时间工作日 17:30，汇总明确承诺及待确认项，不自动认领或落库。
- PR / Issue 跟进：每 30 分钟核对本群明确链接的事项，22:00–09:00 静默，有可核实的新变化才发送。
- 需求投票：沿用部署和本空间开关，按需发起。

排障、建 Issue、改代码和进度表仍按具体任务处理；勾选跟进不授予仓库写权限。三个简报职责在宿主层只签发读取工具作用域，保留真实创建者和原空间权限。取消勾选复用 RoutineApplication 的事务与执行取消机制。卡片核对真实操作人、群、消息 ID 和逐项版本，重投不重复创建，过期回调不覆盖新状态。

简报正文按 Markdown 标题拆为卡片区块，短结果展开，长结果保留首节并折叠详情。保留粗体、真实来源链接和飞书原生 `:THUMBSUP:` / `:OK:`；不把表情文本等同于消息 reaction。未确认的表情键不猜。

交互参考（只取已适配现有能力的部分）：
- [OpenClaw Feishu messaging](https://docs.openclaw.ai/channels/feishu/messaging)：卡片、富文本与 reaction 的区别。
- [飞书 checker](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/interactive-components/checker)
- [飞书表情说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)

