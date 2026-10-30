---
name: dsh-codebase-explainer
description: 讲解 DeepSeek Harness (dsh) 代码库：某个包做什么、某条链路怎么走、某个概念（session / agent loop / cordis 插件 / ACP / sandbox / compaction）在哪实现。用户问"dsh 里 X 是怎么实现的"、"X 在哪个包"、"解释一下 dsh 的 Y"时使用。
---

# 讲解 dsh 代码库

代码库在工作区 `repos/deepseek-harness/`（只读）。这是一个 pnpm monorepo，"Everything is a Plugin"：
每个功能都是一个 cordis 插件，按 profile（bundle 叠 patch）组合成一棵插件树。

先核对实际 checkout 的 commit 与用户版本；只读镜像不修改。版本不同或路径不存在时重新定位，不能把本地图谱当作永远有效。问实现不自动开 issue、写记忆或修改代码。

## 定位顺序

1. 先读 `repos/deepseek-harness/docs/architecture.md` 的相关小节，再读 `docs/subsystems/<topic>.md`（session、agent、tools、sandbox、ssh、schedule、webhook、compaction、spill、skills、approval、subagent 都有一篇）。
2. 包目录 `packages/<area>/<pkg>/`，每个包有 `README.md`（含 Summary / Use this package / Known Limitations）和 `src/index.ts`。用 `rg -n "<关键词>" packages/*/*/README.md` 快速定位包，再进 `src/`。
3. 插件 id 与包名的对应看 `packages/bundle/base/cordis.patch.yml`（base 组合）和 `packages/bundle/acp-app/cordis.patch.yml` 等。
4. 设计决策与历史看 `.agents/notes/`（implemented/ 下按主题分目录）和 `docs/postmortem/`。

## 常用地图

| 概念 | 主要位置 |
| --- | --- |
| Agent 运行时（followup / steer / inject / cancel） | `packages/core/agent/src/runtime-types.ts`、`packages/core/agent/src/index.ts` |
| Agent loop、create / resume | `packages/core/agent-loop/src/index.ts` |
| 会话事件日志（JSONL、zstd） | `packages/session/session-persistence-jsonl/`、`docs/persistence-catalog.md` |
| 工具注册与 pre/post-execute 策略 | `packages/core/tools/` |
| 系统提示词 section / context | `packages/core/system-prompt/`（`docs/subsystems/system-prompt.md`） |
| 上下文压缩 / spill | `packages/compaction/`、`packages/spill/` |
| 沙箱（bwrap / Landlock / Seatbelt） | `packages/sandbox/`、`docs/subsystems/sandbox.md` |
| 远程 SSH 执行面 | `packages/ssh/`（ssh / fs-ssh / subprocess-ssh / sandbox-ssh） |
| ACP server（Friday 用的接口） | `packages/acp/acp/`（README 列了支持/不支持的方法） |
| SDK（stdio JSON-RPC）与 Python SDK | `packages/sdk/`、`python/sdk/` |
| MCP client | `packages/mcp/` |
| Skills / presets / persona | `packages/skill/`、`packages/preset/` |
| 子代理 / workflow / jobs | `packages/subagent/`、`packages/workflow/`、`packages/jobs/` |
| 定时 / webhook | `packages/schedule/`、`packages/webhook/` |
| 模型适配（deepseek / pi-ai） | `packages/llm/` |

## 回答要求

- IM 先用 1–3 个短句说明实际行为；用户需要技术细节时再给 2–5 步链路、版本、文件与行号（`rg -n` 定位）。不要默认把整张地图发给用户。
- 引用 README 或 docs 里的原句时用引号并注明文件。
- 区分"文档说的"和"你从代码推断的"。找不到就说没找到并列出查过的路径。
- 不要整段贴代码；关键函数签名或 10 行以内的片段即可。
