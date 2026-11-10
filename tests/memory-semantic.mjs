import fs from 'node:fs/promises';import crypto from 'node:crypto';import {performance} from 'node:perf_hooks';import {records} from './memory-evaluation.mjs';
if(!process.env.HUB_EMBEDDING_CONFIG)throw Error('Set private HUB_EMBEDDING_CONFIG; no credentials in tests');
process.env.MEM0_TELEMETRY='false';
const {setGlobalDispatcher}=await import('undici');const {networkDispatcher}=await import('../local/transport.mjs');setGlobalDispatcher(networkDispatcher());
const {Memory}=await import('../server/memory-runtime/node_modules/mem0ai/dist/oss/index.mjs');
const embedding=JSON.parse(await fs.readFile(process.env.HUB_EMBEDDING_CONFIG,'utf8'));
const memory=new Memory({disableHistory:true,embedder:{provider:'openai',config:embedding},llm:{provider:'openai',config:{apiKey:'unused',model:'unused'}},vectorStore:{provider:'qdrant',config:{url:process.env.HUB_QDRANT_URL||'http://127.0.0.1:16335',dimension:1024,collectionName:'duolawork_memory_evaluation'}}});let lastFetch=0;memory.embedder.openai.fetch=async(...args)=>{const wait=Math.max(0,1250-(Date.now()-lastFetch));if(wait)await new Promise(r=>setTimeout(r,wait));lastFetch=Date.now();return globalThis.fetch(...args);};memory.embedder.openai.timeout=10000;memory.embedder.openai.maxRetries=0;
const userId='isolated-evaluation',agentId='authorized-group',measurements=[],failures=[];
await memory.deleteAll({userId});
for(const r of records)await memory.add([{role:'user',content:r.title+'\n'+r.body}],{userId,agentId,runId:r.id,infer:false,metadata:{sourceId:r.id,version:1}});
console.log('40 deidentified sources indexed using real Mem0 and persistent Qdrant');
for(const r of records)for(const q of r.questions){const start=performance.now();const result=await memory.search(q.query,{topK:8,filters:{user_id:userId,agent_id:agentId}});const hit=result.results.some(x=>x.metadata?.sourceId===r.id);measurements.push({sourceId:r.id,split:q.split,hit,ms:Math.round(performance.now()-start)});if(!hit)failures.push({sourceId:r.id,query:q.query,retrieved:result.results.map(x=>x.metadata?.sourceId)});}
const percent=rows=>Math.round(1000*rows.filter(x=>x.hit).length/rows.length)/10;const sorted=measurements.map(x=>x.ms).sort((a,b)=>a-b);
const evidence={at:new Date().toISOString(),scope:'Controlled semantic retrieval; actual Mem0 3.3.1, Qdrant 1.18.3, Workers AI bge-m3. Does not prove native Agent behavior or independent human usefulness.',datasetSha256:crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'),sourceCount:40,queries:measurements.length,recallAt8:percent(measurements),heldOutRecallAt8:percent(measurements.filter(x=>x.split==='held-out')),p95Ms:sorted[Math.ceil(sorted.length*.95)-1],failures,measurements};
await fs.writeFile('evidence/memory-semantic.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({...evidence,measurements:undefined}));process.exit(evidence.recallAt8>=90&&evidence.heldOutRecallAt8>=90?0:1);
