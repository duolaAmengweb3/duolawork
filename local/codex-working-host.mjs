import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import WebSocket from 'ws';
import {findExecutable} from './native-agent.mjs';
const execute=promisify(execFile);

// Read metadata and queue into the original daemon. Never resume a GUI thread
// on Hub's separate App Server, change its model, or take over its approvals.
export class CodexWorkingHost {
  constructor({exec=execute,home=os.homedir(),rpcFactory}={}) {Object.assign(this,{exec,home,rpcFactory});}
  async socket() {
    const {stdout}=await this.exec('/bin/ps',['-ax','-o','pid=,command=']);
    const pids=stdout.split('\n').flatMap(l=>{const m=l.match(/^\s*(\d+)\s+(.+)$/);return m&&m[2].startsWith(path.join(this.home,'.codex/packages/app-server-daemon/'))&&m[2].includes('--listen unix://')?[m[1]]:[];});
    const candidates=new Set();for(const pid of pids){const {stdout}=await this.exec('/usr/sbin/lsof',['-a','-p',pid,'-U','-Fn']);for(const l of stdout.split('\n'))if(l.startsWith('n/private/tmp/codex-daemon-'+process.getuid()+'/'))candidates.add(l.slice(1));}
    if(candidates.size!==1)throw Error('原 Codex 运行端未开启或实例不唯一，请先在 Codex 中打开工作会话');return [...candidates][0];
  }
  async read(fn) {
    const socket=await this.socket(),rpc=this.rpcFactory?this.rpcFactory(socket):new CodexSocketRpc(socket);
    try {await rpc.call('initialize',{clientInfo:{name:'agent-hub-session-picker',version:'1.0.0'},capabilities:{experimentalApi:true}});rpc.send({jsonrpc:'2.0',method:'initialized',params:{}});return await fn(rpc,socket);}finally{await rpc.stop();}
  }
  async sessions() {
    return this.read(async rpc=>{const loaded=await rpc.call('thread/loaded/list',{}),items=[];
      for(const id of loaded.data||[]){const {thread:t}=await rpc.call('thread/read',{threadId:id,includeTurns:false});if(!t.cwd||t.archived||t.canAcceptDirectInput===false||!['cli','vscode','appServer'].includes(t.source))continue;
        items.push({id:t.id,title:t.name||t.preview?.split('\n')[0]?.slice(0,100)||'Codex 原工作会话',preview:t.preview?.slice(0,140)||'',workspace:t.cwd,projectId:t.projectId,updatedAt:t.updatedAt,running:t.status?.type==='active',source:t.source,mode:'native-existing'});
      }return{items};});
  }
  async queue({sessionId,workspace,prompt}) {
    const list=await this.sessions(),s=list.items.find(s=>s.id===sessionId);if(!s||path.resolve(s.workspace)!==path.resolve(workspace))throw Error('原 Codex 会话未开启或项目已变化，未创建替代会话');
    const command=await findExecutable('codex');if(!command)throw Error('缺少官方 Codex 命令');
    await this.exec(command,['queue','--remote','unix://'+await this.socket(),'--thread',sessionId,'--message',prompt],{cwd:workspace,timeout:30000,maxBuffer:1024*1024});
  }
}

class CodexSocketRpc {
  constructor(socket){this.pending=new Map();this.id=0;this.ws=new WebSocket('ws://localhost/',{createConnection:()=>net.createConnection(socket),handshakeTimeout:10000});this.ready=new Promise((r,j)=>{this.ws.once('open',r);this.ws.once('error',j);});this.ws.on('error',()=>{});this.ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.method){this.onNotification?.(m.method,m.params||{});return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});this.ws.on('close',()=>this.fail());}
  send(m){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(m));}
  async call(method,params){await this.ready;const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('原 Codex 运行端暂未响应'));},15000);this.pending.set(id,{resolve,reject,timer});this.send({jsonrpc:'2.0',id,method,params});});}
  fail(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('原 Codex 连接已关闭'));}this.pending.clear();}
  async stop(){this.fail();this.ws.close();}
}
