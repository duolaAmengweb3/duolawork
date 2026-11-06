// Dedicated process: indexing and embedding never block chat delivery.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {forgottenLedger,scrubMemoryReceipts} from '../memory-ledger.mjs';
import {openDatabase} from '../sqlite.mjs';
import {Repository} from './repository.mjs';
process.env.MEM0_TELEMETRY='false';
const config=JSON.parse(await fs.readFile(process.env.HUB_SERVER_CONFIG,'utf8'));
const options=config.memory;
if(!options?.embedding?.apiKey||!options.qdrant?.url)throw Error('Memory embedding and Qdrant configuration required');
const {Memory}=await import('mem0ai/oss');
const db=openDatabase(config.database,path.join(import.meta.dirname,'../migrations'));
const repo=new Repository(db,config.workspaceId);
const engine=new Memory({disableHistory:true,embedder:{provider:'openai',config:options.embedding},llm:{provider:'openai',config:{apiKey:'unused-no-generation',model:'unused'}},vectorStore:{provider:'qdrant',config:{url:options.qdrant.url,apiKey:options.qdrant.apiKey,collectionName:options.collection||'duolawork_shared_memory_v1',dimension:options.dimension||1024,onDisk:true}}});
// Mem0 3.3.1 exposes its OpenAI client but does not forward timeout config.
// Pin this integration and test it when upgrading; no source patch in Mem0.
engine.embedder.openai.timeout=10000;
engine.embedder.openai.maxRetries=0;
engine.embedder.openai.fetch=globalThis.fetch;
let closing=false,indexing=false,lastSuccess=null,lastFailure=null,processed=0,searches=0;
const scoped=m=>m.memoryScope==='workspace'?'__workspace':m.scopeId;
async function indexOne(job){
  const current=await repo.get('channel_memory',job.id,false);
  await engine.deleteAll({userId:repo.workspaceId,runId:job.id});
  if(current?.status==='approved'&&!current.sourceUnavailable){
    await engine.add([{role:'user',content:current.title+'\n'+current.body+(current.conditions?'\n适用条件：'+current.conditions:'')}],{userId:repo.workspaceId,agentId:scoped(current),runId:current.id,infer:false,metadata:{hubMemoryId:current.id,hubVersion:current.version,hubScope:current.scopeId}});
  }
  if(await repo.get('memory_tombstone',job.id,false))await scrubMemoryReceipts(db,repo.workspaceId,job.id);
  await repo.transact('memory-index:'+job.id+':'+job.revision+':'+Date.now(),{id:job.id,revision:job.revision},async tx=>{
    const latest=await tx.get('channel_memory',job.id,false),fresh=await tx.get('memory_index_job',job.id);
    if(fresh.revision!==job.revision||latest?.version!==current?.version)return;
    tx.put('memory_index_job',{...fresh,status:'done',indexedVersion:current?.version||0,indexedAt:tx.now,lastError:null});
  });
  processed++;lastSuccess=new Date().toISOString();
}
async function tick(){
  if(indexing||closing)return;indexing=true;
  try{
    // Save deletion intent before any network dependency. Embedding outages do
    // not prevent the independent deletion ledger or receipt cleanup.
    const tombstones=await forgottenLedger(db,repo.workspaceId,config.database);
    for(const row of tombstones){const job=await repo.get('memory_index_job',row.id,false);if(job?.status==='pending')await scrubMemoryReceipts(db,repo.workspaceId,row.id);}
    const due=await db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='memory_index_job' AND status='pending' AND (json_extract(body,'$.retryAt') IS NULL OR json_extract(body,'$.retryAt')<=?) ORDER BY updated_at,id LIMIT 100").bind(repo.workspaceId,new Date().toISOString()).all();
    const jobs=due.results.map(r=>JSON.parse(r.body));
    for(const job of jobs){
      if(closing)break;if(job.retryAt&&job.retryAt>new Date().toISOString())continue;
      try{await indexOne(job);}catch{
        lastFailure=new Date().toISOString();
        await repo.transact('index-retry:'+job.id+':'+Date.now(),{},async tx=>{const fresh=await tx.get('memory_index_job',job.id);if(fresh.revision!==job.revision)return;tx.put('memory_index_job',{...fresh,status:'pending',attempts:(job.attempts||0)+1,lastError:'语义索引暂不可用，将自动重试',retryAt:new Date(Date.now()+Math.min(300000,5000*2**Math.min(job.attempts||0,6))).toISOString()});});
      }
    }
  }catch{lastFailure=new Date().toISOString();}finally{indexing=false;}
}
await forgottenLedger(db,repo.workspaceId,config.database,{restore:true});
let after='';for(;;){
  const rows=await repo.list('channel_memory',{after,limit:500});
  for(const m of rows)if(!await repo.get('memory_index_job',m.id,false))await repo.transact('memory-backfill:'+m.id+':'+m.version,{},tx=>tx.put('memory_index_job',{id:m.id,scopeId:m.scopeId,status:'pending',memoryVersion:m.version,attempts:0}));
  if(rows.length<500)break;after=rows.at(-1).id;
}
// Probe both embeddings and persisted vectors after restart, even with an empty queue.
try{await engine.search('DuolaWork memory service readiness',{topK:1,filters:{user_id:repo.workspaceId,agent_id:'__readiness__'}});lastSuccess=new Date().toISOString();}catch{lastFailure=new Date().toISOString();}
const server=http.createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  try{
    if(req.url==='/status'&&req.method==='GET'){
      const pending=await db.prepare("SELECT count(*) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='memory_index_job' AND status='pending'").bind(repo.workspaceId).first();
      return send(200,{configured:true,state:lastFailure&&(!lastSuccess||lastFailure>lastSuccess)?'degraded':lastSuccess?'ready':'initializing',model:options.embedding.model,pending:pending.n,processed,lastSuccess,lastFailure});
    }
    if(req.url!=='/search'||req.method!=='POST')return send(404,{error:'not_found'});
    if(searches>=3||closing)return send(503,{error:'busy'});
    let body='';for await(const chunk of req){body+=chunk;if(body.length>16000)return send(413,{error:'too_large'});}
    const args=JSON.parse(body);
    if(typeof args.query!=='string'||args.query.length>8000||!Array.isArray(args.allowedScopes)||args.allowedScopes.length>100||args.allowedScopes.some(x=>typeof x!=='string'||x.length>200))return send(400,{error:'invalid_query'});
    searches++;
    try{
      const results=[];
      for(const scope of new Set(args.allowedScopes)){
        const found=await engine.search(args.query,{topK:8,filters:{user_id:repo.workspaceId,agent_id:scope}});
        results.push(...found.results.map(m=>({memoryId:m.metadata?.hubMemoryId,version:m.metadata?.hubVersion,score:m.score})));
      }
      lastSuccess=new Date().toISOString();send(200,{results:results.sort((a,b)=>b.score-a.score).slice(0,20)});
    }finally{searches--;}
  }catch{lastFailure=new Date().toISOString();send(503,{error:'memory_unavailable'});}
});
server.requestTimeout=15000;server.headersTimeout=5000;
server.listen(options.port||8791,'127.0.0.1');const timer=setInterval(tick,2500);void tick();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(closing)return;closing=true;clearInterval(timer);server.close();server.closeIdleConnections();
  const drain=setInterval(()=>{if(!indexing&&!searches){clearInterval(drain);db.close();process.exit(0);}},100);
  setTimeout(()=>process.exit(1),20000).unref();
});
