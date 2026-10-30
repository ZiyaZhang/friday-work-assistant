import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerRepositoryFileTools(server: Pick<McpServer, 'registerTool'>,
  call: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>, errorResult: (error: unknown) => { content: { type: 'text'; text: string }[]; isError: boolean }) {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  const base = { changeId: z.string().describe('github_start_change 返回的 id'), path: z.string().describe('修改副本内的相对路径') }
  const readConsistency = { consistency: z.enum(['files', 'snapshot']).optional().describe('默认 files：实际文件字节/覆盖范围，不是整树原子快照；snapshot 才执行完整树校验'), expectedSnapshot: z.string().optional().describe('一旦提供即严格核验整树版本') }
  server.registerTool('github_list_change_files', { title: '列出修改副本文件',
    description: '列出已登记修改副本的当前目录。默认 files 只读目录，不计算整树；after 分页携带上一页 directoryVersion 作为 expectedDirectoryVersion（绑定目录身份、名称和类型，不代表内容或整树版本）。需要整树一致性可显式 snapshot，旧 expectedSnapshot 仍严格核验。只有原 Work、会话和发起人可读。',
    inputSchema: { changeId: base.changeId, path: base.path.optional(), after: z.string().optional(), ...readConsistency, expectedDirectoryVersion: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async args => { try { return result(await call('/v1/github/change/files/list', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_read_change_file', { title: '读取修改副本文件',
    description: '读取实际仓库文件内容及 SHA256 digest。默认仅保证读到的文件字节，不计算或声称整树原子快照；需要严格校验时显式 consistency=snapshot。写前对选定文件用 consistency=snapshot 的严格读取取得 snapshot。不能用 friday_write_file 代替改仓库。',
    inputSchema: { ...base, ...readConsistency },
  }, async args => { try { return result(await call('/v1/github/change/files/read', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_read_change_files', { title: '批量读取同一修改副本文件',
    description: '已定位多个相关文件时一次读取。默认返回逐文件 digest/content，不计算或声称整树原子快照；consistency=snapshot 或 expectedSnapshot 才校验完整树。paths 最多16个，每文件最多1MiB、总共最多4MiB；任一缺失、非文本或越界时整批报错，不省略文件。',
    inputSchema: { changeId: base.changeId, paths: z.array(base.path).min(1).max(16), ...readConsistency },
  }, async args => { try { return result(await call('/v1/github/change/files/read-many', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_search_change_files', { title: '搜索修改副本中的路径或文本',
    description: '在当前工作登记的真实仓库副本中定位代码。query 是区分大小写的字面字符串；多个已知候选词可改传queries（最多8个，和query二选一），一次扫描共享总limit和覆盖预算。默认不计算整树快照；content 命中带实际文件 digest，path 模式在 tracked + 未忽略 untracked 路径清单中匹配文件与目录，不读正文；忽略的未跟踪内容不在搜索范围，已知路径可直接读取。支持分页；返回 nextCursor 时用相同 changeId/path/query 或 queries/consistency 继续，cursor 只表示位置，每页 coverage=page，不证明调用者已读过前页。files 分页非原子整树，候选路径集合变化拒绝续页；需要整树版本不变用 snapshot。mode 默认为 content，path 可限定子目录或一个具体文件。批量返回逐词results；任何 truncated 或 skippedFiles>0 都不能证明完整无命中。inventory 不完整且无 nextCursor 时必须缩小 path，不能宣称全仓没有。写前对选定文件用 consistency=snapshot 的严格读取取得 snapshot。',
    inputSchema: { changeId: base.changeId, path: base.path.optional(), query: z.string().min(1).max(4096).optional(), queries: z.array(z.string().min(1).max(4096)).min(1).max(8).optional(),
      mode: z.enum(['content', 'path']).optional(), cursor: z.string().min(1).max(65536).optional().describe('仅 path 模式的 nextCursor；保持原查询与范围'), limit: z.number().int().min(1).max(200).optional(), ...readConsistency },
  }, async args => { try { return result(await call('/v1/github/change/files/search', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_write_change_file', { title: '修改 Git 工作副本文件',
    description: '仅修改当前工作已登记的仓库副本，保留真实文件版本与整树快照检查。先读文件取得 digest，并用 consistency=snapshot 的严格读取取得 snapshot；创建时 expectedDigest=null，删除时 content=null。不会执行 shell、推送或合并。完成后需验证并用原修改副本发布 Draft PR；未运行测试要明确说明。',
    inputSchema: { ...base, expectedSnapshot: z.string(), expectedDigest: z.string().nullable(), content: z.string().nullable() },
  }, async args => { try { return result(await call('/v1/github/change/files/write', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_edit_change_file', { title: '精确修改仓库文件的一处内容',
    description: '先读文件取得 digest，并用 consistency=snapshot 的严格读取取得 snapshot，再用原文 oldText 和替换文 newText 改一处；oldText 必须非空且唯一。适合大文件中的小修复，无需重写全文。下一次修改沿用返回的新 snapshot，并使用目标文件自己的 digest。版本变化、原文不存在或多处匹配均拒绝；保留其余字节、文件模式和现有发布权限。',
    inputSchema: { ...base, expectedSnapshot: z.string(), expectedDigest: z.string(), oldText: z.string().min(1), newText: z.string() },
  }, async args => { try { return result(await call('/v1/github/change/files/edit', args)) } catch (error) { return errorResult(error) } })
}
