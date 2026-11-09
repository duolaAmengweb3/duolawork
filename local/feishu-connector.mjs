import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {findExecutable} from './native-agent.mjs';
import {privateJson} from './storage.mjs';
import {requestJson} from './transport.mjs';
import {runFeishu,parseFeishu,feishuIdentity} from './feishu-cli.mjs';
export class FeishuConnector{
 constructor(config,dataDir,host,{find=findExecutable,request=requestJson}={}){this.config=config;this.root=path.join(dataDir,'feishu-connectors');this.host=host;this.find=find;this.request=request;this.pending=new Map();}
 async accounts(){
  const command=await this.find('lark-cli');if(!command)return {installed:false,accounts:[],message:'请先在这台电脑安装飞书官方 CLI 并登录，然后刷新；现有登录不会被替换。'};
  const profiles=parseFeishu(await runFeishu(command,['profile','list']));
  const accounts=[];for(const p of profiles){if(p.brand!=='feishu'||!p.user)continue;const r=await runFeishu(command,['--profile',p.name,'whoami']);let who;try{who=parseFeishu(r);}catch{continue;}
   if(!r.exitCode&&who.available&&who.identity==='user'&&who.onBehalfOf?.openId)accounts.push({profile:p.name,name:who.onBehalfOf.userName||p.user,appId:who.appId,openId:who.onBehalfOf.openId,command});
  }
  return {installed:true,accounts};
 }
 async status(){const r=await this.accounts();return {...r,accounts:r.accounts.map(({command,openId,appId,...a})=>a)};}
 async connect(profile){
  const r=await this.accounts();if(!r.installed||!r.accounts.length)throw new Error(r.message||'未找到已登录的飞书用户，请先在官方 CLI 登录，再刷新。');
  const a=profile?r.accounts.find(a=>a.profile===profile):r.accounts.length===1?r.accounts[0]:null;
  if(!a)return {chooseAccount:true,accounts:r.accounts.map(({profile,name})=>({profile,name}))};
  const key=createHash('sha256').update(this.config.endpoint+':'+a.profile+':'+a.appId+':'+a.openId).digest('hex').slice(0,24);
  if(this.pending.has(key))return this.pending.get(key);
  const work=this.save(a,key).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
 }
 async save(a,key){
  const cwd=path.join(this.root,key);await fs.mkdir(cwd,{recursive:true,mode:0o700});const descriptor=path.join(cwd,'account.json');
  const binding={command:a.command,profile:a.profile,appId:a.appId,openId:a.openId,cwd};await feishuIdentity(binding);
  // Only native CLI account identifiers live here. OAuth tokens stay in its own store.
  await privateJson(descriptor,binding);
  const {hostId}=await this.host.connect(),endpoint=this.config.endpoint+'/v2/connectors';
  const existing=await this.request(endpoint,{token:this.config.adminKey});
  let saved;try{saved=JSON.parse(await fs.readFile(path.join(cwd,'connection.json'),'utf8'));}catch{}
  const current=existing.items.find(c=>c.id===saved?.connectionId);
  if(current&&current.status!=='disconnected'&&current.hostId===hostId)return this.request(endpoint,{method:'POST',token:this.config.adminKey,timeout:45000,body:{action:'check',connectionId:current.id,requestId:crypto.randomUUID()}});
  const result=await this.request(endpoint,{method:'POST',token:this.config.adminKey,timeout:45000,body:{action:'save',requestId:current?crypto.randomUUID():'feishu:'+key+':'+hostId,...(current?{connectionId:current.id,expectedVersion:current.version}:{}),provider:'feishu',name:'飞书 · '+a.name,transport:'stdio',hostId,command:process.execPath,args:[fileURLToPath(new URL('./feishu-mcp-bundle.cjs',import.meta.url)),descriptor],env:{ELECTRON_RUN_AS_NODE:'1'},authType:'none'}});
  if(result.connection?.id)await privateJson(path.join(cwd,'connection.json'),{connectionId:result.connection.id});return result;
 }
}
