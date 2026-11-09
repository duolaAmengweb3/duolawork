import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {callTool,TOOLS} from '../cloud/collaboration/api.mjs';
import {conversationCommand,claimConversation,readChannel} from '../cloud/collaboration/conversation.mjs';
import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
import {productRelease,readProductContext,acknowledgeProductContext} from '../cloud/collaboration/product-context.mjs';
import {HUB_INSTRUCTIONS} from '../cloud/collaboration/agent-instructions.mjs';

async function setup(t,platform='codex'){
 const f=await fixture(t);let seq=0;const actor={memberId:'grok'};f.identity.members[0].platformId=platform;
 const requestId=()=>`context-release-${++seq}`;
 const send=(type,args={},who={owner:true})=>conversationCommand(f.repo,f.identity,who,{type,requestId:requestId(),...args});
 const c=await send('channel.create',{name:'Context release',memberIds:['grok','check'],coordinatorId:'grok'});
 const bind=id=>registerExecutionBindings(f.repo,f.identity,actor,{requestId:requestId(),bindings:[{channelId:c.id,sessionId:id}]});
 const native=!['dots','grok-bot'].includes(platform);if(native)await bind('original-session');
 const message=body=>send('channel.post',{channelId:c.id,body,mentions:['grok']});
 const claim=(m,extra={})=>callTool(f.repo,f.identity,actor,'claim_work',{requestId:requestId(),stepId:`turn_${m.id}_grok`,channelId:c.id,...(native?{expectedSessionId:'original-session',contextMode:'incremental'}:{}),...extra},{});
 const reply=claim=>send('channel.post',{channelId:c.id,turnId:claim.turnId,body:'Actual response to this notice',mentions:[]},actor);
 const tool=(name,args)=>callTool(f.repo,f.identity,actor,name,args,{});
 return {...f,actor,c,send,bind,message,claim,reply,tool,requestId,native};
}

for(const platform of ['codex','antigravity','gemini-cli','deepseek-harness','claude-code','dots','grok-bot'])test(`${platform}: an existing conversation receives current rules and cached-catalog fallback without a new identity or forced workflow`,async t=>{
 const f=await setup(t,platform);
 const old=await f.message('Historical user requirement: keep the original account, model and project.');
 const initial=await f.claim(old);await f.reply(initial);
 const next=await f.message('Only discuss this proposal. New correction: do not develop or start a meeting.');
 const claim=await f.claim(next),context=claim.input.productContext;
 assert.equal(Object.keys(claim.input)[0],'productContext');assert.equal(context.stage,'prepared');
 assert.equal(context.scopeKind,f.native?'native-session':'agent-channel');
 assert.equal(context.changed.guidance,false);assert.deepEqual(context.changed.tools,[]);
 assert.equal(context.previousResponseRevision,initial.input.productContext.revision);
 assert.ok(claim.input.messages.some(m=>m.id===old.id));assert.ok(claim.input.messages.some(m=>m.id===next.id));
 assert.equal(claim.input.todoInstruction,HUB_INSTRUCTIONS.todoInstruction);
 const before=(await f.repo.list('channel_message')).length;
 const guide=await f.tool('post_message',{requestId:f.requestId(),channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'read_product_context',arguments:{channelId:f.c.id,toolNames:['board_task','read_product_context']}})});
 assert.equal(guide.release.revision,context.revision);assert.equal(guide.tools.find(t=>t.name==='board_task').inputSchema.properties.workSpec.type,'object');
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active','reading definitions never acknowledges the actual task');
 assert.equal((await f.repo.list('channel_message')).length,before,'compatibility calls do not post fake group messages');
 await f.reply(claim);const delivery=await f.repo.get('agent_context_delivery',claim.turnId);assert.equal(delivery.status,'response_recorded');
 assert.ok(!('understood' in delivery));assert.ok(!('adopted' in delivery));
 for(const kind of ['channel_task','channel_meeting','channel_doc'])assert.equal((await f.repo.list(kind)).length,0);
});

test('release hashes follow actual rules/schema content, not a manually maintained date or object key order',async()=>{
 const old=await productRelease(TOOLS),reordered=Object.fromEntries(Object.entries(HUB_INSTRUCTIONS).reverse());
 assert.equal((await productRelease([...TOOLS].reverse(),reordered)).revision,old.revision);
 const ruleChange=await productRelease(TOOLS,{...HUB_INSTRUCTIONS,todoInstruction:HUB_INSTRUCTIONS.todoInstruction+'\nA changed product contract.'});
 assert.notEqual(ruleChange.guidanceRevision,old.guidanceRevision);assert.equal(ruleChange.toolCatalogRevision,old.toolCatalogRevision);
 const tools=TOOLS.map(t=>t.name==='board_task'?{...t,description:t.description+' Updated definition.'}:t);
 const schemaChange=await productRelease(tools);assert.notEqual(schemaChange.toolCatalogRevision,old.toolCatalogRevision);assert.equal(schemaChange.guidanceRevision,old.guidanceRevision);
});

test('upgrade reaches an already acknowledged native session; only changed tools are highlighted and current definitions are readable',async t=>{
 const f=await setup(t),message=await f.message('Prepare a result using current tools.');
 const raw=await claimConversation(f.repo,f.identity,f.actor,{requestId:f.requestId(),stepId:`turn_${message.id}_grok`,channelId:f.c.id,expectedSessionId:'original-session',contextMode:'incremental'});
 const oldTools=TOOLS.filter(t=>t.name!=='read_product_context').map(t=>t.name==='board_task'?{...t,inputSchema:{...t.inputSchema,properties:{channelId:{type:'string'},action:{type:'string'}}}}:t);
 const old=await withConversationContext(f.repo,f.identity,f.actor,raw,{tools:oldTools});await f.reply(old);
 const next=await f.claim(await f.message('The product was updated; keep this same native conversation.'));
 assert.equal(next.input.history.mode,'incremental');assert.equal(next.input.productContext.previousResponseRevision,old.input.productContext.revision);
 assert.deepEqual(new Set(next.input.productContext.changed.tools),new Set(['read_product_context','board_task']));
 assert.equal(next.input.productContext.changed.guidance,false);assert.notEqual(next.input.productContext.revision,old.input.productContext.revision);
 const current=await f.tool('read_product_context',{channelId:f.c.id,toolNames:['board_task']});
 assert.ok(current.tools[0].inputSchema.properties.submission);assert.equal(current.deliveries[0].status,'prepared');
 assert.ok(!JSON.stringify(current.deliveries).includes('lease_'));assert.ok(!JSON.stringify(current.deliveries).includes('original-session'));
 await f.reply(next);
});

test('prepared is not a response or adoption; a completed-notice replay cannot acknowledge a newly deployed contract',async t=>{
 const f=await setup(t),m=await f.message('Read current original text.');const claim=await f.claim(m);
 assert.equal((await f.repo.list('agent_context_checkpoint')).length,0);
 const turn=await f.repo.get('channel_turn',claim.turnId);
 await f.repo.transact(f.requestId(),{},tx=>acknowledgeProductContext(tx,{...turn,lease:'wrong-lease'},'done'));
 assert.equal((await f.repo.list('agent_context_checkpoint')).length,0);
 await f.reply(claim);const before=(await f.repo.list('agent_context_checkpoint'))[0];
 const changed=TOOLS.map(t=>t.name==='read_channel'?{...t,description:'Changed after the response'}:t);
 const replay=await withConversationContext(f.repo,f.identity,f.actor,claim,{tools:changed});assert.equal(replay.input.productContext.stage,'notice_ended');
 assert.deepEqual((await f.repo.list('agent_context_checkpoint'))[0],before);
 assert.equal((await f.repo.get('agent_context_delivery',claim.turnId)).status,'response_recorded');
});

test('records isolate native sessions and members; same session in another group does not borrow an acknowledgement',async t=>{
 const f=await setup(t),a=await f.claim(await f.message('First scope.'));await f.reply(a);
 await f.bind('new-session');const m=await f.message('New native conversation.');const next=await f.claim(m,{expectedSessionId:'new-session'});
 assert.equal(next.input.productContext.previousResponseRevision,null);assert.equal(next.input.productContext.changed.guidance,true);await f.reply(next);
 const g=await f.send('channel.create',{name:'Another scope',memberIds:['grok']});
 await registerExecutionBindings(f.repo,f.identity,f.actor,{requestId:f.requestId(),bindings:[{channelId:f.c.id,sessionId:'new-session'},{channelId:g.id,sessionId:'new-session'}]});
 const source=await f.send('channel.post',{channelId:g.id,body:'Same native session, another group.',mentions:['grok']});
 const c=await callTool(f.repo,f.identity,f.actor,'claim_work',{requestId:f.requestId(),stepId:`turn_${source.id}_grok`,channelId:g.id,expectedSessionId:'new-session',contextMode:'incremental'},{});
 assert.equal(c.input.productContext.previousResponseRevision,null);
 await assert.rejects(readProductContext(f.repo,{memberId:'check'},{channelId:g.id},TOOLS),e=>e.code==='forbidden');
 await assert.rejects(readProductContext(f.repo,f.actor,{channelId:f.c.id,memberId:'check'},TOOLS),e=>e.code==='forbidden');
 await assert.rejects(f.tool('read_product_context',{channelId:f.c.id,toolNames:['not_a_real_tool']}),e=>e.code==='unknown_tool');
});

test('reading current state after a correction records its version without changing the product release or ending active work',async t=>{
 const f=await setup(t),m=await f.message('Initial concrete requirement.');const claim=await f.claim(m);
 await f.send('channel.message.edit',{channelId:f.c.id,messageId:m.id,expectedVersion:1,body:'Corrected concrete requirement.'});
 const updated=await withConversationContext(f.repo,f.identity,f.actor,claim,{tools:TOOLS});
 assert.equal(updated.input.productContext.revision,claim.input.productContext.revision);assert.notEqual(updated.input.productContext.stateRevision,claim.input.productContext.stateRevision);
 const delivery=await f.repo.get('agent_context_delivery',claim.turnId);assert.ok(delivery.stateRefs.requirements.some(r=>r.id===m.id&&r.version===2));
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active');
});

test('large research, implementation and data-review outputs remain exact and readable without repeating all bodies on unrelated messages',async t=>{
 const f=await setup(t),source=await f.message('Keep exact original data and results; this is a controlled context fixture.');const sourceClaim=await f.claim(source);await f.reply(sourceClaim);
 const tasks=[];
 for(const title of ['Research evidence','Implementation result','Data verification']){
  const task=await f.send('channel.task',{channelId:f.c.id,action:'create',title,assigneeId:'grok',notifyAssignee:false,sourceMessageId:source.id});
  const body=(title+':'+('exact original content and independent evidence. '.repeat(450))).trim();
  const submitted=await f.send('channel.task',{channelId:f.c.id,taskId:task.id,action:'submit',expectedVersion:task.version,workSpecVersion:task.workSpec.version,submission:{body,coverage:[{id:'outcome',location:'body'}]}});
  tasks.push({task:submitted,body});
 }
 const ordinary=await f.claim(await f.message('A separate ordinary question, no new task or meeting.'));
 assert.equal(ordinary.input.taskWork.length,0);assert.ok(ordinary.input.tasks.every(t=>t.contentIncluded===false&&!t.delivery?.submission&&!t.body));
 const full=await readChannel(f.repo,f.identity,f.actor,{channelId:f.c.id});
 assert.ok(JSON.stringify(ordinary.input.tasks).length<JSON.stringify(full.tasks).length/10,'task-index bytes must fall without summarizing originals');
 for(const {task,body}of tasks){const restored=await f.tool('read_todo',{channelId:f.c.id,taskId:task.id});assert.equal(restored.delivery.submission.body,body);assert.equal(restored.sourceMessages[0].body,'Keep exact original data and results; this is a controlled context fixture.');}
 await f.reply(ordinary);
 const target=tasks[1];const notice=await f.send('channel.task',{channelId:f.c.id,taskId:target.task.id,action:'update',expectedVersion:target.task.version,notifyAssignee:true,progress:'Review this exact result.'});
 const related=await f.claim({id:notice.notificationMessageId});assert.equal(related.input.taskWork[0].delivery.submission.body,target.body);assert.equal(related.input.taskWork[0].sourceMessages[0].id,source.id);
});
