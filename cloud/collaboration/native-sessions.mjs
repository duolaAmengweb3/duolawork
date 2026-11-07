import {putExecutionBinding} from './execution-bindings.mjs';
import {executionResource} from './execution-bindings.mjs';
import {fail,required,id,digest} from './repository.mjs';

const live=s=>s?.status==='online'&&Date.now()-Date.parse(s.seenAt)<90000;
async function expireCreates(repo,memberId){
  for(const c of await repo.list('native-command',{parent:memberId,status:'pending',limit:501})){
    if(c.engine!=='claude'||Date.now()-Date.parse(c.createdAt)<300000)continue;
    await repo.transact('expire-create:'+c.id,{id:c.id},async tx=>{const fresh=await tx.get('native-command',c.id);if(fresh.status==='pending'){fresh.status='failed';fresh.message='原环境没有完成创建，原对话保留。请检查 Claude 的连接状态后重试。';tx.put('native-command',fresh);}return{};});
  }
}
function member(identity,memberId){const m=identity.members.find(m=>m.id===memberId&&m.status!=='disabled');if(!m||m.platformId!=='claude-code')fail('member_unavailable','Claude 成员不可用',403);return m;}
export async function remoteSessions(repo,identity,actor,input={},write=false){
  const memberId=actor.memberId||input.memberId;
  if(!actor.owner&&!actor.memberId)fail('forbidden','需要成员或所有者身份',403);
  member(identity,memberId);
  const connection=await repo.get('connection',memberId,false);
  if(connection?.status==='disconnected')fail('disconnected','此成员已解除连接',403);
  await expireCreates(repo,memberId);
  if(!write&&input.commandId){
    if(!actor.owner)fail('forbidden','只有用户可以查看创建请求',403);
    const command=await repo.get('native-command',input.commandId);
    if(command.memberId!==memberId||command.engine!=='claude')fail('forbidden','请求不属于此成员',403);
    return command;
  }
  if(write&&input.action)return createCommand(repo,actor,input);
  if(write){
    if(!actor.memberId)fail('forbidden','只有原生连接器可登记会话',403);
    const sessionId=required(input.sessionId,'原生会话编号',100),instanceId=required(input.instanceId,'运行实例',100);
    if(!/^[a-zA-Z0-9_-]+$/.test(sessionId)||!/^[a-zA-Z0-9_-]+$/.test(instanceId))fail('invalid_session','会话编号无效');
    await repo.transact(id('native-heartbeat'),{memberId,sessionId,instanceId},async tx=>{
      const r=await tx.get('native-source',memberId,false)||{id:memberId,sessions:{},bindings:{}};
      const prior=r.sessions[sessionId];
      if(live(prior)&&prior.instanceId!==instanceId)fail('session_busy','同一原生会话已有连接器，请先关闭重复终端',409);
      const other=await tx.list('native-source',{limit:501});
      const runtimeId=required(input.runtimeId,'运行端编号',100);
      if(other.some(x=>x.id!==memberId&&Object.values(x.sessions||{}).some(s=>s.runtimeId===runtimeId&&s.id===sessionId&&live(s))))fail('session_owned','此会话已经属于另一位 Hub 成员',409);
      if(!prior&&Object.keys(r.sessions).length>=100)fail('session_limit','会话登记已达上限，请整理离线会话');
      r.sessions[sessionId]={id:sessionId,instanceId,runtimeId,title:required(input.title,'会话名称',200),workspace:required(input.workspace,'项目目录',1000),createdAt:prior?.createdAt||tx.now,seenAt:tx.now,status:input.status==='offline'?'offline':'online',canCreate:input.canCreate===true};
      if(!r.verificationSessionId||connection?.status!=='verified'&&!live(r.sessions[r.verificationSessionId]))r.verificationSessionId=sessionId;
      tx.put('native-source',r);return{};
    });
  }
  const r=await repo.get('native-source',memberId,false),items=Object.values(r?.sessions||{}).map(({instanceId,runtimeId,...s})=>({...s,online:live(s)}));
  const canCreate=items.some(s=>s.online&&s.canCreate);
  // A different online conversation must not turn this chat's offline binding green.
  const observedAt=new Date().toISOString(),assignments=Object.entries(r?.bindings||{}).map(([channelId,b])=>{
    const session=items.find(s=>s.id===b.sessionId);
    return {channelId,...b,nativeState:session?.online?'unknown':'unavailable',observedAt,...(!session?.online?{nativeIssueCode:'session_offline',nativeMessage:'这段原对话的接收连接已离线。请在原环境检查或打开这段对话；原项目与历史保留。'}:{})};
  });
  const commands=actor.memberId?(await repo.list('native-command',{parent:memberId,status:'pending',limit:501})).filter(c=>c.engine==='claude'):undefined;
  return {items,bindings:r?.bindings||{},verificationSessionId:r?.verificationSessionId||null,capabilities:{create:canCreate,createHint:canCreate?'新对话会在 Claude 原来的电脑或服务器创建，沿用原账号和工具。':'原环境的连接器尚未提供新建能力；可配对已打开的对话。'},...(commands?{commands}:{}),record:{memberId,enabled:!!r,sourceReady:items.some(s=>s.online),manualAssignments:true,status:items.some(s=>s.online)?'idle':'offline',message:items.some(s=>s.online)?'Claude 工作会话已在线':'请在原来的环境打开已接入的 Claude',assignments}};
}
export async function assignRemoteSession(repo,identity,actor,input){
  if(!actor.owner)fail('forbidden','只有用户可以选择工作会话',403);
  member(identity,input.memberId);
  if(!['existing','new'].includes(input.mode))fail('unsupported','请选择已有对话或新建对话');
  return repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
    const c=await tx.get('connection',input.memberId,false);if(c?.status==='disconnected')fail('disconnected','此成员已解除连接',403);
    const channel=await tx.get('channel',input.channelId);if(!channel.memberIds.includes(input.memberId))fail('forbidden','先将成员加入此聊天',403);
    const resource=await tx.get('resource',c?await executionResource(tx,c,input.channelId):'',false);if(resource?.status==='busy')fail('resource_busy','这位成员正在处理消息，结束后再切换会话',409);
    const r=await tx.get('native-source',input.memberId);
    if(input.mode==='new'){
      const pending=(await tx.list('native-command',{parent:input.memberId,status:'pending',limit:501})).find(c=>c.channelId===channel.id);if(pending)return pending;
      const available=Object.values(r.sessions).filter(s=>live(s)&&s.canCreate);
      if(!available.length)fail('unsupported','原环境的连接器尚未提供新建能力，请更新连接器或配对已打开的对话',409);
      const workspace=typeof input.workspace==='string'?input.workspace.trim():'';
      if(workspace&&(workspace.length>1000||!workspace.startsWith('/')||workspace.includes('\0')))fail('invalid_workspace','请选择 Claude 所在环境中的项目目录');
      const selected=r.sessions[r.bindings[channel.id]?.sessionId],project=available.find(s=>workspace&&s.workspace===workspace);
      const runtimeId=project?.runtimeId||selected?.runtimeId||(new Set(available.map(s=>s.runtimeId)).size===1?available[0].runtimeId:null);
      if(!runtimeId||!available.some(s=>s.runtimeId===runtimeId))fail('runtime_required','请选择要在哪个原环境的项目中新建对话',409);
      return tx.put('native-command',{id:id('nativecmd'),engine:'claude',parentId:input.memberId,memberId:input.memberId,runtimeId,channelId:channel.id,mode:'new',workspace,title:channel.name,status:'pending',createdAt:tx.now,previousBinding:r.bindings[channel.id]||null});
    }
    const s=r.sessions[input.sessionId];if(!live(s))fail('session_offline','请先在原来的环境打开这个 Claude 会话',409);
    for(const pending of await tx.list('native-command',{parent:input.memberId,status:'pending',limit:501}))if(pending.channelId===channel.id){pending.status='failed';pending.message='你已选择其他对话，未覆盖当前选择；已经创建的对话仍保留。';tx.put('native-command',pending);}
    const binding={sessionId:s.id,title:s.title,workspace:s.workspace};r.bindings[input.channelId]=binding;tx.put('native-source',r);
    await putExecutionBinding(tx,{id:input.memberId+':'+input.channelId,parentId:input.memberId,scopeId:input.channelId,sessionKey:await digest(s.id),status:'active'});
    return{binding};
  });
}

async function createCommand(repo,actor,input){
  if(!actor.memberId||!['claim-create','complete-create','fail-create'].includes(input.action))fail('forbidden','无效的原环境创建操作',403);
  return repo.transact(required(input.requestId,'请求编号',120),{...input,memberId:actor.memberId},async tx=>{
    const r=await tx.get('native-source',actor.memberId),s=r.sessions[input.sessionId];
    if(!live(s)||s.instanceId!==input.instanceId||!s.canCreate)fail('forbidden','只有在线的原环境接收器可以创建对话',403);
    const c=await tx.get('native-command',required(input.commandId,'创建请求',120));
    if(c.memberId!==actor.memberId||c.engine!=='claude'||c.runtimeId!==s.runtimeId)fail('forbidden','创建请求属于其他原环境',403);
    if(c.status!=='pending')return c;
    const holder=c.claimedBy&&r.sessions[c.claimedBy.sessionId];
    const ours=c.claimedBy?.sessionId===s.id&&c.claimedBy?.instanceId===s.instanceId;
    if(input.action==='claim-create'){
      if(!ours&&c.claimedBy&&holder?.instanceId===c.claimedBy.instanceId&&live(holder))return {...c,owned:false};
      c.claimedBy={sessionId:s.id,instanceId:s.instanceId};tx.put('native-command',c);return {...c,owned:true};
    }
    if(!ours)fail('forbidden','创建请求由其他接收器处理',403);
    if(input.action==='fail-create'){c.status='failed';c.message=required(input.message,'失败原因',1000);tx.put('native-command',c);return c;}
    const fresh=r.sessions[input.createdSessionId];
    if(!live(fresh)||fresh.runtimeId!==c.runtimeId)fail('session_not_ready','新对话尚未接通，原绑定保留',409);
    if(Date.parse(fresh.createdAt||fresh.seenAt)<Date.parse(c.createdAt))fail('not_new_session','不能把原有对话冒充新建对话',409);
    if(fresh.workspace!==input.workspace)fail('workspace_changed','新对话与创建的项目不一致，原绑定保留',409);
    const channel=await tx.get('channel',c.channelId);
    if(!channel.memberIds.includes(actor.memberId)||JSON.stringify(r.bindings[c.channelId]||null)!==JSON.stringify(c.previousBinding)){
      c.status='failed';c.message='聊天成员或对话选择已变化，新建对话已保留，未覆盖当前选择';tx.put('native-command',c);return c;
    }
    const connection=await tx.get('connection',actor.memberId),resource=await tx.get('resource',await executionResource(tx,connection,c.channelId),false);
    if(resource?.status==='busy')fail('resource_busy','原对话仍在处理消息，结束后自动完成选择',409);
    c.sessionId=fresh.id;c.binding={sessionId:fresh.id,title:c.title,workspace:fresh.workspace,mode:'new',runtimeId:c.runtimeId};
    r.bindings[c.channelId]=c.binding;tx.put('native-source',r);
    await putExecutionBinding(tx,{id:actor.memberId+':'+c.channelId,parentId:actor.memberId,scopeId:c.channelId,sessionKey:await digest(fresh.id),status:'active'});
    c.status='completed';c.completedAt=tx.now;tx.put('native-command',c);return c;
  });
}
