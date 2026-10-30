/** 只渲染已授权 ProjectView。无远端请求、写操作或凭据；筛选全部在当前页面完成。 */
import type { ProjectItem, ProjectPageCoverage, ProjectRepoStatus, ProjectView } from '../github/project-view.js'

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function date(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '尚未同步'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '时间未知'
}

function elapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60_000) return '不到 1 分钟'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor(ms % 86_400_000 / 3_600_000)
  if (days) return `${days} 天${hours ? ` ${hours} 小时` : ''}`
  if (hours) return `${hours} 小时`
  return `${Math.floor(ms / 60_000)} 分钟`
}

function githubUrl(item: ProjectItem, allowedHosts: readonly string[]): string | undefined {
  try {
    const url = new URL(item.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.includes(url.hostname.toLowerCase())) return undefined
    if (url.pathname.toLowerCase() !== `/${item.repo.toLowerCase()}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`) return undefined
    // 只跳到正式事项，不携带任意查询参数/片段里的凭据或用户输入。
    return `${url.origin}${url.pathname}`
  } catch { return undefined }
}

function coverageText(c: ProjectPageCoverage): string {
  const reason: Record<ProjectPageCoverage['reason'], string> = {
    complete: '分页已读完', not_synced: '尚未同步', page_limit: '达到分页上限', request_failed: '读取失败',
    invalid_response: '返回格式异常', invalid_item: '部分记录无法解析', pagination_shift: '分页存在重复，范围待核实',
  }
  return `${reason[c.reason]}${c.httpStatus ? `（HTTP ${c.httpStatus}）` : ''} · ${c.pages} 页 / ${c.items} 项`
}

function repoStatus(repo: ProjectRepoStatus, hasOldRows: boolean): string {
  if (repo.syncAt === null) return '<span class="badge warn">尚未同步</span>'
  if (!repo.coverage.complete) return '<span class="badge warn">覆盖不全</span>'
  if (repo.stale || hasOldRows) return '<span class="badge warn">包含过期快照</span>'
  return '<span class="badge fresh">已同步</span>'
}

function row(item: ProjectItem, hosts: readonly string[]): string {
  const merged = item.kind === 'pr' && item.coverage.mergeStateKnown && item.mergedAt !== null
  const state = merged ? '已合并' : item.state === 'open' ? '未关闭' : '已关闭'
  const stateClass = merged ? 'merged' : item.state === 'open' ? 'open' : 'closed'
  const target = githubUrl(item, hosts)
  const title = target ? `<a class="item-title" href="${escape(target)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}<span aria-hidden="true" class="external">↗</span></a>` : `<span class="item-title">${escape(item.title)}</span>`
  const duration = merged ? item.createdToMergedMs : item.state === 'closed' && item.closedAt !== null ? item.createdToClosedMs : null
  const durationLabel = merged ? '创建至合并' : item.state === 'open' ? '尚未关闭' : item.closedAt === null ? '关闭时间未知' : '创建至关闭'
  return `<article class="item" data-item data-repo="${escape(item.repo)}" data-assignees="${escape(JSON.stringify(item.assignees.map((s) => s.toLowerCase())))}" data-state="${escape(item.state)}" data-merged="${merged}">
    <div class="item-main"><div class="item-ref"><span class="kind">${item.kind === 'pr' ? 'PR' : 'ISSUE'}</span> #${escape(item.number)}${item.draft === true ? '<span class="draft">草稿</span>' : ''}${item.stale ? '<span class="old">需更新</span>' : ''}</div>${title}${!target ? '<small class="link-note">链接未通过验证</small>' : ''}</div>
    <div class="assignees"><span class="mobile-label">负责人</span>${item.assignees.length ? item.assignees.map((s) => `<span class="person">${escape(s)}</span>`).join('') : '<span class="muted">未指派</span>'}</div>
    <div class="state"><span class="badge ${stateClass}">${state}</span>${item.kind === 'pr' && !item.coverage.mergeStateKnown ? '<small class="muted">合并信息未核实</small>' : ''}</div>
    <div class="updated"><span class="mobile-label">GitHub 更新</span><time>${escape(date(item.updatedAt))}</time></div>
    <div class="elapsed"><strong>${escape(elapsed(duration))}</strong><small>${durationLabel}</small></div>
  </article>`
}

/** 默认只允许 github.com；Enterprise host 必须由可信服务器配置传入。 */
export function renderProjectPage(view: ProjectView, opts: { allowedGitHubHosts?: readonly string[] } = {}): string {
  const hosts = (opts.allowedGitHubHosts ?? ['github.com']).map((host) => host.toLowerCase())
  const permittedRepos = new Set(view.repositories.map((r) => r.repo))
  // renderer 不扩展授权：只展示 view.repositories 明确列出的项目。
  const items = view.items.filter((x) => permittedRepos.has(x.repo))
  const people = [...new Set(items.flatMap((x) => x.assignees))].sort((a, b) => a.localeCompare(b))
  const open = items.filter((x) => x.state === 'open').length
  const prs = items.filter((x) => x.kind === 'pr').length
  const hasGap = !view.coverageComplete || view.repositories.some((r) => !r.coverage.complete)
  const stale = view.stale || items.some((x) => x.stale) || view.repositories.some((r) => r.stale)
  const banner = hasGap ? '部分项目尚未同步完整。这里展示已获取的记录，不能据此判断没有其他事项。' : stale ? '部分记录需要更新。未在本轮同步中出现的旧记录仍然保留，请以 GitHub 当前状态为准。' : '当前展示最近一次同步快照。GitHub 上的后续变化会在下次同步后更新。'
  const projects = view.repositories.map((repo) => {
    const rows = items.filter((x) => x.repo === repo.repo)
    return `<section class="project" data-project data-repo="${escape(repo.repo)}" aria-label="${escape(repo.repo)}">
      <div class="project-heading"><div><div class="eyebrow">项目 · GitHub 仓库</div><h2>${escape(repo.repo)}</h2></div>${repoStatus(repo, rows.some((x) => x.stale))}</div>
      <div class="sync-meta"><span>最近同步 <time>${escape(date(repo.syncAt))}</time></span>${repo.lastCompleteSyncAt !== repo.syncAt ? `<span>上次完整同步 <time>${escape(date(repo.lastCompleteSyncAt))}</time></span>` : ''}</div>
      <details class="coverage"${!repo.coverage.complete ? ' open' : ''}><summary>同步范围${repo.coverage.complete ? '' : ' · 有缺口'}</summary><p>事项列表：${escape(coverageText(repo.coverage.issues))}<br>PR 详情：${escape(coverageText(repo.coverage.pullRequests))}</p><p class="muted">缺页或读取失败不会把未见事项改成已关闭。</p></details>
      <div class="table-head" aria-hidden="true"><span>事项</span><span>负责人</span><span>GitHub 状态</span><span>GitHub 更新</span><span>历时</span></div>
      <div class="items">${rows.map((x) => row(x, hosts)).join('')}</div><p class="project-empty" data-project-empty${rows.length ? ' hidden' : ''}>${repo.coverage.complete ? '当前缓存没有符合条件的记录。' : '当前没有可展示的记录；同步尚未完整，不能判断项目为空。'}</p>
    </section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>Friday · 项目进展</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#24312e;background:#f6f7f4;font-synthesis:none}*{box-sizing:border-box}body{margin:0}a{color:inherit}button,select{font:inherit}header{height:68px;background:#fff;border-bottom:1px solid #e3e8e1;display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,calc((100vw - 1160px)/2));gap:16px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.3px}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#254c3b;color:#fff;font-size:18px}.readonly{font-size:12px;color:#626e67;background:#f3f5f1;padding:6px 10px;border:1px solid #e1e7df;border-radius:20px}main{max-width:1208px;margin:0 auto;padding:44px 24px 32px}.intro{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-bottom:24px}h1{font-size:30px;letter-spacing:-1px;line-height:1.2;margin:0 0 12px}p{line-height:1.65}.subtitle{margin:0;color:#657067;font-size:14px}.numbers{display:flex;gap:26px;flex-shrink:0}.metric strong{font-size:25px;font-weight:650;display:block;font-variant-numeric:tabular-nums}.metric span{font-size:12px;color:#6b756d}.notice{padding:12px 16px;border:1px solid #dbe5da;border-left:3px solid #66806c;background:#eef4ed;border-radius:7px;font-size:13px;color:#4e6451;margin-bottom:24px}.notice.caution{background:#faf5e9;border-color:#ebe0c3;border-left-color:#b08a3a;color:#77643c}.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px;margin-bottom:24px}.filter{display:flex;flex-direction:column;gap:7px;min-width:170px}.filter label{font-size:12px;color:#536157;font-weight:600}select{width:100%;height:39px;background:#fff;color:#24312e;border:1px solid #d6dfd5;border-radius:7px;padding:0 30px 0 11px}select:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #89ab90;outline-offset:3px}.filtered-count{font-size:12px;color:#6b766d;margin:0 0 10px auto}.project{margin-bottom:24px;background:#fff;border:1px solid #dee5da;border-radius:12px;overflow:hidden}.project-heading{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:22px 24px 10px}.eyebrow{font-size:11px;font-weight:600;letter-spacing:.8px;color:#7a867b;margin-bottom:7px}h2{margin:0;font-size:20px;font-weight:650;overflow-wrap:anywhere}.sync-meta{display:flex;gap:18px;flex-wrap:wrap;color:#748076;font-size:11px;padding:0 24px 12px;line-height:1.6}.sync-meta time{margin-left:5px;font-variant-numeric:tabular-nums}.coverage{font-size:12px;color:#647266;margin:0 24px 17px}.coverage summary{cursor:pointer;width:fit-content}.coverage p{margin:7px 0 0;padding-left:14px}.table-head,.item{display:grid;grid-template-columns:minmax(220px,1fr) 120px 102px 142px 112px;gap:18px;padding:14px 24px;align-items:center}.table-head{background:#f7f9f5;font-size:11px;font-weight:600;color:#748076;border-top:1px solid #edf0e9;border-bottom:1px solid #e6ebe2}.item{padding-top:19px;padding-bottom:19px;border-bottom:1px solid #edf0e9;font-size:13px}.item:last-child{border-bottom:0}.item-ref{display:flex;align-items:center;gap:7px;font-size:11px;color:#7b867d;margin-bottom:7px}.kind{font-size:9px;font-weight:700;letter-spacing:.4px;color:#657b6c}.draft{border:1px solid #dedde5;border-radius:4px;padding:1px 5px;color:#757181;font-size:10px}.old{color:#9b7733;font-size:10px}.item-title{font-weight:600;line-height:1.6;text-decoration:none;overflow-wrap:anywhere;display:block}.item-title:hover{color:#276143;text-decoration:underline;text-underline-offset:3px}.external{font-weight:400;font-size:12px;color:#849887;margin-left:6px}.assignees{display:flex;gap:5px;flex-wrap:wrap;overflow-wrap:anywhere}.person{font-size:12px;line-height:1.6}.person+.person:before{content:", ";color:#94a196}.badge{display:inline-flex;align-items:center;width:fit-content;white-space:nowrap;font-size:11px;line-height:1.5;border-radius:5px;padding:4px 8px;font-weight:500}.fresh,.open{background:#eaf3eb;color:#3f7051}.warn{background:#f7f0dd;color:#907439}.closed{background:#f0f1ee;color:#68746d}.merged{background:#efebf8;color:#775b9a}.state small{display:block;margin-top:6px;font-size:10px;line-height:1.4}.updated{font-size:11px;color:#778176;line-height:1.65;font-variant-numeric:tabular-nums}.elapsed strong{font-size:12px;font-weight:550;display:block}.elapsed small{font-size:10px;color:#828a7e;display:block;margin-top:4px}.mobile-label{display:none}.muted{color:#818a80}.link-note{display:block;color:#977147;margin-top:4px}.project-empty,.empty-state{font-size:13px;color:#7a8579;text-align:center;padding:24px;margin:0}.empty-state{border:1px dashed #d2dbcd;border-radius:10px;background:#fff}.footnote{font-size:11px;color:#7c8679;line-height:1.9;margin:28px 2px 0;max-width:850px}[hidden]{display:none!important}@media(max-width:950px){.table-head,.item{grid-template-columns:minmax(190px,1fr) 90px 88px 120px 88px;gap:12px;padding-left:18px;padding-right:18px}.project-heading{padding-left:18px;padding-right:18px}.sync-meta{padding-left:18px;padding-right:18px}.coverage{margin-left:18px;margin-right:18px}.numbers{gap:18px}}@media(max-width:720px){header{height:59px;padding:0 18px}main{padding:29px 16px}.intro{display:block;margin-bottom:21px}h1{font-size:27px}.numbers{margin-top:24px;gap:32px}.metric strong{font-size:22px}.filters{gap:12px}.filter{flex:1;min-width:125px}.filter:first-child{flex-basis:100%}.filtered-count{width:100%;margin:0}.project{border-radius:10px}.project-heading{align-items:flex-start;padding-top:19px}h2{font-size:17px}.sync-meta{gap:6px}.table-head{display:none}.item{grid-template-columns:1fr auto;gap:10px;padding:18px;border-top:1px solid #edf0e9;border-bottom:0}.item-main{grid-column:1/-1}.item-title{font-size:14px}.assignees{font-size:12px;align-items:center}.state{text-align:right}.mobile-label{display:inline;color:#929b8f;font-size:10px;margin-right:7px}.updated{grid-column:1;align-self:end;font-size:10px}.elapsed{grid-column:2;text-align:right}.footnote{font-size:10px}.coverage{margin-bottom:15px}}
  </style></head><body><header><div class="brand"><span class="mark" aria-hidden="true">F</span>Friday<span class="muted" style="font-weight:400;margin-left:7px">/ 项目</span></div><span class="readonly">只读预览</span></header><main>
  <div class="intro"><div><h1>项目进展</h1><p class="subtitle">从项目看事项，再按负责人筛选。状态以 GitHub 为准。</p></div><div class="numbers"><div class="metric"><strong>${view.repositories.length}</strong><span>已选项目</span></div><div class="metric"><strong>${items.length}</strong><span>缓存事项</span></div><div class="metric"><strong>${open}</strong><span>未关闭</span></div><div class="metric"><strong>${prs}</strong><span>PR</span></div></div></div>
  <div class="notice${hasGap || stale ? ' caution' : ''}" role="status">${banner}</div>
  <div class="filters"><div class="filter"><label for="repo-filter">项目</label><select id="repo-filter"><option value="">全部项目</option>${view.repositories.map((r) => `<option value="${escape(r.repo)}">${escape(r.repo)}</option>`).join('')}</select></div><div class="filter"><label for="assignee-filter">负责人</label><select id="assignee-filter"><option value="">全部负责人</option><option value="__unassigned__">未指派</option>${people.map((who) => `<option value="${escape(who.toLowerCase())}">${escape(who)}</option>`).join('')}</select></div><div class="filter"><label for="state-filter">GitHub 状态</label><select id="state-filter"><option value="">全部状态</option><option value="open">未关闭</option><option value="closed">已关闭（含已合并）</option><option value="merged">已合并</option></select></div><p id="filtered-count" class="filtered-count" aria-live="polite">${items.length} 条记录 · 基于当前缓存</p></div>
  ${projects || '<p class="empty-state">尚未选择可查看的项目。</p>'}
  <p class="footnote">历时是从创建到关闭或合并的自然时间，不代表个人投入或工时。没有负责人就保留未指派，不从评论或提交活动推断。<br>此页仅查看同步快照；变更状态请打开对应 GitHub 链接。页面筛选不会请求新数据。</p>
  </main><script>
  (() => {
    const repo = document.getElementById('repo-filter');
    const assignee = document.getElementById('assignee-filter');
    const state = document.getElementById('state-filter');
    const count = document.getElementById('filtered-count');
    const projects = Array.from(document.querySelectorAll('[data-project]'));
    function filter() {
      let shown = 0;
      for (const project of projects) {
        project.hidden = Boolean(repo.value && project.dataset.repo !== repo.value);
        let inProject = 0;
        for (const item of project.querySelectorAll('[data-item]')) {
          const assigned = JSON.parse(item.dataset.assignees || '[]');
          const matchAssignee = !assignee.value || (assignee.value === '__unassigned__' ? assigned.length === 0 : assigned.includes(assignee.value));
          const match = !project.hidden && matchAssignee && (!state.value || (state.value === 'merged' ? item.dataset.merged === 'true' : item.dataset.state === state.value));
          item.hidden = !match;
          if (match) { shown += 1; inProject += 1; }
        }
        project.querySelector('[data-project-empty]').hidden = inProject > 0;
      }
      count.textContent = shown + ' 条记录 · 基于当前缓存';
    }
    for (const control of [repo, assignee, state]) control.addEventListener('change', filter);
    filter();
  })();
  </script></body></html>`
}
