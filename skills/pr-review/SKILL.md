---
name: pr-review
description: 按准确 PR head 审阅 diff 和上下文，只报告有具体失败条件的问题；默认在当前对话交付，明确要求后才发 GitHub 评论。
---

# 审阅一个 PR

用 `github_pr_diff` 核对 repo、number、base/head SHA、coverage、已有 review 和行内评论；必要时 `github_get_issue` 补普通讨论。只读当前获准仓库。读取改动函数及调用方，先确认本地 checkout 与 PR head 一致；不一致时不能引用本地行号冒充 PR 改动行。旧 commit 的评论要核对是否仍适用，行内评论列表不提供线程是否已解决的结论。

优先查正确性、回归、并发、迁移、越权/外泄和异常路径。每条发现都写清输入/触发、后果、位置和依据。只在需要验证某个疑点时跑相关测试；未运行测试说清。diff 截断或上下文缺失不等于完整审阅通过，PR 更新后旧结论标过期。

IM 先用 1–3 个短句给审阅结论和阻塞数，详细发现按需展开。没有发现可复现问题就如实说，避免“保证可以合”或把 code review 当作合并授权。

默认只在当前对话回复。用户明确要求发到 PR 时才 `github_comment_issue`，先读现有评论避免重复，并经过当前网关的确认流程。结果未知先读回，不盲重发。要修复时切换 `github-small-change`；review 本身不允许改代码、推送、合并或部署。
