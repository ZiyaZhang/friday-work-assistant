# Harness 反馈与导出：按需核对路径

路径地图基于包版本 `0.1.6-alpha.2`。这是定位参考，不是固定用户版本或遥测后台状态。以下路径相对工作区获准的 Harness checkout（通常为 `repos/deepseek-harness/`）；实际 checkout 有变化时用 `rg --files` 重新定位，不要求用户查源码。没有挂载代码或无法核对用户版本时保留这个限制，不为确认路径搜用户 home 或日志目录。

| 要确认的事实 | 源码位置与语义 |
|---|---|
| `/feedback <text>` | `packages/feedback/command-feedback/src/index.ts`：`USAGE`、`executeFeedbackCommand`；反馈写入 canonical `feedback/record`，返回 Session ID 与匿名 user ID。空文本给用法，不是日志获取入口 |
| Web `/export` | `packages/session-query/session-log-export/src/index.ts`：注册 export 命令，无路径参数；这里只返回下载请求成功 |
| Web 实际下载入口 | 同包 `src/client/index.ts`：监听 command/executed 并调用 controller.download，同时注册 session header utility；`src/client/HeaderAction.tsx` 核验当前按钮文案 |
| 浏览器下载与后代 | 同包 `src/client/controller.ts`：HEAD 再触发 GET，当前 `includeDescendants=true`；UI success 不证明本机最终保存成功 |
| 导出内容 | 同包 `src/archive.ts`：规范 JSONL、可选子会话及被引用附件；根会话可能含继承上下文；`includeDescendants=false` 不关闭附件也不抹父前缀 |
| 反馈遥测 | `packages/session/session-telemetry/src/coordinator.ts`、`packages/session/session-telemetry-otel/src/index.ts`：上传端不是查询端，OTel 片段不等于无损完整 JSONL |
| DeepSeek 请求附带日志 | `packages/session/session-log-deepseek/src/index.ts`：另一条发送路径，accepted 不是诊断后台已收到或可下载 |

先读相关实现与用户版本，再给简单操作；只为回答一个导出问题，无需向用户展开所有路径。版本差异实际影响入口时才说明或询问。Web 入口缺失时只问关键补充，不让用户按 mtime 猜记录、不索取全 home 目录或浏览器 cookie。

不能用 Session ID 发明工具名、拼后台请求路径或谎称取得日志。用户在本话题主动提交的文件走入站附件接收；成功后可以用于本次排查。普通 `feishu_get_message_file` 能取获准消息附件，但不能据此访问未提交的后台日志。

这些是执行规则。只拿到 Session ID 且排查需要文件时，直接请用户发送该会话的导出文件；无需介绍日志接收设施。用户明确询问能力时再说明具体支持范围。

## 用户上传的导出包

使用本轮成功回执中的文件路径；来源记录在同一消息目录的 `source.json`，文件在 `files/`。核对消息、群、话题与当前请求，不能按文件名或旧目录猜本次证据。接收记录的 coverage 是 unverified，完整性要读内容后判断。

回执给出受管文件编号和摘要时，ZIP 先用 `friday_list_zip_members` 列出目录，再用 `friday_extract_zip_members` 解出相关 JSONL；沿用返回的成员文件编号、摘要及原包来源，不运行包内脚本。回执给出文件路径时，先列包内容，再只在该消息目录内解包；拒绝绝对路径、越出目标目录的 `..` 和符号链接，不运行其中的脚本。读取与现象有关的会话事件、模型尝试、工具结果和时间点，区分已证实、源码推断与仍未覆盖。导出可能带后代、附件与继承前缀，不能把包内全部内容当成本次问题的范围；不搜索其他消息目录补齐缺口。

短答给出与症状直接相关的发现和下一步，详细证据按需展开。不要把接收成功当作分析完成，也不要因日志未覆盖就断言没有错误或回复。目录分开只解决来源与同名冲突，不是 OS 硬隔离；原始内容不自动转发或写进 GitHub。
