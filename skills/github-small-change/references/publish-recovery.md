# 发布与未知结果恢复

只在用户要求发布、修改已经可审阅时用 `github_open_pr`。确认对象是工具准备的目录与当前代码快照；等待确认时不要继续改文件，变化后须重新核对。示例仅说明参数，目录、标题和正文使用实际值。

```json
{"tool":"github_open_pr","arguments":{"dir":"work/example-change/example-repo","title":"修复列表空状态","body":"说明具体触发条件、修改及实际验证结果。","draft":true}}
```

网关维护会话/发起人/仓库/基线/分支绑定和 push/PR 阶段，worker 可写的 `.friday-change.json` 只是线索。不能修改 marker 来迁移任务、改 remote 或自己提交发布凭据。目录独立也不允许共享别的任务的修改。

成功返回真实 URL/编号后，用 `github_get_issue` 回读 repo、number、head/base 与 draft 状态。需要逐文件核对时用 `github_pr_diff`。工具报“分支已推送”却没有编号/链接时，只确认分支阶段，不说 PR 已创建。

超时、连接中断或结果未知：保留本地目录和网关阶段，**先只读核对**真实分支/commit 与远端 PR，不重新调用准备或发布工具。已知分支的查询要覆盖关闭/已合并的 PR：

```json
{"tool":"github_list_issues","arguments":{"repo":"example-org/example-repo","type":"pr","state":"all","query":"head:friday/example-branch"}}
```

```json
{"tool":"github_get_issue","arguments":{"repo":"example-org/example-repo","number":42}}
```

核对候选的实际 head/base 和内容后复用已有链接；搜索命中不足、分页/权限错误或仍无法确认时说“发布结果未知”，不要把空搜索当作可安全再次 POST 的证据。当前没有模型可调用的独立 publish-status/reconcile 工具；不要发明恢复接口。核实结果前不能默认重试、创建第二个 PR、合并或部署。
