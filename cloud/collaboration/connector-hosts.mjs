import {id,fail,digest,required} from './repository.mjs';
import {unseal} from './security.mjs';
import {connectorAllowed} from '../../shared/connector-catalog.mjs';
export async function connectorHostRequest(repo,identity,args,token,env){
 if(args.action==='pair'){
  const key=args.key||id('hostkey');if(typeof key!=='string'||key.length<32||key.length>200)fail('invalid_host_key','运行端密钥无效');const hash=await digest(key);
  await repo.transact(id('hostpair'),{},async tx=>{
   const host=await tx.get('service_host',required(args.hostId,'运行端'));
   if(['paired','connected'].includes(host.status)&&host.tokenHash===hash)return host;
   if(host.status!=='waiting'||Date.parse(host.expiresAt)<Date.now()||host.pairingHash!==await digest(required(args.code,'配对码')))fail('pairing_expired','配对码已失效，请重新添加运行端',401);
   return tx.put('service_host',{...host,status:'paired',pairingHash:null,tokenHash:hash,lastSeen:null,environment:args.environment||null});
  });
  return {hostId:args.hostId,token:key};
 }
 const host=await repo.get('service_host',required(args.hostId,'运行端'));
 if(host.status==='disconnected'||!token||host.tokenHash!==await digest(token))fail('unauthorized','运行端授权无效',401);
 if(args.action==='poll'){
  return repo.transact(id('hostpoll'),{},async tx=>{
   const current=await tx.get('service_host',host.id);if(current.status==='disconnected')fail('unauthorized','运行端已断开',401);
   tx.put('service_host',{...current,lastSeen:tx.now,status:'connected',environment:args.environment||current.environment});
   const pending=await tx.list('service_job',{parent:host.id,status:'pending',limit:50});
   const jobs=[];for(const job of pending){
    const c=await tx.get('service_connection',job.scopeId,false);
    const member=job.memberId==='owner'?{id:'owner',status:'enabled'}:identity.members.find(m=>m.id===job.memberId);
    if(!c||c.hostId!==host.id||c.status==='disconnected'||c.version!==job.connectionVersion||!member||member.status==='disabled'||job.channelId&&!connectorAllowed(c,{memberId:job.memberId},job.channelId)){
     tx.put('service_job',{...job,status:'failed',code:'connection_changed',message:'连接或使用范围已变化'});continue;
    }
    if(Date.now()-Date.parse(job.createdAt)>40000){tx.put('service_job',{...job,status:'failed',code:'not_started',message:'请求已过期，未开始执行'});continue;}
    const lease=id('lease');tx.put('service_job',{...job,status:'active',lease,claimedAt:tx.now});
    const claimed={...job,lease,config:await unseal(c.credentials,env.ADMIN_KEY)};
    if(!args.batch)return {job:claimed};jobs.push(claimed);if(jobs.length>=20)break;
   }
   return args.batch?{jobs}:{job:null};
  });
 }
 if(args.action==='complete')return repo.transact(id('hostresult'),{},async tx=>{
  const j=await tx.get('service_job',required(args.jobId,'调用'));
  if(j.parentId!==host.id||j.status!=='active'||j.lease!==args.lease)fail('lease_conflict','此调用的领取已变化',409);
  if(j.invocationId){
   const invocation=await tx.get('service_invocation',j.invocationId,false),connection=await tx.get('service_connection',j.scopeId,false);
   const allowed=connection&&connection.status!=='disconnected'&&connection.version===j.connectionVersion&&connectorAllowed(connection,{memberId:j.memberId},j.channelId);
   if(invocation){const status=!allowed||args.error?'unknown':args.result?.isError?'failed':'succeeded',message=status==='succeeded'?'工具已返回结果':status==='unknown'?'未取得可确认的结果，请核对服务记录，勿重复执行':'工具返回执行错误';tx.put('service_invocation',{...invocation,status,message,...(allowed&&!args.error?{result:args.result}:{}),completedAt:tx.now});const event=await tx.get('connector_activity',j.invocationId,false);if(event)tx.put('connector_activity',{...event,status,message,completedAt:tx.now});}
  }
  return {status:tx.put('service_job',{...j,status:args.error?'failed':'done',...(args.error?{code:'tool_error',message:'运行端工具执行失败，请检查命令与依赖'}:{result:args.result}),completedAt:tx.now}).status};
 });
 fail('invalid_action','运行端操作无效');
}
