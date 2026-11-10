import {WebSocket} from 'undici';

// A hidden target in the SAME installed, headed Chrome and profile. It has no
// native window and is owned by this CDP connection; no headless switch, cookie
// export, browser flags that weaken isolation, or manipulation of daily Chrome.
export class BackgroundPage {
 static async create(endpoint,url){
  const page=new BackgroundPage(endpoint);
  try{await page.open();let targetId,bootstrap;
   try{({targetId}=await page.send('Target.createTarget',{url:'about:blank',hidden:true,background:true}));}
   catch(e){if(!e.message.includes('Hidden target can be created only when remote debugging is enabled'))throw e;
    // Chrome requires a frame to bootstrap hidden targets. Restore its default
    // profile with an unfocused, MINIMIZED blank window, create the hidden
    // target, then immediately discard only our blank bootstrap. No login UI.
    bootstrap=(await page.send('Target.createTarget',{url:'about:blank',newWindow:true,windowState:'minimized',background:true,focus:false})).targetId;
    try{({targetId}=await page.send('Target.createTarget',{url:'about:blank',hidden:true,background:true}));}
    finally{await page.send('Target.closeTarget',{targetId:bootstrap});}
   }
   page.targetId=targetId;
   page.sessionId=(await page.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
   await page.command('Page.enable');
   // A windowless target has a zero-size surface until a viewport is assigned.
   // This is its ordinary rendering size, not a spoofed identity or user agent.
   await page.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:0,mobile:false});
   if(url!=='about:blank')await page.goto(url);return page;
  }catch(e){page.close();throw e;}
 }
 constructor(endpoint){this.endpoint=endpoint;this.pending=new Map();this.sequence=0;this.location='about:blank';this.closed=false;}
 async open(){
  const socket=this.socket=new WebSocket(this.endpoint);
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const job=this.pending.get(message.id);if(!job)return;clearTimeout(job.timer);this.pending.delete(message.id);message.error?job.reject(new Error('后台浏览器命令失败：'+message.error.message)):job.resolve(message.result);}
   else if(message.method==='Page.frameNavigated'&&message.sessionId===this.sessionId&&!message.params.frame.parentId)this.location=message.params.frame.url;
  });
  socket.addEventListener('close',()=>{this.closed=true;for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('后台浏览器连接已断开'));}this.pending.clear();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('后台浏览器连接超时'));},10000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('后台浏览器连接失败'));},{once:true});});
 }
 send(method,params={},sessionId){
  if(this.closed)return Promise.reject(new Error('后台页面已关闭'));
  return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('后台浏览器命令超时'));},15000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,sessionId}));});
 }
 command(method,params={}){return this.send(method,params,this.sessionId);}
 async evaluate(fn,arg){const response=await this.command('Runtime.evaluate',{expression:`(${fn.toString()})(${JSON.stringify(arg)??'undefined'})`,awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw new Error('后台页面检查失败');return response.result?.value;}
 url(){return this.location;}
 isClosed(){return this.closed;}
 async goto(url){
  const result=await this.command('Page.navigate',{url});if(result.errorText&&result.errorText!=='net::ERR_ABORTED')throw new Error('后台页面网络连接失败，保留账号资料：'+result.errorText);
  const until=Date.now()+30000;while(Date.now()<until){try{const state=await this.evaluate(()=>({url:location.href,ready:document.readyState}));this.location=state.url;if((state.url!=='about:blank'||url==='about:blank')&&['interactive','complete'].includes(state.ready))return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('后台页面加载超时，未清理登录资料');
 }
 locator(selector){
  if(!['textarea:visible','textarea:visible, [contenteditable="true"]:visible'].includes(selector))throw new Error('后台适配只开放已验证的输入控件');
  return{
   inputValue:async()=>this.evaluate(sel=>{const nodes=[...document.querySelectorAll(sel)].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');if(nodes.length!==1)throw new Error('输入框不唯一');return nodes[0].value??nodes[0].innerText??'';},selector==='textarea:visible'?'textarea':'textarea,[contenteditable="true"]'),
   fill:async text=>{const count=await this.evaluate(sel=>{const nodes=[...document.querySelectorAll(sel)].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');if(nodes.length===1){const el=nodes[0];el.focus();if(el.tagName==='TEXTAREA')el.select();else{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}}return nodes.length;},selector==='textarea:visible'?'textarea':'textarea,[contenteditable="true"]');if(count!==1)throw new Error('输入框不唯一');await this.command('Input.insertText',{text});},
   press:async key=>{if(key!=='Enter')throw new Error('未适配的按键');
    // Chrome 157 needs both target activation and renderer focus for trusted
    // keyboard delivery to a windowless target. Its native focus routing settles
    // asynchronously after the CDP ACK; wait before the single business key.
    // No native window, synthetic DOM event or retransmission is introduced.
    await this.command('Page.bringToFront');await this.command('Emulation.setFocusEmulationEnabled',{enabled:true});
    await new Promise(resolve=>setTimeout(resolve,150));
    await this.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r',commands:['insertNewline']});await this.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});},
  };
 }
 async clickPoint(x,y){
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)throw new Error('发送按钮坐标无效');
  await this.command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
 }
 close(){this.closed=true;this.socket?.close();}
}

export const accountPages=entry=>[entry?.workPage,...(entry?.context?.pages()||[])].filter(page=>page&&!page.isClosed());
