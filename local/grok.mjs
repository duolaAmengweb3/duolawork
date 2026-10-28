import {accountPages} from './background-page.mjs';
import {classifyLogin,collectLoginSignals} from './login-status.mjs';
import {parseMuseResult,resultStart,resultEnd,resultSources} from '../shared/muse-protocol.mjs';
export const GROK_COMPOSER='textarea:visible, [contenteditable="true"]:visible';
const failure=(code,message)=>Object.assign(new Error(message),{code});
export const grokBotUrl=url=>{try{const u=new URL(url);return ['grok.com','www.grok.com'].includes(u.hostname)&&/^\/bot\/[a-zA-Z0-9-]+\/?$/.test(u.pathname);}catch{return false;}};
// Product adapter: inspect controls and only the CURRENT task's marked result.
// Never export other conversation bodies, cookies or storage.
export function grokState(id){
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
 const inputs=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
 const controls=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
 const named=re=>controls.some(el=>re.test((el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim()));
 const bots=[...new Set([...document.querySelectorAll('a[href]')].filter(visible).map(a=>{try{const u=new URL(a.getAttribute('href'),location.href);return u.origin===location.origin&&/^\/bot\/[a-zA-Z0-9-]+\/?$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}}).filter(Boolean))];
 const busy=named(/^(Stop|Stop generating|停止|停止生成|停止响应)$/i);
 const approval=[...document.querySelectorAll('[role="dialog"],[data-testid*="approval"]')].some(el=>visible(el)&&[...el.querySelectorAll('button')].some(b=>/^(Approve|Allow|批准|允许|确认执行)$/i.test(b.textContent.trim())));
 let matched='',requestPresent=false,markerCount=0;const markerElements=[];
 if(id){const start='<<<HUB_RESULT_'+id+'>>>',end='<<<HUB_END_'+id+'>>>',request='HUB_TASK_REQUEST_'+id;
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode())){if(node.textContent.includes(request))requestPresent=true;if(!node.textContent.includes(start))continue;markerCount++;let el=node.parentElement;markerElements.push({tag:el?.tagName,classes:typeof el?.className==='string'?el.className.slice(0,200):''});
   for(let depth=0;el&&el!==document.body&&depth<14;depth++,el=el.parentElement){
    if(el.matches('textarea,[contenteditable="true"],script,style'))break;
    const text=el.innerText||'';if(text.length>50000||text.includes(request))break;
    if(text.includes(start)&&text.includes(end)){matched=text;break;}
   }
  }
 }
 const draftText=inputs[0]?.value??inputs[0]?.innerText??'';
 return{inputs:inputs.length,inputTag:inputs[0]?.tagName,draft:!!draftText.trim(),ownedDraft:!!id&&draftText.trim().startsWith('HUB_TASK_REQUEST_'+id),busy,approval,bots,matched,requestPresent,markerCount,markerElements};
}
export function grokSendControl(){
 const controls=[...document.querySelectorAll('button,[role="button"]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');
 const buttons=controls.filter(el=>/^(Send|Send message|发送|发送消息)(\s.*)?$/i.test((el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim()));
 if(buttons.length!==1)return{count:buttons.length};const r=buttons[0].getBoundingClientRect();return{count:1,x:r.x+r.width/2,y:r.y+r.height/2};
}
export class GrokTransport{
 constructor(browsers){this.browsers=browsers;}
 page(account){const entry=this.browsers.active.get(account.id);if(!entry)throw failure('WINDOW_CLOSED','Grok 原账号后台尚未恢复，保留资料，未要求重新登录。');const pages=accountPages(entry).filter(p=>{try{return ['grok.com','www.grok.com'].includes(new URL(p.url()).hostname);}catch{return false;}});const page=pages.find(p=>grokBotUrl(p.url()))||pages[0];if(!page)throw failure('LOGIN_REQUIRED','Grok 原账号页面暂未就绪，未重置登录资料。');return page;}
 async prepare(account){let page=this.page(account);const login=classifyLogin('grok-bot',page.url(),await page.evaluate(collectLoginSignals));if(login!=='authenticated')throw failure('LOGIN_REQUIRED','Grok 登录尚未确认，等待原账号页面就绪。');const state=await page.evaluate(grokState);
  if(grokBotUrl(page.url()))return;
  if(state.draft||state.busy||state.approval)throw failure('WAITING_IDLE','Grok 原页面有草稿、正在工作或待批准，未覆盖。');
  if(state.bots.length!==1)throw failure('BOT_SELECTION_REQUIRED',state.bots.length?'这个账号有多个原生 Bot，请在专用窗口选择要接入的 Bot；不会随意派给其中一个。':'已登录 Grok，但没有发现可用的原生 Bot；请在专用窗口查看 Bot 是否可用。');
  await page.goto(state.bots[0],{waitUntil:'domcontentloaded',timeout:30000});
  for(let i=0;i<120;i++){if((await page.evaluate(grokState)).inputs===1)return;await new Promise(r=>setTimeout(r,250));}
  throw failure('WAITING_IDLE','原生 Bot 页面还在加载，稍后自动检查；尚未发送任务。');
 }
 async inspect(account,id){const page=this.page(account);if(!grokBotUrl(page.url()))throw failure('BOT_SELECTION_REQUIRED','当前不是原生 Grok Bot 会话；普通 Grok 聊天不会被当成 Bot。');return page.evaluate(grokState,id);}
 async send(account,id,input,beforeSend){const page=this.page(account);if(!grokBotUrl(page.url()))throw failure('BOT_SELECTION_REQUIRED','只能向原生 Bot 派发，未改用普通聊天或模型 API。');if(classifyLogin('grok-bot',page.url(),await page.evaluate(collectLoginSignals))!=='authenticated')throw failure('LOGIN_REQUIRED','Grok 登录待确认，未发送。');const state=await this.inspect(account,id);if(state.inputs!==1)throw failure('UI_CHANGED','Grok 输入框不唯一，未发送。');if((state.draft&&!state.ownedDraft)||state.busy)throw failure('WAITING_IDLE','Grok 正在工作或有草稿，未覆盖或发送。');if(state.approval)throw failure('PLATFORM_APPROVAL','Grok 正等待本人批准，工作台不会代替你批准。');
  const prompt=['HUB_TASK_REQUEST_'+id,'这是从我自己的 Agent Hub 工作台交给你的任务。请使用原 Bot 的记忆、规划、工具和权限完成；不要修改现有例行任务、设置或连接器。','任务输入：',typeof input==='string'?input:JSON.stringify(input,null,2),'完成后才输出完整成果信封。在 RESULT 后填写完整成果正文，在 SOURCES 后填写实际使用的 HTTPS 来源 JSON 数组（无来源写 []），最后输出 END。以下仅为格式，RESULT 和 SOURCES 之间当前为空，必须用你的真实成果填入：',resultStart(id),resultSources(id),'[]',resultEnd(id),'需要本人批准或还没做完就正常说明，不要提前输出完成信封。'].join('\n');
  const box=page.locator(GROK_COMPOSER),normal=value=>value.replace(/\s+/g,' ').trim(),existing=await box.inputValue();
  if(existing.trim()&&normal(existing)!==normal(prompt))throw failure('WAITING_IDLE','发现未匹配的草稿，未覆盖或发送。');
  if(!existing.trim())await box.fill(prompt,{timeout:10000});
  if(normal(await box.inputValue())!==normal(prompt))throw failure('UI_CHANGED','Grok 输入内容与任务不匹配，尚未点击发送；保留页面核对。');
  const button=await page.evaluate(grokSendControl);
  await beforeSend();
  if(button.count===1){if(page.clickPoint)await page.clickPoint(button.x,button.y);else await page.mouse.click(button.x,button.y);}
  else await box.press('Enter',{timeout:10000});
 }
 async wait(account,id,{timeoutMs=180000,onState=async()=>{}}={}){const started=Date.now();let last='',stableAt=0,phase='';while(Date.now()-started<timeoutMs){const s=await this.inspect(account,id);const next=s.approval?'platform_approval':s.busy?'working':'awaiting_result';if(next!==phase){phase=next;await onState(next);}const result=parseMuseResult(s.matched,id);if(result&&!s.busy&&!s.approval){if(last===s.matched){if(Date.now()-stableAt>=2000)return{...result,reply:s.matched};}else{last=s.matched;stableAt=Date.now();}}else{last='';stableAt=0;}await new Promise(r=>setTimeout(r,600));}throw failure('NEEDS_REVIEW','Grok 任务可能已收到，但还没有完整匹配成果；保留原记录，不自动重复发送。');}
}
