import {putExecutionBinding} from './execution-bindings.mjs';
import {executionResource} from './execution-bindings.mjs';
import {fail,required,id,digest} from './repository.mjs';
import {nativeForm} from '../../shared/native-forms.mjs';
import {revision as currentRevision} from './runtime-download.mjs';
import {conversationCommand} from './conversation.mjs';
import {runtimeUpdateSkill} from './runtime-setup.mjs';
import {receiverVersion} from '../../shared/receiver-revision.mjs';

const live=r=>!!r&&Date.now()-Date.parse(r.seenAt)<90000;
const key=value=>required(value,'编号',120);
function member(identity,actor,memberId){
  const m=identity.members.find(m=>m.id===(actor.memberId||memberId)&&m.status!=='disabled');
  if(!m||!['codex','gemini-cli','antigravity','deepseek-harness'].includes(m.platformId))fail('invalid_member','这个成员不支持原生运行端连接');
  return m;
}
function publicRuntime(r,m){
  const online=live(r),items=r?.items||[],bindings=r?.bindings||{};
  return {remote:!!r,items,projects:r?.projects||[],bindings,capabilities:{kind:'sessions',remote:true,existing:true,create:!!r?.create,multiple:true,label:m.name+' 的对话'},
    record:{memberId:m.id,enabled:!!r,sourceReady:online&&r.sourceReady,status:online?r.status:'offline',message:online?r.message:r?'原环境暂时离线，连接、项目和对话均已保留':'复制说明，发给原来的 Agent 完成连接',runtimeLabel:r?.label||'',form:r?.form,assignments:Object.entries(bindings).map(([channelId,b])=>({channelId,...b,...(online?(r.executions||[]).find(e=>e.channelId===channelId&&e.sessionId===b.sessionId)||{}:{})}))}};
}
export async function runtimeOwner(repo,identity,actor,input={},write=false,origin=''){
  if(!actor.owner)fail('forbidden','只有用户可以选择工作对话',403);
  const m=member(identity,actor,input.memberId),r=await repo.get('remote-runtime',m.id,false);
  if(!write){if(input.commandId){const c=await repo.get('native-command',input.commandId);if(c.memberId!==m.id)fail('forbidden','请求属于其他成员',403);return c;}const result=publicRuntime(r,m);if(r){Object.assign(result.record,receiverVersion(r.receiverRevision,currentRevision));if(origin&&result.record.updateAvailable){result.updateSkill=runtimeUpdateSkill({origin,member:m,form:r.form});result.record.canRequestUpdate=live(r)&&r.sourceReady&&Object.keys(r.bindings||{}).length>0;result.record.updateRequest=await repo.get('native-update',m.id,false);}}if((await repo.get('connection',m.id,false))?.status==='disconnected')Object.assign(result.record,{enabled:false,sourceReady:false,status:'disconnected',message:'已解除连接，原项目和对话保留'});return result;}
  if((await repo.get('connection',m.id,false))?.status==='disconnected')fail('disconnected','请先重新连接这个账号',409);
  if(input.action==='update'){
    if(!r||!origin)fail('runtime_missing','请先连接原环境',409);
    if(r.receiverRevision===currentRevision)return {status:'current'};
    const previous=await repo.get('native-update',m.id,false);
    if(previous?.targetRevision===currentRevision){
      const turn=await repo.get('channel_turn','turn_'+previous.messageId+'_'+m.id,false);
      if(previous.requestId===input.requestId||['ready','active'].includes(turn?.status)||Date.now()-Date.parse(previous.requestedAt)<120000)return previous;
    }
    const channels=(await repo.list('channel',{limit:501})).filter(c=>c.memberIds.includes(m.id)&&r.bindings?.[c.id]);
    const channel=channels.find(c=>c.direct)||Object.keys(r.bindings).map(id=>channels.find(c=>c.id===id)).find(Boolean);if(!channel)fail('conversation_required','请先选择一段工作对话，或把更新说明发给原 Agent',409);
    const requestId=required(input.requestId,'请求编号',120);
    const notificationId='runtime-update:'+m.id+':'+currentRevision.slice(0,16)+':'+(previous?.messageId||'first');
    const message=await conversationCommand(repo,identity,actor,{type:'channel.post',requestId:notificationId,channelId:channel.id,mentions:[m.id],body:runtimeUpdateSkill({origin,member:m,form:r.form})});
    return repo.transact('update-record:'+message.id,{memberId:m.id,messageId:message.id},tx=>tx.put('native-update',{id:m.id,requestId,targetRevision:currentRevision,messageId:message.id,channelId:channel.id,requestedAt:tx.now,status:'requested'}));
  }
  if(!live(r)||!r.sourceReady)fail('runtime_offline','Agent 所在的电脑或服务器暂未连接，原对话保留',409);
  if(!['existing','new'].includes(input.mode))fail('invalid_mode','请选择已有对话或新建对话');
  if(input.mode==='new'&&!r.create)fail('unsupported','请在原 Agent 中新建对话后选择');
  const channel=await repo.get('channel',key(input.channelId));if(!channel.memberIds.includes(m.id))fail('forbidden','先将成员加入聊天',403);
  if(input.mode==='existing'&&!r.items.some(s=>s.id===input.sessionId))fail('invalid_session','这段对话不在已连接的原环境中');
  return repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
    const connection=await tx.get('connection',m.id),resource=await tx.get('resource',await executionResource(tx,connection,channel.id),false);if(resource?.status==='busy')fail('resource_busy','这段工作对话正在处理消息，原绑定保留',409);
    const pending=[...await tx.list('native-command',{parent:m.id,status:'pending',limit:501}),...await tx.list('native-command',{parent:m.id,status:'prepared',limit:501})].find(c=>c.channelId===channel.id);if(pending)return pending;
    const fresh=await tx.get('remote-runtime',m.id),command={id:id('nativecmd'),parentId:m.id,memberId:m.id,runtimeId:fresh.runtimeId,channelId:channel.id,mode:input.mode,sessionId:input.sessionId||null,workspace:typeof input.workspace==='string'?input.workspace.slice(0,1000):'',title:channel.name,status:'pending',createdAt:tx.now,previousBinding:fresh.bindings?.[channel.id]||null};tx.put('native-command',command);return command;
  });
}
export async function runtimeSelf(repo,identity,actor,input={},write=false){
  if(!actor.memberId)fail('forbidden','需要原生连接器身份',403);
  const m=member(identity,actor),connection=await repo.get('connection',m.id,false);if(connection?.status==='disconnected')fail('disconnected','已解除连接',403);
  if(write){
    const runtimeId=key(input.runtimeId),instanceId=key(input.instanceId);
    if(input.action==='heartbeat'){
      const form=nativeForm(input.form,m.platformId);
      if(!Array.isArray(input.items)||input.items.length>1000||!Array.isArray(input.projects)||input.projects.length>1000)fail('invalid_catalog','项目目录过大或格式不正确');
      const items=input.items.map(s=>({id:key(s.id),title:required(s.title||'未命名对话','对话名称',200),workspace:required(s.workspace,'项目位置',1000),projectId:typeof s.projectId==='string'?s.projectId.slice(0,200):undefined,projectName:typeof s.projectName==='string'?s.projectName.slice(0,200):undefined,source:input.form,mode:s.mode,updatedAt:s.updatedAt,running:!!s.running}));
      const projects=input.projects.map(p=>({id:key(p.id),name:required(p.name,'项目名称',200),workspace:required(p.workspace,'项目位置',1000)}));
      await repo.transact(id('runtimebeat'),{memberId:m.id,runtimeId,instanceId},async tx=>{
        const old=await tx.get('remote-runtime',m.id,false);
        if(old&&(old.runtimeId!==runtimeId||live(old)&&old.instanceId!==instanceId))fail('runtime_conflict','此账号已连接另一个环境；原连接保留，不自动覆盖',409);
        const executions=(Array.isArray(input.executions)?input.executions:[]).filter(e=>old?.bindings?.[e.channelId]?.sessionId===e.sessionId).slice(0,1000).map(e=>({channelId:key(e.channelId),sessionId:key(e.sessionId),pendingStepId:e.pendingStepId?key(e.pendingStepId):null,nativeState:['idle','running','unavailable','unknown'].includes(e.nativeState)?e.nativeState:undefined,observedAt:Number.isFinite(Date.parse(e.observedAt))?e.observedAt:undefined,deliveryState:['sent','queued','sending','uncertain','working'].includes(e.deliveryState)?e.deliveryState:null,workState:String(e.workState||'').slice(0,60),workMessage:String(e.workMessage||'').slice(0,1000)}));
        tx.put('remote-runtime',{...old,id:m.id,runtimeId,instanceId,form:input.form,label:required(input.label,'环境名称',200),seenAt:tx.now,sourceReady:input.sourceReady===true,receiverRevision:/^[a-f0-9]{64}$/.test(input.receiverRevision||'')?input.receiverRevision:null,status:['idle','working','syncing','needs_review','connecting','waiting_login'].includes(input.status)?input.status:'offline',message:String(input.message||'').slice(0,1000),executions,items,projects,create:form.create,bindings:old?.bindings||{}});return{};
      });
    }else if(input.action==='link'){
      await repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
        const r=await tx.get('remote-runtime',m.id),link=await tx.get('session-link',key(input.linkId));
        if(r.runtimeId!==runtimeId||r.instanceId!==instanceId||link.memberId!==m.id||link.runtimeId!==runtimeId)fail('forbidden','关联不属于这个原环境',403);
        const commandId='nativecmd_'+link.id.slice(12),old=await tx.get('native-command',commandId,false);if(old)return old;
        if(link.status!=='verified')fail('unverified','尚未收到原生对话确认',409);
        if(JSON.stringify(r.bindings[link.channelId]||null)!==JSON.stringify(link.previousBinding))fail('binding_changed','这个聊天刚刚选择了其他对话，旧配对说明不会覆盖它',409);
        const channel=await tx.get('channel',link.channelId);if(!channel.memberIds.includes(m.id))fail('forbidden','成员已离开聊天',403);
        const c={id:commandId,parentId:m.id,memberId:m.id,runtimeId,channelId:link.channelId,mode:'existing',sessionId:link.session.id,workspace:link.session.workspace,title:link.session.title,status:'pending',createdAt:tx.now,previousBinding:link.previousBinding,linkIntentId:link.id};
        tx.put('native-command',c);return c;
      });
    }else if(input.action==='release'){
      await repo.transact(id('runtimebye'),{memberId:m.id,runtimeId,instanceId},async tx=>{const r=await tx.get('remote-runtime',m.id,false);if(r?.runtimeId===runtimeId&&r.instanceId===instanceId){r.seenAt=new Date(0).toISOString();tx.put('remote-runtime',r);}return{};});
    }else if(['complete','activate'].includes(input.action)){
      await repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
        const r=await tx.get('remote-runtime',m.id);if(r.runtimeId!==runtimeId||r.instanceId!==instanceId)fail('runtime_conflict','运行端已变化',409);
        const c=await tx.get('native-command',key(input.commandId));if(c.memberId!==m.id||c.runtimeId!==runtimeId)fail('forbidden','不能完成其他运行端的请求',403);if(['completed','failed'].includes(c.status))return{};
        const link=c.linkIntentId?await tx.get('session-link',c.linkIntentId):null;
        if(link&&link.status!=='verified'){c.status='failed';c.message='原对话关联已取消，原绑定保留';tx.put('native-command',c);return{};}
        if(input.error){c.status='failed';c.message=String(input.error).slice(0,1000);if(link){link.status='failed';link.message=c.message;tx.put('session-link',link);}}else{
          const b=input.action==='activate'?c.binding:input.binding;if(!b||!b.sessionId||!b.workspace)fail('invalid_binding','未收到原生对话回执');
          if(input.action==='activate'&&c.status!=='prepared')fail('invalid_phase','原生对话还未准备完成',409);
          if(c.mode==='existing'&&b.sessionId!==c.sessionId)fail('wrong_session','返回了另一段对话，原绑定保留',409);
          if(JSON.stringify(r.bindings[c.channelId]||null)!==JSON.stringify(c.previousBinding))fail('binding_changed','聊天已选择其他对话，未覆盖',409);
          const channel=await tx.get('channel',c.channelId);if(!channel.memberIds.includes(m.id))fail('forbidden','成员已离开该聊天',403);
          c.binding={sessionId:key(b.sessionId),title:required(b.title||c.title,'对话名称',200),workspace:required(b.workspace,'项目位置',1000),mode:b.mode==='native-existing'?'native-existing':'existing',runtimeId};
          if(input.action==='activate'){const connection=await tx.get('connection',m.id),resource=await tx.get('resource',await executionResource(tx,connection,c.channelId),false);if(resource?.status==='busy')fail('resource_busy','原对话仍在工作，消息和原绑定保留',409);await putExecutionBinding(tx,{id:m.id+':'+c.channelId,parentId:m.id,scopeId:c.channelId,sessionKey:await digest(c.binding.sessionId),status:'active'});r.bindings[c.channelId]=c.binding;tx.put('remote-runtime',r);c.status='completed';if(link){link.status='completed';link.binding=c.binding;link.completedAt=tx.now;tx.put('session-link',link);}}else c.status='prepared';
        }c.completedAt=tx.now;tx.put('native-command',c);return{};
      });
    }else fail('invalid_action','无效的运行端操作');
  }
  const r=await repo.get('remote-runtime',m.id,false),channels=(await repo.list('channel',{limit:501})).filter(c=>c.memberIds.includes(m.id)).map(c=>({id:c.id,name:c.name,memberIds:[m.id]}));
  return{member:{id:m.id,name:m.name,platformId:m.platformId,accountId:m.accountId},channels,runtime:r?{runtimeId:r.runtimeId,bindings:r.bindings}:null,commands:[...await repo.list('native-command',{parent:m.id,status:'pending',limit:501}),...await repo.list('native-command',{parent:m.id,status:'prepared',limit:501})]};
}
export async function remoteRuntimeMembers(repo,identity){const rows=[];for(const r of await repo.list('remote-runtime',{limit:501})){const m=identity.members.find(m=>m.id===r.id&&m.status!=='disabled');if(m&&(await repo.get('connection',m.id,false))?.status!=='disconnected')rows.push(publicRuntime(r,m).record);}return rows;}
