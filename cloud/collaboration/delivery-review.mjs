import {fail, required, digest} from './repository.mjs';

const held = new Set(['limited','stalled','unavailable']);
const terminal = new Set(['done','silent','removed']);
const unique = xs => [...new Set(xs)];
export const DELIVERY_TOOLS = [{
 name:'resolve_delivery',
 description:'处理本群的一件消息异常，先 read 获取原消息与每位成员真实回执。retry 只重新通知尚未执行的消息；covered 须引用成员的实际回复 evidenceMessageIds，表示旧通知被后续工作覆盖，不冒充执行成功；dismiss 表示无需再通知，必须说明理由。needs_user 只用于确需人类决定，说明影响及具体问题。负责人负责收尾，不要求人类排查日志。',
 inputSchema:{type:'object',properties:{requestId:{type:'string'},channelId:{type:'string'},issueId:{type:'string'},action:{type:'string',enum:['read','retry','covered','dismiss','needs_user']},expectedVersion:{type:'integer'},summary:{type:'string'},nextAction:{type:'string'},turnIds:{type:'array',items:{type:'string'}},evidenceMessageIds:{type:'array',items:{type:'string'}}},required:['requestId','channelId','issueId','action'],additionalProperties:false}
}];

// A long thread is not a loop. Only repeated identical requests, or an extreme
// automatic burst within one causal branch, hold further wakes. Human input and
// the single recovery notification always remain independent of that branch.
export async function automationHold(tx, channel, message) {
 if(message.authorId==='owner'||message.hidden||message.type!=='message')return null;
 const root=message.rootId||message.id, now=Date.parse(tx.now);
 const recent=(await tx.list('channel_message',{scope:channel.id,order:'recent',limit:200})).filter(m=>m.id!==message.id&&!m.hidden&&m.type==='message'&&m.authorId!=='owner'&&(m.rootId||m.id)===root&&now-Date.parse(m.createdAt)<300000);
 const signature=m=>JSON.stringify([m.authorId,m.body.trim().replace(/\s+/g,' '),[...(m.recipientIds||[])].sort(),m.refs||[]]);
 if(recent.filter(m=>signature(m)===signature(message)).length>=2)return 'repeated_request';
 if(recent.filter(m=>(m.recipientIds||[]).length&&now-Date.parse(m.createdAt)<10000).length>=20)return 'automatic_burst';
 return null;
}

async function effectiveTurn(tx,turn){
 const seen=new Set();
 while(turn?.status==='merged'&&turn.mergedInto&&!seen.has(turn.id)){seen.add(turn.id);turn=await tx.get('channel_turn',turn.mergedInto,false);}
 return turn;
}
const issueKey=t=>'delivery_'+t.scopeId+'_'+(t.holdReason?(t.rootId||t.messageId)+':'+t.holdReason:t.messageId);
const causeOf=t=>t.holdReason||({limited:'legacy_hold',stalled:t.claimedAt?'execution_unknown':'not_received',unavailable:'connection'}[t.status]);
const impact={legacy_hold:'旧的次数限制留下了未送达通知，需要核对后续工作是否已覆盖。',repeated_request:'同一分支短时间重复发送了相同请求，已暂缓重复通知。',automatic_burst:'流量保护暂缓通知：同一分支 5 分钟内已产生 60 条自动消息。消息已保存，不代表已经确认发生循环。',execution_unknown:'原会话曾开始处理，但尚无完成回执；先核对，避免重复执行。',not_received:'多次通知后仍未收到成员领取回执。',connection:'成员连接尚未就绪，消息已保存。'};

export async function reconcileDeliveryIssue(tx,issueId){
 const issue=await tx.get('channel_delivery_issue',issueId,false);if(!issue||issue.status==='resolved')return;
 const effective=await Promise.all(issue.turnIds.map(async id=>effectiveTurn(tx,await tx.get('channel_turn',id,false))));
 if(effective.length&&effective.every(t=>t&&terminal.has(t.status)))tx.put('channel_delivery_issue',{...issue,status:'resolved',summary:'相关通知均已有处理回执，可在记录中查看实际回复或收尾原因。',resolvedAt:tx.now,version:issue.version+1});
}

export async function deliveryReviewSource(tx,message){
 if(!message?.deliveryReview)return message;
 const issue=await tx.get('channel_delivery_issue',message.deliveryReview,false);
 return (issue?.messageId&&await tx.get('channel_message',issue.messageId,false))||message;
}

export async function deliveryIssueDetail(tx,channel,issue){
 const turns=(await Promise.all(issue.turnIds.map(id=>tx.get('channel_turn',id,false)))).filter(Boolean);
 const receipts=await Promise.all(turns.map(async t=>{const current=await effectiveTurn(tx,t);return {id:t.id,memberId:t.memberId,messageId:t.messageId,status:current?.status||t.status,claimedAt:current?.claimedAt||null,reason:t.reason};}));
 const sources=(await Promise.all(unique(turns.map(t=>t.messageId)).map(id=>tx.get('channel_message',id,false)))).filter(Boolean);
 const existingArtifactInstruction='已有产物可能满足后来提出的要求：由对应成员实际读取原产物版本，对照这次要求，在本群回复覆盖了哪些要求、还剩什么，并用 refs 引用原版本。负责人引用这条新的核对回复作为 covered 依据；不要复制文档、改旧消息时间或重新执行原任务来凑证据。缺少核对或仍有未完成要求时保持未收尾，dismiss 也不能冒充业务完成。';
 return {...issue,receipts,messages:sources,existingArtifactInstruction,request:issue.rootId?await tx.get('channel_message',issue.rootId,false):null,tool:'resolve_delivery',instruction:'先逐项对照原要求与实际后续结果；有具体未完成工作才继续通知。客套回复不需重发。covered 必须给出对应成员在原通知之后的实际回复，说明哪些要求由哪份结果覆盖；只完成部分要求时不能把整条通知收尾。时间及作者校验不代表内容相关或业务完成，不能用新消息出现、沉默、同意或其他工作的回执代替核对。dismiss 只表示无需再通知，不表示任务完成。summary 用人话说明哪件事、实际影响、剩余要求和下一步。只有明确需要本人决定或操作才用 needs_user；你尚未核对完不属于人类待办。只更新本异常后，再回复通知即可。回群只用一两句话说明处理结果；不要输出工具名、内部状态码或排查步骤，不为同步结果再次 @ 全员。'};
}

export async function deliveryReviewCommand(tx,identity,channel,actor,cmd,helpers){
 const issue=await tx.get('channel_delivery_issue',required(cmd.issueId,'异常编号'));
 if(issue.scopeId!==channel.id)fail('forbidden','异常不属于本群',403);
 if(!actor.owner&&actor.memberId!==channel.coordinatorId)fail('forbidden','请由当前负责人处理本群异常',403);
 if(cmd.action==='read')return deliveryIssueDetail(tx,channel,issue);
 if(!['retry','covered','dismiss','needs_user'].includes(cmd.action))fail('invalid_action','处理方式无效');
 if(issue.version!==cmd.expectedVersion)fail('version_conflict','处理状态已变化，请先读取最新回执',409);
 if(issue.status==='resolved')return issue;
 const summary=required(cmd.summary,'处理结论',2000);
 const ids=cmd.turnIds??issue.turnIds;
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!issue.turnIds.includes(id)))fail('invalid_input','请选择本次异常中的通知');
 const turns=await Promise.all(unique(ids).map(id=>tx.get('channel_turn',id)));
 if(!Array.isArray(cmd.evidenceMessageIds||[])||(cmd.evidenceMessageIds||[]).length>100||(cmd.evidenceMessageIds||[]).some(id=>typeof id!=='string'))fail('invalid_input','依据消息列表无效');
 const evidence=await Promise.all((cmd.evidenceMessageIds||[]).map(id=>tx.get('channel_message',id)));
 if(evidence.some(m=>m.scopeId!==channel.id||m.hidden))fail('forbidden','依据必须是本群可见消息',403);
 if(cmd.action==='covered'&&turns.some(t=>!evidence.some(m=>m.authorId===t.memberId&&m.type==='message'&&m.id!==t.messageId&&Date.parse(m.createdAt)>=Date.parse(t.createdAt))))fail('evidence_required','请为每条通知引用对应成员在该通知发出后的实际回复；较早的回复不能作为后续工作已覆盖的依据',409);
 if(cmd.action==='needs_user'){
  const nextAction=required(cmd.nextAction,'需要用户做的具体决定或操作',1500);
  return tx.put('channel_delivery_issue',{...issue,status:'needs_user',action:'decision',summary,nextAction,version:issue.version+1,reviewedBy:actor.memberId||'owner'});
 }
 for(const t of turns){
  if(!held.has(t.status))continue;
  if(cmd.action==='retry'){
   if(t.claimedAt||t.lease)fail('execution_unknown','这条消息已开始执行；请先核对原会话，不能直接重做',409);
   const c=await tx.get('connection',t.memberId,false),m=identity.members.find(m=>m.id===t.memberId);
   if(!channel.memberIds.includes(t.memberId)||!m||m.paused||m.status==='disabled'||c?.status!=='verified')fail('connection_required','请先恢复该成员连接，原消息保留',409);
   if(!await helpers.meetingTurnAllowed(tx,t))fail('meeting_changed','这条会议通知已过期，请核对结果后收尾',409);
   const next=tx.put('channel_turn',{...t,status:'ready',reason:null,nativeReceptionFailed:false,deliveryIssueId:issue.id,recoveryCount:(t.recoveryCount||0)+1});
   await helpers.outbox(tx,channel,next,c);
  }else{
   tx.put('channel_turn',{...t,status:'removed',reason:summary,resolution:cmd.action,resolvedBy:actor.memberId||'owner',evidenceMessageIds:evidence.map(m=>m.id),completedAt:tx.now});
   const n=await tx.get('outbox','notice_'+t.id,false);if(n&&!['claimed','canceled'].includes(n.status))tx.put('outbox',{...n,status:'canceled',reason:summary});
  }
 }
 const remaining=await Promise.all(issue.turnIds.map(id=>tx.get('channel_turn',id,false)));
 const resolved=remaining.every(t=>t&&terminal.has(t.status));
 const resolutions=unique(remaining.filter(Boolean).map(t=>t.resolution||t.status));
 return tx.put('channel_delivery_issue',{...issue,status:resolved?'resolved':remaining.some(t=>t&&held.has(t.status))?'reviewing':'recovering',action:null,summary,nextAction:null,version:issue.version+1,reviewedBy:actor.memberId||'owner',evidenceMessageIds:unique([...(issue.evidenceMessageIds||[]),...evidence.map(m=>m.id)]),...(resolved?{resolvedAt:tx.now,resolution:resolutions.length===1?resolutions[0]:'mixed'}:{})});
}

export async function deliveryReviewMaintenance(repo,identity,helpers,now){
 // Paginate all unresolved states so old records cannot starve current work.
 const candidates=[];
 for(const status of held){let after='';for(;;){const page=await repo.list('channel_turn',{status,after,limit:500});candidates.push(...page);if(page.length<500)break;after=page.at(-1).id;}}
 // New short traffic backoffs are a durable queue, not a user/coordinator issue.
 const cooling=candidates.filter(t=>t.status==='limited'&&t.holdReason==='automatic_burst'&&t.resumeAfter);
 for(const row of cooling)if(row.resumeAfter<=now)await repo.transact('delivery-cooldown:'+row.id+':'+row.resumeAfter+':'+(await repo.get('channel',row.scopeId,false))?.revision+':'+identity.members.find(m=>m.id===row.memberId)?.paused,{},async tx=>{
  const t=await tx.get('channel_turn',row.id);if(t.status!=='limited'||!t.resumeAfter||t.resumeAfter>now||t.claimedAt||t.lease)return {};
  const channel=await tx.get('channel',t.scopeId,false),m=identity.members.find(m=>m.id===t.memberId),c=await tx.get('connection',t.memberId,false);
  if(!channel||!channel.memberIds.includes(t.memberId)||!m||m.status==='disabled'||!await helpers.meetingTurnAllowed(tx,t))return tx.put('channel_turn',{...t,status:'removed',reason:'原通知已不再适用，未重新执行',completedAt:now});
  if(channel.status!=='active'||m.paused)return {};
  // Limit each release batch too; do not turn a restart into a second burst.
  const gateId=t.scopeId+':'+t.rootId,gate=await tx.get('delivery_cooldown',gateId,false);
  const fresh=!gate||Date.parse(now)-Date.parse(gate.windowAt)>=10000;
  const messages=fresh?[]:gate.messageIds;
  if(!messages.includes(t.messageId)&&messages.length>=20)return tx.put('channel_turn',{...t,resumeAfter:new Date(Date.parse(gate.windowAt)+10000).toISOString()});
  if(!messages.includes(t.messageId))tx.put('delivery_cooldown',{id:gateId,scopeId:t.scopeId,windowAt:fresh?now:gate.windowAt,messageIds:[...messages,t.messageId]});
  const next=tx.put('channel_turn',{...t,status:c?.status==='verified'?'ready':'unavailable',resumeAfter:null,reason:c?.status==='verified'?null:'等待恢复连接，消息已保留'});
  if(next.status==='ready')await helpers.outbox(tx,channel,next,c);
  return {};
 },now);
 const groups=new Map();for(const t of candidates){if(t.deliveryReview||t.deliveryIssueId||t.resumeAfter)continue;const key=issueKey(t);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);}
 for(const [key,rows] of groups)await repo.transact('delivery-discover:'+await digest(key+rows.map(t=>t.id+':'+t.revision).join(',')),{ids:rows.map(t=>t.id)},async tx=>{
  const channel=await tx.get('channel',rows[0].scopeId,false);if(!channel)return {};
  const prior=await tx.get('channel_delivery_issue',key,false),valid=[];
  for(const row of rows){const t=await tx.get('channel_turn',row.id);if(!held.has(t.status)||t.deliveryIssueId)continue;valid.push(t);tx.put('channel_turn',{...t,deliveryIssueId:key});}
  if(!valid.length)return {};
  const first=valid[0],cause=causeOf(first);
  return tx.put('channel_delivery_issue',{...prior,id:key,scopeId:channel.id,parentId:first.messageId,messageId:first.messageId,rootId:first.rootId,cause,impact:impact[cause],status:prior?.status==='resolved'?'reviewing':prior?.status||'reviewing',turnIds:unique([...(prior?.turnIds||[]),...valid.map(t=>t.id)]),memberIds:unique([...(prior?.memberIds||[]),...valid.map(t=>t.memberId)]),version:(prior?.version||0)+1,summary:prior?.summary||'',createdAt:prior?.createdAt||now});
 },now);
 const open=[];let after='';for(;;){const page=await repo.list('channel_delivery_issue',{after,limit:500});open.push(...page.filter(i=>i.status!=='resolved'));if(page.length<500)break;after=page.at(-1).id;}
 for(const row of open){
  const observedChannel=await repo.get('channel',row.scopeId,false);
  const observedTurns=await Promise.all([...row.turnIds,...(row.reviewTurnId?[row.reviewTurnId]:[])].map(id=>repo.get('channel_turn',id,false)));
  const observedEffective=await Promise.all(observedTurns.filter(Boolean).map(t=>effectiveTurn(repo,t)));
  const reviewerReceipts=observedChannel?.coordinatorId?await repo.list('channel_turn',{scope:row.scopeId,parent:observedChannel.coordinatorId,status:'done',order:'recent',limit:1}):[];
  const connections=await Promise.all(unique([...row.memberIds,observedChannel?.coordinatorId].filter(Boolean)).map(id=>repo.get('connection',id,false)));
  const members=identity.members.filter(m=>row.memberIds.includes(m.id)||m.id===observedChannel?.coordinatorId).map(m=>[m.id,m.paused,m.status]);
  const event=await digest(JSON.stringify(['review-classification-v2',row.id,row.revision,observedChannel?.coordinatorId,observedChannel?.status,observedTurns.map(t=>[t?.id,t?.revision]),observedEffective.map(t=>[t?.id,t?.revision]),reviewerReceipts.map(t=>[t.id,t.revision]),connections.map(c=>[c?.id,c?.status,c?.configVersion]),members]));
  await repo.transact('delivery-review:'+event,{id:row.id,event},async tx=>{
  let issue=await tx.get('channel_delivery_issue',row.id);const channel=await tx.get('channel',issue.scopeId,false);if(!channel||issue.status==='resolved')return {};
  if(issue.cause==='automatic_burst'&&issue.impact!==impact.automatic_burst)issue=tx.put('channel_delivery_issue',{...issue,impact:impact.automatic_burst,version:issue.version+1});
  const turns=(await Promise.all(issue.turnIds.map(id=>tx.get('channel_turn',id,false)))).filter(Boolean);
  const effective=await Promise.all(turns.map(t=>effectiveTurn(tx,t)));
  if(turns.length&&effective.every(t=>t&&terminal.has(t.status)))return tx.put('channel_delivery_issue',{...issue,status:'resolved',summary:issue.summary||'相关通知已有明确处理回执。',resolvedAt:now,version:issue.version+1});
  // Connection recovery only resumes undelivered work, never an uncertain execution.
  for(const t of turns.filter(t=>t.status==='unavailable'&&!t.claimedAt&&!t.lease)){
   const m=identity.members.find(m=>m.id===t.memberId),c=await tx.get('connection',t.memberId,false);
   if(channel.status==='active'&&channel.memberIds.includes(t.memberId)&&m&&!m.paused&&m.status!=='disabled'&&c?.status==='verified'&&await helpers.meetingTurnAllowed(tx,t)){
    const next=tx.put('channel_turn',{...t,status:'ready',reason:null});await helpers.outbox(tx,channel,next,c);
   }
  }
  const fresh=await Promise.all(turns.map(t=>tx.get('channel_turn',t.id)));
  if(fresh.every(t=>!held.has(t.status)))return issue.status==='recovering'?{}:tx.put('channel_delivery_issue',{...issue,status:'recovering',summary:'消息已继续投递，正在等待实际回执。',nextAction:null,version:issue.version+1});
  if(channel.status!=='active')return {};
  if(fresh.some(t=>t.status==='unavailable'))return issue.status==='needs_user'&&issue.action==='connect'?{}:tx.put('channel_delivery_issue',{...issue,status:'needs_user',action:'connect',summary:'有成员连接尚未就绪，相关消息暂未送达。',nextAction:'打开成员连接；恢复后会自动继续投递。',version:issue.version+1});
  const coordinator=identity.members.find(m=>m.id===channel.coordinatorId&&!m.paused&&m.status!=='disabled'),connection=coordinator&&await tx.get('connection',coordinator.id,false);
  if(!coordinator||connection?.status!=='verified')return issue.status==='needs_user'&&issue.action==='coordinator'?{}:tx.put('channel_delivery_issue',{...issue,status:'needs_user',action:'coordinator',summary:issue.impact,nextAction:coordinator?'恢复负责人的连接后，将自动核对这件事。':'选择一位负责人来核对，或逐项决定如何处理。',version:issue.version+1});
  const failedReviewer=fresh.filter(t=>t.memberId===coordinator.id&&t.status==='stalled');
  const lastReply=(await tx.list('channel_turn',{scope:channel.id,parent:coordinator.id,status:'done',order:'recent',limit:1}))[0];
  if(failedReviewer.length&&!failedReviewer.every(t=>lastReply?.completedAt>(t.updatedAt||t.createdAt)))return issue.status==='needs_user'&&issue.action==='reviewer_unreachable'?{}:tx.put('channel_delivery_issue',{...issue,status:'needs_user',action:'reviewer_unreachable',summary:issue.impact,nextAction:'负责人自己的消息也未能处理，已停止重复通知。请检查原 Agent，恢复后可继续原消息。',version:issue.version+1});
  const previous=issue.reviewTurnId&&await tx.get('channel_turn',issue.reviewTurnId,false);
  if(issue.reviewerId===coordinator.id&&previous){
   // A receipt without a resolution is unfinished coordinator work, not a
   // decision only the human can make. Also repair the old automatic escalation.
   if(['done','silent','removed'].includes(previous.status)&&(['reviewing','recovering'].includes(issue.status)||(issue.status==='needs_user'&&issue.action==='discuss'))){
    if(issue.action==='review_incomplete')return {};
    return tx.put('channel_delivery_issue',{...issue,status:'reviewing',action:'review_incomplete',summary:issue.summary||issue.impact,nextAction:'负责人尚未完成核对，已有工作和消息保留。',reviewCheckedAt:previous.completedAt||previous.updatedAt||now,version:issue.version+1});
   }
   if(previous.status==='stalled'&&['reviewing','recovering'].includes(issue.status))return tx.put('channel_delivery_issue',{...issue,status:'needs_user',action:'reviewer_unreachable',summary:issue.summary||issue.impact,nextAction:'核对通知未能完成。请检查负责人的原环境，已有工作保留。',version:issue.version+1});
   return {};
  }
  if(previous&&['ready','limited','unavailable','stalled'].includes(previous.status))tx.put('channel_turn',{...previous,status:'removed',reason:'已交给当前负责人核对'});
  const signal=await helpers.channelMessage(tx,channel,{memberId:'system'},'请核对一件协作消息异常。不要重复执行已有工作；用 resolve_delivery 读取详情并决定继续、被后续结果覆盖、无需再通知，或具体需要用户决定什么。',{type:'delivery_review',hidden:true,deliveryReview:issue.id,hops:0,rootId:issue.rootId});
  await helpers.enqueue(tx,identity,channel,signal,coordinator.id);
  return tx.put('channel_delivery_issue',{...issue,status:'reviewing',action:null,nextAction:null,reviewerId:coordinator.id,reviewTurnId:'turn_'+signal.id+'_'+coordinator.id,reviewRequestedAt:now,version:issue.version+1});
 },now);
 }
}
