import {fail,required,id} from './repository.mjs';
import {nativeForm} from '../../shared/native-forms.mjs';

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
    record:{memberId:m.id,enabled:!!r,sourceReady:online&&r.sourceReady,status:online?r.status:'offline',message:online?r.message:r?'原环境暂时离线，连接、项目和对话均已保留':'复制说明，发给原来的 Agent 完成连接',runtimeLabel:r?.label||'',form:r?.form,assignments:Object.entries(bindings).map(([channelId,b])=>({channelId,...b}))}};
}
export async function runtimeOwner(repo,identity,actor,input={},write=false){
  if(!actor.owner)fail('forbidden','只有用户可以选择工作对话',403);
  const m=member(identity,actor,input.memberId),r=await repo.get('remote-runtime',m.id,false);
  if(!write){if(input.commandId){const c=await repo.get('native-command',input.commandId);if(c.memberId!==m.id)fail('forbidden','请求属于其他成员',403);return c;}const result=publicRuntime(r,m);if((await repo.get('connection',m.id,false))?.status==='disconnected')Object.assign(result.record,{enabled:false,sourceReady:false,status:'disconnected',message:'已解除连接，原项目和对话保留'});return result;}
  if((await repo.get('connection',m.id,false))?.status==='disconnected')fail('disconnected','请先重新连接这个账号',409);
  if(!live(r)||!r.sourceReady)fail('runtime_offline','Agent 所在的电脑或服务器暂未连接，原对话保留',409);
  if(!['existing','new'].includes(input.mode))fail('invalid_mode','请选择已有对话或新建对话');
  if(input.mode==='new'&&!r.create)fail('unsupported','请在原 Agent 中新建对话后选择');
  const channel=await repo.get('channel',key(input.channelId));if(!channel.memberIds.includes(m.id))fail('forbidden','先将成员加入聊天',403);
  if(input.mode==='existing'&&!r.items.some(s=>s.id===input.sessionId))fail('invalid_session','这段对话不在已连接的原环境中');
  return repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
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
        tx.put('remote-runtime',{...old,id:m.id,runtimeId,instanceId,form:input.form,label:required(input.label,'环境名称',200),seenAt:tx.now,sourceReady:input.sourceReady===true,status:['idle','working','needs_review','connecting'].includes(input.status)?input.status:'offline',message:String(input.message||'').slice(0,1000),items,projects,create:form.create,bindings:old?.bindings||{}});return{};
      });
    }else if(input.action==='release'){
      await repo.transact(id('runtimebye'),{memberId:m.id,runtimeId,instanceId},async tx=>{const r=await tx.get('remote-runtime',m.id,false);if(r?.runtimeId===runtimeId&&r.instanceId===instanceId){r.seenAt=new Date(0).toISOString();tx.put('remote-runtime',r);}return{};});
    }else if(['complete','activate'].includes(input.action)){
      await repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
        const r=await tx.get('remote-runtime',m.id);if(r.runtimeId!==runtimeId||r.instanceId!==instanceId)fail('runtime_conflict','运行端已变化',409);
        const c=await tx.get('native-command',key(input.commandId));if(c.memberId!==m.id||c.runtimeId!==runtimeId)fail('forbidden','不能完成其他运行端的请求',403);if(['completed','failed'].includes(c.status))return{};
        if(input.error){c.status='failed';c.message=String(input.error).slice(0,1000);}else{
          const b=input.action==='activate'?c.binding:input.binding;if(!b||!b.sessionId||!b.workspace)fail('invalid_binding','未收到原生对话回执');
          if(input.action==='activate'&&c.status!=='prepared')fail('invalid_phase','原生对话还未准备完成',409);
          if(c.mode==='existing'&&b.sessionId!==c.sessionId)fail('wrong_session','返回了另一段对话，原绑定保留',409);
          if(JSON.stringify(r.bindings[c.channelId]||null)!==JSON.stringify(c.previousBinding))fail('binding_changed','聊天已选择其他对话，未覆盖',409);
          const channel=await tx.get('channel',c.channelId);if(!channel.memberIds.includes(m.id))fail('forbidden','成员已离开该聊天',403);
          c.binding={sessionId:key(b.sessionId),title:required(b.title||c.title,'对话名称',200),workspace:required(b.workspace,'项目位置',1000),mode:b.mode==='native-existing'?'native-existing':'existing',runtimeId};
          if(input.action==='activate'){r.bindings[c.channelId]=c.binding;tx.put('remote-runtime',r);c.status='completed';}else c.status='prepared';
        }c.completedAt=tx.now;tx.put('native-command',c);return{};
      });
    }else fail('invalid_action','无效的运行端操作');
  }
  const r=await repo.get('remote-runtime',m.id,false),channels=(await repo.list('channel',{limit:501})).filter(c=>c.memberIds.includes(m.id)).map(c=>({id:c.id,name:c.name,memberIds:[m.id]}));
  return{member:{id:m.id,name:m.name,platformId:m.platformId,accountId:m.accountId},channels,runtime:r?{runtimeId:r.runtimeId,bindings:r.bindings}:null,commands:[...await repo.list('native-command',{parent:m.id,status:'pending',limit:501}),...await repo.list('native-command',{parent:m.id,status:'prepared',limit:501})]};
}
export async function remoteRuntimeMembers(repo,identity){const rows=[];for(const r of await repo.list('remote-runtime',{limit:501})){const m=identity.members.find(m=>m.id===r.id&&m.status!=='disabled');if(m&&(await repo.get('connection',m.id,false))?.status!=='disconnected')rows.push(publicRuntime(r,m).record);}return rows;}
