import {accountPages} from './background-page.mjs';
import {classifyLogin,collectLoginSignals} from './login-status.mjs';

export class MuseError extends Error{constructor(code,message){super(message);this.code=code;}}
import {parseMuseResult,resultStart,resultEnd,resultSources} from '../shared/muse-protocol.mjs';
export {parseMuseResult,resultStart,resultEnd} from '../shared/muse-protocol.mjs';

// Fixed per-platform DOM knowledge. Inspect only pending controls and this
// attempt's marked reply; unrelated private conversation text never leaves it.
export function museState(id){
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
 const inputs=[...document.querySelectorAll('textarea')].filter(visible);
 const busy=[...document.querySelectorAll('button[aria-label*="Stop" i],button[aria-label*="停止"]')].some(el=>visible(el)&&!el.disabled);
 const approval=[...document.querySelectorAll('[data-testid="hatch-inline-approval-card"]')].some(card=>visible(card)&&[...card.querySelectorAll('button')].some(b=>visible(b)&&!b.disabled));
 const bubbles=[...document.querySelectorAll('div[class*="hatch-agent-bubble-bg"]')];
 const start='<<<HUB_RESULT_'+id+'>>>',end='<<<HUB_END_'+id+'>>>';
 const matched=bubbles.slice(-60).map(el=>el.innerText||'').filter(text=>text.includes(start)&&text.includes(end)).at(-1)||'';
 return{inputs:inputs.length,draft:!!inputs[0]?.value.trim(),busy,approval,matched};
}

export class MuseTransport{
 constructor(browsers){this.browsers=browsers;}
 page(account){
  const entry=this.browsers.active.get(account.id);
  if(!entry)throw new MuseError('WINDOW_CLOSED','账号后台尚未恢复，工作台会保留资料并检查，不需要重复登录。');
  const page=accountPages(entry).find(p=>{try{return !p.isClosed()&&['muse.ai','www.muse.ai'].includes(new URL(p.url()).hostname);}catch{return false;}});
  if(!page)throw new MuseError('LOGIN_REQUIRED','专用窗口不在 Muse 聊天界面，等待本人完成登录。');
  return page;
 }
 async inspect(account,id){const page=this.page(account);return page.evaluate(museState,id);}
 async send(account,id,input,beforeSend){
  const page=this.page(account),login=classifyLogin('muse',page.url(),await page.evaluate(collectLoginSignals));
  if(login!=='authenticated')throw new MuseError('LOGIN_REQUIRED','当前窗口的登录尚未确认，不自动重试登录。');
  const snapshot=await page.evaluate(museState,id);
  if(snapshot.inputs!==1)throw new MuseError('UI_CHANGED','Muse 输入框不唯一，停止发送并保留会话。');
  if(snapshot.draft||snapshot.busy)throw new MuseError('WAITING_IDLE','Muse 正在处理任务或有未发送草稿，等待空闲；不会覆盖。');
  if(snapshot.approval)throw new MuseError('PLATFORM_APPROVAL','Muse 有待本人处理的批准，工作台不会代替你批准或拒绝。');
  const prompt=[
   '这是从我自己的 Agent Hub 工作台交给你的任务。请保留你原来的记忆、规划、工具和权限规则，按正常能力完成。不要修改现有例行任务、设置或连接器。',
   '任务输入：',typeof input==='string'?input:JSON.stringify(input,null,2),
   '任务完成后，按下面三个标记输出。两个标记之间直接放完整成果正文，不要再套 JSON 信封，不要转义正文里的引号。来源标记后放实际使用的 HTTPS 地址 JSON 数组，没有则放 []。',
   resultStart(id),'在这里填写本次完整真实成果；要求 JSON 时直接放 JSON 对象，不要包在字符串里。',resultSources(id),'[]',resultEnd(id),
   '最后再发这个完整信封；尚未完成或需要批准时先正常说明，不要提前发完成信封。',
  ].join('\n');
  // Save the attempt BEFORE any possible send. A crash never blindly resends.
  await beforeSend();
  const inputBox=page.locator('textarea:visible');
  if(await inputBox.inputValue())throw new MuseError('WAITING_IDLE','发现新草稿，未覆盖或发送。');
  await inputBox.fill(prompt,{timeout:10000});await inputBox.press('Enter',{timeout:10000});
 }
 async wait(account,id,{timeoutMs=180000,onState=async()=>{}}={}){
  const start=Date.now();let last='',stable=0,phase='';
  while(Date.now()-start<timeoutMs){
   let snapshot;try{snapshot=await this.inspect(account,id);}catch(e){throw new MuseError('NEEDS_REVIEW','已派发，当前无法读取原窗口；先核对 Muse，不自动重发。');}
   const next=snapshot.approval?'platform_approval':snapshot.busy?'working':'awaiting_result';
   if(next!==phase){phase=next;await onState(phase);}
   const result=parseMuseResult(snapshot.matched,id);
   if(result&&!snapshot.busy&&!snapshot.approval){
    if(snapshot.matched===last){if(Date.now()-stable>=1200)return{...result,reply:snapshot.matched};}
    else{last=snapshot.matched;stable=Date.now();}
   }else{last='';stable=0;}
   await new Promise(resolve=>setTimeout(resolve,600));
  }
  throw new MuseError('NEEDS_REVIEW','Muse 已收到或可能收到任务，但未取得完整匹配成果；保留本次记录，不自动重发。');
 }
}
