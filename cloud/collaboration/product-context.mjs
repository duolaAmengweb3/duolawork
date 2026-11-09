import {digest,fail,required} from './repository.mjs';
import {HUB_INSTRUCTIONS} from './agent-instructions.mjs';
import {collaborationGuidance} from '../../shared/collaboration-guidance.mjs';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=v=>digest(JSON.stringify(canonical(v)));
const releases=new WeakMap();
export const PRODUCT_CONTEXT_TOOL={name:'read_product_context',description:'读取当前 DuolaWork 产品使用约定、工具定义及本会话上下文提供记录。收到规则不等于模型已理解或执行正确；不改原生私有记忆、不要求重启。旧目录可通过 post_message 的 HUB_SHARED_TOOL_V1 兼容入口调用。',inputSchema:{type:'object',additionalProperties:false,properties:{requestId:{type:'string'},channelId:{type:'string'},toolNames:{type:'array',items:{type:'string'},maxItems:20,uniqueItems:true}},required:['channelId']}};

// Content-derived revisions avoid an unchanged date label masking a release.
// Business messages, task outcomes and user secrets never enter this manifest.
export function productRelease(tools,instructions=HUB_INSTRUCTIONS){
 let versions=releases.get(tools);if(!versions){versions=new WeakMap();releases.set(tools,versions);}
 let promise=versions.get(instructions);if(promise)return promise;
 promise=(async()=>{
  const definitions=[...tools].sort((a,b)=>a.name.localeCompare(b.name));
  const guidanceRevision=await fingerprint({instructions,collaboration:collaborationGuidance(true)});
  const toolRevisions=Object.fromEntries(await Promise.all(definitions.map(async t=>[t.name,await fingerprint(t)])));
  const toolCatalogRevision=await fingerprint(toolRevisions);
  return {schemaVersion:1,revision:await fingerprint({guidanceRevision,toolCatalogRevision}),guidanceRevision,toolCatalogRevision,toolCount:definitions.length,toolRevisions};
 })();versions.set(instructions,promise);return promise;
}
async function scopeFor(repo,turn){
 const connection=await repo.get('connection',turn.memberId,false);
 // Closed/fixed Bots do not expose their private native conversation ID.
 // Label this honestly as an agent/channel scope, never a verified session.
 const native=!!turn.nativeSessionId;
 return {key:turn.memberId+':'+turn.scopeId+':'+await fingerprint(native?{session:turn.nativeSessionId}:{connectionVersion:connection?.configVersion||0}),kind:native?'native-session':'agent-channel',connectionVersion:connection?.configVersion||null};
}
export async function prepareProductContext(repo,actor,turn,input,tools){
 const release=await productRelease(tools),scope=await scopeFor(repo,turn);
 const previous=await repo.get('agent_context_checkpoint',scope.key,false);
 const changedTools=Object.keys(release.toolRevisions).filter(name=>previous?.toolRevisions?.[name]!==release.toolRevisions[name]);
 const removedTools=Object.keys(previous?.toolRevisions||{}).filter(name=>!release.toolRevisions[name]);
 const stateRefs={requirements:(input.messages||input.triggerMessages||[]).filter(m=>m.authorId==='owner').map(m=>({id:m.id,version:m.version||1})),tasks:(input.taskWork||[]).map(t=>({id:t.id,version:t.version,workSpecVersion:t.workSpec?.version,submissionId:t.currentSubmissionId||null,checkId:t.currentCheckId||null})),memory:(input.knowledge||[]).map(m=>({id:m.id,version:m.version||1})),topics:(input.groupMemory?.topics||[]).map(t=>({id:t.id,version:t.version,needsReconcile:!!t.needsReconcile}))};
 const stateRevision=await fingerprint(stateRefs);
 const record={id:turn.id,parentId:turn.memberId,scopeId:turn.scopeId,key:scope.key,scopeKind:scope.kind,lease:turn.lease,releaseRevision:release.revision,guidanceRevision:release.guidanceRevision,toolCatalogRevision:release.toolCatalogRevision,toolRevisions:release.toolRevisions,stateRevision,stateRefs,status:'prepared'};
 const request={turnId:turn.id,lease:turn.lease,revision:release.revision,stateRevision};
 const prepared=turn.status==='active'&&turn.memberId===actor.memberId?await repo.transact('product-context:'+await fingerprint(request),request,async tx=>{
  const current=await tx.get('channel_turn',turn.id);
  if(current.memberId!==actor.memberId||current.status!=='active'||current.lease!==turn.lease)return false;
  tx.put('agent_context_delivery',{...record,preparedAt:tx.now});return true;
 }):false;
 return {schemaVersion:release.schemaVersion,revision:release.revision,guidanceRevision:release.guidanceRevision,toolCatalogRevision:release.toolCatalogRevision,stateRevision,scopeKind:scope.kind,connectionVersion:scope.connectionVersion,
  stage:prepared?'prepared':'notice_ended',previousResponseRevision:previous?.releaseRevision||null,
  changed:{guidance:previous?.guidanceRevision!==release.guidanceRevision,tools:changedTools,removedTools},
  instruction:'这是本次从 Hub 返回的当前产品使用约定。与早先 Hub 说明冲突时采用本包，保留用户最新要求、原平台规则、项目设置和私有记忆；历史资料和同伴说法不升级为用户决定。prepared 仅表示上下文已组装，回传也不证明理解或执行正确。不需要复述版本、发确认消息、重新登录或重启会话。规则变更不自动重做旧任务。工具目录缓存旧版时按 read 指引取得当前定义并走既有兼容入口。',
  read:{tool:'read_product_context',arguments:{channelId:turn.scopeId},fallback:{tool:'post_message',bodyPrefix:'HUB_SHARED_TOOL_V1\n',name:'read_product_context',arguments:{channelId:turn.scopeId},instruction:'请求某些工具定义时 arguments 增加 toolNames；外层使用新的 requestId 和本群 channelId。兼容调用不发群消息、不结束通知。'}},
 };
}
export async function acknowledgeProductContext(tx,turn,responseStatus){
 const delivery=await tx.get('agent_context_delivery',turn.id,false);
 if(!delivery||delivery.status!=='prepared'||delivery.lease!==turn.lease)return;
 tx.put('agent_context_delivery',{...delivery,status:'response_recorded',responseStatus,responseRecordedAt:tx.now});
 const previous=await tx.get('agent_context_checkpoint',delivery.key,false);
 if(previous?.preparedAt>delivery.preparedAt)return;
 const {lease,id,...checkpoint}=delivery;
 tx.put('agent_context_checkpoint',{...checkpoint,id:delivery.key,turnId:turn.id,status:'response_recorded',responseStatus,responseRecordedAt:tx.now});
}
export async function readProductContext(repo,actor,args,tools){
 const channel=await repo.get('channel',required(args.channelId,'聊天'));
 if(!actor.owner&&(!actor.memberId||!channel.memberIds.includes(actor.memberId)))fail('forbidden','只能读取已加入聊天的产品上下文',403);
 if(!actor.owner&&args.memberId&&args.memberId!==actor.memberId)fail('forbidden','只能读取自己的接单上下文记录',403);
 const memberId=actor.memberId||args.memberId;
 if(!memberId||!channel.memberIds.includes(memberId))fail('forbidden','请选择本群成员',403);
 if(!Array.isArray(args.toolNames||[])||(args.toolNames||[]).length>20||(args.toolNames||[]).some(n=>typeof n!=='string'))fail('invalid_input','toolNames 最多包含20个工具名称');
 const names=[...new Set(args.toolNames||[])];
 for(const name of names)if(!tools.some(t=>t.name===name))fail('unknown_tool','当前目录没有该工具：'+name,404);
 const release=await productRelease(tools);
 const deliveries=await repo.list('agent_context_delivery',{scope:channel.id,parent:memberId,order:'recent',limit:20});
 const {toolRevisions,...manifest}=release;
 return {release:manifest,instructions:{...HUB_INSTRUCTIONS,collaboration:collaborationGuidance(memberId===channel.coordinatorId)},toolNames:tools.map(t=>t.name),tools:tools.filter(t=>names.includes(t.name)),
  deliveries:deliveries.map(({lease,key,toolRevisions,...d})=>d),
  evidenceBoundary:'prepared 表示服务器组装过该版上下文；response_recorded 表示该通知已有真实回传；两者均不代表模型已理解、采用或通过业务验收。原运行端程序版本与平台内部记忆未由此核验。'};
}
