/** Inserted inside the console closure; all business text still uses DOM textContent. */
export const consoleActionScript = String.raw`
  async function applyCommand(command, button, message) {
    const space = $('spaces').value, view = requestNumber;
    button.disabled = true;
    try {
      const receipt = await api('/console/api/spaces/'+encodeURIComponent(space)+'/operations', {
        method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(command)
      });
      if (view !== requestNumber) return;
      const refreshed = await load();
      if (!refreshed || requestNumber !== view + 1 || $('spaces').value !== space) return;
      $('notice').textContent = receipt.runtimeCleanup === 'pending' ? '停止状态已保存，执行仍在停止中。'
        : receipt.appliedResult.state === 'already_finished' ? '这次执行已结束。'
        : receipt.appliedResult.state === 'already_cancelled' ? '这段委托之前已经取消。'
        : receipt.appliedResult.state === 'already_resumed' ? '这个暂停原因已经不存在，无需恢复。'
        : receipt.appliedResult.result ? (reconcileResults[receipt.appliedResult.result] || message)
        : receipt.replayed ? '这次操作之前已提交，已重新读取状态。' : message;
    } catch (e) {
      if (view !== requestNumber) return;
      if (e.status === 401) signedOut();
      $('notice').textContent = e.message || '结果暂时没有返回，请重新读取状态。';
    } finally { button.disabled = false; }
  }
  function commandButton(parent, label, input, message) {
    const button = text(parent, 'button', label);
    button.type = 'button';
    // A retry of this same visible action retains its identity after a lost HTTP reply.
    const command = {...input, requestId:crypto.randomUUID()};
    button.addEventListener('click', () => applyCommand(command, button, message));
    return button;
  }
  function field(parent, label, tag, value) {
    const wrapper = el('label', label), control = el(tag);
    control.value = value ?? ''; wrapper.append(control); parent.append(wrapper); return control;
  }
  function choice(parent, label, options, selected) {
    const control = field(parent,label,'select','');
    for(const [value,title] of options) { const option=el('option',title);option.value=value;control.append(option); }
    control.value=selected; return control;
  }
  function preferenceEditor(parent, data) {
    if (!data.canConfigure) return;
    const details=el('details',undefined,'editor'), form=el('form'); text(details,'summary','修改展示偏好');
    const brevity=choice(form,'回答长度',[['short','简短'],['normal','正常'],['detailed','详细']],data.settings.brevity);
    const ack=choice(form,'状态反馈',[['react','表情'],['none','不显示']],data.settings.statusFeedback==='none'?'none':'react');
    text(form,'p','保存后用于后续消息。','muted');
    const button=text(form,'button','保存偏好');button.type='submit';
    let pending;
    form.addEventListener('submit',e=>{
      e.preventDefault(); if(button.disabled)return;
      const input={operation:'space.presentation',expectedTag:data.settingsTag,patch:{brevity:brevity.value,ack:ack.value}};
      const signature=JSON.stringify(input);
      if(!pending||pending.signature!==signature)pending={signature,command:{...input,requestId:crypto.randomUUID()}};
      void applyCommand(pending.command,button,'已保存，后续消息生效。');
    });
    details.append(form);parent.append(details);
  }
  function modelEditor(parent, data) {
    const catalog=data.models;
    if(!catalog||catalog.status!=='available'){text(parent,'p',catalog?.message||'尚未启用模型选择。','row muted');return;}
    const route=catalog.choices.find(item=>catalog.selected===null?item.providerId===catalog.defaultRoute.providerId&&item.modelId===catalog.defaultRoute.modelId&&item.accountRef===catalog.defaultRoute.accountRef:item.value===catalog.selected);
    facts(parent,[['后续执行模型',route?route.providerId+' / '+route.modelId:'所选模型当前不可用'],['模型账户',route?.accountRef||'—']]);
    if(catalog.legacyPreferences)text(parent,'p','旧模型偏好已保留，不用于实际选择。','row muted');
    if(!data.canConfigure)return;
    const details=el('details',undefined,'editor'),form=el('form');text(details,'summary','选择模型');
    const choices=[['','跟随部署默认 · '+catalog.defaultRoute.providerId+' / '+catalog.defaultRoute.modelId],...catalog.choices.map(item=>[item.value,item.label+' · '+item.providerId+' / '+item.modelId])];
    if(catalog.selected!==null&&!catalog.choices.some(item=>item.value===catalog.selected))choices.push([catalog.selected,'原选择当前不可用']);
    const selected=choice(form,'后续执行使用',choices,catalog.selected??'');
    text(form,'p','保存后用于新执行；正在执行的任务保持原模型。计费用量暂不可用。','muted');
    const button=text(form,'button','保存模型');button.type='submit';let pending;
    form.addEventListener('submit',e=>{
      e.preventDefault();if(button.disabled)return;
      const input={operation:'space.model',value:selected.value||null,expectedTag:catalog.tag,generation:catalog.generation},signature=JSON.stringify(input);
      if(!pending||pending.signature!==signature)pending={signature,command:{...input,requestId:crypto.randomUUID()}};
      void applyCommand(pending.command,button,'已保存，新的执行将使用这个模型。');
    });details.append(form);parent.append(details);
  }
  function localDateTime(ms) {
    if(ms===null||ms===undefined)return '';
    const d=new Date(ms);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  function todoControls(parent,item) {
    if(!item.canEdit)return;
    const actions=el('div',undefined,'actions');
    if(item.status==='done'||item.status==='cancelled'){
      if(item.transitions?.includes('open'))commandButton(actions,'重新打开',{operation:'todo.update',id:item.id,expectedTag:item.tag,patch:{status:'open'}},'已重新打开，可在进行中的待办里查看。');
      parent.append(actions);return;
    }
    if(!item.confirmed)commandButton(actions,'确认待办',{operation:'todo.update',id:item.id,expectedTag:item.tag,patch:{confirm:true}},'已确认这条待办。');
    if(item.transitions?.includes('done'))commandButton(actions,'标记完成',{operation:'todo.update',id:item.id,expectedTag:item.tag,patch:{status:'done'}},'已标记完成。');
    if(item.transitions?.includes('cancelled'))commandButton(actions,'取消待办',{operation:'todo.update',id:item.id,expectedTag:item.tag,patch:{status:'cancelled'}},'已取消这条待办。');
    parent.append(actions);
    const details=el('details',undefined,'editor'),form=el('form');text(details,'summary','修改待办');
    const title=field(form,'标题','input',item.title);title.required=true;title.maxLength=200;
    const detail=field(form,'补充说明','textarea',item.detail);detail.maxLength=2000;
    const due=field(form,'到期时间（本机时区）','input',localDateTime(item.dueMs));due.type='datetime-local';
    const labels={open:'进行中',blocked:'阻塞',review:'待验收',done:'完成',cancelled:'取消'};
    const status=choice(form,'状态',[[item.status,item.statusLabel],...(item.transitions||[]).filter(s=>s!==item.status).map(s=>[s,labels[s]])],item.status);
    const note=field(form,'状态变化说明','input','');note.maxLength=300;
    const button=text(form,'button','保存待办');button.type='submit';let pending;
    form.addEventListener('submit',e=>{
      e.preventDefault();if(button.disabled)return;const patch={};
      if(title.value!==item.title)patch.title=title.value;
      if(detail.value!==(item.detail||''))patch.detail=detail.value||null;
      if(due.value!==localDateTime(item.dueMs))patch.dueMs=due.value?new Date(due.value).getTime():null;
      if(status.value!==item.status){patch.status=status.value;if(note.value)patch.statusNote=note.value;}
      if(!Object.keys(patch).length){$('notice').textContent='内容没有变化。';return;}
      const input={operation:'todo.update',id:item.id,expectedTag:item.tag,patch},signature=JSON.stringify(input);
      if(!pending||pending.signature!==signature)pending={signature,command:{...input,requestId:crypto.randomUUID()}};
      void applyCommand(pending.command,button,'待办已更新。');
    });details.append(form);parent.append(details);
  }
  function routineControls(parent,item) {
    const actions=el('div',undefined,'actions');
    if(item.canPause)commandButton(actions,'暂停职责',{operation:'routine.pause',id:item.id,expectedConfigVersion:item.configVersion},'已暂停这条职责。');
    if(item.canResume)commandButton(actions,'恢复职责',{operation:'routine.resume',id:item.id,expectedConfigVersion:item.configVersion},'已恢复这条职责。');
    if(actions.childNodes.length)parent.append(actions);
  }
  function runControls(parent,item) {
    for(const run of item.runs)if(run.canStop)commandButton(parent,'停止这次执行',{operation:'run.stop',runId:run.id,taskId:item.id},'已请求停止这次执行。');
  }
  // The whole delegation, not one Run: queued follow-ups and the running Run end together; nothing new starts from it.
  function workControls(parent,w) {
    for(const pause of w.pauses||[])if(pause.canResume)commandButton(parent,'恢复：'+(pauseReasons[pause.reason]||pause.reason),{operation:'work.resume',workKey:w.key,expectedRevision:w.revision,reason:pause.reason,causeRef:pause.causeRef},'已恢复这段委托，等待中的补充会继续处理。');
    if(w.canCancel)commandButton(parent,'取消这段委托',{operation:'work.cancel',workKey:w.key,expectedRevision:w.revision},'已取消这段委托，正在停止相关执行。');
  }
  // What the platform actually showed for one receipt; the receipt itself never carries the message body.
  const reconcileResults={confirmed:'平台上找到了这条消息，回执已改为已回读核实。',acknowledged:'平台上有这条消息，但这种正文类型无法逐字比对，保持“平台已接收”。',
    remote_absent:'发送时间窗内平台没有机器人消息，这条没有发出去；不会自动补发。',remote_absent_incomplete:'时间窗内消息太多没有读完，结果仍待核对。',
    unverifiable:'时间窗内有机器人消息，但不能确认就是这条，结果仍待核对。',remote_mismatch:'记录的消息 ID 在平台上属于别的会话或发送者，请人工查看。',
    read_unavailable:'暂时读不到平台结果，稍后再试。',already_confirmed:'这条之前已经核实过。'};
  const reconcileStates={confirmed:'已核实',acknowledged:'平台有此消息，正文未比对',remote_absent:'核对：未发出',remote_absent_incomplete:'核对：窗口未读完',
    unverifiable:'核对：无法确认',remote_mismatch:'核对：与平台不一致',read_unavailable:'核对：平台暂不可读'};
  function deliveryControls(parent,receipt,label) {
    const line=el('p',undefined,'muted');line.textContent=label+(receipt.reconciliation?' · '+(reconcileStates[receipt.reconciliation.result]||receipt.reconciliation.result)+' '+date(receipt.reconciliation.checkedAt):'');
    parent.append(line);
    if(receipt.canReconcile||receipt.can_reconcile)commandButton(parent,'核对发送结果',{operation:'delivery.reconcile',key:receipt.key},'已按平台实际结果更新回执。');
  }
`

export const consoleActionCss = `
.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}.actions button,.editor button{font-size:12px}.editor{margin:14px 22px 20px}.row .editor{margin:14px 0 0}.editor form{max-width:580px;margin-top:14px;display:grid;gap:14px}.editor label{display:grid;gap:4px;font-size:12px;color:#56644f}.editor input,.editor textarea{font:inherit;font-size:13px;padding:8px 10px;border:1px solid #d8dfd5;border-radius:6px;color:#24312e;min-width:0;width:100%;background:white}.editor textarea{min-height:80px;resize:vertical}.editor button{justify-self:start}.editor select{margin:0}.editor input:focus-visible,.editor textarea:focus-visible{outline:3px solid #8aad92;outline-offset:2px}
`
