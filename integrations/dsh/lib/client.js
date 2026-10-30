// Browser credentials are DSH's existing session only. Device and provider tokens stay on the Host.
window.__ModuleLoader__.load({ id: 'dsh-friday', factory: require => {
  const React = require('react'), h = React.createElement
  const CSS = `.friday-panel{height:100%;overflow:auto;color:var(--dsw-alias-label-primary,#20232a);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.friday-inner{max-width:880px;margin:auto;padding:28px 32px 72px}.friday-header{display:flex;gap:16px;align-items:center;margin-bottom:24px}.friday-header h1{font-size:23px;letter-spacing:-.5px;margin:0;font-weight:650}.friday-header p{margin:2px 0 0;color:var(--dsw-alias-label-secondary,#70737c)}.friday-header .friday-actions{margin-left:auto}.friday-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.friday-panel button,.friday-panel input,.friday-panel textarea{font:inherit}.friday-panel button{border:1px solid var(--dsw-alias-border-l,#dfe1e6);background:transparent;color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer}.friday-panel button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}.friday-panel button:disabled{opacity:.5;cursor:default}.friday-panel button.primary{background:var(--dsw-alias-state-business-primary,#4c64dd);color:white;border-color:transparent}.friday-panel :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4c64dd);outline-offset:3px}.friday-panel a{color:var(--dsw-alias-state-business-primary,#465fc4);text-decoration:none}.friday-panel a:hover{text-decoration:underline}.friday-nav{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l,#e5e6ea);margin-bottom:22px}.friday-nav button{border:0;border-radius:0;padding:9px 0;color:var(--dsw-alias-label-secondary,#737580)}.friday-nav button[aria-current=page]{border-bottom:2px solid currentColor;color:var(--dsw-alias-label-primary,#20232a)}.friday-row{display:flex;align-items:flex-start;gap:13px;padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l,#e6e7eb)}.friday-row input[type=checkbox]{width:19px;height:19px;margin:3px 0;accent-color:var(--dsw-alias-state-business-primary,#4c64dd);flex:none}.friday-row-main{flex:1;min-width:0}.friday-title{font-size:15px;font-weight:600;margin:0 0 6px;overflow-wrap:anywhere}.friday-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#777b86);margin:5px 0}.friday-context{font-size:13px;color:var(--dsw-alias-label-secondary,#737784);margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.friday-links{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:8px}.friday-more{margin-top:10px}.friday-more summary{font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary,#777)}.friday-more .friday-actions{margin-top:9px}.friday-offer{padding:18px 20px;margin:20px 0;border:1px solid var(--dsw-alias-border-l,#dfe2e8);border-radius:12px}.friday-offer p{margin:8px 0 12px}.friday-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dsw-alias-label-secondary,#777)}.friday-empty{padding:40px 0;color:var(--dsw-alias-label-secondary,#727680)}.friday-error{padding:12px 16px;background:var(--dsw-alias-interactive-bg-hover-danger,#fff1ef);border-radius:8px;margin:12px 0;color:var(--dsw-alias-state-error-primary,#b24435)}.friday-form{max-width:520px;margin-top:22px}.friday-form label{display:block;margin:16px 0 6px}.friday-form input{display:block;width:100%;box-sizing:border-box;padding:10px 12px;background:transparent;border:1px solid var(--dsw-alias-border-l,#d8dae0);border-radius:8px;color:inherit}.friday-code{font:600 22px ui-monospace,monospace;letter-spacing:3px;margin:20px 0}.friday-section-title{font-size:14px;font-weight:600;margin:28px 0 6px}.friday-composer{padding:18px 0;margin-top:20px;border-top:1px solid var(--dsw-alias-border-l,#e5e6ea)}.friday-composer textarea{display:block;box-sizing:border-box;width:100%;resize:vertical;min-height:95px;padding:12px;border:1px solid var(--dsw-alias-border-l,#dfe1e6);background:transparent;color:inherit;border-radius:10px;margin:8px 0}.friday-composer .friday-actions{justify-content:flex-end}.friday-turn{padding:18px 0 26px;border-bottom:1px solid var(--dsw-alias-border-l,#e5e6ea)}.friday-question{font-size:15px;white-space:pre-wrap}.friday-nav{overflow-x:auto;white-space:nowrap}.friday-pages{display:flex;justify-content:space-between;align-items:center;margin-top:24px}@media(max-width:640px){.friday-inner{padding:20px 18px 48px}.friday-header{align-items:flex-start}.friday-header .friday-actions{gap:4px}.friday-header button{padding:6px 9px}.friday-title{font-size:14px}}`
  const CHAT_CSS = `
    .friday-panel.friday-im{overflow:hidden;min-height:0}
    .friday-im .friday-inner{height:100%;max-width:1100px;box-sizing:border-box;padding:24px 32px 0;display:flex;flex-direction:column;min-height:0}
    .friday-im .friday-header{flex:none;margin-bottom:16px}
    .friday-im .friday-nav{flex:none;margin-bottom:0;gap:20px}
    .friday-im .friday-error{flex:none;margin:8px 0;font-size:12px;padding:8px 12px}
    .friday-im .friday-error p{margin:0 0 6px}
    .friday-chat{position:relative;display:flex;flex:1;flex-direction:column;min-height:0}
    .friday-sync{flex:none;display:flex;align-items:center;gap:8px;padding:8px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#777b86)}
    .friday-sync::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
    .friday-chat-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px 4px 28px;scrollbar-gutter:stable}
    .friday-chat-note{text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#777b86);margin:0 0 24px}
    .friday-chat-day{text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary,#777b86);margin:20px 0}
    .friday-message{display:flex;gap:10px;align-items:flex-start;margin:18px 0}
    .friday-message-own{flex-direction:row-reverse}
    .friday-avatar{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;font-size:12px;font-weight:650;background:var(--dsw-alias-interactive-bg-hover,#f1f2f5);border:1px solid var(--dsw-alias-border-l,#e5e6ea)}
    .friday-message-content{max-width:min(85%,760px);min-width:0}
    .friday-message-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary,#777b86);margin:0 0 5px}
    .friday-message-own .friday-message-meta{justify-content:flex-end}
    .friday-bubble{padding:11px 15px;border-radius:2px 12px 12px 12px;border:1px solid var(--dsw-alias-border-l,#e5e6ea);overflow-wrap:anywhere;min-width:30px}
    .friday-message-own .friday-bubble{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover,#f1f2f5);border-radius:12px 2px 12px 12px;white-space:pre-wrap}
    .friday-bubble .friday-answer{margin:0!important;font-size:14px}
    .friday-bubble .friday-answer>:first-child{margin-top:0!important}.friday-bubble .friday-answer>:last-child{margin-bottom:0!important}
    .friday-bubble .friday-context{margin:0}.friday-bubble pre{max-width:100%;overflow:auto}
    .friday-message .friday-actions{margin-top:8px;font-size:12px}.friday-message .friday-actions:empty{display:none}
    .friday-message .friday-actions button{padding:3px 8px}
    .friday-delivery{margin-top:5px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary,#777b86)}
    .friday-delivery button{font-size:11px;padding:2px 6px;margin-left:8px}
    .friday-chat .friday-composer{flex:none;margin:0;padding:12px 0 16px;background:var(--dsw-alias-background-primary,transparent)}
    .friday-chat .friday-composer textarea{resize:none;min-height:78px;max-height:160px;margin:0 0 8px;padding:12px 14px}
    .friday-compose-footer{display:flex;gap:12px;justify-content:space-between;align-items:center}
    .friday-compose-footer .friday-muted{margin:0}
    .friday-chat-jump{position:absolute;bottom:150px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-background-primary,#fff)!important;box-shadow:0 2px 8px #00000010;font-size:12px!important}
    .friday-chat-empty{display:flex;min-height:170px;height:100%;box-sizing:border-box;align-items:center;justify-content:center;flex-direction:column;text-align:center;color:var(--dsw-alias-label-secondary,#777b86)}
    .friday-chat-empty h2{font-size:20px;color:var(--dsw-alias-label-primary,#20232a);font-weight:600;margin:0 0 10px}
    .friday-chat-empty p{margin:0;max-width:350px}.friday-chat-empty .friday-actions{margin-top:20px;justify-content:center}
    @media(max-width:640px){.friday-im .friday-inner{padding:16px 14px 0}.friday-im .friday-header{margin-bottom:10px}.friday-im .friday-nav{gap:16px}.friday-message-content{max-width:calc(100% - 40px)}.friday-compose-footer .friday-muted{font-size:11px}}
  `
  const date = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
  const link = (label, url, key) => { try { if (new URL(url).protocol === 'https:') return h('a', { key, href: url, target: '_blank', rel: 'noopener noreferrer' }, label) } catch {} return h('span', { key }, label) }
  const READ_OPERATIONS = new Set(['list', 'works', 'result', 'conversation', 'email-list', 'email-get', 'local-list', 'local-get', 'mcp-list', 'account-list'])
  const SYNC_INTERVAL_MS = 15_000, RESULT_RECHECK_MS = 15_000, RESULT_VISIBILITY_MS = 30_000
  const MAX_RESULT_READS = 2, AUTO_EXPAND_RESULTS = 3
  function commandForLocation({ section, page }) {
    switch (section) {
      case 'local': return { operation: 'local-list' }
      case 'mail': return { operation: 'email-list', page }
      case 'chat': return { operation: 'conversation', includeResults: false }
      case 'works': return { operation: 'works' }
      default: return { operation: 'list', view: ['active', 'later', 'closed'].includes(section) ? section : 'active', page }
    }
  }
  function Panel({ api, openSession, pickDirectory }) {
    const [status, setStatus] = React.useState(null), [data, setData] = React.useState(null), [error, setError] = React.useState('')
    const [loading, setLoading] = React.useState(false), [syncError, setSyncError] = React.useState('')
    const [lastSync, setLastSync] = React.useState(0), [offline, setOffline] = React.useState(false), [retryAt, setRetryAt] = React.useState(0)
    const [busy, setBusy] = React.useState(false), [section, setSection] = React.useState('chat'), [page, setPage] = React.useState(0)
    const [mailDraft, setMailDraft] = React.useState(null)
    const [connections, setConnections] = React.useState(null)
    const [localWork, setLocalWork] = React.useState(null), [localText, setLocalText] = React.useState(''), [localSource, setLocalSource] = React.useState(null)
    const [result, setResult] = React.useState(null), [draft, setDraft] = React.useState(''), [target, setTarget] = React.useState(null)
    const [url, setUrl] = React.useState(''), [label, setLabel] = React.useState('我的电脑')
    const [conversation, setConversation] = React.useState(null), [messageDraft, setMessageDraft] = React.useState(''), [outbox, setOutbox] = React.useState([]), [sending, setSending] = React.useState(false)
    const chatSending = React.useRef(false), chatEpoch = React.useRef(0)
    const pending = React.useRef(new Map()), refresh = React.useRef(null)
    const syncFailures = React.useRef(0), nextSync = React.useRef(0)
    const networkEpoch = React.useRef(0), networkOffline = React.useRef(false)
    const chatValue = React.useRef(null), resultReads = React.useRef(new Map()), expandedResults = React.useRef(new Set())
    const setChat = update => { const value = typeof update === 'function' ? update(chatValue.current) : update; chatValue.current = value; setConversation(value) }
    const resetChat = () => {
      chatEpoch.current++; expandedResults.current.clear(); setChat(null)
      setOutbox([]); setMessageDraft(''); chatSending.current = false; setSending(false)
    }
    const updateReply = (id, version, patch) => setChat(value => value && { ...value,
      items: value.items.map(item => item.id === id && item.resultVersion === version ? { ...item, ...patch } : item) })
    const localDetail = React.useRef(localWork); localDetail.current = localWork
    const alive = React.useRef(true), changing = React.useRef(false), generation = React.useRef(0), location = React.useRef({ section, page })
    location.current = { section, page }
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const call = async command => {
      const read = READ_OPERATIONS.has(command.operation), key = JSON.stringify(command)
      const requestId = read ? crypto.randomUUID() : pending.current.get(key) || crypto.randomUUID()
      if (!read) pending.current.set(key, requestId)
      const value = await api('request', { requestId, command })
      pending.current.delete(key); return value
    }
    const readReplies = () => {
      if (!alive.current || location.current.section !== 'chat' || networkOffline.current) return
      const items = chatValue.current?.items ?? [], epoch = chatEpoch.current, network = networkEpoch.current, conversationId = chatValue.current?.conversationId
      // Keep two relay slots free for new messages and the metadata heartbeat.
      for (const item of [...items].reverse()) {
        if (resultReads.current.size >= MAX_RESULT_READS) break
        if (!item.resultPending || !expandedResults.current.has(item.id) || resultReads.current.has(item.id)
          || (item.body && Date.now() - item.verifiedAt < RESULT_RECHECK_MS) || item.resultError) continue
        const version = item.resultVersion
        const operation = call({ operation: 'result', taskId: item.id, ...(conversationId ? { conversationId } : {}) })
        resultReads.current.set(item.id, operation)
        operation.then(reply => {
          if (!alive.current || epoch !== chatEpoch.current || network !== networkEpoch.current || chatValue.current?.conversationId !== conversationId) return
          if (version && reply.resultVersion !== version) {
            updateReply(item.id, version, { body: undefined, verifiedAt: 0, resultError: '回复已更新，正在同步最新状态。', resultLoading: false })
            return
          }
          updateReply(item.id, version, { body: reply.body.slice(0, 8000), truncated: Boolean(reply.nextOffset) || reply.body.length > 8000,
            verifiedAt: Date.now(), unavailable: false, resultError: '', resultLoading: false })
        }).catch(error => {
          if (!alive.current || epoch !== chatEpoch.current || network !== networkEpoch.current) return
          updateReply(item.id, version, { body: undefined, verifiedAt: 0, unavailable: true, resultError: error.message, resultLoading: false })
        }).finally(() => { if (resultReads.current.get(item.id) === operation) resultReads.current.delete(item.id); readReplies() })
      }
    }
    const expandReply = item => {
      expandedResults.current.add(item.id)
      setChat(value => value && { ...value, items: value.items.map(current => current.id === item.id ? { ...current, resultError: '', unavailable: false, resultLoading: true } : current) })
      readReplies()
    }
    const load = async () => {
      // A relay read can take longer than the refresh interval. Share that read
      // instead of invalidating its result every 15 seconds; navigation queues
      // a fresh read for the latest location after the old request settles.
      if (refresh.current) {
        const running = refresh.current
        if (running.stamp === generation.current && running.section === location.current.section && running.page === location.current.page) return running.promise
        await running.promise
        if (alive.current) return load()
        return
      }
      const stamp = ++generation.current, selected = { ...location.current }, network = networkEpoch.current
      const valid = () => alive.current && stamp === generation.current && network === networkEpoch.current && selected.section === location.current.section && selected.page === location.current.page
      const running = { ...selected, stamp, promise: null }; refresh.current = running
      setLoading(true)
      running.promise = (async () => {
        try {
          const current = await api('status'); if (!valid()) return
          setStatus(current)
          if (current.state === 'connected' && selected.section === 'connections') {
            const accounts = await call({ operation: 'account-list' })
            if (!valid()) return
            const mcp = await call({ operation: 'mcp-list' })
            if (valid()) setConnections({ ...accounts, ...mcp })
          } else if (current.state === 'connected') {
            let snapshot
            try { snapshot = await call(commandForLocation(selected)) }
            catch (error) {
              // Older gateways reject the optional metadata-only field. Keep
              // installed desktop clients usable during a rolling upgrade.
              if (selected.section !== 'chat' || error.message !== '这个操作暂不可用，请刷新。') throw error
              snapshot = await call({ operation: 'conversation' })
            }
            if (valid()) {
              setData(snapshot)
              if (selected.section === 'chat') {
                if (chatValue.current?.conversationId && snapshot.conversationId !== chatValue.current.conversationId) resetChat()
                const previous = new Map((chatValue.current?.items ?? []).map(item => [item.id, item]))
                snapshot.items?.filter(item => item.resultPending).slice(-AUTO_EXPAND_RESULTS).forEach(item => expandedResults.current.add(item.id))
                setChat({ ...snapshot, items: snapshot.items?.map(item => {
                  const prior = previous.get(item.id), keep = item.resultPending && prior?.resultVersion === item.resultVersion && Date.now() - prior.verifiedAt < RESULT_VISIBILITY_MS
                  return { ...item, ...(item.body ? { verifiedAt: Date.now() } : keep ? { body: prior.body, truncated: prior.truncated, verifiedAt: prior.verifiedAt } : {}), resultLoading: item.resultPending && expandedResults.current.has(item.id) }
                }) })
                readReplies()
                setOutbox(previous => previous.filter(message => !snapshot.items?.some(item => item.id === message.taskId)))
              }
            }
            const detail = localDetail.current
            if (valid() && selected.section === 'local' && detail && ['running', 'stopping'].includes(detail.state)) {
              const updated = await call({ operation: 'local-get', id: detail.id })
              if (valid() && localDetail.current?.id === detail.id) setLocalWork({ ...updated, metadata: detail.metadata })
            }
          } else { setConnections(null); setData(null); setResult(null); setMailDraft(null); setLocalWork(null); setLocalSource(null); setTarget(null); resetChat() }
          if (valid()) { setSyncError(''); setOffline(false); networkOffline.current = false; setLastSync(Date.now()); syncFailures.current = 0; nextSync.current = Date.now() + SYNC_INTERVAL_MS; setRetryAt(0); readReplies() }
        } catch (e) { if (valid()) {
          setSyncError(e.message); syncFailures.current++
          nextSync.current = Date.now() + Math.min(60_000, 3000 * 2 ** Math.min(syncFailures.current - 1, 5)); setRetryAt(nextSync.current)
        } }
        finally {
          if (refresh.current === running) refresh.current = null
          if (alive.current) setLoading(false)
        }
      })()
      return running.promise
    }
    React.useEffect(() => { setSyncError(''); load(); return () => { generation.current++ } }, [section, page])
    React.useEffect(() => { if (status?.state === 'connected') load() }, [status?.state])
    React.useEffect(() => {
      const resume = () => { if (document.visibilityState !== 'visible') return; setOffline(false); networkOffline.current = false; nextSync.current = 0; if (!changing.current) load() }
      const disconnected = () => { networkEpoch.current++; networkOffline.current = true; setOffline(true); setChat(value => value && { ...value, items: value.items.map(item => ({ ...item, body: undefined, verifiedAt: 0 })) }) }
      window.addEventListener?.('online', resume); window.addEventListener?.('offline', disconnected); window.addEventListener?.('focus', resume); document.addEventListener?.('visibilitychange', resume)
      const timer = setInterval(() => {
        const now = Date.now(), value = chatValue.current
        if (value?.items?.some(item => item.body && item.verifiedAt && now - item.verifiedAt >= RESULT_VISIBILITY_MS)) setChat(current => current && { ...current, items: current.items.map(item => item.verifiedAt && now - item.verifiedAt >= RESULT_VISIBILITY_MS ? { ...item, body: undefined, verifiedAt: 0 } : item) })
        if (!changing.current && document.visibilityState === 'visible' && now >= nextSync.current && !refresh.current) load()
      }, 1000)
      return () => { clearInterval(timer); window.removeEventListener?.('online', resume); window.removeEventListener?.('offline', disconnected); window.removeEventListener?.('focus', resume); document.removeEventListener?.('visibilitychange', resume) }
    }, [])
    React.useEffect(() => {
      if (status?.state !== 'pairing') return
      let disposed = false, loading = false
      const timer = setInterval(async () => { if (disposed || loading) return; loading = true
        try { const value = await api('pair/status', {}); if (!disposed && alive.current) { setStatus(value); if (value.state === 'connected') { setSection('chat'); setData(null); setError('') } else if (value.state === 'disconnected') setError('配对链接已过期。请在飞书重新打开「连接 DSH」，取得新的链接。') } }
        catch (e) { if (!disposed && alive.current) setError(e.message) } finally { loading = false }
      }, 2000)
      return () => { disposed = true; clearInterval(timer) }
    }, [status?.state])
    const act = async work => {
      if (changing.current) return
      changing.current = true; generation.current++; setBusy(true); setError('')
      try { await work(); generation.current++; await load() } catch (e) { if (alive.current) setError(e.message) }
      finally { changing.current = false; if (alive.current) setBusy(false) }
    }
    const button = (text, action, primary = false, props = {}) => h('button', { key: text, type: 'button', disabled: busy, className: primary ? 'primary' : '', onClick: () => act(action), ...props }, text)
    const sendMessage = async retry => {
      if (chatSending.current || status?.state !== 'connected') return
      const text = retry ? retry.text : messageDraft.trim()
      if (!text) return
      const message = retry || { requestId: crypto.randomUUID(), text, at: Date.now() }, epoch = chatEpoch.current
      chatSending.current = true; setSending(true); generation.current++
      setOutbox(previous => retry ? previous.map(item => item.requestId === message.requestId ? { ...item, state: 'sending', error: '' } : item) : [...previous, { ...message, state: 'sending' }])
      if (!retry) setMessageDraft('')
      try {
        // A timeout can follow successful delivery. Keep the same identity for
        // this bubble's retry; a deliberate new message gets a new identity.
        const receipt = await api('request', { requestId: message.requestId, command: { operation: 'message', text } })
        if (alive.current && epoch === chatEpoch.current) setOutbox(previous => previous.map(item => item.requestId === message.requestId ? { ...item, state: 'accepted', taskId: receipt.taskId } : item))
      } catch (e) {
        if (alive.current && epoch === chatEpoch.current) setOutbox(previous => previous.map(item => item.requestId === message.requestId ? { ...item, state: 'failed', error: e.message } : item))
      } finally {
        if (epoch === chatEpoch.current) {
          chatSending.current = false
          if (alive.current) { setSending(false); generation.current++; load() }
        }
      }
    }
    const itemAction = (item, action) => call({ operation: 'item', id: item.id, version: item.version, action })
    const rows = data?.items?.map(item => h('article', { className: 'friday-row', key: item.id },
      h('input', { type: 'checkbox', checked: ['done', 'cancelled'].includes(item.status), disabled: busy, 'aria-label': item.status === 'done' ? '恢复 ' + item.title : '完成 ' + item.title,
        onChange: e => { const checked = e.target.checked; act(() => itemAction(item, checked ? 'done' : 'undo')) } }),
      h('div', { className: 'friday-row-main' }, h('p', { className: 'friday-title' }, item.githubUrl ? link(item.title, item.githubUrl) : item.title),
        h('p', { className: 'friday-muted' }, [item.person, item.place, date(item.at), item.dueMs ? '截止 ' + date(item.dueMs) : ''].filter(Boolean).join(' · ')),
        item.context ? h('p', { className: 'friday-context' }, item.context) : null,
        item.progress ? h('p', { className: 'friday-muted' }, item.progress) : null,
        item.native && item.native.state !== 'not_applicable' && h('p', { className: 'friday-muted' }, '飞书任务 · ' + item.native.label,
          item.native.lastSuccessAt ? ' · 核验于 ' + date(item.native.lastSuccessAt) : ''),
        h('div', { className: 'friday-links' }, ...(item.origin?.items ?? []).map((source, i) => link(source.label, source.url, i))),
        item.preparation && h('div', { className: 'friday-actions' }, item.preparation.taskId
          ? button('查看准备进展', async () => { setSection('works'); setData(null) })
          : button('帮我准备', () => call({ operation: 'offer', id: item.preparation.id, version: item.preparation.version, decision: 'start' }), true)),
        h('details', { className: 'friday-more' }, h('summary', null, '更多'), h('div', { className: 'friday-actions' },
          ...(section === 'closed' ? [button('恢复事项', () => itemAction(item, 'undo'))] : [button('一小时后', () => itemAction(item, 'hour')), button('明天', () => itemAction(item, 'tomorrow')), button('忽略', () => itemAction(item, 'ignore'))]))))))
    const offer = data?.suggestion
    const offerView = offer && h('section', { className: 'friday-offer' }, h('div', { className: 'friday-label' }, offer.taskId ? 'Friday 正在处理' : '可以帮你推进'),
      h('p', { className: 'friday-title' }, offer.prUrl ? link(offer.title, offer.prUrl) : offer.title),
      h('p', { className: 'friday-context' }, offer.taskId ? ({ completed: '准备已完成。', running: '正在整理上下文与处理建议。', queued: '已接下这项工作，等待开始。', failed: '这次准备未完成。', cancelled: '已停止。' })[offer.state] || '状态正在更新。' : offer.description),
      !offer.taskId && h('div', { className: 'friday-actions' }, button(offer.label, () => call({ operation: 'offer', id: offer.id, version: offer.version, decision: 'start' }), true),
        button('暂不需要', () => call({ operation: 'offer', id: offer.id, version: offer.version, decision: 'dismiss' }))))
    const workAction = (item, action) => call({ operation: 'work', taskId: item.id, revision: item.work.revision, action })
    const viewLocal = async id => {
      const value = await call({ operation: 'local-get', id }), metadata = await api('local/metadata').catch(() => ({ available: false, model: '' }))
      setLocalWork({ ...value, metadata })
    }
    const continueLocal = item => { setLocalSource(item); setLocalText(''); setResult(null); setLocalWork(null); setData(null); setSection('local') }
    const composer = h('form', { className: 'friday-composer', onSubmit: e => { e.preventDefault(); act(async () => {
      const text = draft.trim(); if (!text) return
      await call({ operation: 'message', text, ...(target ? { taskId: target.id } : {}) })
      setDraft(''); setTarget(null); setResult(null); setData(null); setSection(target ? 'works' : 'chat')
    }) } }, target && h('div', { className: 'friday-context' }, '继续：' + target.title, h('button', { type: 'button', onClick: () => setTarget(null) }, '取消')),
      h('label', { htmlFor: 'friday-message', className: 'friday-muted' }, target ? '补充这项工作' : '和 Friday 说点什么'),
      h('textarea', { id: 'friday-message', value: draft, rows: 3, maxLength: 12000, disabled: busy, placeholder: '梳理一个 PR、起草回复，或接着飞书里的话说…', onChange: e => setDraft(e.target.value) }),
      h('div', { className: 'friday-actions' }, h('button', { type: 'submit', className: 'primary', disabled: busy || !draft.trim() }, busy ? '正在提交…' : '发送')))
    let content
    if (status?.state === 'connected' && section === 'chat') content = h(ChatView, { value: conversation, outbox, draft: messageDraft, setDraft: setMessageDraft, sending, send: sendMessage, syncError, busy, expandReply,
      syncLabel: offline ? '网络已断开 · 恢复联网后自动同步' : syncError ? '同步中断 · 将自动重试' : loading ? lastSync ? '正在更新消息与工作状态…' : '正在读取最近的消息…' : lastSync ? '已同步 · ' + new Date(lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '正在连接 Friday…',
      viewResult: item => act(async () => setResult(await call({ operation: 'result', taskId: item.id }))), stop: item => act(() => workAction(item, 'stop')) })
    else if (syncError && (!status || (status.state === 'connected' && !(section === 'connections' ? connections : data)))) content = null
    else if (!status) content = h('p', { className: 'friday-empty' }, '正在读取 Friday…')
    else if (status.state === 'connected' && section === 'connections') content = h(ConnectionsView, { value: connections, busy, act, call, device: status,
      disconnect: () => act(async () => { await call({ operation: 'disconnect' }); setData(null) }) })
    else if (status.state !== 'connected') content = h('section', { className: 'friday-form' },
      h('h2', { className: 'friday-section-title' }, status.state === 'connected' ? '已连接 ' + status.label : '连接你的 Friday'),
      status.state === 'connected' ? h(React.Fragment, null, h('p', { className: 'friday-context' }, '清单和工作与飞书私聊同步。'),
        button('断开这台设备', async () => { await call({ operation: 'disconnect' }); setData(null) }))
        : status.state === 'pairing' ? h(React.Fragment, null, h('p', null, '回到 Friday 飞书私聊，核对并确认这台设备。'),
          h('div', { className: 'friday-code' }, status.fingerprint), h('p', { className: 'friday-muted' }, status.label + ' · ' + date(status.expiresAt) + ' 前有效'),
          button('取消', async () => { await api('forget', {}); setStatus(await api('status')) }))
        : h('form', { onSubmit: e => { e.preventDefault(); act(async () => { if (status.state === 'expired') await api('forget', {}); setStatus(await api('pair', { url, label })) }) } },
          h('p', { className: 'friday-context' }, '在 Friday 飞书私聊发送「连接 DSH」，打开配对链接并粘贴到这里。'),
          h('label', { htmlFor: 'friday-pair-link' }, '配对链接'), h('input', { id: 'friday-pair-link', value: url, type: 'url', autoComplete: 'off', required: true, onChange: e => setUrl(e.target.value), placeholder: 'https://…/desktop/pair#…' }),
          h('label', { htmlFor: 'friday-device-name' }, '设备名称'), h('input', { id: 'friday-device-name', value: label, maxLength: 80, required: true, onChange: e => setLabel(e.target.value) }),
          h('div', { className: 'friday-actions', style: { marginTop: 18 } }, h('button', { type: 'submit', className: 'primary', disabled: busy || !url }, '连接'))))
    else if (section === 'local') content = h(React.Fragment, null,
      h('p', { className: 'friday-context' }, '用这台电脑上的仓库、工具和 DSH 模型处理工作，结果同步回 Friday。'),
      ...(data?.items ?? []).map(item => h('article', { key: item.id, className: 'friday-row' }, h('div', { className: 'friday-row-main' },
        h('p', { className: 'friday-title' }, item.title), h('p', { className: 'friday-muted' }, item.deviceName + ' · ' + item.label),
        h('div', { className: 'friday-actions' }, button(item.state === 'queued' ? '查看并开始' : '查看工作', () => viewLocal(item.id)),
          item.sessionId && openSession && button('打开 DSH 会话', () => openSession(item.sessionId)))))),
      h('form', { className: 'friday-composer', onSubmit: e => { e.preventDefault(); act(async () => {
        const created = await call({ operation: 'local-create', text: localText.trim(), ...(localSource ? { sourceTaskId: localSource.id } : {}) })
        setLocalText(''); setLocalSource(null); await viewLocal(created.id)
      }) } }, localSource && h('p', { className: 'friday-context' }, '带入背景：' + localSource.title, h('button', { type: 'button', onClick: () => setLocalSource(null) }, '移除')),
        h('label', { htmlFor: 'friday-local-text' }, '交给本机处理'),
        h('textarea', { id: 'friday-local-text', rows: 3, maxLength: 6000, value: localText, placeholder: '例如：结合刚才的评审要点，检查这个仓库的实现和测试。', onChange: e => setLocalText(e.target.value) }),
        h('div', { className: 'friday-actions' }, h('button', { type: 'submit', disabled: busy || !localText.trim(), className: 'primary' }, '选择目录与开始'))))
    else if (section === 'mail') content = h(React.Fragment, null,
      ...(data?.items ?? []).map(item => h('article', { className: 'friday-row', key: item.id }, h('div', { className: 'friday-row-main' },
        h('p', { className: 'friday-title' }, item.subject), h('p', { className: 'friday-muted' }, item.from + ' → ' + item.to.join(', ')),
        h('p', { className: 'friday-muted' }, item.busy ? '正在核对邮件…' : ({ draft: '草稿', sending: '正在核对发送结果', uncertain: '发送结果待核对', sent: '已发送' })[item.state]),
        item.error && h('p', { className: 'friday-error' }, item.error),
        button(item.state === 'draft' ? '查看与修改' : '查看邮件', async () => setMailDraft(await call({ operation: 'email-get', id: item.id }))),
        item.url && h('div', { className: 'friday-links' }, link(item.state === 'sent' ? '查看已发邮件' : '查看原邮件', item.url))))),
      !data?.items?.length && h('p', { className: 'friday-empty' }, data ? '还没有可显示的邮件草稿。可以在对话中让 Friday 起草邮件；Gmail 在飞书的「账号连接」中管理。' : '正在读取草稿…'),
      data?.unavailable > 0 && h('p', { className: 'friday-muted' }, '部分草稿的来源暂不可用，恢复连接后可继续查看。'),
      data?.pages > 1 && h('div', { className: 'friday-pages' },
        h('button', { type: 'button', disabled: busy || page === 0, onClick: () => { setData(null); setPage(page - 1) } }, '上一页'),
        h('span', null, `${data.page + 1} / ${data.pages}`),
        h('button', { type: 'button', disabled: busy || page + 1 >= data.pages, onClick: () => { setData(null); setPage(page + 1) } }, '下一页')))
    else if (section === 'works') content = h(React.Fragment, null,
      ...(data?.items ?? []).map(item => h('article', { className: 'friday-row', key: item.id }, h('div', { className: 'friday-row-main' },
        h('p', { className: 'friday-title' }, item.title), h('p', { className: 'friday-muted' }, item.progress.label + ' · ' + date(item.at)),
        h('p', { className: 'friday-context' }, item.progress.detail), h('div', { className: 'friday-actions' },
          item.resultAvailable && button('查看结果', async () => setResult(await call({ operation: 'result', taskId: item.id })), true),
          item.resultAvailable && button('在本机继续', () => continueLocal(item)),
          item.work?.canContinue && button('补充要求', async () => { setTarget(item); setResult(null) }),
          item.work?.canStop && button('停止本次执行', () => workAction(item, 'stop')),
          item.work?.canCancel && button('取消工作', () => workAction(item, 'cancel')),
          item.work?.canResume && button('继续剩余工作', () => workAction(item, 'resume')))))),
      !data?.items?.length && h('p', { className: 'friday-empty' }, data ? '你交给 Friday 的工作会出现在这里。' : '正在同步工作…'), target && composer)
    else if (section === 'waiting') content = h(React.Fragment, null,
      ...(data?.waiting ?? []).map((item, i) => h('article', { key: i, className: 'friday-row' }, h('div', { className: 'friday-row-main' }, h('p', { className: 'friday-title' }, link(item.title ?? item.url, item.url)), h('p', { className: 'friday-context' }, item.note ?? (item.draft ? '草稿 PR，准备好后再请求评审。' : '已提交，等待评审或后续反馈。'))))),
      ...(data?.mail ?? []).filter(item => item.state === 'waiting').map(item => h('article', { key: item.id, className: 'friday-row' }, h('div', { className: 'friday-row-main' }, link(item.title, item.url), h('p', { className: 'friday-context' }, item.reason)))),
      !data?.waiting?.length && !data?.mail?.some(item => item.state === 'waiting') ? h('p', { className: 'friday-empty' }, '目前没有已记录的等待事项。') : null)
    else content = h(React.Fragment, null,
      data && h('details', { className: 'friday-more' }, h('summary', null, '来源与同步范围'),
        h('p', { className: 'friday-muted' }, '飞书消息：' + ({ off: '尚未开启收集', paused: '收集已暂停', today: '正在读取近期消息', history: '正在补齐历史', current: '持续更新中', partial: '部分消息无法读取', needs_connection: '需要重新连接飞书', retrying: '部分读取需要重试' })[data.collection?.state || 'off']
          + (data.collection?.lanes?.length ? '' : data.collection?.through ? ' · 已覆盖至 ' + date(data.collection.through) : ' · 尚未完成一轮覆盖')),
        ...(data.collection?.lanes ?? []).filter(lane => ['group', 'p2p'].includes(lane.lane)).map(lane => h('p', { key: lane.lane, className: 'friday-muted' },
          (lane.lane === 'group' ? '群聊：' : '私聊：') + ({ collecting: '持续读取中', partial: '存在未读缺口', retrying: '读取重试中', needs_connection: '需要重新连接飞书', paused: '收集已暂停' })[lane.state]
          + (lane.through ? ' · 已覆盖至 ' + date(lane.through) : ' · 尚未完成一轮覆盖')
          + (lane.gapCount > 0 && lane.scannedThrough ? ' · 已扫描至 ' + date(lane.scannedThrough) : '')
          + (lane.nextRetryAt ? ' · 下次尝试 ' + date(lane.nextRetryAt) : ''))),
        data.collection?.gapCount > 0 && h('p', { className: 'friday-context' }, '飞书无法读取已解散群中的 ' + data.collection.gapCount + ' 条消息，尚未纳入事项。其他可读消息继续更新，当前清单可能不完整。'),
        data.partial && h('p', { className: 'friday-muted' }, '当前展示范围有限，仍有事项未加载。'),
        data.nativeSync && h(React.Fragment, null, h('p', { className: 'friday-muted' }, '飞书原生任务：仅同步 Friday 管理的事项 · ' + data.nativeSync.label
          + (data.nativeSync.lastSuccessAt ? ' · 最近核验 ' + date(data.nativeSync.lastSuccessAt) : '')),
          data.nativeSync.nextStep && h('p', { className: 'friday-context' }, data.nativeSync.nextStep),
          data.nativeSync.requiredScopes?.length > 0 && h('p', { className: 'friday-muted' }, '所需权限：' + data.nativeSync.requiredScopes.join(' / ')),
          data.nativeSync.nextRetryAt && h('p', { className: 'friday-muted' }, '下次尝试 ' + date(data.nativeSync.nextRetryAt)))),
      data?.nativeSync?.state === 'permission_required' && h('p', { className: 'friday-context', role: 'status' }, '飞书任务同步等待管理员补齐权限。事项已保留，可继续准备和处理；详情见「来源与同步范围」。'),
      section === 'active' ? offerView : null, rows?.length ? rows : h('p', { className: 'friday-empty' }, data ? '这个分类里暂时没有事项。' : '正在同步清单…'),
      section === 'active' && (data?.mail ?? []).filter(item => item.state === 'needs_reply').map(item => h('article', { key: item.id, className: 'friday-row' },
        h('div', { className: 'friday-row-main' }, h('p', { className: 'friday-title' }, link(item.title, item.url)), h('p', { className: 'friday-muted' }, [item.from, date(item.at)].filter(Boolean).join(' · ')), h('p', { className: 'friday-context' }, item.quote)))),
      data?.pages > 1 && h('div', { className: 'friday-pages' }, h('button', { type: 'button', disabled: busy || page === 0, onClick: () => { setData(null); setPage(Math.max(0, page - 1)) } }, '上一页'),
        h('span', { className: 'friday-muted' }, `${data.page + 1} / ${data.pages}`), h('button', { type: 'button', disabled: busy || page + 1 >= data.pages, onClick: () => { setData(null); setPage(page + 1) } }, '下一页')),
      data?.updatedAt && h('p', { className: 'friday-muted', style: { marginTop: 24 } }, '更新于 ' + date(data.updatedAt)))
    const chatting = status?.state === 'connected' && section === 'chat' && !result && !mailDraft && !localWork
    return h('div', { className: 'friday-panel' + (chatting ? ' friday-im' : '') }, h('style', null, CSS + CHAT_CSS), h('div', { className: 'friday-inner' },
      h('header', { className: 'friday-header' }, h('div', null, h('h1', null, 'Friday'), h('p', null, chatting ? '与你的飞书私聊相连' : '你的个人助手')), h('div', { className: 'friday-actions' }, h('button', { type: 'button', disabled: busy || loading, onClick: () => load() }, loading ? '同步中…' : '刷新'), h('button', { type: 'button', onClick: () => { setMailDraft(null); setLocalWork(null); setResult(null); setSection('connections') } }, '连接'))),
      status?.state === 'connected' && h('nav', { className: 'friday-nav', 'aria-label': '个人清单分类' }, ...[['chat', '对话'], ['active', '需要你处理'], ['waiting', '等别人'], ['works', 'Friday 的工作'], ['local', '本机工作'], ['mail', '邮件草稿'], ['later', '稍后'], ['closed', '已结束']].map(([key, title]) =>
        h('button', { key, type: 'button', 'aria-current': section === key ? 'page' : undefined, onClick: () => { setMailDraft(null); setLocalWork(null); setResult(null); setTarget(null); if (section === key && page === 0) { load(); return }; setData(null); setPage(0); setSection(key) } }, title))),
      error && h('div', { className: 'friday-error', role: 'alert' }, error),
      syncError && h('div', { className: 'friday-error', role: 'alert' }, h('p', null, '暂未同步到最新内容。' + syncError),
        retryAt > 0 && h('p', null, '将在 ' + new Date(retryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' 自动重试。'),
        h('button', { type: 'button', disabled: busy || loading, onClick: () => load() }, loading ? '正在重试…' : '重试')),
      localWork ? h(LocalWorkView, { key: localWork.id + ':' + localWork.revision, value: localWork, busy, pickDirectory, openSession,
        back: () => setLocalWork(null), refresh: () => act(() => viewLocal(localWork.id)),
        start: directory => act(async () => {
          try { await api('local/start', { id: localWork.id, fingerprint: localWork.fingerprint, directory, model: localWork.metadata.model }) }
          finally { await viewLocal(localWork.id) }
        }),
        stop: () => act(async () => { await call({ operation: 'local-stop', id: localWork.id, revision: localWork.revision }); await api('local/stop', { id: localWork.id }).catch(() => {}); await viewLocal(localWork.id) }) }) : mailDraft ? h(EmailDraftView, { key: mailDraft.id + ':' + mailDraft.revision, value: mailDraft, busy,
        back: () => setMailDraft(null), refresh: () => act(async () => setMailDraft(await call({ operation: 'email-get', id: mailDraft.id }))),
        save: content => act(async () => { await call({ operation: 'email-edit', id: mailDraft.id, revision: mailDraft.revision, ...content }); setMailDraft(await call({ operation: 'email-get', id: mailDraft.id })) }),
        action: action => act(async () => { await call({ operation: 'email-action', id: mailDraft.id, revision: mailDraft.revision, action }); setMailDraft(null) }) }) : result ? h('section', { className: 'friday-result' }, h('div', { className: 'friday-actions' }, h('button', { type: 'button', onClick: () => setResult(null) }, '返回')),
        h(Answer, { text: result.body }), result.nextOffset && button('继续展开', async () => {
          const next = await call({ operation: 'result', taskId: result.taskId, offset: result.nextOffset })
          setResult({ ...next, body: result.body + next.body })
        })) : content))
  }
  function ChatView({ value, outbox, draft, setDraft, sending, send, syncError, busy, viewResult, stop, expandReply, syncLabel }) {
    const log = React.useRef(null), following = React.useRef(true), composing = React.useRef(false), lastSent = React.useRef(outbox.length)
    const [unread, setUnread] = React.useState(false)
    const items = [...(value?.items ?? [])].sort((a, b) => (a.at || 0) - (b.at || 0) || a.id - b.id)
    const pending = outbox.filter(message => !items.some(item => item.id === message.taskId))
    const events = items.flatMap(item => [
      { key: 'request:' + item.id, own: true, at: item.at, text: item.request, origin: item.origin, accepted: true },
      { key: 'answer:' + item.id, own: false, at: item.answerAt || item.at, item },
    ]).concat(pending.map(message => ({ key: message.requestId, own: true, at: message.at, text: message.text, message })))
      .sort((a, b) => (a.at || 0) - (b.at || 0))
    const signature = JSON.stringify(events.map(event => [event.key, event.text, event.item?.body, event.item?.progress, event.item?.unavailable, event.message?.state]))
    React.useEffect(() => {
      const ownSend = outbox.length > lastSent.current
      lastSent.current = outbox.length
      if (following.current || ownSend) {
        if (log.current) log.current.scrollTop = log.current.scrollHeight
        following.current = true; setUnread(false)
      } else setUnread(true)
    }, [signature])
    const submit = e => { e.preventDefault(); if (!sending && draft.trim()) send() }
    const time = at => at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
    const day = at => at ? new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : ''
    let previousDay = ''
    return h('section', { className: 'friday-chat', 'aria-label': '与 Friday 对话' },
      h('div', { className: 'friday-sync', role: 'status' }, syncLabel),
      h('div', { id: 'friday-chat-log', className: 'friday-chat-log', ref: log, role: 'log', 'aria-label': '对话消息', 'aria-live': 'polite', 'aria-relevant': 'additions text', onScroll: e => {
        const node = e.currentTarget
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        if (following.current) setUnread(false)
      } },
        events.length > 0 && h('p', { className: 'friday-chat-note' }, '最近的对话 · 与飞书私聊共用上下文'),
        ...events.map(event => {
          const currentDay = day(event.at), separator = currentDay && currentDay !== previousDay ? h('div', { className: 'friday-chat-day' }, currentDay) : null
          previousDay = currentDay
          const item = event.item, progress = item?.progress
          return h(React.Fragment, { key: event.key }, separator,
            h('article', { className: 'friday-message' + (event.own ? ' friday-message-own' : ''), 'aria-label': event.own ? '你发送的消息' : 'Friday 的回复' },
              h('div', { className: 'friday-avatar', 'aria-hidden': true }, event.own ? '你' : 'F'),
              h('div', { className: 'friday-message-content' },
                h('div', { className: 'friday-message-meta' }, h('span', null, event.own ? '你' : 'Friday'), event.origin === 'feishu' && h('span', null, '来自飞书'), h('time', null, time(event.at))),
                h('div', { className: 'friday-bubble' }, event.own ? event.text : item.body ? h(Answer, { text: item.body }) : h('p', { className: 'friday-context' }, item.unavailable ? '回复暂未读到，重试时会重新核验来源权限。' : item.resultPending ? item.resultLoading ? '回复已生成，正在核验并读取…' : '回复已保存，点击查看。' : progress?.detail || progress?.label || '正在等待回复…')),
                !event.own && h('div', { className: 'friday-actions' },
                  item.resultPending && !item.body && h('button', { type: 'button', disabled: busy || item.resultLoading && !item.resultError, title: item.resultError || '', onClick: () => expandReply(item) }, item.resultError ? '重试读取' : item.resultLoading ? '读取中…' : '查看回复'),
                  item.truncated && h('button', { type: 'button', disabled: busy, onClick: () => viewResult(item) }, '查看完整结果'), item.work?.canStop && h('button', { type: 'button', disabled: busy, onClick: () => stop(item) }, '停止本次执行')),
                !event.own && item.body && progress && h('p', { className: 'friday-muted' }, progress.state === 'handled' ? '本次回复已就绪' : progress.label),
                event.accepted && h('div', { className: 'friday-delivery' }, '已送达'),
                event.message && h('div', { className: 'friday-delivery', role: 'status' },
                  event.message.state === 'sending' ? '发送中…' : event.message.state === 'failed' ? '暂未确认送达' : '已送达 · 等待 Friday 回复',
                  event.message.state === 'failed' && h('button', { type: 'button', disabled: sending, title: event.message.error, onClick: () => send(event.message) }, '重试发送')))))
        }),
        !events.length && h('div', { className: 'friday-chat-empty' }, h('h2', null, '和 Friday 聊聊'),
          h('p', null, value ? '可以从这里继续和 Friday 交谈。飞书私聊使用同一段上下文。' : syncError ? '暂时没有读到历史消息，你仍然可以发送新的消息。' : '正在同步对话…'),
          h('div', { className: 'friday-actions' }, ...['今天有哪些需要我处理的事？', '帮我梳理一个 PR'].map(text => h('button', { type: 'button', key: text, onClick: () => setDraft(text) }, text))))),
      unread && h('button', { type: 'button', className: 'friday-chat-jump', onClick: () => { if (log.current) log.current.scrollTop = log.current.scrollHeight; following.current = true; setUnread(false) } }, '有新消息 · 回到最新'),
      h('form', { className: 'friday-composer', onSubmit: submit },
        h('textarea', { id: 'friday-message', 'aria-label': '发送给 Friday', value: draft, rows: 3, maxLength: 12000, placeholder: '发消息给 Friday…', onChange: e => setDraft(e.target.value),
          onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false }, onKeyDown: e => {
            if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.isComposing && !e.nativeEvent?.isComposing && e.keyCode !== 229 && e.nativeEvent?.keyCode !== 229) submit(e)
          } }),
        h('div', { className: 'friday-compose-footer' }, h('span', { className: 'friday-muted' }, 'Enter 发送 · Shift + Enter 换行'), h('button', { type: 'submit', className: 'primary', disabled: sending || !draft.trim() }, sending ? '发送中…' : '发送'))))
  }
  function ConnectionsView({ value, device, busy, act, call, disconnect }) {
    const [adding, setAdding] = React.useState(false), [name, setName] = React.useState(''), [endpoint, setEndpoint] = React.useState(''), [token, setToken] = React.useState(''), [authorization, setAuthorization] = React.useState(null)
    const button = (label, action, primary = false) => h('button', { type: 'button', disabled: busy, className: primary ? 'primary' : '', onClick: () => act(action) }, label)
    React.useEffect(() => { setAuthorization(null) }, [value?.github?.revision, value?.gmail?.revision])
    const connect = (provider, method = 'oauth') => async () => { const receipt = await call({ operation: 'account-connect', provider, method }); setAuthorization({ ...receipt, provider }) }
    if (!value) return h('p', { className: 'friday-empty' }, '正在读取账号连接…')
    return h('section', null, h('h2', { className: 'friday-section-title' }, '账号与工具'),
      h('p', { className: 'friday-context' }, '连接 GitHub 和 Gmail，让 Friday 结合工作进展与邮件帮你处理事情。飞书和 DSH 使用同一份连接。'),
      ...[['github', 'GitHub', '查看你的 PR、评审请求和 Issue'], ['gmail', 'Gmail', '整理待回复邮件，准备和修改草稿']].map(([provider, title, description]) => {
        const account = value[provider], connected = account.status === 'connected'
        return h('article', { key: provider, className: 'friday-row' }, h('div', { className: 'friday-row-main' },
          h('p', { className: 'friday-title' }, title), h('p', { className: 'friday-context' }, description),
          h('p', { className: 'friday-muted' }, connected ? '已连接 · ' + (account.login || account.email || '') : account.status === 'needs_connection' ? '连接已失效，请重新连接' : account.available ? '尚未连接' : '服务端正在准备此连接'),
          h('div', { className: 'friday-actions' }, account.available && button(connected ? '更换账号' : '连接 ' + title, connect(provider), !connected),
            provider === 'github' && account.tokenAvailable && button('使用个人令牌', connect(provider, 'token')),
            provider === 'gmail' && connected && !account.canSend && button('允许发送邮件', connect(provider, 'send')),
            connected && button('断开连接', () => call({ operation: 'account-disconnect', provider, revision: account.revision }))),
          authorization?.provider === provider && h('p', { className: 'friday-context' }, link('继续授权 ' + title + ' ↗', authorization.url), ' · ', date(authorization.expires) + ' 前有效'),
          provider === 'gmail' && connected && h('p', { className: 'friday-muted' }, account.canSend ? '发送前会展示收件人和完整正文，由你确认。' : '当前可读取与起草，尚未开启发送。')))
      }),
      h('h2', { className: 'friday-section-title' }, '其他工具'),
      h('p', { className: 'friday-context' }, '通过 MCP 连接其他服务。工具参数会交给所连接的服务处理；需要确认时，Friday 会在你的飞书私聊显示具体操作。'),
      ...(value.connections ?? []).filter(c => c.connected).map(c => h(McpConnection, { key: c.id + ':' + c.revision, value: c, busy, act, call })),
      adding ? h('form', { className: 'friday-form', onSubmit: e => { e.preventDefault(); act(async () => {
        await call({ operation: 'mcp-connect', name: name.trim(), url: endpoint.trim(), ...(token ? { token } : {}) }); setToken(''); setName(''); setEndpoint(''); setAdding(false)
      }) } }, h('label', { htmlFor: 'friday-mcp-name' }, '服务名称'), h('input', { id: 'friday-mcp-name', value: name, required: true, maxLength: 80, onChange: e => setName(e.target.value), placeholder: '例如：团队知识库' }),
        h('label', { htmlFor: 'friday-mcp-endpoint' }, 'MCP 地址'), h('input', { id: 'friday-mcp-endpoint', type: 'url', value: endpoint, required: true, maxLength: 1500, onChange: e => setEndpoint(e.target.value), placeholder: 'https://…/mcp' }),
        h('label', { htmlFor: 'friday-mcp-token' }, '访问令牌（如服务需要）'), h('input', { id: 'friday-mcp-token', type: 'password', autoComplete: 'new-password', value: token, maxLength: 8000, onChange: e => setToken(e.target.value) }),
        h('p', { className: 'friday-muted' }, '支持公网 HTTPS 的 Streamable HTTP 地址和 Bearer 令牌。凭据加密保存，模型不会收到令牌。'),
        h('div', { className: 'friday-actions' }, h('button', { type: 'submit', className: 'primary', disabled: busy || !name.trim() || !endpoint.trim() }, busy ? '正在检查连接…' : '连接'),
          h('button', { type: 'button', disabled: busy, onClick: () => { setToken(''); setAdding(false) } }, '取消')))
        : h('div', { className: 'friday-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => setAdding(true) }, '添加 MCP')),
      value.calls?.length > 0 && h('details', { className: 'friday-more' }, h('summary', null, '最近的工具使用'),
        h('p', { className: 'friday-muted' }, '结果请在发起这次调用的原工作中查看。'),
        ...value.calls.map(c => h('article', { key: c.id, className: 'friday-row' }, h('div', { className: 'friday-row-main' },
          h('p', { className: 'friday-title' }, c.name + ' · ' + c.tool), h('p', { className: 'friday-muted' }, date(c.at) + ' · ' + ({ checking: '正在核对工具', awaiting_confirmation: '等待你在飞书确认', completed: '已返回结果', failed: '调用未完成', declined: '已拒绝，未执行', cancelled: '已取消，未执行', uncertain: '回执未确认，请到原服务核实', running: '处理中' }[c.state] || c.state)))))),
      h('h2', { className: 'friday-section-title' }, '此设备'), h('p', { className: 'friday-context' }, device.label + ' · 清单和工作与飞书私聊同步'),
      h('div', { className: 'friday-actions' }, h('button', { type: 'button', disabled: busy, onClick: disconnect }, '断开这台设备')))
  }
  function McpConnection({ value, busy, act, call }) {
    const [automatic, setAutomatic] = React.useState(value.automatic)
    const hasReadOnly = value.tools.some(tool => tool.readOnly)
    return h('article', { className: 'friday-row' }, h('div', { className: 'friday-row-main' }, h('p', { className: 'friday-title' }, value.name),
      h('p', { className: 'friday-context', style: { overflowWrap: 'anywhere' } }, value.url),
      h('p', { className: 'friday-muted' }, value.tools.length + ' 个工具 · ' + value.automatic.length + ' 个允许自动读取'),
      h('details', { className: 'friday-more' }, h('summary', null, '工具与权限'),
        h('p', { className: 'friday-context' }, hasReadOnly ? '选中的只读工具可用于你的任务；其他工具每次使用前都会确认。' : '这个服务没有声明哪些工具只读。使用前会显示具体参数，由你确认。'),
        ...value.tools.map(tool => h('label', { key: tool.name, className: 'friday-row' },
          tool.readOnly && h('input', { type: 'checkbox', disabled: busy, checked: automatic.includes(tool.name), onChange: e => setAutomatic(e.target.checked ? [...automatic, tool.name] : automatic.filter(name => name !== tool.name)) }),
          h('div', { className: 'friday-row-main' }, h('p', { className: 'friday-title' }, tool.title || tool.name), h('p', { className: 'friday-muted' }, tool.readOnly ? '服务声明为只读' : '每次确认'), h('p', { className: 'friday-context' }, tool.description || tool.name)))),
        hasReadOnly && h('div', { className: 'friday-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => act(() => call({ operation: 'mcp-configure', id: value.id, revision: value.revision, automatic })) }, '保存工具权限'))),
      h('div', { className: 'friday-actions', style: { marginTop: 12 } }, h('button', { type: 'button', disabled: busy, onClick: () => act(() => call({ operation: 'mcp-disconnect', id: value.id, revision: value.revision })) }, '断开连接'))))
  }
  function LocalWorkView({ value, busy, pickDirectory, openSession, back, refresh, start, stop }) {
    const [directory, setDirectory] = React.useState(value.directory || ''), [pickError, setPickError] = React.useState('')
    const button = (text, click) => h('button', { type: 'button', disabled: busy, onClick: click }, text)
    return h('section', null, h('div', { className: 'friday-actions' }, button('返回', back), button('刷新进展', refresh)),
      h('h2', { className: 'friday-section-title' }, value.title), h('p', { className: 'friday-muted' }, value.deviceName + ' · ' + value.label),
      value.material && h('details', { className: 'friday-more' }, h('summary', null, '带入的工作背景'), h(Answer, { text: value.material })),
      value.state === 'queued' ? h('form', { className: 'friday-form', onSubmit: e => { e.preventDefault(); start(directory.trim()) } },
        h('label', { htmlFor: 'friday-local-directory' }, '工作目录'), h('input', { id: 'friday-local-directory', value: directory, required: true, placeholder: '/Users/…/project', onChange: e => setDirectory(e.target.value) }),
        pickDirectory && button('选择目录', async () => { try { const path = await pickDirectory(); if (path) setDirectory(path); setPickError('') } catch { setPickError('未能打开目录选择器，可以直接填写路径。') } }),
        pickError && h('p', { className: 'friday-error' }, pickError),
        h('p', { className: 'friday-context' }, '使用 DSH 模型：' + (value.metadata.model || '尚未选择')),
        h('p', { className: 'friday-context' }, '开始后，上面的工作背景会进入本机模型会话。沿用 DSH 的工具权限，本次最多执行 10 分钟、20 步。'),
        h('div', { className: 'friday-actions' }, h('button', { type: 'submit', className: 'primary', disabled: busy || !directory.trim() || !value.metadata.available }, '在这台电脑开始'), button('取消工作', stop)))
        : h(React.Fragment, null, value.directory && h('p', { className: 'friday-muted' }, value.directory + ' · ' + value.model),
          h('div', { className: 'friday-actions' }, value.sessionId && openSession && button('打开 DSH 会话', () => openSession(value.sessionId)), value.canStop && button('停止', stop))),
      value.result && h(Answer, { text: value.result }))
  }
  function EmailDraftView({ value, busy, back, refresh, save, action }) {
    const [mode, setMode] = React.useState('view'), [to, setTo] = React.useState(value.to.join(', ')), [subject, setSubject] = React.useState(value.subject), [body, setBody] = React.useState(value.body)
    const button = (title, click, primary = false) => h('button', { type: 'button', disabled: busy || value.busy, className: primary ? 'primary' : '', onClick: click }, title)
    const actions = h('div', { className: 'friday-actions' }, button('返回', back), button('刷新草稿', refresh))
    if (mode === 'edit') return h('section', null, actions, h('form', { className: 'friday-form', onSubmit: e => { e.preventDefault(); save({ to: to.split(/[,;，；]/).map(v => v.trim()).filter(Boolean), subject, body }) } },
      h('label', { htmlFor: 'friday-email-to' }, '收件人'), h('input', { id: 'friday-email-to', value: to, required: true, maxLength: 1000, onChange: e => setTo(e.target.value) }),
      h('label', { htmlFor: 'friday-email-subject' }, '主题'), h('input', { id: 'friday-email-subject', value: subject, required: true, maxLength: 200, disabled: value.reply, onChange: e => setSubject(e.target.value) }),
      h('div', { className: 'friday-composer' }, h('label', { htmlFor: 'friday-email-body' }, '正文'), h('textarea', { id: 'friday-email-body', value: body, required: true, rows: 14, maxLength: 6000, onChange: e => setBody(e.target.value) })),
      h('div', { className: 'friday-actions' }, h('button', { type: 'submit', className: 'primary', disabled: busy }, '保存修改'), button('取消修改', () => setMode('view')))))
    return h('section', null, actions,
      h('h2', { className: 'friday-section-title' }, value.subject), h('p', { className: 'friday-muted' }, '发件人：' + value.from), h('p', { className: 'friday-muted' }, '收件人：' + value.to.join(', ')),
      h('div', { className: 'friday-context', style: { padding: '18px 0', fontSize: 14, color: 'var(--dsw-alias-label-primary,#20232a)' } }, value.body),
      value.error && h('p', { className: 'friday-error', role: 'alert' }, value.error),
      value.state === 'draft' ? h(React.Fragment, null,
        mode === 'confirm' ? h('div', { className: 'friday-offer', role: 'group', 'aria-label': '确认发送邮件' },
          h('p', null, '将从 ' + value.from + ' 向 ' + value.to.join(', ') + ' 发送上面的内容。'),
          h('div', { className: 'friday-actions' }, button('确认发送', () => action('send'), true), button('返回修改', () => setMode('edit')), button('取消发送', () => setMode('view'))))
          : h('div', { className: 'friday-actions' }, button('发送邮件', () => setMode('confirm'), true), button('修改', () => setMode('edit'))),
        h('details', { className: 'friday-more' }, h('summary', null, '更多'), button('丢弃草稿', () => action('cancel'))))
        : value.state === 'sent' ? h('p', null, '已发送') : h(React.Fragment, null, h('p', null, '发送结果暂未确认，核对回执后再继续。'), button('核对发送结果', () => action('reconcile'), true)),
      value.url && h('div', { className: 'friday-links' }, link(value.state === 'sent' ? '查看已发邮件' : '查看原邮件', value.url)))
  }
  function Answer({ text }) {
    const inline = value => value.split(/(\[[^\]\n]+\]\(https:\/\/[^\s)]+\)|\*\*[^*]+\*\*)/g).map((part, index) => {
      const match = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(part)
      return match ? link(match[1], match[2], index) : /^\*\*.*\*\*$/.test(part) ? h('strong', { key: index }, part.slice(2, -2)) : part
    })
    return h('div', { className: 'friday-answer', style: { marginTop: 24, overflowWrap: 'anywhere' } }, ...text.split(/(```[\s\S]*?```)/g).flatMap((block, index) => {
      if (block.startsWith('```')) return [h('pre', { key: index, style: { overflowX: 'auto', padding: 14, background: 'var(--dsw-alias-interactive-bg-hover,#f3f4f6)', borderRadius: 8 } }, h('code', null, block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')))]
      return block.split(/\n\n+/).filter(Boolean).map((paragraph, line) => {
        const title = /^(#{1,4})\s+(.+)$/.exec(paragraph)
        return title ? h('h' + Math.min(4, title[1].length + 1), { key: index + ':' + line }, inline(title[2])) : h('p', { key: index + ':' + line, style: { whiteSpace: 'pre-wrap' } }, inline(paragraph))
      })
    }))
  }
  function Icon() { return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true }, h('path', { d: 'M5 16V4h11M5 10h8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })) }
  return { inject: ['slots', 'connection'], apply(ctx) {
    const api = async (path, value = {}) => {
      try {
        const response = await fetch('api/friday/' + path, path === 'status' ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Friday 连接暂时不可用，请刷新后重试。')
        return data
      } catch (error) { throw new Error(/^[\u3000-\u9fff]/.test(error.message) ? error.message : 'Friday 连接暂时不可用，请刷新后重试。') }
    }
    ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'friday', order: 15, label: 'Friday' }, Icon)), 'Friday: sidebar')
    const openSession = async id => { const workspace = ctx.get('uiWorkspace'); if (!workspace) throw new Error('DSH 会话入口暂不可用。'); await workspace.openSession(id) }
    const pickDirectory = async () => globalThis.__DSH_DIRECTORY_PICKER__ ? globalThis.__DSH_DIRECTORY_PICKER__.pick() : ctx.get('uiWorkspace')?.pickDirectory()
    ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'friday' }, () => h(Panel, { api, openSession, pickDirectory }))), 'Friday: personal panel')
  } }
} })
