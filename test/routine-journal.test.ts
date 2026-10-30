/**
 * 日报存进文档这件事，是**能力**，不是规矩。
 *
 * 真机上他建了一条「项目群日报」，每天 18:00 汇总本群。日报一长就走折叠面板，
 * 而代码自己在别处写过——「折叠面板里的东西大多数人不会点开，写在里面约等于没写」。
 * 折叠一次是没人看，天天折叠就是这个功能白做。
 *
 * 第一版我把"长了就落文档"写成了默认行为，他当场纠正：
 * 「不是说日报一定要这样，如果用户在群里要求改你也可以改，只是你有调用飞书文档的能力，
 * 规则还是跟着用户要求来。」——对。能力归 Friday，**规矩归群里的人**：
 * 默认照旧直接发，有人说一句"太长了写文档里吧"才切过去，说"还是发群里"就切回来。
 *
 * 所以这组用例守的是"往顶上插"这个能力本身：
 * - 每天新建一篇 → 链接每天变、历史散在十几篇里，等于没有归档；
 * - 整篇重写（`rewriteDocument`）→ 把前几期删掉；
 * - 往顶上插 → 打开就是今天的，往下翻是历史。
 *
 * 分批是这里唯一容易写错的地方：一期日报超过 50 个块时，第二批要接在第一批**后面**，
 * 否则今天这一期自己就被自己打乱了。
 */
import { describe, expect, it, vi } from 'vitest'
import { FeishuClient } from '../src/feishu/client.js'

type Call = { documentId: string; index: number; count: number; first?: unknown }

/** 只搭 prependToDocument 这条路需要的东西：记下每次 children.create 的 index 和条数。 */
function setup() {
  const calls: Call[] = []
  const client = {
    docx: {
      v1: {
        documentBlockChildren: {
          create: vi.fn(async (req: Record<string, never>) => {
            const r = req as unknown as { path: { document_id: string }; data: { children: unknown[]; index: number } }
            calls.push({ documentId: r.path.document_id, index: r.data.index, count: r.data.children.length, first: r.data.children[0] })
            return { code: 0, data: {} }
          }),
        },
      },
    },
  }
  const feishu = Object.create(FeishuClient.prototype) as FeishuClient
  Object.assign(feishu, { client, docUrl: (id: string) => `https://example.feishu.cn/docx/${id}` })
  return { feishu, calls }
}

describe('新一期插在最前面', () => {
  it('一批就写完时插在 index 0——打开文档看到的是今天这期', () => {
    const t = setup()
    return t.feishu.prependToDocument('doc_1', '## 2026-09-22\n\n今天没什么大事。').then(() => {
      expect(t.calls).toHaveLength(1)
      expect(t.calls[0]!.index).toBe(0)
      expect(t.calls[0]!.documentId).toBe('doc_1')
    })
  })

  it('不删已有内容——历史必须留着', () => {
    // rewriteDocument 会先 batchDelete；归档这条路一次都不该删。
    const t = setup()
    return t.feishu.prependToDocument('doc_1', '## 2026-09-22\n\n正文').then(() => {
      expect(JSON.stringify(t.calls)).not.toContain('batchDelete')
      expect(t.calls.every((c) => c.documentId === 'doc_1')).toBe(true)
    })
  })

  it('超过 50 个块时第二批接在第一批后面，不把今天这期打乱', async () => {
    const t = setup()
    // 每行一个段落块，120 行 → 3 批
    const long = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行`).join('\n\n')
    await t.feishu.prependToDocument('doc_1', long)
    expect(t.calls.length).toBeGreaterThan(1)
    // index 必须是 0, 50, 100…：第一批占 0..49，第二批插在 50 正好接住
    expect(t.calls.map((c) => c.index)).toEqual(t.calls.map((_, i) => i * 50))
    // 而且是严格递增的，没有哪一批插回到前面去
    for (let i = 1; i < t.calls.length; i += 1) expect(t.calls[i]!.index).toBeGreaterThan(t.calls[i - 1]!.index)
  })

  it('回报的链接是这篇文档自己的，不是新建的', async () => {
    const t = setup()
    const r = await t.feishu.prependToDocument('doc_keep', '正文')
    expect(r.documentId).toBe('doc_keep')
    expect(r.url).toContain('doc_keep')
  })
})
