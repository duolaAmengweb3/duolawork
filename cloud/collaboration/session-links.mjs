import {digest,fail,id,required} from './repository.mjs';
import {nativeForm} from '../../shared/native-forms.mjs';

const active=new Set(['waiting','confirming','verified','applying']);
const publicLink=r=>{const {codeHash,challenge,locator,...v}=r;return v;};
async function valid(repo,identity,r){
 if(!identity.members.some(m=>m.id===r.memberId&&m.status!=='disabled'))fail('member_missing','成员已移除',409);
 if((await repo.get('connection',r.memberId,false))?.status==='disconnected')fail('disconnected','账号已解除连接',409);
 if(!(await repo.get('channel',r.channelId)).memberIds.includes(r.memberId))fail('member_removed','成员已离开这个聊天',409);
}
export async function sessionLinks(repo,identity,actor,input,write,origin){
 if(!actor.owner&&!actor.memberId)fail('forbidden','请先连接账号',403);
 if(!write){
  if(input.id){const r=await repo.get('session-link',input.id);if(!actor.owner&&r.memberId!==actor.memberId)fail('forbidden','这不是你的关联',403);return publicLink(r);}
  if(actor.owner&&input.memberId&&input.channelId)return{items:(await repo.list('session-link',{parent:input.memberId,scope:input.channelId,order:'recent',limit:1})).map(publicLink)};
  const rows=(await Promise.all([...active].map(status=>repo.list('session-link',{status,...(actor.memberId?{parent:actor.memberId}:{}),limit:501})))).flat();
  return{items:rows.filter(r=>active.has(r.status)&&(!actor.memberId||r.memberId===actor.memberId)).map(r=>actor.owner||actor.memberId?{...r,codeHash:undefined}:publicLink(r))};
 }
 if(input.action==='create'){
  if(!actor.owner)fail('forbidden','只有用户可发起关联',403);
  const m=identity.members.find(m=>m.id===input.memberId&&m.status!=='disabled');if(!m)fail('member_missing','成员不存在');
  const runtime=await repo.get('remote-runtime',m.id,false),claude=m.platformId==='claude-code'?await repo.get('native-source',m.id,false):null,executor=runtime?'runtime':claude?'claude':input.executor;
  const form=runtime?.form||input.form;nativeForm(form,m.platformId);
  if(!['runtime','local','claude'].includes(executor)||!['codex','antigravity-cli','antigravity-desktop','deepseek-harness','deepseek-desktop','claude-code'].includes(form))fail('unsupported','这个运行形态还不能从当前对话关联，请使用项目列表');
  const code=Array.from(crypto.getRandomValues(new Uint8Array(10)),n=>n.toString(16).padStart(2,'0')).join('').toUpperCase(),codeHash=await digest(code);
  const r={id:id('sessionlink'),parentId:m.id,scopeId:input.channelId,memberId:m.id,channelId:required(input.channelId,'聊天',120),executor,form,runtimeId:runtime?.runtimeId||null,locator:executor==='local'?input.locator:null,previousBinding:runtime?runtime.bindings?.[input.channelId]||null:claude?claude.bindings?.[input.channelId]||null:input.previousBinding||null,codeHash,status:'waiting',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60000).toISOString()};
  await valid(repo,identity,r);
  await repo.transact(id('newlink'),{id:r.id},async tx=>{for(const old of await tx.list('session-link',{parent:m.id,scope:r.channelId,limit:501}))if(active.has(old.status)){if(old.status==='applying')fail('applying','正在保存已确认的关联，请稍候',409);old.status='cancelled';tx.put('session-link',old);}tx.put('session-link',r);return{};});
  const args={endpoint:origin,memberId:m.id,id:r.id,code,form,executor,...(r.locator?{locator:r.locator}:{})};
  if(executor==='claude')return{...publicLink(r),skill:`请把你当前正在工作的这段 Claude 对话关联到 DuolaWork 的聊天。账号已经接入，不要新建成员或更换项目。调用已有 DuolaWork 连接器的 link_current_conversation 工具，参数 ${JSON.stringify({id:r.id,code})}。由原生通道确认当前会话，不猜测会话编号。收到关联确认通知后调用 confirm_current_conversation，原项目、登录与历史保留。若没有这两个工具，请报告连接器需要更新，不要伪造完成。`};
  return{...publicLink(r),skill:`请把你当前正在工作的这段原对话关联到 DuolaWork 的聊天。账号已经连接，不要重新配对账号或新建成员。读取 ${origin}/v2/connectors/native/guide，按其中 install 下载并校验连接组件，然后运行同一目录 connectors/runtime/session-link.mjs，将下面 JSON 从标准输入传入：${JSON.stringify(args)}。必须由当前原 Agent 自己的终端工具执行，不能猜测会话 ID 或换到另一段对话。不改登录、模型、项目和原任务。执行后结束本轮；DuolaWork 会自动向原会话发送一次关联确认。收到后按指令完成，成功状态会自动显示在 DuolaWork。`};
 }
 const r=await repo.get('session-link',required(input.id,'关联',120));
 if(!actor.owner&&r.memberId!==actor.memberId)fail('forbidden','不能操作其他成员的关联',403);
 await valid(repo,identity,r);
 if(input.action==='cancel'){
  if(!actor.owner)fail('forbidden','只有用户可取消关联',403);
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:'cancel'},async tx=>{const v=await tx.get('session-link',r.id);if(v.status==='applying')fail('applying','原对话已确认，正在保存关联，请稍候',409);if(active.has(v.status)){v.status='cancelled';tx.put('session-link',v);}return publicLink(v);});
 }
 if(input.action==='redeem'){
  if(actor.memberId!==r.memberId||await digest(required(input.code,'配对码',100).toUpperCase())!==r.codeHash)fail('invalid_code','这段说明不属于当前已连接账号',403);
  if(Date.parse(r.expiresAt)<Date.now()&&r.status==='waiting')fail('expired','这段配对说明已过期，请在 DuolaWork 重新复制',410);
  if(r.executor==='runtime'&&r.runtimeId!==input.runtimeId)fail('wrong_runtime','当前 Agent 不在这个账号已连接的环境中',409);
  const s=input.session;if(!s?.id||!s.workspace)fail('missing_native_identity','未取得原生对话身份');
  const session={id:required(s.id,'对话编号',120),workspace:required(s.workspace,'项目位置',1000),title:required(s.title||'当前对话','对话标题',200)};
  if(r.executor==='claude'){
   const source=await repo.get('native-source',r.memberId),native=source.sessions[session.id];
   if(!native||native.runtimeId!==input.runtimeId||native.workspace!==session.workspace||native.status!=='online'||Date.now()-Date.parse(native.seenAt)>90000)fail('wrong_native','这不是当前已登记的原 Claude 会话',409);
  }
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:'redeem',session},async tx=>{const v=await tx.get('session-link',r.id);if(v.session&&(v.session.id!==session.id||v.session.workspace!==session.workspace))fail('already_claimed','这段说明已由另一段对话领取',409);if(!active.has(v.status)&&v.status!=='completed')fail('cancelled','这次关联已取消',409);if(v.session)return publicLink(v);v.session=session;v.challenge=id('challenge');v.status='confirming';v.claimedAt=tx.now;tx.put('session-link',v);return publicLink(v);});
 }
 if(input.action==='confirm'){
  if(actor.memberId!==r.memberId||r.challenge!==input.challenge||r.session?.id!==input.sessionId)fail('wrong_receipt','不是这段原对话的确认回执',403);
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:'confirm',sessionId:input.sessionId},async tx=>{const v=await tx.get('session-link',r.id);if(['verified','applying','completed'].includes(v.status))return publicLink(v);if(v.status!=='confirming')fail('cancelled','这次关联已取消',409);v.status='verified';v.verifiedAt=tx.now;tx.put('session-link',v);return publicLink(v);});
 }
 if(input.action==='apply-claude'){
  if(r.executor!=='claude'||actor.memberId!==r.memberId)fail('forbidden','需要原 Claude 连接器',403);
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:'apply-claude'},async tx=>{
   const v=await tx.get('session-link',r.id);if(v.status==='completed')return publicLink(v);if(v.status!=='verified')fail('unverified','原对话尚未确认',409);
   const source=await tx.get('native-source',r.memberId),native=source.sessions[v.session.id];if(!native||native.status!=='online'||Date.now()-Date.parse(native.seenAt)>90000)fail('offline','原 Claude 暂时离线',409);
   const c=await tx.get('connection',r.memberId),resource=await tx.get('resource',c.resourceKey||'',false);if(resource?.status==='busy')fail('busy','等待原工作完成后保存关联',409);
   if(JSON.stringify(source.bindings[v.channelId]||null)!==JSON.stringify(v.previousBinding))fail('binding_changed','聊天刚刚选择了其他对话，旧说明没有覆盖它',409);
   source.bindings[v.channelId]={sessionId:native.id,title:native.title,workspace:native.workspace};tx.put('native-source',source);v.status='completed';v.completedAt=tx.now;tx.put('session-link',v);return publicLink(v);
  });
 }
 if(input.action==='begin'){
  if(!actor.owner||r.executor!=='local')fail('forbidden','需要原本机执行端',403);
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:'begin'},async tx=>{const v=await tx.get('session-link',r.id);if(v.status==='applying')return publicLink(v);if(v.status!=='verified')fail('unverified','原对话尚未确认或关联已取消',409);v.status='applying';tx.put('session-link',v);return publicLink(v);});
 }
 if(['failed','completed'].includes(input.action)){
  if(r.executor==='local'?!actor.owner:actor.memberId!==r.memberId)fail('forbidden','需要原连接器回执',403);
  return repo.transact(required(input.requestId,'请求',120),{id:r.id,action:input.action,message:input.message||''},async tx=>{const v=await tx.get('session-link',r.id);if(v.status==='completed')return publicLink(v);if(!active.has(v.status))fail('cancelled','关联已取消',409);if(input.action==='completed'&&v.status!=='applying')fail('unverified','尚未收到原生回执',409);v.status=input.action;v.message=String(input.message||'').slice(0,1000);v.completedAt=tx.now;tx.put('session-link',v);return publicLink(v);});
 }
 fail('invalid_action','无效的关联操作');
}
