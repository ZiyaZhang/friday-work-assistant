#!/usr/bin/env node
// Compatibility reader for Python SQLite builds without the application's FTS tokenizer.
// Private stdout is consumed by the guard only; never log SQL errors or row values.
import { DatabaseSync } from 'node:sqlite'

const [path, table] = process.argv.slice(2)
let db
try {
  if (!path || !table) throw new Error('missing reader arguments')
  db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('table missing')
  const quote = name => '"' + name.replaceAll('"', '""') + '"'
  const info = db.prepare(`PRAGMA table_info(${quote(table)})`).all()
  const columns = info.map(row => row.name)
  const primary = info.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name)
  const statement = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`)
  statement.setReadBigInts(true)
  const token = value => {
    if (value === null) return ['null']
    if (typeof value === 'bigint') return ['integer', value.toString()]
    if (typeof value === 'number') {
      const bits = Buffer.allocUnsafe(8)
      bits.writeDoubleBE(value)
      return ['real64', bits.toString('hex')]
    }
    if (typeof value === 'string') return ['text', value]
    if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')]
    throw new Error('unsupported SQLite value')
  }
  const rows = statement.all().map(row => columns.map(column => token(row[column])))
  process.stdout.write(JSON.stringify({ columns, primary_key: primary, rows }))
} catch {
  // The caller reports a fixed error code. Raw errors can contain private content.
  process.exitCode = 1
} finally {
  db?.close()
}
