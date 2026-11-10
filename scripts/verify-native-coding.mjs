import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readConfig,dataDir,privateJson} from '../local/storage.mjs';
import {requestJson} from '../local/transport.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
const config=await readConfig();
const owner=(route,body)=>requestJson(config.endpoint+route,{token:config.adminKey,...(body===undefined?{}:{method:'POST',body})});
const local=(body)=>requestJson('http://127.0.0.1:8766/api/action',{method:'POST',body});
const state=await requestJson('http://127.0.0.1:8766/api/state');
const manager=new CodingManager({config,dataDir});await manager.load();
const evidence={at:new Date().toISOString(),members:[],providerConfigurationChanged:false,existingIdeSessionClaim:false,subscriptionClaudeCodeInvoked:false};
try{
 for(const engine of ['codex','antigravity']){
  const name=engine==='codex'?'Codex':'Gemini';
  if(!state.platforms.some(p=>p.id===engine))await local({type:'platform.create',payload:{id:engine,name:engine==='codex'?'Codex':'Gemini · Antigravity',nativeAgents:true}});
  let member=state.members.find(m=>m.platformId===engine&&m.name===name&&m.status!=='disabled');
  if(!member){const {result:account}=await local({type:'account.create',payload:{platformId:engine,label:name}});member=(await local({type:'member.create',payload:{accountId:account.id,name,mode:'connector'}})).result;}
  evidence.members.push({engine,memberId:member.id});
  if(!manager.records[member.id])await manager.connect({memberId:member.id,engine});
 }
 await manager.start();
 const end=Date.now()+12*60000;let old='';
 while(Date.now()<end){
  const status=manager.status();const signature=JSON.stringify(status.members.map(m=>[m.engine,m.status,m.message]));if(signature!==old){console.log(signature);old=signature;}
  if(status.members.every(m=>['needs_review','paused'].includes(m.status)))break;
  if(status.members.every(m=>m.lastCompletedAt||m.status==='needs_review'))break;
  await new Promise(r=>setTimeout(r,1500));
 }
 const w=await owner('/v2/workspace');
 for(const item of evidence.members){const r=manager.records[item.memberId],c=w.connections.find(c=>c.id===item.memberId);Object.assign(item,{status:r.status,message:r.message,verified:c?.status==='verified',verifiedAt:c?.verifiedAt||null,sessions:r.sessions,lastReceiptAt:r.lastReceiptAt||null});}
 await privateJson(path.join(process.cwd(),'evidence/native-coding.json'),evidence);
 console.log(JSON.stringify(evidence));
}finally{await manager.stop();}
