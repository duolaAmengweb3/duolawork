import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {skillSettings,skillTool,parseSkill,skillCatalog} from '../cloud/collaboration/skills.mjs';
import {connectorSettings,connectorTool} from '../cloud/collaboration/connectors.mjs';
import {importGithubSkill,fileBytes,fileHash} from '../cloud/collaboration/skill-package.mjs';
import {activityPage} from '../cloud/collaboration/service-activity.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
const owner={owner:true},agent={memberId:'grok'},peer={memberId:'check'},outsider={memberId:'write'};
const files={'SKILL.md':'---\nname: verify-source\ndescription: 核对资料\ncompatibility: Node 22\n---\nRead references/check.md and scripts/check.mjs when needed.','references/check.md':'核对原文','scripts/check.mjs':'console.log("ok")','assets/icon.bin':{encoding:'base64',data:'AP8BAg=='}};
async function setup(t){
 const f=await fixture(t);const send=(type,args={},actor=owner)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:crypto.randomUUID(),...args});
 const c=await send('channel.create',{name:'技能协作',memberIds:['grok','check','write'],coordinatorId:'grok'});
 const save=args=>skillSettings(f.repo,f.identity,owner,{action:'save',requestId:crypto.randomUUID(),files,channelIds:[c.id],...args});
 const task=args=>send('channel.task',{channelId:c.id,action:'create',notifyAssignee:false,...args});
 const tool=(name,args={},actor=agent)=>skillTool(f.repo,actor,name,{requestId:crypto.randomUUID(),channelId:c.id,...args});
 return {...f,c,send,save,task,tool};
}
test('task pins survive skill edits, children inherit and revoked methods do not prevent Todo creation',async t=>{
 const f=await setup(t),s=await f.save({});
 const root=await f.task({title:'发布',skillRefs:[{skillId:s.id,version:1}]});
 await f.save({skillId:s.id,expectedVersion:1,files:{...files,'references/check.md':'第二版'}});
 const child=await f.task({title:'核对',parentTaskId:root.id});assert.equal(child.skillRefs[0].version,1);
 const read=await f.tool('read_skill',{skillId:s.id,taskId:child.id,path:'references/check.md'});assert.equal(read.body,'核对原文');assert.equal(read.version,1);
 assert.equal((await f.tool('read_skill',{skillId:s.id,path:'references/check.md'})).body,'第二版');
 await f.save({skillId:s.id,expectedVersion:2,enabled:false});
 assert.equal((await f.task({title:'可继续记事',parentTaskId:root.id})).skillRefs[0].version,1);
 await assert.rejects(f.tool('read_skill',{skillId:s.id,taskId:child.id}),e=>e.code==='forbidden');
 assert.equal((await f.tool('skill_activity',{taskId:child.id},owner)).items[0].readId,undefined);assert.equal((await f.tool('skill_activity',{taskId:child.id},owner)).items[0].version,1);
 await assert.rejects(f.task({title:'显式选停用技能',skillRefs:[{skillId:s.id,version:1}]}),e=>e.code==='skill_unavailable');
 const foreign=await f.send('channel.create',{name:'私有群',memberIds:['grok']});
 const privateSkill=await f.save({channelIds:[foreign.id]});
 await assert.rejects(f.task({title:'错误跨群',skillRefs:[{skillId:privateSkill.id,version:1}]}),e=>e.code==='skill_unavailable');
});
test('use receipts bind reader, exact version and task; independent reviews require another authorized member and sources',async t=>{
 const f=await setup(t),s=await f.save({memberIds:['grok','check']}),task=await f.task({title:'核验'});
 const read=await f.tool('read_skill',{skillId:s.id,taskId:task.id});
 await f.save({skillId:s.id,expectedVersion:1});
 const report={skillId:s.id,version:1,readId:read.readId,taskId:task.id,summary:'核对三条来源',environment:'独立原环境',dependencyStatus:'ready',execution:[{command:'node check.mjs',exitCode:0,artifact:'result.json'}]};
 await assert.rejects(f.tool('report_skill_use',report,peer),e=>e.code==='invalid_read');
 await assert.rejects(f.tool('report_skill_use',{...report,taskId:undefined}),e=>e.code==='invalid_read');
 await assert.rejects(f.tool('report_skill_use',{...report,readId:undefined}),e=>e.code==='version_conflict');
 await assert.rejects(f.tool('report_skill_use',{...report,dependencyStatus:'missing'}),e=>e.code==='invalid_outcome');
 const use=await f.tool('report_skill_use',report);assert.equal(use.evidence,'agent_reported');assert.equal(use.version,1);
 await assert.rejects(f.tool('review_skill_use',{useId:use.id,outcome:'passed',summary:'自评'}),e=>e.code==='self_review');
 await assert.rejects(f.tool('review_skill_use',{useId:use.id,outcome:'passed',summary:'无依据'},peer),e=>e.code==='source_required');
 const refs=[{kind:'task',id:task.id,version:1}];
 await assert.rejects(f.tool('review_skill_use',{useId:use.id,outcome:'passed',summary:'不可见',refs},outsider),e=>e.code==='forbidden');
 const review=await f.tool('review_skill_use',{useId:use.id,outcome:'passed',summary:'独立核对产物三条',refs},peer);assert.equal(review.useId,use.id);assert.equal(review.version,1);assert.equal(review.evidence,'peer_reviewed');
 const blocked=await f.tool('report_skill_use',{skillId:s.id,version:2,summary:'没有运行依赖',outcome:'blocked',dependencyStatus:'missing',missingDependencies:['Node 22'],taskId:task.id});assert.equal(blocked.outcome,'blocked');
 const list=await f.tool('skill_activity',{taskId:task.id});assert.equal(list.items.length,4);
 assert.deepEqual((await f.tool('skill_activity',{},outsider)).items,[]);
 assert.equal((await f.repo.list('channel_message')).length,0);
});
test('activity pagination retains legacy use records without inventing reads or changing stored history',async t=>{
 const f=await setup(t),s=await f.save({});
 await f.repo.transact('old-activity',{},tx=>{for(let i=0;i<53;i++)tx.put(i===0?'skill_use':'skill_activity',{id:'event-'+String(i).padStart(3,'0'),parentId:s.id,scopeId:f.c.id,memberId:'grok',version:1,summary:'old '+i,...(i?{event:'read'}:{}),createdAt:tx.now});return {};});
 const a=await activityPage(f.repo,'skill_activity',{parent:s.id}),b=await activityPage(f.repo,'skill_activity',{parent:s.id,after:a.next});
 assert.equal(a.items.length,50);assert.equal(b.items.length,3);assert.equal(b.next,null);assert.equal(new Set([...a.items,...b.items].map(x=>x.id)).size,53);
 const legacy=[...a.items,...b.items].find(x=>x.legacy);assert.equal(legacy.event,'use');assert.equal(legacy.readId,undefined);assert.equal((await f.repo.get('skill_use',legacy.id)).event,undefined);
 const review=await f.tool('review_skill_use',{useId:legacy.id,outcome:'passed',summary:'人类核对原记录'},owner);assert.equal(review.evidence,'owner_reviewed');
});
test('group methods retain source versions and limits, cannot be promoted across private scopes, hide when source removed',async t=>{
 const f=await setup(t),doc=await f.send('channel.doc.create',{channelId:f.c.id,title:'实操记录',body:'来源和结果'});
 const args={files,conditions:'同类资料核对',limitations:'没有原文时不可推断',refs:[{kind:'document',id:doc.id,version:1}]};
 await assert.rejects(f.tool('save_method',{...args,refs:[]}),e=>e.code==='source_required');
 const method=await f.tool('save_method',args);assert.equal(method.mandatory,false);assert.deepEqual(method.channelIds,[f.c.id]);
 assert.equal((await f.tool('read_skill',{skillId:method.id})).derivedFrom.refs[0].version,1);
 await assert.rejects(f.tool('save_method',{...args,skillId:method.id,expectedVersion:1},outsider),e=>e.code==='forbidden');
 await assert.rejects(f.save({skillId:method.id,expectedVersion:1,channelIds:[]}),e=>e.code==='private_sources');
 const counts=(await f.repo.list('document_read')).length;await skillCatalog(f.repo,agent,f.c.id);assert.equal((await f.repo.list('document_read')).length,counts);
 await f.repo.transact('remove-source',{},tx=>tx.put('channel_doc',{...doc,status:'deleted'}));
 assert.ok(!(await skillCatalog(f.repo,agent,f.c.id)).some(x=>x.id===method.id));
 await assert.rejects(f.tool('read_skill',{skillId:method.id}),e=>e.code==='forbidden');
});
test('public GitHub import fixes revision and retains entire folder including binary bytes, refuses unsafe or incomplete packages',async()=>{
 const sha='a'.repeat(40),encoded=Object.entries(files).map(([path,value],i)=>({path:'skills/verify/'+path,sha:String(i),type:'blob',mode:'100644',size:fileBytes(value).length}));
 const calls=[];
 const fetcher=async url=>{calls.push(url);return new Response(JSON.stringify(url.includes('/commits/')?{sha}:url.includes('/git/trees/')?{tree:encoded}: {encoding:'base64',content:Buffer.from(fileBytes(Object.values(files)[Number(url.split('/').at(-1))])).toString('base64')}));};
 const imported=await importGithubSkill('https://github.com/org/repo/tree/main/skills/verify',fetcher);assert.equal(imported.sourceRevision,sha);assert.deepEqual(Object.keys(imported.files),Object.keys(files));assert.deepEqual([...fileBytes(imported.files['assets/icon.bin'])],[0,255,1,2]);assert.equal(await fileHash(imported.files['assets/icon.bin']),await fileHash(files['assets/icon.bin']));assert.ok(calls.some(x=>x.includes('/git/trees/'+sha)));assert.equal(parseSkill(imported.files).resourceWarnings.length,0);
 assert.equal(parseSkill({'SKILL.md':files['SKILL.md']}).resourceWarnings.length,2);
 for(const url of ['https://github.com/org/repo/tree/%ZZ/skill','https://evil.test/skill','https://user:pass@github.com/org/repo/tree/main/skill'])await assert.rejects(importGithubSkill(url,fetcher),e=>e.code==='invalid_source');
 await assert.rejects(importGithubSkill('https://github.com/org/repo/tree/main/skills/verify',async url=>new Response(JSON.stringify(url.includes('/commits/')?{sha}:{tree:[{path:'skills/verify/escape',type:'blob',mode:'120000'}]}))),e=>e.code==='invalid_skill');
 assert.throws(()=>parseSkill({...files,'../escape':'bad'}),e=>e.code==='invalid_skill');assert.throws(()=>parseSkill({...files,'assets/bad':{encoding:'base64',data:'%bad'}}),e=>e.code==='invalid_skill');
});
test('GitHub receipts distinguish authorization, rate, permission, missing resource, network and timeout without credential leakage',async t=>{
 const f=await setup(t),env={ADMIN_KEY:'isolated-test-key'},response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
 const connection=await connectorSettings(f.repo,f.identity,owner,{action:'connect',requestId:'connect',token:'private-never-in-ledger',repositories:['org/project'],channelIds:[f.c.id]},env,async()=>response({login:'account',id:1}));
 const args={action:'repository',channelId:f.c.id,connectionId:connection.id,repository:'org/project'};
 const success=await connectorTool(f.repo,agent,args,env,async()=>response({name:'project'}));assert.ok(success.readAt);assert.ok(success.receiptId);
 for(const [fetcher,code] of [[()=>response({},401),'authorization_expired'],[()=>response({},403),'permission_denied'],[()=>response({},403,{'x-ratelimit-remaining':'0'}),'rate_limited'],[()=>response({},429,{'retry-after':'10'}),'rate_limited'],[()=>response({},404),'resource_unavailable'],[()=>response({},503),'github_unavailable'],[()=>{throw new TypeError('private-never-in-ledger');},'connection_network'],[()=>{throw new DOMException('timeout','TimeoutError');},'connection_timeout']]){
  await assert.rejects(connectorTool(f.repo,agent,args,env,fetcher),e=>e.code===code);
 }
 const list=await connectorTool(f.repo,peer,{...args,action:'activity'},env);assert.equal(list.items.length,9);assert.equal(JSON.stringify(list).includes('private-never-in-ledger'),false);assert.equal(list.items.filter(x=>x.status==='succeeded').length,1);
 const check=await connectorSettings(f.repo,f.identity,owner,{action:'check',connectionId:connection.id},env,async()=>response({name:'project'}));assert.ok(check.receiptId);
 assert.equal((await connectorTool(f.repo,peer,{...args,action:'activity'},env)).items.length,9);
 assert.equal((await connectorSettings(f.repo,f.identity,owner,{action:'activity',connectionId:connection.id},env)).items.length,10);
});
test('old native tool catalogs can invoke new skill tools through the compatibility envelope',async t=>{
 const f=await setup(t),s=await f.save({}),task=await f.task({title:'兼容使用',skillRefs:[{skillId:s.id,version:1}]});
 const wrap=(name,args,who=agent)=>callTool(f.repo,f.identity,who,'post_message',{requestId:crypto.randomUUID(),channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name,arguments:{channelId:f.c.id,...args}})},{});
 const read=await wrap('read_skill',{skillId:s.id,taskId:task.id});assert.ok(read.readId);
 const use=await wrap('report_skill_use',{skillId:s.id,version:1,taskId:task.id,readId:read.readId,summary:'兼容入口核对完成'});assert.equal(use.taskId,task.id);
 const review=await wrap('review_skill_use',{useId:use.id,outcome:'passed',summary:'独立核对',refs:[{kind:'task',id:task.id}]},peer);assert.equal(review.useId,use.id);
 assert.equal((await wrap('skill_activity',{taskId:task.id})).items.length,3);
 assert.equal((await f.repo.list('channel_message')).length,0);
});
