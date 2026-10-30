/**
 * 多维表格（Bitable）：飞书表格端口。
 *
 * PMO 建行后保留人工字段，读取表内事实，只更新 Friday 的观察和风险列。
 * 表格与本地工作项不自动双向覆盖；不一致由观察说明。
 *
 * 需要飞书应用权限：`bitable:app`（建表、读写记录）。没开权限时所有调用都会带着清楚的错误码失败，
 * 调用方据此提示去开权限，而不是默默不同步。
 */
import type { Client } from '@larksuiteoapi/node-sdk'

export interface BitableField {
  field_name: string
  /** 1 文本 / 2 数字 / 3 单选 / 5 日期 / 7 复选框 */
  type: number
  property?: Record<string, unknown>
}

export interface BitableRecord {
  recordId?: string
  fields: Record<string, unknown>
}

export const FIELD_TYPE = { text: 1, number: 2, singleSelect: 3, date: 5, checkbox: 7 } as const

function ok<T>(api: string, res: { code?: number; msg?: string; data?: T }): T {
  if (res.code !== undefined && res.code !== 0) {
    const err = new Error(`${api} 失败（code=${res.code}）：${res.msg ?? ''}`)
    // 平台原文单独留一份：PMO 的日志和手动同步回复只引用错误码和原文。
    Object.assign(err, { code: res.code, msg: res.msg })
    throw err
  }
  return (res.data ?? {}) as T
}

export class Bitable {
  constructor(private readonly client: Client) {}

  /** 新建一个多维表格（app_token 就是这个表格的身份，存起来后面都用它）。 */
  async createBase(name: string, folderToken?: string): Promise<{ appToken: string; url: string }> {
    const data = ok('bitable.app.create', await this.client.bitable.v1.app.create({ data: { name: name.slice(0, 100), ...(folderToken ? { folder_token: folderToken } : {}) } })) as {
      app?: { app_token?: string; url?: string }
    }
    const appToken = data.app?.app_token
    if (!appToken) throw new Error('建多维表格没有返回 app_token')
    return { appToken, url: data.app?.url ?? `https://feishu.cn/base/${appToken}` }
  }

  async listTables(appToken: string): Promise<{ tableId: string; name: string }[]> {
    const data = ok('bitable.table.list', await this.client.bitable.v1.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } })) as {
      items?: { table_id?: string; name?: string }[]
    }
    return (data.items ?? []).map((t) => ({ tableId: String(t.table_id), name: String(t.name ?? '') }))
  }

  async listFields(appToken: string, tableId: string): Promise<{ fieldName: string; type: number }[]> {
    const data = ok('bitable.field.list', await this.client.bitable.v1.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 100 } })) as {
      items?: { field_name?: string; type?: number }[]
    }
    return (data.items ?? []).map((f) => ({ fieldName: String(f.field_name ?? ''), type: Number(f.type ?? 0) }))
  }

  /**
   * 读记录。**只读**，给"表格是事实源、Friday 跟着它变"的场景用（比如成员对照表）。
   * 自动翻页，`limit` 是硬上限——对照表再大也不该把网关拖住。
   */
  async listRecords(appToken: string, tableId: string, opts: { limit?: number; assertCurrent?: () => void } = {}): Promise<{ records: BitableRecord[]; complete: boolean }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000))
    const records: BitableRecord[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 60; page += 1) {
      opts.assertCurrent?.()
      const data = ok('bitable.record.list', await this.client.bitable.v1.appTableRecord.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: Math.min(500, limit - records.length), ...(pageToken ? { page_token: pageToken } : {}) },
      })) as { items?: { record_id?: string; fields?: Record<string, unknown> }[]; page_token?: string; has_more?: boolean }
      opts.assertCurrent?.()
      for (const r of data.items ?? []) records.push({ recordId: r.record_id ? String(r.record_id) : undefined, fields: r.fields ?? {} })
      pageToken = data.has_more ? data.page_token : undefined
      if (!pageToken || records.length >= limit) return { records, complete: !data.has_more }
    }
    return { records, complete: false }
  }

  /** 按名字找表，没有就按给定字段建一张。 */
  async ensureTable(appToken: string, name: string, fields: BitableField[]): Promise<string> {
    const existing = (await this.listTables(appToken)).find((t) => t.name === name)
    if (existing) return existing.tableId
    const data = ok(
      'bitable.table.create',
      await this.client.bitable.v1.appTable.create({ path: { app_token: appToken }, data: { table: { name, default_view_name: '全部', fields: fields as never } } }),
    ) as { table_id?: string }
    if (!data.table_id) throw new Error('建表没有返回 table_id')
    return data.table_id
  }

  /** 补齐表里缺的列（表已经存在、但 Friday 版本更新加了字段时用）。 */
  async ensureFields(appToken: string, tableId: string, fields: BitableField[]): Promise<number> {
    const data = ok('bitable.field.list', await this.client.bitable.v1.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200 } })) as {
      items?: { field_name?: string }[]
    }
    const have = new Set((data.items ?? []).map((f) => String(f.field_name)))
    let added = 0
    for (const f of fields) {
      if (have.has(f.field_name)) continue
      ok('bitable.field.create', await this.client.bitable.v1.appTableField.create({ path: { app_token: appToken, table_id: tableId }, data: f as never }))
      added += 1
    }
    return added
  }

  async batchCreate(appToken: string, tableId: string, records: BitableRecord[]): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < records.length; i += 500) {
      const data = ok(
        'bitable.record.batchCreate',
        await this.client.bitable.v1.appTableRecord.batchCreate({ path: { app_token: appToken, table_id: tableId }, data: { records: records.slice(i, i + 500).map((r) => ({ fields: r.fields })) as never } }),
      ) as { records?: { record_id?: string }[] }
      for (const r of data.records ?? []) ids.push(String(r.record_id))
    }
    return ids
  }

  async batchUpdate(appToken: string, tableId: string, records: (BitableRecord & { recordId: string })[]): Promise<number> {
    let n = 0
    for (let i = 0; i < records.length; i += 500) {
      const slice = records.slice(i, i + 500)
      ok(
        'bitable.record.batchUpdate',
        await this.client.bitable.v1.appTableRecord.batchUpdate({ path: { app_token: appToken, table_id: tableId }, data: { records: slice.map((r) => ({ record_id: r.recordId, fields: r.fields })) as never } }),
      )
      n += slice.length
    }
    return n
  }

  async batchDelete(appToken: string, tableId: string, recordIds: string[]): Promise<number> {
    let n = 0
    for (let i = 0; i < recordIds.length; i += 500) {
      const slice = recordIds.slice(i, i + 500)
      ok('bitable.record.batchDelete', await this.client.bitable.v1.appTableRecord.batchDelete({ path: { app_token: appToken, table_id: tableId }, data: { records: slice } }))
      n += slice.length
    }
    return n
  }

  baseUrl(appToken: string, tableId?: string): string {
    return `https://feishu.cn/base/${appToken}${tableId ? `?table=${tableId}` : ''}`
  }
}
