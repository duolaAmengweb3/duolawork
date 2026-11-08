import {id,fail,digest,required} from './repository.mjs';
import {unseal} from './security.mjs';
import {connectorAllowed} from '../../shared/connector-catalog.mjs';
import {resolveConnectorCredentials} from './mcp-connectors.mjs';
import {assertVaultUses,recordVaultUse} from './vault.mjs';
import {concealSecrets} from '../../shared/vault-references.mjs';
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
  const claimed=await repo.transact(id('hostpoll'),{},async tx=>{
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
    jobs.push({...job,lease});if(!args.batch||jobs.length>=20)break;
   }
   return {jobs};
  });
  const jobs=[];
  // Decrypt only after committing the claim. A transaction response is retained
  // in the idempotency ledger; putting resolved config there would copy secrets.
  for(const job of claimed.jobs){
   try{
    const c=await repo.get('service_connection',job.scopeId),actor=job.memberId==='owner'?{owner:true}:{memberId:job.memberId};
    const resolved=await resolveConnectorCredentials(repo,c,actor,job.channelId,env);
    await repo.transact(id('hostvault'),{},async tx=>{const current=await tx.get('service_job',job.id),connection=await tx.get('service_connection',c.id),currentHost=await tx.get('service_host',host.id);if(currentHost.status==='disconnected'||current.lease!==job.lease||connection.version!==job.connectionVersion||connection.status==='disconnected')fail('connection_changed','运行端或连接已变化',409);await assertVaultUses(tx,resolved.uses,actor,job.channelId);tx.put('service_job',{...current,vaultUses:resolved.uses});return {prepared:true};});
    const executionRevision=resolved.uses.length?job.connectionVersion+':vault:'+await digest(JSON.stringify(resolved.uses)):job.connectionVersion;
    // Older installed hosts already key sessions by connectionVersion. Give
    // them an opaque execution revision too, so rotation cannot reuse old env.
    jobs.push({...job,connectionRecordVersion:job.connectionVersion,connectionVersion:executionRevision,executionRevision,config:resolved.config});
   }catch{await repo.transact(id('hostvaultfail'),{},async tx=>{const current=await tx.get('service_job',job.id);if(current.lease===job.lease)tx.put('service_job',{...current,status:'failed',code:'vault_unavailable',message:'凭证或使用范围已变化，未启动工具'});return {};});}
  }
  return args.batch?{jobs}:{job:jobs[0]||null};
 }
 if(args.action==='complete')return repo.transact(id('hostresult'),{},async tx=>{
  const j=await tx.get('service_job',required(args.jobId,'调用'));
  if(j.parentId!==host.id||j.status!=='active'||j.lease!==args.lease)fail('lease_conflict','此调用的领取已变化',409);
  const connection=await tx.get('service_connection',j.scopeId,false),actor=j.memberId==='owner'?{owner:true}:{memberId:j.memberId};
  let allowed=connection&&connection.status!=='disconnected'&&connection.version===j.connectionVersion&&(actor.owner||connectorAllowed(connection,actor,j.channelId)),result;
  try{if(allowed){const resolved=await resolveConnectorCredentials(tx,connection,actor,j.channelId,env,j.vaultUses);await assertVaultUses(tx,j.vaultUses,actor,j.channelId);result=concealSecrets(args.result,resolved.secrets);}}catch{allowed=false;}
  if(j.invocationId){
   const invocation=await tx.get('service_invocation',j.invocationId,false);
   if(invocation){const status=!allowed||args.error?'unknown':result?.isError?'failed':'succeeded',message=status==='succeeded'?'工具已返回结果':status==='unknown'?'未取得可确认的结果，请核对服务记录，勿重复执行':'工具返回执行错误';tx.put('service_invocation',{...invocation,status,message,...(allowed&&!args.error?{result}:{}),completedAt:tx.now});const event=await tx.get('connector_activity',j.invocationId,false);if(event)tx.put('connector_activity',{...event,status,message,completedAt:tx.now});}
  }
  await recordVaultUse(tx,j.vaultUses,actor,j.channelId,j.action==='tools'?'connector_check':'connector_call',allowed&&!args.error?'succeeded':'unknown');
  return {status:tx.put('service_job',{...j,status:args.error||!allowed?'failed':'done',...(args.error||!allowed?{code:!allowed?'outcome_unknown':'tool_error',message:!allowed?'凭证或权限已变化，结果未交付；请核对服务记录':'运行端工具执行失败，请检查命令与依赖'}:{result}),completedAt:tx.now}).status};
 });
 fail('invalid_action','运行端操作无效');
}
