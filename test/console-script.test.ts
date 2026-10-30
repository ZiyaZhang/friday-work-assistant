import { describe, expect, it } from 'vitest'
import { consoleScript } from '../src/web/console-page.js'

describe('console browser script', () => {
  it('parses as one script and issues every console command with a request identity and its CAS field', () => {
    expect(() => new Function(consoleScript)).not.toThrow()
    expect(consoleScript).toContain("operation:'work.cancel',workKey:w.key,expectedRevision:w.revision")
    expect(consoleScript).toContain("operation:'work.resume',workKey:w.key,expectedRevision:w.revision,reason:pause.reason,causeRef:pause.causeRef")
    expect(consoleScript).toContain("operation:'run.stop',runId:run.id,taskId:item.id")
    expect(consoleScript).toContain("operation:'routine.pause',id:item.id,expectedConfigVersion:item.configVersion")
    expect(consoleScript).toContain('requestId:crypto.randomUUID()')
    expect(consoleScript).toContain('const progress=item.progress')
    expect(consoleScript).not.toContain('row(p,item.request,runStates[item.status]')
  })
})
