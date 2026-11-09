import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mcpTools} from '../shared/mcp-client.mjs';
import {requestJson} from './transport.mjs';
import os from 'node:os';

// This process hosts tools only. It never launches an Agent or reads its login.
export class McpToolHost{
 constructor(config){this.config=config;this.sessions=new Map();this.sessionUsers=new Map();this.latestSession=new Map();this.running=false;this.stopping=false;this.active=new Set();}
 async request(args){return requestJson(this.config.endpoint+'/v2/connectors/host',{method:'POST',token:this.config.token,body:{hostId:this.config.hostId,...args}});}
 async session(job){
  const key=this.sessionKey(job);this.latestSession.set(job.scopeId,key);await this.prune(job.scopeId);
  if(this.sessions.has(key))return this.sessions.get(key);
  const pending=this.openSession(job).catch(e=>{this.sessions.delete(key);throw e;});this.sessions.set(key,pending);return pending;
 }
 sessionKey(job){return job.scopeId+':'+(job.executionRevision||job.connectionVersion);}
 async prune(scope){for(const [key,pending]of this.sessions)if(key.startsWith(scope+':')&&key!==this.latestSession.get(scope)&&!this.sessionUsers.get(key)){this.sessions.delete(key);await pending.then(s=>s.client.close()).catch(()=>{});}}
 async openSession(job){
  const {command,args=[],env={},cwd}=job.config;
  const client=new Client({name:'DuolaWork-tool-host',version:'1.0.0'});
  const transport=new StdioClientTransport({command,args,env:{...process.env,...env},...(cwd?{cwd}:{}),stderr:'pipe'});
  // Consume stderr without publishing arbitrary tool logs or credentials.
  transport.stderr?.on('data',()=>{});
  try{await client.connect(transport,{timeout:20000});}catch(e){await client.close().catch(()=>{});throw e;}
  return {client,transport};
 }
 async execute(job){
  const key=this.sessionKey(job);this.sessionUsers.set(key,(this.sessionUsers.get(key)||0)+1);
  try{
   const {client}=await this.session(job);
   const result=job.action==='tools'?await mcpTools(client):await client.callTool({name:job.tool,arguments:job.arguments||{}},undefined,{timeout:30000});
   await this.request({action:'complete',jobId:job.id,lease:job.lease,result});
  }catch{await this.request({action:'complete',jobId:job.id,lease:job.lease,error:true}).catch(()=>{});}finally{this.sessionUsers.set(key,Math.max(0,(this.sessionUsers.get(key)||1)-1));await this.prune(job.scopeId);}
 }
 async tick(){
  const response=await this.request({action:'poll',batch:true,environment:{hostname:os.hostname(),platform:process.platform,node:process.versions.node}});
  for(const job of response.jobs||(response.job?[response.job]:[])){const work=this.execute(job);this.active.add(work);work.finally(()=>this.active.delete(work));}
 }
 async start(){
  if(this.running)return;this.running=true;
  while(!this.stopping){try{await this.tick();}catch(e){if([401,403].includes(e.status))this.stopping=true;}if(!this.stopping)await new Promise(r=>{this.wake=r;this.timer=setTimeout(r,750);});}
  await Promise.allSettled([...this.active]);await Promise.allSettled([...this.sessions.values()].map(async s=>(await s).client.close()));this.running=false;
 }
 async stop(){this.stopping=true;clearTimeout(this.timer);this.wake?.();}
}
