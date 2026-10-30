/** A small first-party form. No analytics, third-party scripts, cookies or token URLs. */
export function tokenPage(setup, headers) {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const html = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 GitHub · Friday</title>
<style>*{box-sizing:border-box}body{margin:0;padding:48px 24px;background:#f7f8fa;color:#20242b;font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{margin:6vh auto;max-width:480px}header{font-weight:600;color:#50616f;margin-bottom:28px}h1{font-size:28px;line-height:1.3;margin:0 0 12px}p{margin:0 0 20px;color:#5b6572}label{display:block;font-weight:600;margin:28px 0 8px}input{width:100%;font:inherit;background:#fff;border:1px solid #b5bec8;border-radius:8px;padding:12px;outline:none}input:focus{border-color:#245bdb;box-shadow:0 0 0 3px #245bdb20}button{font:inherit;border:0;border-radius:8px;background:#245bdb;color:white;padding:11px 22px;cursor:pointer}button:disabled{opacity:.6;cursor:default}.actions{display:flex;gap:16px;align-items:center;margin-top:20px;flex-wrap:wrap}a{color:#245bdb;text-underline-offset:3px}small{font-size:13px;display:block;margin-top:10px;color:#657180}#status{margin-top:20px;white-space:pre-wrap}details{margin-top:28px;color:#657180;font-size:14px}summary{cursor:pointer}details p{margin-top:12px;font-size:14px}noscript{color:#9a3a20}</style></head>
<body><main><header>Friday</header><h1>连接你的 GitHub</h1><p>整理等你评审的 PR、分配给你的 Issue，以及你已提交的工作。</p>
<form id="connect"><label for="token">个人访问令牌</label><input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="160" required placeholder="github_pat_… 或 ghp_…"><small>请使用你本人的令牌。不要将令牌发到聊天中。</small>
<div class="actions"><button id="submit" type="submit">连接账号</button><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">在 GitHub 创建令牌 ↗</a></div>
<details><summary>如何选择访问范围</summary><p>优先创建细粒度令牌，只选择希望 Friday 读取的仓库。开启 Contents、Issues 和 Pull requests 的只读权限；需要检查详情时再开启 Actions 和 Checks 的只读权限。组织仓库可能需要管理员批准。</p><p>本次连接只用于读取与准备草稿。令牌在浏览器加密后提交，由 Friday 服务端加密保存。你可以随时在飞书的账号连接中断开。</p></details></form>
<p id="status" role="status" aria-live="polite"></p><noscript>请启用 JavaScript。此页面需要在浏览器中加密令牌后才能提交。</noscript>
<script nonce="${nonce}">
const setup=${JSON.stringify(setup)};
const form=document.getElementById('connect'), field=document.getElementById('token'), button=document.getElementById('submit'), status=document.getElementById('status');
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
form.addEventListener('submit',async event=>{event.preventDefault();const token=field.value.trim();
if(token.length>160||!/^(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)){status.textContent='请粘贴 GitHub 生成的个人访问令牌。';return;}
button.disabled=true;status.textContent='正在连接…';
try{const key=await crypto.subtle.importKey('spki',decode(setup.key),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
const data=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP',label:new TextEncoder().encode(setup.state)},key,new TextEncoder().encode(token)));
field.value='';const code=btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const result=await fetch('/github/token',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify({...setup,code})});
if(!result.ok)throw new Error(result.status===409?'这次配置已提交，请回 Friday 查看结果。':'提交未完成，请回 Friday 重新打开配置页。');
form.hidden=true;status.textContent='已提交，Friday 正在核实账号。请回飞书查看连接结果。';
}catch(error){field.value='';status.textContent=error.message||'连接暂未完成，请稍后重试。';button.disabled=false;}});
</script></main></body></html>`
  return new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` } })
}
