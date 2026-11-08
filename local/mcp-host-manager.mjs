import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import toolHostRuntime from './mcp-tool-host-bundle.cjs';
const {McpToolHost}=toolHostRuntime;
import {requestJson} from './transport.mjs';
export class McpHostManager{
 constructor(config,dataDir){this.config=config;this.file=path.join(dataDir,'shared-tool-host.json');}
 async load(){try{const c=JSON.parse(await fs.readFile(this.file,'utf8'));if(c.endpoint===this.config.endpoint){this.host=new McpToolHost(c);this.host.start().catch(()=>{});return {hostId:c.hostId};}}catch{}return {};}
 async connect(){
  if(this.host&&!this.host.stopping)return {hostId:this.host.config.hostId};
  if(this.pending)return this.pending;
  this.pending=(async()=>{
   const args={action:'host.create',name:'这台电脑 · '+os.hostname(),requestId:crypto.randomUUID()};
   const created=await requestJson(this.config.endpoint+'/v2/connectors',{method:'POST',token:this.config.adminKey,body:args});
   const paired=await requestJson(this.config.endpoint+'/v2/connectors/host',{method:'POST',body:{action:'pair',hostId:created.hostId,code:created.code,environment:{hostname:os.hostname(),platform:process.platform}}});
   const record={...paired,endpoint:this.config.endpoint};await fs.writeFile(this.file,JSON.stringify(record),{mode:0o600});await fs.chmod(this.file,0o600);
   this.host=new McpToolHost(record);await this.host.tick();this.host.start().catch(()=>{});return {hostId:paired.hostId};
  })().finally(()=>{this.pending=null;});return this.pending;
 }
 async stop(){await this.host?.stop();}
}
