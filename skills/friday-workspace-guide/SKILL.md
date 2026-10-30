---
name: friday-workspace-guide
description: 查询 Friday 当前空间的状态、私人待办与日程、记忆来源，或按要求调整偏好、整理知识文档和交接；项目 issue/PR 总览使用 project-tracking。
---

# 使用当前空间的助手能力

按请求选择一项，不把查询扩成整套检查。工具返回的是当前授权范围内的登记事实，不是团队全部活动。

| 请求 | 操作与结果边界 |
|---|---|
| 这里有什么进展、到期项 | `friday_work_status`；默认只读，保留日期、编号和统计范围。明确要周报文档才传 `as_document=true`。 |
| 我今天有什么待办、会议 | `friday_todo_list`；确实问到日程时在本人私聊调用 `feishu_my_calendar`。按已知时间合并，缺少授权不等于没有会议。 |
| 你记住了什么 | `friday_memory_search`；这只是查询，不调用会新建或重写文档的 Wiki 工具。 |
| 记住、纠正、忘记一件事 | 先搜索定位原条目。纠正用 `friday_memory_save` 的 replaces，只写本人说过的内容，不再删旧的（旧条目在本人确认新条目前继续有效）；只有本人要求忘掉时才用 `friday_memory_forget`。模型写入一律 candidate，候选不会撤销已确认事实。回执只说明实际操作和状态；用户问"怎么确认"时，告诉他跟我说一声就行，不要让他去敲命令。不能把查询顺手变成保存，也不能声称尚未实现的自然语言确认已生效。 |
| 把已确认知识整理成持续文档 | `friday_wiki` 会创建或重写同一文档；只在明确要求归档时用。临时纪要走 `group-digest`，不覆盖知识页。 |
| 我要交接 | `friday_handover` 生成状态与待办文档。只交付获准资料与真实链接；接手人仍须自己授权，不把交接称为身份或权限转移。 |
| 你为什么这么答、能看到哪些群 | `friday_explain_context` / `friday_visible_groups`。仅报告网关实际记录的来源和限制，不凭模型回忆补全。 |
| 以后短答、关闭主动回复、改变行为偏好 | `friday_space_settings` 留空先看；按现有 args 契约更改所需项，并核对回执。负责人权限由网关验证，不能用普通记忆绕过。 |
| 有哪些模型、以后换个模型、恢复默认 | 用 `friday_space_settings` 的 `models` 查看当前目录；用户明确选定后通过 `set model main <目录中的 ID>` 保存，恢复默认用 `set model main default`。只说下次执行生效，不说当前任务已经换了；不猜模型名、额度、计费账号或消耗。 |

用户只是要这一次简短，直接简短回答，不改长期配置。普通执行没有过程卡；不能用旧 `set card` 选项承诺开启过程卡。

新增私人待办要有明确委托，先查重，owner/due 未知就留空；正式 issue/PR 状态从 GitHub 读取，参考 `project-tracking`。用户要后台跟进时再读 `routine-management`。

只有用户明确要求把某个做法设为技能时才 `friday_propose_skill`，正文保存通用操作方法，不含案件原文、成员名单、私聊事实或凭据。自定义技能按空间绑定版本；这不等于文件系统隔离。一次性查询不用提技能。
