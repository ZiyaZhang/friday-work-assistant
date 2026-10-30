import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { IngressClassifier, type IngressClassificationInput } from '../src/acp/ingress-classifier.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { createLogger } from '../src/log.js'

/** Exercises the actual tool-less ACP envelope, not a claim of real-model semantic acceptance. */
describe('delivery adjustments preserve the original result relationship', () => {
  it.each(['amend', 'new_work', 'clarify'] as const)('keeps host output identities and the original explicit decision %s', async kind => {
    const decision = kind === 'amend' ? {kind,targetRef:'produced-result'} : {kind}
    const { app, state } = createFakeAgent({script:[{kind:'text',text:JSON.stringify(decision)}]})
    const log = createLogger('deliverable-classifier','error')
    const classifier = new IngressClassifier({cwd:'/tmp/friday-router-unit',timeoutMs:1000,log,createRuntime:()=>new AcpRuntime({transport:{kind:'inproc',agent:app},
      maxConcurrent:1,onPermission:async()=>({outcome:{outcome:'cancelled'}}),log})})
    const input: IngressClassificationInput = { message:{text:'收到，等结果出来再叫我，带上链接。',replyToRef:'produced-result'}, candidates:[
      {ref:'produced-result',title:'完成原来的小修改',status:'done',work:{lifecycle:'open',pauseReasons:[]},
        deliverables:[{kind:'pull_request',repo:'org/demo',number:12,url:'https://github.com/org/demo/pull/12'}]},
      {ref:'separate-reminder',title:'讨论一个后续提醒',status:'done',work:{lifecycle:'open',pauseReasons:[]}},
    ] }
    try {
      expect(await classifier.classify(input)).toEqual(decision)
      const prompt=state.allPrompts[0]!.text
      expect(JSON.parse(prompt.split('Input data:\n')[1]!)).toEqual(input)
      expect(prompt).toContain('Adjusting the delivery, notification timing, recipient, or permitted handling')
      expect(prompt).toContain('genuinely unrelated reminder or independent deliverable separately')
      expect(prompt).toContain('A change to future domain follow-up, responsibilities, or handling is business work')
      expect(prompt).not.toContain('Stopping future follow-up on a feedback case, changing existing responsibilities')
    } finally {await classifier.stop()}
  })
})
