import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';
const execute=promisify(execFile);

// List metadata and queue/resume on the ORIGINAL daemon. Never move a native
// thread onto Hub's separate App Server or override its model/permissions.
export class CodexWorkingHost {
  constructor({exec=execute,home=os.homedir(),rpcFactory}={}) {Object.assign(this,{exec,home,rpcFactory});}
  async socket() {
    const {stdout}=await this.exec('/bin/ps',['-ax','-o','pid=,command=']);
    const rows=stdout.split('\n').flatMap(l=>{const m=l.match(/^\s*(\d+)\s+(.+)$/);return m&&m[2].startsWith(path.join(this.home,'.codex/packages/app-server-daemon/'))?[{pid:m[1],command:m[2]}]:[];});
    const candidates=new Set();
    for(const row of rows){
      const match=row.command.match(/--listen(?:=|\s+)(?:"unix:\/\/([^"]+)"|'unix:\/\/([^']+)'|unix:\/\/(\S+))/),socket=match&&(match[1]||match[2]||match[3]);
      if(socket&&path.isAbsolute(socket)){try{const stat=await fs.stat(socket);if(stat.isSocket()&&stat.uid===process.getuid())candidates.add(socket);}catch{}continue;}
      if(process.platform==='darwin'&&row.command.includes('--listen unix://')){const {stdout}=await this.exec('/usr/sbin/lsof',['-a','-p',row.pid,'-U','-Fn']);for(const l of stdout.split('\n'))if(l.startsWith('n/private/tmp/codex-daemon-'+process.getuid()+'/'))candidates.add(l.slice(1));}
    }
    if(candidates.size!==1)throw Error('原 Codex 运行端未开启或实例不唯一，请先在 Codex 中打开工作会话');return [...candidates][0];
  }
  async open() {
    const socket=await this.socket(),rpc=this.rpcFactory?this.rpcFactory(socket):new CodexSocketRpc(socket);
    try {await rpc.call('initialize',{clientInfo:{name:'agent-hub-session-picker',version:'1.0.0'},capabilities:{experimentalApi:true}});rpc.send({jsonrpc:'2.0',method:'initialized',params:{}});return rpc;}catch(e){await rpc.stop();throw e;}
  }
  async read(fn) {const rpc=await this.open();try{return await fn(rpc);}finally{await rpc.stop();}}
  async watch({sessionId,workMarker,exactPrompt,onApproval}){
    const rpc=await this.open();
    rpc.onRequest=async(method,params)=>{
      if(params.threadId!==sessionId||!params.turnId)return;
      const {data:items}=await rpc.call('thread/items/list',{threadId:sessionId,turnId:params.turnId,limit:10,sortDirection:'asc'});
      if(!items?.some(({item:i})=>i?.type==='userMessage'&&i.content?.some(c=>c.type==='text'&&c.text.includes(exactPrompt||'claim_step '+workMarker))))return;
      return onApproval({engine:'codex',method,params,sessionId});
    };
    try{await rpc.call('thread/resume',{threadId:sessionId,excludeTurns:true});return()=>rpc.stop();}catch(e){await rpc.stop();throw e;}
  }
  async sessions() {
    return this.read(async rpc=>{
      const loaded=new Set((await rpc.call('thread/loaded/list',{})).data||[]),threads=new Map(),projects=[];
      const pages=async(method,params,accept)=>{let cursor;const seen=new Set();do{const page=await rpc.call(method,{...params,...(cursor?{cursor}:{})});for(const item of page.data||[])accept(item);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('原生项目列表分页异常，请刷新后重试');seen.add(cursor);}while(cursor);};
      await pages('thread/list',{limit:100,archived:false,useStateDbOnly:true,sortKey:'updated_at'},t=>threads.set(t.id,t));
      // Also include live threads whose persistence metadata has not landed yet.
      for(const id of loaded)if(!threads.has(id)){const {thread}=await rpc.call('thread/read',{threadId:id,includeTurns:false});threads.set(id,thread);}
      try{await pages('project/list',{limit:100},p=>projects.push({id:p.id,name:p.name,workspace:p.roots?.find(r=>r.kind==='local')?.path||p.roots?.[0]?.path||''}));}catch(e){if(!/method.*not.*found|unknown.*method|-32601/i.test(e.message))throw e;}
      const byId=new Map(projects.map(p=>[p.id,p]));
      const items=[...threads.values()].filter(t=>t.cwd&&!t.archived&&t.canAcceptDirectInput!==false&&['cli','vscode','appServer'].includes(t.source)).map(t=>({id:t.id,title:t.name||t.preview?.split('\n')[0]?.slice(0,100)||'未命名对话',preview:t.preview?.slice(0,140)||'',workspace:t.cwd,projectId:t.projectId,projectName:byId.get(t.projectId)?.name,updatedAt:t.updatedAt,running:t.status?.type==='active',loaded:loaded.has(t.id),source:t.source,mode:'native-existing'}));
      return{items,projects};
    });
  }
  async isQueued({sessionId,workMarker}) {
    return this.read(async rpc => {
      const queue = await rpc.call('thread/queue/list', {threadId:sessionId,limit:100});
      return queue.data?.some(item => JSON.stringify(item).includes('claim_step '+workMarker)) || false;
    });
  }
  async executionState({sessionId}) {
    // Read only this already-bound thread's metadata; never inspect other chats.
    return this.read(async rpc => {
      const {thread}=await rpc.call('thread/read',{threadId:sessionId,includeTurns:false});
      return {state:thread.status?.type==='active'?'running':thread.status?.type==='idle'?'idle':'unknown'};
    });
  }
  async queue({sessionId,workspace,prompt,isCompleted}) {
    const list=await this.sessions(),s=list.items.find(s=>s.id===sessionId);if(!s||path.resolve(s.workspace)!==path.resolve(workspace))throw Error('原 Codex 会话未开启或项目已变化，未创建替代会话');
    return this.read(async rpc=>{
      await rpc.call('thread/resume',{threadId:sessionId,excludeTurns:true});
      const hash=createHash('sha256').update(sessionId+'\n'+prompt).digest('hex'),clientUserMessageId=[hash.slice(0,8),hash.slice(8,12),'4'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20,32)].join('-');
      const {queuedSubmission}=await rpc.call('thread/queue/add',{threadId:sessionId,clientUserMessageId,input:[{type:'text',text:prompt}]});
      const deadline=Date.now()+20*60000;
      let nextReceiptCheck=0;
      while(Date.now()<deadline){
        const queue=await rpc.call('thread/queue/list',{threadId:sessionId,limit:100});
        if(!queue.data?.some(q=>q.id===queuedSubmission.id))return; // native UI already consumed it
        // This exact Hub message may have been handled by the original session
        // through a concurrent user turn. Only an authoritative completed
        // receipt allows deleting our own redundant queued wake. Never interrupt
        // the active turn or delete any other user's queued message.
        if(isCompleted&&Date.now()>=nextReceiptCheck){
          nextReceiptCheck=Date.now()+5000;
          if(await isCompleted().catch(()=>false)){
            await rpc.call('thread/queue/delete',{threadId:sessionId,queuedSubmissionId:queuedSubmission.id});
            return;
          }
        }
        const {thread}=await rpc.call('thread/read',{threadId:sessionId,includeTurns:false});
        if(thread.status?.type==='idle'&&queue.data[0]?.id===queuedSubmission.id){await rpc.call('thread/queue/start',{threadId:sessionId,queuedSubmissionId:queuedSubmission.id});return;}
        await new Promise(r=>setTimeout(r,1500));
      }
      throw Object.assign(Error('原 Codex 工作尚未结束，消息仍在原队列中，未打断或重复发送'), {code:'native_queued'});
    });
  }
}

class CodexSocketRpc {
  constructor(socket){this.pending=new Map();this.id=0;this.ws=new WebSocket('ws://localhost/',{createConnection:()=>net.createConnection(socket),handshakeTimeout:10000});this.ready=new Promise((r,j)=>{this.ws.once('open',r);this.ws.once('error',j);});this.ws.on('error',()=>{});this.ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.method){if(m.id!==undefined&&this.onRequest)Promise.resolve().then(()=>this.onRequest(m.method,m.params||{})).then(result=>{if(result!==undefined)this.send({jsonrpc:'2.0',id:m.id,result});}).catch(()=>{});else this.onNotification?.(m.method,m.params||{});return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});this.ws.on('close',()=>this.fail());}
  send(m){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(m));}
  async call(method,params){await this.ready;const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('原 Codex 运行端暂未响应'));},15000);this.pending.set(id,{resolve,reject,timer});this.send({jsonrpc:'2.0',id,method,params});});}
  fail(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('原 Codex 连接已关闭'));}this.pending.clear();}
  async stop(){this.fail();this.ws.close();}
}
