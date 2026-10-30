import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../integrations/dsh/lib/client.js', import.meta.url), 'utf8')
type Element = { type: unknown, props: Record<string, any>, children: any[] }
const cleanups = new Set<() => void>()
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

// Run the shipped browser module, its effects, and UI event handlers without a
// browser dependency. The harness supplies only the React hooks this panel uses.
function mount(handle: (path: string, input: any) => Promise<any> | any) {
  const components = new Map<string, { type: unknown, hooks: any[] }>(), dom = new Map<string, any>()
  const listeners = new Map<string, Set<() => void>>()
  const events = {
    addEventListener(name: string, listener: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener) },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener) },
  }
  const effects: (() => void)[] = []
  let hooks: any[] = []
  let cursor = 0, queued = false, stopped = false, renderer: () => Element, tree: Element
  const schedule = () => {
    if (queued || stopped) return
    queued = true
    Promise.resolve().then(() => { queued = false; if (!stopped) render() })
  }
  const React = {
    createElement: (type: unknown, props: Record<string, any> | null, ...children: any[]) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState(value: any) {
      const index = cursor++, owner = hooks
      if (!(index in owner)) owner[index] = typeof value === 'function' ? value() : value
      return [owner[index], (next: any) => {
        const updated = typeof next === 'function' ? next(owner[index]) : next
        if (!Object.is(updated, owner[index])) { owner[index] = updated; schedule() }
      }]
    },
    useRef(value: any) { const index = cursor++; return hooks[index] ??= { current: value } },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++, previous = hooks[index]
      if (!previous || !deps || deps.some((item, i) => !Object.is(item, previous.deps?.[i]))) {
        const entry = { deps, cleanup: previous?.cleanup }; hooks[index] = entry
        effects.push(() => { entry.cleanup?.(); entry.cleanup = effect() })
      }
    },
  }
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const value = await handle(url.replace('api/friday/', ''), init?.body ? JSON.parse(String(init.body)) : {})
    return { ok: true, json: async () => value }
  })
  runInNewContext(source, { window: { ...events, __ModuleLoader__: { load({ factory }: any) {
    factory(() => React).apply({ effect: (fn: () => unknown) => fn(), slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (slot: { name: string }, component: () => Element) => { if (slot.name === 'main') renderer = component },
    } })
  } } }, fetch, crypto: { randomUUID }, document: { ...events, visibilityState: 'visible' }, Date, URL, setInterval, clearInterval, setTimeout, clearTimeout })
  function render() {
    const used = new Set<string>()
    const expand = (node: any, path: string): any => {
      if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.props?.key ?? index}`))
      if (!node || typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        let component = components.get(path)
        if (component && component.type !== node.type) { component.hooks.forEach(hook => hook?.cleanup?.()); component = undefined }
        if (!component) { component = { type: node.type, hooks: [] }; components.set(path, component) }
        used.add(path); hooks = component.hooks; cursor = 0
        return expand(node.type({ ...node.props, children: node.children }), `${path}/render`)
      }
      const result = { ...node, children: expand(node.children, `${path}/children`) }
      const key = node.props.id || path
      let element = dom.get(key)
      if (!element) {
        element = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400, focus: vi.fn(),
          scrollTo(options: { top: number } | number, y?: number) { this.scrollTop = typeof options === 'number' ? y : options.top },
          scrollIntoView: vi.fn(), style: {},
        }
        dom.set(key, element)
      }
      element.props = node.props
      if (typeof node.props.ref === 'function') node.props.ref(element)
      else if (node.props.ref) node.props.ref.current = element
      return result
    }
    tree = expand(renderer(), 'root')
    for (const [path, component] of components) if (!used.has(path)) { component.hooks.forEach(hook => hook?.cleanup?.()); components.delete(path) }
    effects.splice(0).forEach(effect => effect())
  }
  const all = (node: any): Element[] => node && typeof node === 'object' ? [node, ...(node.children ?? []).flat(Infinity).flatMap(all)] : []
  const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? node.type === 'style' ? '' : text(node.children ?? []) : typeof node === 'string' ? node : ''
  render()
  const input = () => all(tree).find(node => node.props.id === 'friday-message')!
  const type = async (value: string) => { input().props.onChange({ target: { value } }); await flush() }
  const close = () => { stopped = true; components.forEach(component => component.hooks.forEach(hook => hook?.cleanup?.())); cleanups.delete(close) }
  cleanups.add(close)
  return { fetch, text: () => text(tree), input, type,
    async event(name: string) { listeners.get(name)?.forEach(listener => listener()); await flush() },
    find: (predicate: (node: Element) => boolean) => all(tree).find(predicate),
    node: (id: string) => { if (!dom.has(id)) throw new Error('DOM node not found: ' + id); return dom.get(id) },
    async key(options: Record<string, any> = {}) {
      const event = { key: 'Enter', keyCode: 13, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...options }
      input().props.onKeyDown?.(event); await flush(); return event
    },
    async scroll(id: string, top: number) {
      const element = dom.get(id); if (!element) throw new Error('DOM node not found: ' + id)
      element.scrollTop = top; element.props.onScroll?.({ currentTarget: element, target: element }); await flush()
    },
    button(label: string) {
      const button = all(tree).find(node => node.type === 'button' && text(node) === label)
      if (!button) throw new Error('Button not found: ' + label)
      expect(button.props.disabled).not.toBe(true)
      button.props.onClick(); return flush()
    },
    async message(value: string) {
      await type(value)
      all(tree).find(node => node.type === 'form' && all(node).some(child => child.props.id === 'friday-message'))!.props.onSubmit({ preventDefault() {} })
      await flush()
    },
    close,
  }
}

afterEach(() => { cleanups.forEach(close => close()); vi.useRealTimers() })
describe('DSH personal items, preparation and native task boundaries', () => {
  it('shows unread dissolved-chat gaps separately from continued scanning', async () => {
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') return { items: [] }
      return { items: [], collection: { state: 'partial', gapCount: 8, lanes: [
        { lane: 'group', state: 'partial', through: 1_800_000_000_000, scannedThrough: 1_800_090_000_000, gapCount: 8, nextRetryAt: null },
        { lane: 'p2p', state: 'collecting', through: 1_800_090_000_000, scannedThrough: 1_800_090_000_000, gapCount: 0, nextRetryAt: null },
      ] } }
    })
    await flush(); await panel.button('需要你处理')
    expect(panel.text()).toContain('群聊：存在未读缺口 · 已覆盖至')
    expect(panel.text()).toContain('已扫描至')
    expect(panel.text()).toContain('私聊：持续读取中 · 已覆盖至')
    expect(panel.text()).toContain('8 条消息，尚未纳入事项')
    expect(panel.text()).toContain('当前清单可能不完整')
    expect(panel.text()).not.toContain('飞书消息：持续更新中')
    panel.close()
  })
  it('distinguishes a stalled group window from private messages that still update', async () => {
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') return { items: [] }
      return { items: [], collection: { state: 'retrying', through: 1_800_000_000_000, lanes: [
        { lane: 'group', state: 'retrying', through: 1_800_000_000_000, nextRetryAt: 1_800_001_000_000 },
        { lane: 'p2p', state: 'collecting', through: 1_800_000_900_000, nextRetryAt: null },
      ] } }
    })
    await flush(); await panel.button('需要你处理')
    expect(panel.text()).toContain('群聊：读取重试中 · 已覆盖至')
    expect(panel.text()).toContain('私聊：持续读取中 · 已覆盖至')
    const group = panel.find(node => node.type === 'p' && node.children.some(value => typeof value === 'string' && value.startsWith('群聊：')))!
    const privateMessages = panel.find(node => node.type === 'p' && node.children.some(value => typeof value === 'string' && value.startsWith('私聊：')))!
    expect(group.children.join('')).toContain('下次尝试')
    expect(privateMessages.children.join('')).not.toContain('下次尝试')
    panel.close()
  })
  it('shows an application-permission gap without blocking preparation, then closes only the item the owner confirms', async () => {
    const prepared = deferred(), commands: any[] = []
    let accepted = false, done = false
    const item = () => ({ id: 7, title: '核对发布清单', version: done ? 'v2' : 'v1', status: done ? 'done' : 'open',
      context: '请在周五前核对发布清单', person: '同事', place: '产品群', at: 1_800_000_000_000,
      origin: { items: [{ label: '原消息', url: 'https://applink.feishu.cn/client/chat/open?openChatId=source' }] },
      native: { state: 'permission_required', label: '缺少飞书任务写入权限，修改还没同步', lastSuccessAt: null },
      preparation: done ? null : { id: 'offer-7', version: 'offer-v1', label: '帮我准备', ...(accepted ? { taskId: 44 } : {}) } })
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      const command = input.command; commands.push(command)
      if (command.operation === 'conversation') return { items: [] }
      if (command.operation === 'offer') return prepared.promise.then(() => { accepted = true; return { ok: true, taskId: 44 } })
      if (command.operation === 'item') { done = true; return { ok: true } }
      if (command.operation === 'list') return { items: command.view === 'closed' ? done ? [item()] : [] : done ? [] : [item()],
        collection: { state: 'current', through: 1_800_000_000_000 }, partial: true,
        nativeSync: { state: 'permission_required', coverage: 'friday_mirror_only', label: 'Friday 事项已保留，飞书任务同步缺少应用权限',
          lastSuccessAt: null, requiredScopes: ['task:task:write', 'task:task:writeonly'], nextRetryAt: 1_800_000_300_000,
          nextStep: '请应用管理员开通飞书任务应用权限；个人重新连接无法补齐。' } }
      throw new Error('Unexpected command: ' + command.operation)
    })
    await flush(); await panel.button('需要你处理')
    expect(panel.text()).toContain('飞书任务同步等待管理员补齐权限')
    expect(panel.text()).toContain('仅同步 Friday 管理的事项')
    expect(panel.text()).toContain('个人重新连接无法补齐')
    expect(panel.text()).toContain('task:task:writeonly')
    expect(panel.text()).toContain('已覆盖至')
    expect(panel.text()).toContain('仍有事项未加载')
    const origin = panel.find(node => node.type === 'a' && node.props.href?.includes('openChatId=source'))
    expect(origin).toBeDefined()
    await panel.button('帮我准备')
    const preparing = panel.find(node => node.type === 'button' && node.children.includes('帮我准备'))!
    expect(preparing.props.disabled).toBe(true)
    preparing.props.onClick(); await flush()
    expect(commands.filter(command => command.operation === 'offer')).toEqual([{ operation: 'offer', id: 'offer-7', version: 'offer-v1', decision: 'start' }])
    expect(commands.some(command => command.operation === 'item')).toBe(false)
    prepared.resolve({}); await flush()
    expect(panel.text()).toContain('查看准备进展')
    expect(panel.text()).toContain('核对发布清单')
    const checkbox = panel.find(node => node.type === 'input' && node.props['aria-label'] === '完成 核对发布清单')!
    expect(checkbox.props.checked).toBe(false)
    checkbox.props.onChange({ target: { checked: true } }); await flush()
    expect(commands.filter(command => command.operation === 'item')).toEqual([{ operation: 'item', id: 7, version: 'v1', action: 'done' }])
    expect(panel.text()).not.toContain('核对发布清单')
    await panel.button('已结束')
    expect(panel.find(node => node.type === 'input' && node.props['aria-label'] === '恢复 核对发布清单')?.props.checked).toBe(true)
    expect(panel.text()).not.toContain('帮我准备')
    expect(panel.text()).toContain('缺少飞书任务写入权限，修改还没同步')
    panel.close()
  })
})
describe('DSH Friday panel synchronization', () => {
  it('keeps a slow read alive across polling intervals and displays its result', async () => {
    vi.useFakeTimers()
    const read = deferred(), panel = mount(path => path === 'status' ? { state: 'connected' } : read.promise)
    await flush(); await vi.advanceTimersByTimeAsync(45_000)
    expect(panel.fetch.mock.calls.filter(([path]) => path.endsWith('/request'))).toHaveLength(1)
    read.resolve({ items: [{ id: 1, request: 'A slow conversation arrived', progress: { label: 'Completed' } }] })
    await flush()
    expect(panel.text()).toContain('A slow conversation arrived')
    expect(panel.text()).not.toContain('同步中…')
    panel.close()
  })

  it('shows a failed first read with retry, then clears the error on recovery', async () => {
    let fail = true
    const panel = mount(path => {
      if (path === 'status') return { state: 'connected' }
      if (fail) throw new Error('暂时连不上 Friday。')
      return { items: [] }
    })
    await flush()
    expect(panel.text()).toContain('暂未同步到最新内容。暂时连不上 Friday。')
    expect(panel.text()).not.toContain('正在同步对话…')
    fail = false; await panel.button('重试')
    expect(panel.text()).not.toContain('暂未同步到最新内容')
    expect(panel.text()).toContain('可以从这里继续和 Friday 交谈')
    panel.close()
  })

  it('retains previous content and exposes a background refresh failure', async () => {
    vi.useFakeTimers()
    let fail = false
    const panel = mount(path => {
      if (path === 'status') return { state: 'connected' }
      if (fail) throw new Error('暂时连不上 Friday。')
      return { items: [{ id: 1, request: 'Keep my conversation', progress: { label: 'Completed' } }] }
    })
    await flush(); fail = true; await vi.advanceTimersByTimeAsync(15_000)
    expect(panel.text()).toContain('Keep my conversation')
    expect(panel.text()).toContain('暂未同步到最新内容')
    panel.close()
  })

  it('queues only the latest selected view and rejects stale content', async () => {
    const first = deferred(), operations: string[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      operations.push(input.command.operation)
      return operations.length === 1 ? first.promise : { items: [] }
    })
    await flush(); await panel.button('Friday 的工作'); await panel.button('邮件草稿')
    expect(operations).toEqual(['conversation'])
    first.resolve({ items: [{ id: 1, request: 'Stale conversation', progress: { label: 'Completed' } }] })
    await flush()
    expect(operations).toEqual(['conversation', 'email-list'])
    expect(panel.text()).not.toContain('Stale conversation')
    expect(panel.text()).toContain('还没有可显示的邮件草稿')
    panel.close()
  })

  it('refreshes the current tab without clearing its loaded content', async () => {
    const next = deferred()
    let reads = 0
    const panel = mount(path => path === 'status' ? { state: 'connected' } : ++reads === 1
      ? { items: [{ id: 1, request: 'Still visible', progress: { label: 'Completed' } }] } : next.promise)
    await flush(); await panel.button('对话')
    expect(reads).toBe(2)
    expect(panel.text()).toContain('Still visible')
    next.resolve({ items: [] }); await flush()
    expect(panel.text()).toContain('可以从这里继续和 Friday 交谈')
    panel.close()
  })

  it('reads fresh state after a mutation instead of reusing a pre-mutation read', async () => {
    vi.useFakeTimers()
    const oldRead = deferred()
    let reads = 0, messages = 0
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') { messages++; return { taskId: 2 } }
      reads++
      return reads === 2 ? oldRead.promise : { items: reads === 3 ? [{ id: 2, request: 'Sent from DSH', progress: { label: 'Running' } }] : [] }
    })
    await flush(); await vi.advanceTimersByTimeAsync(15_000); await panel.message('Sent from DSH')
    expect(messages).toBe(1); expect(reads).toBe(2)
    oldRead.resolve({ items: [] }); await flush()
    expect(reads).toBe(3)
    expect(panel.text()).toContain('Sent from DSH')
    panel.close()
  })

  it('invalidates a navigation read started while a mutation was still pending', async () => {
    const mutation = deferred(), staleRead = deferred()
    let reads = 0
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') return mutation.promise
      reads++
      return reads === 2 ? staleRead.promise : { items: reads === 3 ? [{ id: 2, request: 'Confirmed after navigation', progress: { label: 'Running' } }] : [] }
    })
    await flush(); await panel.message('Confirmed after navigation'); await panel.button('对话')
    expect(reads).toBe(2)
    mutation.resolve({ taskId: 2 }); await flush()
    staleRead.resolve({ items: [] }); await flush()
    expect(reads).toBe(3)
    expect(panel.text()).toContain('Confirmed after navigation')
    panel.close()
  })

  it('loads the conversation immediately when pairing completes on the chat view', async () => {
    vi.useFakeTimers()
    let connected = false
    const panel = mount(path => {
      if (path === 'pair/status') { connected = true; return { state: 'connected' } }
      if (path === 'status') return { state: connected ? 'connected' : 'pairing', fingerprint: '1234', label: 'Test' }
      return { items: [] }
    })
    await flush(); await vi.advanceTimersByTimeAsync(2000)
    expect(panel.fetch.mock.calls.filter(([path]) => path.endsWith('/request'))).toHaveLength(1)
    expect(panel.text()).toContain('可以从这里继续和 Friday 交谈')
    panel.close()
  })
})

describe('DSH Friday chat interactions', () => {
  it('sends with Enter while preserving Shift+Enter and IME confirmation', async () => {
    const sending = deferred(), messages: any[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') { messages.push(input); return sending.promise }
      return { items: [] }
    })
    await flush(); await panel.type('输入法确认后的消息')
    const newline = await panel.key({ shiftKey: true })
    const composing = await panel.key({ nativeEvent: { isComposing: true } })
    const imeConfirmation = await panel.key({ keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })
    expect(messages).toHaveLength(0)
    expect(newline.preventDefault).not.toHaveBeenCalled()
    expect(composing.preventDefault).not.toHaveBeenCalled()
    expect(imeConfirmation.preventDefault).not.toHaveBeenCalled()
    expect(panel.input().props.value).toBe('输入法确认后的消息')
    const enter = await panel.key()
    expect(enter.preventDefault).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
    expect(messages[0].command).toEqual({ operation: 'message', text: '输入法确认后的消息' })
    sending.resolve({ taskId: 21 }); await flush(); panel.close()
  })

  it('shows the outgoing message before acknowledgement and preserves a newly typed draft', async () => {
    const sending = deferred(), messages: any[] = []
    let items: any[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') { messages.push(input); return sending.promise }
      return { items }
    })
    await flush(); await panel.message('立即显示的消息')
    expect(panel.text()).toContain('立即显示的消息')
    expect(panel.input().props.value).toBe('')
    expect(panel.input().props.disabled).not.toBe(true)
    await panel.type('继续编辑的下一条'); await panel.key()
    expect(messages).toHaveLength(1)
    expect(panel.input().props.value).toBe('继续编辑的下一条')
    items = [{ id: 31, at: Date.now(), request: '立即显示的消息', body: '已经收到。', progress: { label: 'Completed' } }]
    sending.resolve({ taskId: 31 }); await flush()
    expect(panel.text().split('立即显示的消息')).toHaveLength(2)
    expect(panel.text()).toContain('已经收到。')
    expect(panel.input().props.value).toBe('继续编辑的下一条')
    panel.close()
  })

  it('keeps a failed message across navigation and retries with the original request identity', async () => {
    const first = deferred(), retry = deferred(), messages: any[] = []
    let items: any[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') { messages.push(input); return messages.length === 1 ? first.promise : retry.promise }
      return { items }
    })
    await flush(); await panel.message('发送失败也别丢掉这条')
    await panel.type('未发送的新草稿')
    first.reject(new Error('暂时连不上 Friday。')); await flush()
    expect(panel.text()).toContain('发送失败也别丢掉这条')
    expect(panel.text()).toContain('重试发送')
    expect(panel.input().props.value).toBe('未发送的新草稿')
    await panel.button('Friday 的工作'); await panel.button('对话')
    expect(panel.text()).toContain('发送失败也别丢掉这条')
    await panel.button('重试发送')
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual(messages[0])
    items = [{ id: 41, at: Date.now(), request: '发送失败也别丢掉这条', progress: { label: 'Running' } }]
    retry.resolve({ taskId: 41 }); await flush()
    expect(panel.text().split('发送失败也别丢掉这条')).toHaveLength(2)
    expect(panel.text()).not.toContain('重试发送')
    expect(panel.input().props.value).toBe('未发送的新草稿')
    panel.close()
  })

  it('uses a fresh request identity when the user deliberately sends the same text again', async () => {
    const messages: any[] = [], items: any[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'message') {
        messages.push(input)
        const taskId = 50 + messages.length
        items.push({ id: taskId, at: Date.now(), request: input.command.text, progress: { label: 'Running' } })
        return { taskId }
      }
      return { items: [...items] }
    })
    await flush(); await panel.message('再试一次'); await panel.message('再试一次')
    expect(messages).toHaveLength(2)
    expect(messages[0].requestId).not.toBe(messages[1].requestId)
    expect(panel.text().split('再试一次')).toHaveLength(3)
    panel.close()
  })

  it.each(['acknowledgement', 'failure'])('discards a disconnected send’s late %s and lets a new connection send', async outcome => {
    const oldSend = deferred(), newSend = deferred(), messages: any[] = []
    let state = 'connected'
    const panel = mount((path, input) => {
      if (path === 'status') return { state }
      if (input.command.operation === 'message') { messages.push(input); return messages.length === 1 ? oldSend.promise : newSend.promise }
      return { items: [] }
    })
    await flush(); await panel.message('旧连接里尚未确认的消息')
    state = 'disconnected'; await panel.button('刷新')
    expect(panel.text()).not.toContain('旧连接里尚未确认的消息')
    state = 'connected'; await panel.button('刷新')
    await panel.message('新连接消息')
    expect(messages).toHaveLength(2)
    expect(panel.text()).toContain('新连接消息')
    if (outcome === 'acknowledgement') oldSend.resolve({ taskId: 61 })
    else oldSend.reject(new Error('旧连接请求已经超时'))
    await flush()
    expect(panel.text()).not.toContain('旧连接里尚未确认的消息')
    expect(panel.text()).not.toContain('旧连接请求已经超时')
    await panel.type('仍在编辑的第三条'); await panel.key()
    expect(messages).toHaveLength(2)
    expect(panel.input().props.value).toBe('仍在编辑的第三条')
    newSend.resolve({ taskId: 62 }); await flush()
    const sendButton = panel.find(node => node.type === 'button' && node.props.type === 'submit')
    expect(sendButton?.props.disabled).toBe(false)
    expect(panel.input().props.value).toBe('仍在编辑的第三条')
    panel.close()
  })

  it('places older conversations first even when the API returns newest first', async () => {
    const panel = mount(path => path === 'status' ? { state: 'connected' } : { items: [
      { id: 71, at: Date.parse('2026-10-12T10:05:00Z'), request: '较晚的问题', body: '较晚的回复', progress: { label: 'Completed' } },
      { id: 72, at: Date.parse('2026-10-12T10:00:00Z'), request: '较早的问题', body: '较早的回复', progress: { label: 'Completed' } },
    ] })
    await flush()
    const content = panel.text()
    expect(content.indexOf('较早的问题')).toBeLessThan(content.indexOf('较早的回复'))
    expect(content.indexOf('较早的回复')).toBeLessThan(content.indexOf('较晚的问题'))
    expect(content.indexOf('较晚的问题')).toBeLessThan(content.indexOf('较晚的回复'))
    panel.close()
  })

  it('places a delayed reply at its answer time after a later user message', async () => {
    const panel = mount(path => path === 'status' ? { state: 'connected' } : { items: [
      { id: 74, at: 2000, answerAt: 4000, request: '后发的问题', body: '第二条回答', progress: { label: 'Completed' } },
      { id: 73, at: 1000, answerAt: 3000, request: '先发的问题', body: '较迟回来的第一条回答', progress: { label: 'Completed' } },
    ] })
    await flush()
    const content = panel.text()
    expect(content.indexOf('先发的问题')).toBeLessThan(content.indexOf('后发的问题'))
    expect(content.indexOf('后发的问题')).toBeLessThan(content.indexOf('较迟回来的第一条回答'))
    expect(content.indexOf('较迟回来的第一条回答')).toBeLessThan(content.indexOf('第二条回答'))
    panel.close()
  })

  it('preserves the reading position on updates and follows new messages when already at the bottom', async () => {
    vi.useFakeTimers()
    let items = [{ id: 81, at: '2026-10-12T10:00:00Z', request: '已有对话', body: '先前回复', progress: { label: 'Completed' } }]
    const panel = mount(path => path === 'status' ? { state: 'connected' } : { items })
    await flush()
    const log = panel.node('friday-chat-log')
    await panel.scroll('friday-chat-log', 200)
    items = [...items, { id: 82, at: '2026-10-12T10:01:00Z', request: '新增对话', body: '新增回复', progress: { label: 'Completed' } }]
    log.scrollHeight = 1500
    await vi.advanceTimersByTimeAsync(15_000)
    expect(panel.text()).toContain('新增回复')
    expect(log.scrollTop).toBe(200)
    await panel.scroll('friday-chat-log', 1100)
    items = [...items, { id: 83, at: '2026-10-12T10:02:00Z', request: '最新对话', body: '最新回复', progress: { label: 'Completed' } }]
    log.scrollHeight = 1800
    await vi.advanceTimersByTimeAsync(15_000)
    expect(panel.text()).toContain('最新回复')
    expect(log.scrollTop).toBeGreaterThanOrEqual(1400)
    panel.close()
  })
})

describe('DSH Friday connected tool receipts', () => {
  it('shows status and the original-work guidance without rendering legacy receipt bodies', async () => {
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected', label: 'Test device' }
      if (input.command.operation === 'account-list') return { github: { status: 'disconnected' }, gmail: { status: 'disconnected' } }
      if (input.command.operation === 'mcp-list') return { connections: [], calls: [
        { id: 'old-call', name: 'Notes', tool: 'post', at: 1000, state: 'completed', result: 'LEGACY_BODY_WITHOUT_RETAINED_SOURCE_PERMISSIONS' },
      ] }
      return { items: [] }
    })
    await flush(); await panel.button('连接')
    expect(panel.text()).toContain('最近的工具使用')
    expect(panel.text()).toContain('Notes · post')
    expect(panel.text()).toContain('已返回结果')
    expect(panel.text()).toContain('结果请在发起这次调用的原工作中查看。')
    expect(panel.text()).not.toContain('LEGACY_BODY_WITHOUT_RETAINED_SOURCE_PERMISSIONS')
    expect(panel.text()).not.toContain('查看结果')
    panel.close()
  })
})

describe('DSH progressive history and reconnect', () => {
  const history = (version = 'v1') => ({ conversationId: 'a'.repeat(64), resultsValidated: false, items: [
    { id: 1, at: 1, request: 'Older request', resultPending: true, resultVersion: version, progress: { state: 'handled', label: '本次处理已结束' } },
    { id: 2, at: 2, request: 'Latest request', resultPending: true, resultVersion: version, progress: { state: 'handled', label: '本次处理已结束' } },
  ] })
  it('renders metadata and accepts a new message while both source checks are pending', async () => {
    const first = deferred(), second = deferred(), messages: any[] = []
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') { expect(input.command.includeResults).toBe(false); return history() }
      if (input.command.operation === 'result') { expect(input.command.conversationId).toBe('a'.repeat(64)); return input.command.taskId === 1 ? first.promise : second.promise }
      messages.push(input); return { taskId: 3 }
    })
    await flush()
    expect(panel.text()).toContain('Latest request')
    expect(panel.text()).toContain('正在核验并读取')
    await panel.message('Send without waiting')
    expect(messages).toHaveLength(1)
    second.resolve({ body: 'Latest verified reply', resultVersion: 'v1' }); await flush()
    expect(panel.text()).toContain('Latest verified reply')
    expect(panel.text()).toContain('本次回复已就绪')
    first.resolve({ body: 'Earlier verified reply', resultVersion: 'v1' }); await flush()
    panel.close()
  })

  it('never extends source authorization with a metadata heartbeat or a failed network read', async () => {
    vi.useFakeTimers()
    let fail = false
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') return history()
      if (fail) return new Promise(() => {})
      return { body: 'Verified private reply', resultVersion: 'v1' }
    })
    await flush(); expect(panel.text()).toContain('Verified private reply')
    fail = true
    await vi.advanceTimersByTimeAsync(31_000)
    expect(panel.text()).toContain('Latest request')
    expect(panel.text()).not.toContain('Verified private reply')
    panel.close()
  })

  it('discards replies started before an offline event without losing an in-flight send or its next draft', async () => {
    const reply = deferred(), sending = deferred(); let resultReads = 0
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') return history()
      if (input.command.operation === 'message') return sending.promise
      resultReads++; return reply.promise
    })
    await flush(); expect(resultReads).toBe(2)
    await panel.message('Still delivering'); await panel.type('Do not lose this draft')
    await panel.event('offline')
    reply.resolve({ body: 'LATE_PRIVATE_REPLY_WHILE_OFFLINE', resultVersion: 'v1' }); await flush()
    expect(panel.text()).not.toContain('LATE_PRIVATE_REPLY_WHILE_OFFLINE')
    expect(resultReads).toBe(2)
    expect(panel.text()).toContain('网络已断开')
    sending.resolve({ taskId: 3 }); await flush()
    expect(panel.input().props.value).toBe('Do not lose this draft')
    expect(panel.find(node => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(false)
    panel.close()
  })

  it('expires a legacy fallback answer when later reads fail instead of retaining it without a verification time', async () => {
    vi.useFakeTimers()
    let failed = false, legacyReads = 0
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (failed) throw new Error('Network unavailable')
      if (input.command.includeResults === false) throw new Error('这个操作暂不可用，请刷新。')
      legacyReads++
      return { items: [{ id: 1, at: 1, request: 'Legacy question', body: 'LEGACY_PRIVATE_REPLY', progress: { state: 'handled' } }] }
    })
    await flush(); expect(legacyReads).toBe(1)
    expect(panel.text()).toContain('LEGACY_PRIVATE_REPLY')
    failed = true
    await vi.advanceTimersByTimeAsync(29_000)
    expect(panel.text()).toContain('LEGACY_PRIVATE_REPLY')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(panel.text()).not.toContain('LEGACY_PRIVATE_REPLY')
    expect(panel.text()).toContain('Legacy question')
    expect(legacyReads).toBe(1)
    panel.close()
  })

  it('does not repeatedly hydrate an outdated result version without refreshing metadata', async () => {
    const blocked = deferred(); let metadataVersion = 'v1', announcedVersion = '', reads = 0, repeatedStaleRead = false
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'conversation') {
        announcedVersion = metadataVersion
        const value = history(metadataVersion); value.items = value.items.slice(-1); return value
      }
      reads++
      if (reads > 1 && announcedVersion !== 'v2') { repeatedStaleRead = true; return blocked.promise }
      metadataVersion = 'v2'
      return { body: 'Fresh version answer', resultVersion: 'v2' }
    })
    await flush()
    expect(repeatedStaleRead).toBe(false)
    expect(reads).toBeLessThanOrEqual(2)
    await panel.button('刷新'); await flush()
    expect(panel.text()).toContain('Fresh version answer')
    panel.close(); blocked.resolve({ body: 'Unused', resultVersion: 'v2' }); await flush()
  })

  it('retries failed first load automatically and refreshes immediately on reconnect', async () => {
    vi.useFakeTimers()
    let fail = true, reads = 0
    const panel = mount(path => {
      if (path === 'status') return { state: 'connected' }
      reads++; if (fail) throw new Error('网络未连接')
      return { items: [] }
    })
    await flush(); expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(3000); expect(reads).toBe(2)
    fail = false; await panel.event('online')
    expect(reads).toBe(3)
    expect(panel.text()).not.toContain('同步中断')
    expect(panel.text()).toContain('已同步')
    panel.close()
  })

  it('rejects a late reply after the primary conversation changes', async () => {
    const reply = deferred(); let changed = false
    const panel = mount((path, input) => {
      if (path === 'status') return { state: 'connected' }
      if (input.command.operation === 'result') return reply.promise
      return changed ? { conversationId: 'b'.repeat(64), items: [] } : history()
    })
    await flush(); changed = true; await panel.button('刷新')
    reply.resolve({ body: 'Old session secret', resultVersion: 'v1' }); await flush()
    expect(panel.text()).not.toContain('Old session secret')
    panel.close()
  })
})
