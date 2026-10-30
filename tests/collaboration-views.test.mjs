import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import { resultPage, pairingFacts } from "../cloud/collaboration/views.mjs";

const solo={mode:"solo",delivery:"final",members:["grok"],lead:"grok",criteria:["出处明确"],internalRevisions:0};
test("results search current body, literal wildcards and filters before pagination; versions are counted",async t=>{
 const f=await fixture(t);await f.repo.transact("seed-search",{},async tx=>{
  for(let n=0;n<130;n++) {const id=`d${String(n).padStart(3,"0")}`,v=`v${n}`;tx.put("document",{id,scopeId:n===129?"target":"other",parentId:"r",status:"delivered",deliverable:true,title:"成果"+n,workingVersionId:v,createdAt:"2026-10-29T23:30:00.000Z"});tx.put("document_version",{id:v,parentId:id,body:n===129?"正文里的独特关键词 100%_可用":"其他正文",format:"text"});}
  tx.put("document_version",{id:"older",parentId:"d129",body:"旧版正文"});return {};
 });
 let rows=await resultPage(f.repo,new URLSearchParams({q:"独特关键词",projectId:"target",status:"pending"}));assert.equal(rows.length,1);assert.equal(rows[0].versionCount,2);
 assert.equal((await resultPage(f.repo,new URLSearchParams({q:"100%_"}))).length,1);
 assert.equal((await resultPage(f.repo,new URLSearchParams({q:"旧版正文"}))).length,0,"search must use the working version rather than any old version");
 assert.equal((await resultPage(f.repo,new URLSearchParams({from:"2026-10-30"}))).length,0);
 assert.equal((await resultPage(f.repo,new URLSearchParams({status:"adopted"}))).length,0);
});
test("explicit same-type scopes share approved rules; unrelated projects stay isolated and trials are consumed once",async t=>{
 const f=await fixture(t);const create=(name,type)=>f.send("project.create",{name,goal:"研究",projectType:type,arrangement:solo});
 const a=await create("甲","内容"),b=await create("乙","内容"),c=await create("丙","旅行");
 const rule=await f.send("knowledge.write",{projectId:a.id,title:"类型偏好",body:"先给结论",scopeMode:"type",approved:true});
 let r=await f.send("run.start",{projectId:b.id});assert(r.knowledge.some(k=>k.id===rule.id));
 const unrelated=await f.send("run.start",{projectId:c.id});assert(!unrelated.knowledge.some(k=>k.id===rule.id));
 await f.send("run.control",{runId:r.id,control:"cancel"});
 const trial=await f.send("knowledge.write",{projectId:a.id,title:"仅试一次",body:"更简短",scopeMode:"type"});
 await f.send("knowledge.review",{knowledgeId:trial.id,revision:trial.revision,status:"trial"});
 r=await f.send("run.start",{projectId:b.id});assert(r.knowledge.some(k=>k.id===trial.id));
 const again=await create("丁","内容"),rr=await f.send("run.start",{projectId:again.id});assert(!rr.knowledge.some(k=>k.id===trial.id));
 const noType=await create("无分类",null);await assert.rejects(f.send("knowledge.write",{projectId:noType.id,title:"不能猜分类",body:"规则",scopeMode:"type"}),{code:"missing_project_type"});
});
test("pairing facts need three matching goal runs; revisions and other explicit types do not inflate samples",async t=>{
 const f=await fixture(t);const project={id:"p",projectType:"内容",arrangement:{members:["check","grok"]}};
 await f.repo.transact("pair-samples",{},async tx=>{
  for(let i=0;i<5;i++){tx.put("run",{id:`run${i}`,scopeId:"p",purpose:i===4?"revise":"goal",projectType:i===3?"旅行":"内容",arrangement:{members:["grok","check"]},status:"completed",probe:false});tx.put("document",{id:`doc${i}`,parentId:`run${i}`,deliverable:true,record:{independent:2,corrections:1}});}return {};
 });
 const facts=await pairingFacts(f.repo,project);assert.equal(facts.samples,3);assert.equal(facts.independent,6);assert.equal(facts.corrections,3);
 assert.equal(await pairingFacts(f.repo,{...project,projectType:"旅行"}),null);
});

const submitReady=async(f,runId,extra={})=>{
 const step=(await f.repo.list('step',{parent:runId})).find(s=>s.status==='ready');
 const actor={memberId:step.memberId},claim=await f.send('step.claim',{stepId:step.id},actor);
 const result=await f.send('step.submit',{attemptId:claim.attemptId,lease:claim.lease,items:[{title:'来源明确的成果',body:'交付内容明确，以下为隔离工程验证资料，不冒充真实商业模型的回答。',sources:['https://example.com/original'],claims:[{id:'a',text:'可验证的论断',sourceUrls:['https://example.com/original']}],selfCheck:[{criterion:0,pass:true,reason:'有原始出处',paragraph:'交付内容'}],...extra}]},actor);
 return f.repo.get('document',result.documentIds[0]);
};
test('all selected reviewers and all cross-check members participate without serializing peers',async t=>{
 const {normalizeArrangement,compileArrangement}=await import('../shared/modes.mjs');
 const a=normalizeArrangement({...solo,mode:'review',members:['grok','check','write'],lead:'check',important:true});
 const plan=compileArrangement(a).recipe.steps;
 assert.equal(plan.filter(s=>s.kind==='review').length,2);
 assert.deepEqual(new Set(plan.map(s=>compileArrangement(a).slots[s.slot])),new Set(a.members));
 const cross=compileArrangement({...a,mode:'parallel',crossCheck:true}).recipe.steps;
 const reviews=cross.filter(s=>s.kind==='review');assert.equal(reviews.length,3);
 assert(reviews.every(s=>s.dependencies.length===3&&s.dependencies.every(d=>d.startsWith('explore-'))));
 assert.equal(cross.find(s=>s.kind==='integrate').dependencies.length,6);
});
test('remember and undo are atomic, preserve history, reject stale decisions and keep independently edited rules',async t=>{
 const f=await fixture(t),p=await f.send('project.create',{name:'决定',goal:'研究',arrangement:solo});
 const r=await f.send('run.start',{projectId:p.id}),doc=await submitReady(f,r.id);
 await f.repo.transact('decision-seed',{},tx=>tx.put('decision',{id:'choice',scopeId:p.id,documentId:doc.id,title:'优先级',description:'先验证还是先扩展',status:'pending',options:[{text:'先验证'},{text:'先扩展'}]}));
 const chosen=await f.send('decision.choose',{decisionId:'choice',revision:doc.revision,option:0,remember:true});
 const rule=await f.repo.get('knowledge',chosen.ruleId);assert.equal(rule.status,'approved');
 let current=await f.repo.get('document',doc.id);assert.match((await f.repo.get('document_version',current.workingVersionId)).body,/先验证/);
 await assert.rejects(f.send('decision.choose',{decisionId:'choice',revision:doc.revision,undo:true}),{code:'revision_conflict'});
 await f.send('decision.choose',{decisionId:'choice',revision:current.revision,undo:true});
 assert.equal((await f.repo.get('knowledge',rule.id)).status,'revoked');assert((await f.repo.list('knowledge_version',{parent:rule.id})).length);
 current=await f.repo.get('document',doc.id);const again=await f.send('decision.choose',{decisionId:'choice',revision:current.revision,option:1,remember:true});
 const edited=await f.send('knowledge.write',{projectId:p.id,knowledgeId:again.ruleId,revision:again.ruleRevision,title:'我另外调整了规则',body:'保留人的修改',approved:true});
 current=await f.repo.get('document',doc.id);await f.send('decision.choose',{decisionId:'choice',revision:current.revision,undo:true});
 assert.equal((await f.repo.get('knowledge',edited.id)).body,'保留人的修改');assert.equal((await f.repo.get('knowledge',edited.id)).status,'approved');
});
test('learning updates one article note, drift is shown once, and stale notice cannot revoke a newer rule',async t=>{
 const f=await fixture(t),p=await f.send('project.create',{name:'改稿',goal:'写稿',arrangement:solo});
 const rule=await f.send('knowledge.write',{projectId:p.id,title:'先交付',body:'先写交付结果',approved:true});
 const r=await f.send('run.start',{projectId:p.id}),doc=await submitReady(f,r.id);
 for(let n=0;n<2;n++){
  const d=await f.repo.get('document',doc.id);await f.send('document.edit',{documentId:d.id,revision:d.revision,body:'我做了具体修改'+n,format:'text'});
  const learn=await f.send('document.learn',{documentId:d.id});await submitReady(f,learn.id,{proposal:{title:'改稿偏好',body:'先给结果'+n,evidence:'把交付结果提到了第一段',relatedRuleId:rule.id}});
 }
 const pending=await f.repo.list('knowledge',{scope:p.id,status:'pending'});assert.equal(pending.length,1);assert.equal(pending[0].body,'先给结果1');
 assert.equal((await f.repo.list('rule_notice',{scope:p.id})).length,1);
 const changed=await f.send('knowledge.write',{projectId:p.id,knowledgeId:rule.id,revision:rule.revision,title:rule.title,body:'变更后规则',approved:true});
 await assert.rejects(f.send('rule.notice.resolve',{noticeId:'drift:'+rule.id,action:'revoke',ruleRevision:rule.revision}),{code:'revision_conflict'});
 await f.send('rule.notice.resolve',{noticeId:'drift:'+rule.id,action:'revoke',ruleRevision:changed.revision});
 assert.equal((await f.repo.get('knowledge',rule.id)).status,'revoked');
});
test('native member suggestions stay pending, require confirmation, and never start a new run',async t=>{
 const f=await fixture(t),p=await f.send('project.create',{name:'建议',goal:'研究',arrangement:solo});
 const r=await f.send('run.start',{projectId:p.id});await submitReady(f,r.id,{proposal:{memberSuggestions:[{memberId:'check',reason:'请这位成员补充已有信源，实际账号权限仍需确认'}]}});
 let project=await f.repo.get('project',p.id);assert.deepEqual(project.arrangement.members,['grok']);
 const [s]=await f.repo.list('member_suggestion',{scope:p.id});assert.equal(s.status,'pending');
 await f.send('member.suggestion.review',{suggestionId:s.id,action:'accept'});project=await f.repo.get('project',p.id);
 assert.deepEqual(new Set(project.arrangement.members),new Set(['grok','check']));assert.equal(project.arrangement.mode,'review');
 assert.equal((await f.repo.list('run',{scope:p.id})).length,1);
});
test('projects are searched before pagination and hidden projects stay hidden',async t=>{
 const {projectPage}=await import('../cloud/collaboration/views.mjs');const f=await fixture(t);
 await f.repo.transact('many-projects',{},tx=>{for(let i=0;i<130;i++)tx.put('project',{id:'older'+i,name:i===129?'唯一较早项目':'普通项目',topic:'主题',hidden:i===128});return {}});
 const rows=await projectPage(f.repo,new URLSearchParams({q:'唯一'}));assert.equal(rows.length,1);assert.equal(rows[0].id,'older129');
 const first=await projectPage(f.repo,new URLSearchParams());assert.equal(first.length,101);assert(!first.some(p=>p.id==='older128'));
 const last=first[99],second=await projectPage(f.repo,new URLSearchParams(),{updatedAt:last.updatedAt,id:last.id});assert.equal(new Set([...first.slice(0,100),...second].map(p=>p.id)).size,130);
});
