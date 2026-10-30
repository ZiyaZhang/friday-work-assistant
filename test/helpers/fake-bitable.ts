/**
 * 多维表格替身：记录真实调用顺序与参数，不连飞书。
 * 只实现通用建表路径用到的四个方法；PMO 的同步路径用的是真实 Bitable 的其余方法。
 */
import type { Bitable, BitableField, BitableRecord } from '../../src/feishu/bitable.js'
import { FeishuApiError } from '../../src/feishu/client.js'

export class FakeBitable {
  bases: { name: string; appToken: string; folderToken?: string }[] = []
  tables: { appToken: string; name: string; tableId: string; fields: BitableField[] }[] = []
  created: { appToken: string; tableId: string; records: BitableRecord[] }[] = []
  /** 依次记录调用顺序，用来断言"先建表再写行，失败时不写行"。 */
  calls: string[] = []
  failCreateBase: FeishuApiError | undefined
  failBatchCreate: FeishuApiError | undefined

  async createBase(name: string, folderToken?: string): Promise<{ appToken: string; url: string }> {
    this.calls.push('createBase')
    if (this.failCreateBase) throw this.failCreateBase
    const appToken = `bascn${this.bases.length + 1}`
    this.bases.push({ name, appToken, folderToken })
    return { appToken, url: `https://test.feishu.cn/base/${appToken}` }
  }

  async ensureTable(appToken: string, name: string, fields: BitableField[]): Promise<string> {
    this.calls.push('ensureTable')
    const tableId = `tbl${this.tables.length + 1}`
    this.tables.push({ appToken, name, tableId, fields })
    return tableId
  }

  async batchCreate(appToken: string, tableId: string, records: BitableRecord[]): Promise<string[]> {
    this.calls.push('batchCreate')
    if (this.failBatchCreate) throw this.failBatchCreate
    this.created.push({ appToken, tableId, records })
    return records.map((_, i) => `rec${i + 1}`)
  }

  baseUrl(appToken: string, tableId?: string): string {
    return `https://test.feishu.cn/base/${appToken}${tableId ? `?table=${tableId}` : ''}`
  }
}

/** 只有通用建表用到的方法被替身覆盖；其余成员不会在这条路径上被调用。 */
export function asBitable(fake: FakeBitable): Bitable {
  return fake as unknown as Bitable
}
