import {executionResource} from './execution-bindings.mjs';
import {fail,required,id} from './repository.mjs';

const live=s=>s?.status==='online'&&Date.now()-Date.parse(s.seenAt)<90000;
function member(identity,memberId){const m=identity.members.find(m=>m.id===memberId&&m.status!=='disabled');if(!m||m.platformId!=='claude-code')fail('member_unavailable','Claude 成员不可用',403);return m;}
export async function remoteSessions(repo,identity,actor,input={},write=false){
  const memberId=actor.memberId||input.memberId;
  if(!actor.owner&&!actor.memberId)fail('forbidden','需要成员或所有者身份',403);
  member(identity,memberId);
  const connection=await repo.get('connection',memberId,false);
  if(connection?.status==='disconnected')fail('disconnected','此成员已解除连接',403);
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
      r.sessions[sessionId]={id:sessionId,instanceId,runtimeId,title:required(input.title,'会话名称',200),workspace:required(input.workspace,'项目目录',1000),seenAt:tx.now,status:input.status==='offline'?'offline':'online'};
      if(!r.verificationSessionId||connection?.status!=='verified'&&!live(r.sessions[r.verificationSessionId]))r.verificationSessionId=sessionId;
      tx.put('native-source',r);return{};
    });
  }
  const r=await repo.get('native-source',memberId,false),items=Object.values(r?.sessions||{}).map(({instanceId,runtimeId,...s})=>({...s,online:live(s)}));
  return {items,bindings:r?.bindings||{},verificationSessionId:r?.verificationSessionId||null,record:{memberId,enabled:!!r,sourceReady:items.some(s=>s.online),manualAssignments:true,status:items.some(s=>s.online)?'idle':'offline',message:items.some(s=>s.online)?'Claude 工作会话已在线':'请在原来的环境打开已接入的 Claude',assignments:Object.entries(r?.bindings||{}).map(([channelId,b])=>({channelId,...b}))}};
}
export async function assignRemoteSession(repo,identity,actor,input){
  if(!actor.owner)fail('forbidden','只有用户可以选择工作会话',403);
  member(identity,input.memberId);
  if(input.mode!=='existing')fail('unsupported','请先在 Claude 中新建工作会话，再回到聊天里选择');
  return repo.transact(required(input.requestId,'请求编号',120),input,async tx=>{
    const c=await tx.get('connection',input.memberId,false);if(c?.status==='disconnected')fail('disconnected','此成员已解除连接',403);
    const channel=await tx.get('channel',input.channelId);if(!channel.memberIds.includes(input.memberId))fail('forbidden','先将成员加入此聊天',403);
    const resource=await tx.get('resource',c?await executionResource(tx,c,input.channelId):'',false);if(resource?.status==='busy')fail('resource_busy','这位成员正在处理消息，结束后再切换会话',409);
    const r=await tx.get('native-source',input.memberId),s=r.sessions[input.sessionId];if(!live(s))fail('session_offline','请先在原来的环境打开这个 Claude 会话',409);
    const binding={sessionId:s.id,title:s.title,workspace:s.workspace};r.bindings[input.channelId]=binding;tx.put('native-source',r);return{binding};
  });
}
