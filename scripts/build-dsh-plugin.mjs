import { readFile, writeFile, mkdir } from 'node:fs/promises'
import ts from 'typescript'
const source = new URL('../src/personal/device-crypto.ts', import.meta.url)
const output = new URL('../integrations/dsh/lib/device-crypto.js', import.meta.url)
await mkdir(new URL('.', output), { recursive: true })
const compiled = ts.transpileModule(await readFile(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: false } })
await writeFile(output, '// Generated from src/personal/device-crypto.ts by scripts/build-dsh-plugin.mjs.\n' + compiled.outputText)
