import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationMaintenance,claimConversation,readChannel,conversationTool} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {SHARED_TOOL_ENVELOPE} from '../cloud/collaboration/shared-space.mjs';
import {deliveryView} from '../shared/delivery-view.mjs';
import {dispatchOne} from '../cloud/collaboration/dispatcher.mjs';
import {seal} from '../cloud/collaboration/security.mjs';
async function setup(t){
 const f=await fixture(t);let seq=0;const now='2026-11-06T08:00:00.000Z';
 const send=(type,args={},memberId)=>conversationCommand(f.repo,f.identity,memberId?{memberId}:{owner:true},{requestId:'review-'+(++seq),type,...args},now);
 const channel=await send('channel.create',{name:'写作协作',memberIds:['grok','check','write'],coordinatorId:'grok'});
 const root=await send('channel.post',{channelId:channel.id,body:'请核对章节内容并交付结果。',mentions:['check','write']});
 const turns=()=>f.repo.list('channel_turn',{scope:channel.id});
 const hold=async(status='limited',extra={})=>f.repo.transact('hold-'+(++seq),{},async tx=>{for(const r of await turns())if(!r.deliveryReview)tx.put('channel_turn',{...r,status,...extra});});
 const maintain=(at=now)=>conversationMaintenance(f.repo,f.identity,at);
 const issues=()=>f.repo.list('channel_delivery_issue',{scope:channel.id});
 const resolve=async(action,args={},actor={memberId:'grok'})=>{const issue=(await issues())[0];return conversationTool(f.repo,f.identity,actor,'resolve_delivery',{requestId:'decision-'+(++seq),channelId:channel.id,issueId:issue.id,expectedVersion:issue.version,action,summary:'核对章节后的明确处理结论',...args});};
 return {...f,now,send,channel,root,turns,hold,maintain,issues,resolve};
}
test('旧次数限制按一件事交给负责人一次；不重放原任务，不占人类待办',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();await f.maintain('2026-11-06T08:01:00.000Z');
 const issues=await f.issues(),turns=await f.turns();assert.equal(issues.length,1);assert.equal(issues[0].turnIds.length,2);
 assert.equal(turns.filter(t=>t.deliveryReview).length,1);assert.equal(turns.filter(t=>t.status==='limited').length,2);
 const view=deliveryView(await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id}));assert.equal(view.attention.length,0);assert.equal(view.recovering.length,1);assert.equal(view.waiting.length,0);
 const claim=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'review-claim',stepId:issues[0].reviewTurnId},f.now);
 assert.equal(claim.input.deliveryReview.request.body,f.root.body);assert.equal(claim.input.deliveryReview.receipts.length,2);
 const countBefore=(await f.repo.db.prepare('SELECT COUNT(*) AS n FROM hub_v2_receipts').first()).n;
 await f.maintain();const after=(await f.repo.db.prepare('SELECT COUNT(*) AS n FROM hub_v2_receipts').first()).n;await f.maintain('2026-11-06T08:02:00.000Z');
 assert.equal((await f.repo.db.prepare('SELECT COUNT(*) AS n FROM hub_v2_receipts').first()).n,after,'无新事件不持续写入维护回执');assert.ok(after>=countBefore);
});
test('异常核对与普通消息的通知及领取互不吞并',async t=>{
 const f=await setup(t),secret='isolated-review';
 await f.repo.transact('webhook',{},async tx=>tx.put('connection',{...await tx.get('connection','grok'),transport:'grok-webhook',credentials:await seal({url:'https://api2.cursor.sh/automations/webhook/review-fixture',token:'crsr_test'},secret)}));
 const ordinary=await f.send('channel.post',{channelId:f.channel.id,body:'这是新的独立需求',mentions:['grok']});
 await f.repo.transact('hold-only-original',{},async tx=>{for(const r of await f.turns())if(r.messageId===f.root.id)tx.put('channel_turn',{...r,status:'limited'});});
 await f.maintain();const issue=(await f.issues())[0],normal=(await f.turns()).find(t=>t.messageId===ordinary.id);
 const calls=[],fetcher=async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}',{status:200});};
 await dispatchOne(f.repo,f.identity,'notice_'+normal.id,{ADMIN_KEY:secret},fetcher,f.now);
 assert.equal((await f.repo.get('outbox','notice_'+issue.reviewTurnId)).status,'pending');
 await dispatchOne(f.repo,f.identity,'notice_'+issue.reviewTurnId,{ADMIN_KEY:secret},fetcher,'2026-11-06T08:02:00.000Z');
 assert.equal(calls.length,2,'原消息已通知仍不能吞并核对通知');
 const claimed=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'normal-first',stepId:normal.id},f.now);
 assert.deepEqual(claimed.input.triggerMessageIds,[ordinary.id]);assert.equal((await f.repo.get('channel_turn',issue.reviewTurnId)).status,'ready');
 await f.send('channel.post',{channelId:f.channel.id,turnId:normal.id,body:'独立需求已回复'},'grok');
 const review=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'review-next',stepId:issue.reviewTurnId},f.now);
 assert.equal(review.input.deliveryReview.id,issue.id);
});
test('覆盖结论需要成员真实回复；后来的无关消息不会自动清除异常',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();
 await f.send('channel.post',{channelId:f.channel.id,replyTo:f.root.id,body:'另一个工作的进展'},'grok');await f.maintain();assert.equal((await f.issues())[0].status,'reviewing');
 await assert.rejects(f.resolve('covered'),e=>e.code==='evidence_required');
 const evidence=[];for(const mid of ['check','write'])evidence.push((await f.send('channel.post',{channelId:f.channel.id,replyTo:f.root.id,body:mid+' 已完成对应章节核对并交付',mentions:[]},mid)).id);
 const issue=await f.resolve('covered',{evidenceMessageIds:evidence});assert.equal(issue.status,'resolved');
 assert.equal(issue.resolution,'covered');
 assert.equal((await f.turns()).filter(t=>t.resolution==='covered').length,2);
 assert.equal((await f.turns()).filter(t=>t.resolution==='covered'&&t.status==='done').length,0,'覆盖旧通知不伪造成功执行');
});
test('覆盖依据逐条校验时间，同成员较早的回复不能覆盖后来的通知',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();
 const early=await f.send('channel.post',{channelId:f.channel.id,replyTo:f.root.id,body:'以前交付过的章节'},'check');
 const valid=await f.send('channel.post',{channelId:f.channel.id,replyTo:f.root.id,body:'当前写作交付'},'write');
 await f.repo.transact('earlier-evidence',{},async tx=>tx.put('channel_message',{...await tx.get('channel_message',early.id),createdAt:'2026-11-06T07:59:59.999Z'}));
 await assert.rejects(f.resolve('covered',{evidenceMessageIds:[early.id,valid.id]}),e=>e.code==='evidence_required');
 assert.equal((await f.issues())[0].status,'reviewing');assert.equal((await f.turns()).filter(t=>t.status==='limited').length,2);
 await f.repo.transact('invalid-evidence-date',{},async tx=>tx.put('channel_message',{...await tx.get('channel_message',early.id),createdAt:'invalid'}));
 await assert.rejects(f.resolve('covered',{evidenceMessageIds:[early.id,valid.id]}),e=>e.code==='evidence_required');
 await f.repo.transact('later-evidence',{},async tx=>tx.put('channel_message',{...await tx.get('channel_message',early.id),createdAt:'2026-11-06T08:00:00.001Z'}));
 assert.equal((await f.resolve('covered',{evidenceMessageIds:[early.id,valid.id]})).status,'resolved','新回复和同一毫秒回复都可作时间有效的依据');
});
test('安全重试只通知未开始的原消息；实际回执到达才自动收尾',async t=>{
 const f=await setup(t);await f.hold('stalled');await f.maintain();await f.resolve('retry');
 for(const mid of ['check','write']){const turn=(await f.turns()).find(t=>t.memberId===mid);assert.equal(turn.status,'ready');const c=await claimConversation(f.repo,f.identity,{memberId:mid},{requestId:'recover-'+mid,stepId:turn.id},f.now);await f.send('channel.post',{channelId:f.channel.id,body:'已核对并交付',turnId:c.turnId},mid);}
 await f.maintain();assert.equal((await f.issues())[0].status,'resolved');
});
test('既有成果可通过成员的新核对回复引用原版本，不复制文档或重做原任务',async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const doc=await conversationCommand(f.repo,f.identity,{owner:true},{requestId:'existing-artifact',type:'channel.doc.create',channelId,title:'已交付章节',body:'原有章节内容'},'2026-11-05T08:00:00.000Z');
 await f.hold();await f.maintain();const evidence=[];
 for(const memberId of ['check','write']){
  const read=await conversationTool(f.repo,f.identity,{memberId},'read_space_object',{channelId,kind:'document',id:doc.id,version:1});assert.equal(read.body,doc.body);
  const result=await f.send('channel.post',{channelId,replyTo:f.root.id,body:'已对照本次要求核对原文档第 1 版，当前章节要求均满足，无剩余缺口。',refs:[{kind:'document',id:doc.id,version:1}]},memberId);evidence.push(result.id);
 }
 const issue=await f.resolve('covered',{evidenceMessageIds:evidence});assert.equal(issue.status,'resolved');
 const snapshot=await readChannel(f.repo,f.identity,{owner:true},{channelId});assert.equal(snapshot.documents.length,1);assert.equal(snapshot.documents[0].version,1);
 assert.ok(snapshot.messages.filter(m=>evidence.includes(m.id)).every(m=>m.refs[0].id===doc.id&&m.refs[0].version===1));
});
test('已开始但结果未知的工作不允许盲目重试，连接恢复也不重复执行',async t=>{
 const f=await setup(t);await f.hold('stalled',{claimedAt:f.now,lease:'existing-execution'});await f.maintain();
 await assert.rejects(f.resolve('retry'),e=>e.code==='execution_unknown');
 await f.send('channel.continue',{channelId:f.channel.id});assert.equal((await f.turns()).filter(t=>t.status==='stalled').length,2);
 await f.resolve('needs_user',{summary:'章节修改曾开始，当前无法确认是否保存。',nextAction:'请打开原会话确认保存结果。'});
 assert.equal(deliveryView(await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id})).attention.length,1);
});
test('连接恢复会自动继续尚未开始的投递；不需要用户再次点击重试',async t=>{
 const f=await setup(t);await f.hold('unavailable');await f.repo.transact('disconnect',{},async tx=>{for(const mid of ['check','write'])tx.put('connection',{...await tx.get('connection',mid),status:'configured'});});
 await f.maintain();assert.equal((await f.issues())[0].action,'connect');
 await f.repo.transact('reconnect',{},async tx=>{for(const mid of ['check','write'])tx.put('connection',{...await tx.get('connection',mid),status:'verified'});});await f.maintain();
 assert.equal((await f.issues())[0].status,'recovering');assert.equal((await f.turns()).filter(t=>t.status==='ready').length,2);
});
test('不同内容的长讨论正常；相同请求第三次重复才暂缓，用户新要求始终可达',async t=>{
 const f=await setup(t);await f.send('channel.update',{channelId:f.channel.id,maxHops:1});
 let parent=f.root;
 for(let n=0;n<20;n++)parent=await f.send('channel.post',{channelId:f.channel.id,replyTo:parent.id,body:'新增证据 '+n,mentions:['check']},'grok');
 assert.equal((await f.turns()).filter(t=>t.status==='limited').length,0);
 for(let n=0;n<3;n++)parent=await f.send('channel.post',{channelId:f.channel.id,replyTo:parent.id,body:'请确认同一结论',mentions:['check']},'grok');
 assert.equal((await f.turns()).filter(t=>t.holdReason==='repeated_request').length,1);
 const user=await f.send('channel.post',{channelId:f.channel.id,body:'请继续核对新的材料',mentions:['check']});assert.equal((await f.turns()).find(t=>t.messageId===user.id).status,'ready');
});
test('工具权限、并发版本与旧 MCP 兼容入口都保持有效',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();const issue=(await f.issues())[0];
 await assert.rejects(f.resolve('dismiss',{}, {memberId:'check'}),e=>e.code==='forbidden');
 await assert.rejects(f.resolve('dismiss',{expectedVersion:0}),e=>e.code==='version_conflict');
 const result=await callTool(f.repo,f.identity,{memberId:'grok'},'post_message',{requestId:'compat-review',channelId:f.channel.id,body:SHARED_TOOL_ENVELOPE+JSON.stringify({name:'resolve_delivery',arguments:{channelId:f.channel.id,issueId:issue.id,action:'dismiss',expectedVersion:issue.version,summary:'这是一条重复确认，无需再次通知。'}})},{});
 assert.equal(result.status,'resolved');
});
test('负责人回复收到但不处理异常不能算完成，也不会循环叫醒负责人',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();const issue=(await f.issues())[0];
 const claim=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'review-unhandled',stepId:issue.reviewTurnId},f.now);
 await f.send('channel.post',{channelId:f.channel.id,turnId:claim.turnId,body:'收到'},'grok');await f.maintain();await f.maintain('2026-11-06T08:01:00.000Z');
 assert.equal((await f.issues())[0].status,'reviewing');assert.equal((await f.issues())[0].action,'review_incomplete');assert.equal((await f.turns()).filter(t=>t.deliveryReview).length,1);
 const snapshot=await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id}),reply=snapshot.messages.find(m=>m.body==='收到');
 assert.equal(deliveryView(snapshot).attention.length,0);assert.equal(deliveryView(snapshot).recovering.length,1);assert.ok(snapshot.deliveryIssues[0].reviewCheckedAt);
 assert.equal(reply.replyTo,f.root.id);assert.equal(reply.replySnapshot.authorId,'owner','核对结果引用原消息，不泄漏隐藏提示为会议记录');
 await f.repo.transact('legacy-review-quote',{},async tx=>tx.put('channel_message',{...await tx.get('channel_message',reply.id),replyTo:claim.input.triggerMessageIds[0],replySnapshot:{authorId:'system',body:'内部提示'}}));
 const legacy=(await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id})).messages.find(m=>m.id===reply.id);
 assert.equal(legacy.replyTo,f.root.id);assert.equal(legacy.replySnapshot.authorId,'owner');
});
test('旧的核对未完成记录回到负责人名下，真正的人类决定仍保留',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();const issue=(await f.issues())[0];
 await f.repo.transact('legacy-escalation',{},async tx=>{
  tx.put('channel_turn',{...await tx.get('channel_turn',issue.reviewTurnId),status:'silent',completedAt:f.now});
  tx.put('channel_delivery_issue',{...await tx.get('channel_delivery_issue',issue.id),status:'needs_user',action:'discuss'});
 });
 await f.maintain();assert.equal((await f.issues())[0].action,'review_incomplete');assert.equal(deliveryView(await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id})).attention.length,0);
 await f.resolve('needs_user',{nextAction:'请确定白皮书面向业务还是技术读者。'});await f.maintain();
 assert.equal((await f.issues())[0].action,'decision');assert.equal((await f.issues())[0].status,'needs_user');
});
test('合并领取的原通知只在实际处理结束后收尾',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();await f.resolve('retry');
 const supplement=await f.send('channel.post',{channelId:f.channel.id,body:'补充验收范围',mentions:['check']});
 const turn=(await f.turns()).find(t=>t.messageId===supplement.id);
 await claimConversation(f.repo,f.identity,{memberId:'check'},{requestId:'merge-check',stepId:turn.id},f.now);
 await f.maintain();assert.notEqual((await f.issues())[0].status,'resolved');
 await f.send('channel.post',{channelId:f.channel.id,turnId:turn.id,body:'原要求和补充已一并完成'},'check');
 const write=(await f.turns()).find(t=>t.memberId==='write');await claimConversation(f.repo,f.identity,{memberId:'write'},{requestId:'merge-write',stepId:write.id},f.now);await f.send('channel.silent',{channelId:f.channel.id,turnId:write.id,reason:'已有交付，无需补充'},'write');
 await f.maintain();assert.equal((await f.issues())[0].status,'resolved');
});
test('异常只随当前负责人交接一次，旧负责人不能继续处置',async t=>{
 const f=await setup(t);await f.hold();await f.maintain();const original=(await f.issues())[0];
 await f.send('channel.update',{channelId:f.channel.id,coordinatorId:'check'});await f.maintain();
 const current=(await f.issues())[0];assert.equal(current.reviewerId,'check');assert.equal((await f.repo.get('channel_turn',original.reviewTurnId)).status,'removed');
 await assert.rejects(f.resolve('dismiss'),e=>e.code==='forbidden');await f.resolve('dismiss',{}, {memberId:'check'});assert.equal((await f.issues())[0].status,'resolved');
});
test('异常自动消息风暴只暂停本分支，用户及其他需求仍可达',async t=>{
 const f=await setup(t);let p=f.root;
 for(let i=0;i<61;i++)p=await f.send('channel.post',{channelId:f.channel.id,replyTo:p.id,body:'过密自动消息 '+i,mentions:['check']},'grok');
 assert.equal((await f.turns()).find(t=>t.messageId===p.id).holdReason,'automatic_burst');
 await f.maintain();const issue=(await f.issues())[0];assert.match(issue.impact,/流量保护/);assert.match(issue.impact,/60 条/);assert.match(issue.impact,/不代表已经确认发生循环/);
 const next=await f.send('channel.post',{channelId:f.channel.id,body:'现在检查另一件事',mentions:['check']});assert.equal((await f.turns()).find(t=>t.messageId===next.id).status,'ready');
});
test('未选工作对话与断开原环境会显示具体操作，正常忙碌仍是自动排队',()=>{
 const snapshot={channel:{id:'c'},activity:[{id:'t',memberId:'a',messageId:'m',status:'ready'}]},members=[{id:'a',platformId:'codex',name:'Codex'}];
 let v=deliveryView(snapshot,members,[{memberId:'a',enabled:true,manualAssignments:true,assignments:[]}]);assert.equal(v.attention[0].action,'select_session');assert.equal(v.waiting.length,0);
 v=deliveryView(snapshot,members,[{memberId:'a',enabled:false,assignments:[]}]);assert.equal(v.attention[0].action,'connect');
 v=deliveryView(snapshot,members,[{memberId:'a',enabled:true,status:'working',assignments:[{channelId:'c'}]}]);assert.equal(v.attention.length,0);assert.equal(v.waiting.length,1);
});
