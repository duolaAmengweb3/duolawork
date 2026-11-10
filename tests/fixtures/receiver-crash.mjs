// An isolated child of the fault test. Never runs a provider or user session.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DshConnector} from '../../local/dsh-connector.mjs';
const [dir,mode]=process.argv.slice(2),stateFile=path.join(dir,'state.json'),sessionId='isolated-crash-session';
const delivery={attempt:0,message:{id:'original-message',version:1,body:'keep the exact full requirement'}};
const agent={id:sessionId,session:{},ctx:{tools:{register:()=>()=>{}}}};
const client={credentials:async()=>({memberId:'isolated-member'}),tools:async()=>[],inbox:async()=>({work:[{stepId:'crash-work',channelId:'isolated-channel',status:'ready',delivery}]}),api:async(route,{body}={})=>{
 if(route==='/v2/self/delivery'){const state=JSON.parse(await fs.readFile(stateFile));if(state.bindings[0].received['crash-work'].message.body!==delivery.message.body)throw Error('ACK without exact persisted content');await fs.appendFile(path.join(dir,'acks.jsonl'),JSON.stringify(body)+'\n');}return{};
}};
const c=await new DshConnector({stateFile,pollMs:1e7,clientFactory:()=>client,ctx:{workingDirectory:{get:()=>dir},sessionController:{list:async()=>({items:[{sessionId,cwd:dir,running:false}]}),resolveAgent:async()=>({agent}),prompt:async()=>{await fs.appendFile(path.join(dir,'prompts'),'one\n');return{accepted:true};}}}}).start();
if(!c.bindings.size)await c.bind({sessionId,workspace:dir,grantFile:path.join(dir,'grant.json'),channelIds:['isolated-channel']});
const save=c.save.bind(c);c.save=async()=>{await save();const state=JSON.parse(await fs.readFile(stateFile));if(mode==='crash'&&state.bindings[0].received?.['crash-work']){process.send({durable:true});await new Promise(()=>{});}};
await c.poll();await c.stop();process.send({done:true});process.disconnect();
