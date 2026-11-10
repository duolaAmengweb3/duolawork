import {secretaryManage} from './secretary.mjs';
import {listChannels} from './channel-management.mjs';
import {runtimeSkill} from './runtime-setup.mjs';
import {claudeSkill} from './claude-setup.mjs';
import {formsFor,nativeForm} from '../../shared/native-forms.mjs';
import {skillSettings} from './skills.mjs';
import {connectorSettings} from './connectors.mjs';
import {fail,required,id,digest} from './repository.mjs';
import {requireManager,workspaceGrant} from './delegation.mjs';
import {conversationCommand,readChannel} from './conversation.mjs';
import {issueAgentSkill} from './onboarding.mjs';
const string={type:'string'};
export const MANAGEMENT_TOOLS=[{name:'manage_workspace',description:'当前全局秘书的实际管理工具。list查看所有单聊/群聊、成员和接入状态；read读取指定聊天；create_group/update_group管理群；prepare_member准备新账号成员；prepare_connection返回一次性接入说明，官方登录仍由用户完成。skills/skill 列出与配置共享技能；connections/connection 管理连接使用范围，settings 使用同名管理表单字段；需要令牌授权时让用户在连接器页完成。overview读取跨群现状与秘书委托；watch用settings.kind(task/meeting)、id关注真实事项完结；request_update用settings.id、status(doing/done/blocked/watching)、progress、refs更新真实委托进度。保留实际秘书身份，不读取原生登录凭证。跨群管理需依据用户委托；更换负责人不能自行改用户安排。',inputSchema:{type:'object',properties:{requestId:string,action:{type:'string',enum:['list','read','create_group','update_group','prepare_member','prepare_connection','skills','skill','connections','connection','overview','watch','request_update']},channelId:string,before:{type:'integer'},name:string,memberId:string,platformId:string,form:string,memberIds:{type:'array',items:string,maxItems:30},coordinatorId:string,description:string,settings:{type:'object'}},required:['requestId','action'],additionalProperties:false}}];
export async function managementSettings(repo,identity,actor,args){
 if(!actor.owner)fail('forbidden','秘书由用户指定和更换',403);
 return repo.transact(args.requestId,{...args,actor},async tx=>{
  const current=await tx.get('workspace_secretary','current',false);
  if(args.expectedVersion!==(current?.version||0))fail('version_conflict','秘书设置已变化，请刷新',409);
  const memberId=args.memberId||null;
  if(memberId&&!identity.members.some(m=>m.id===memberId&&m.status!=='disabled'))fail('invalid_member','请选择有效成员');
  const next=tx.put('workspace_secretary',{id:'current',memberId,version:(current?.version||0)+1,status:memberId?'active':'revoked',authorizedBy:'owner',scope:'workspace-including-direct-chats',createdAt:current?.createdAt||tx.now});
  tx.put('management_event',{id:id('management'),action:'secretary.change',actorId:'owner',memberId,previousMemberId:current?.memberId||null,createdAt:tx.now});return next;
 });
}
export async function workspaceOverview(repo,identity,actor){
 await requireManager(repo,actor);
 return {secretary:await repo.get('workspace_secretary','current',false),channels:await listChannels(repo),members:identity.members.filter(m=>m.status!=='disabled').map(({id,name,platformId})=>({id,name,platformId})),connections:(await repo.list('connection',{limit:500})).map(({memberId,id,status,transport,verifiedAt})=>({memberId:memberId||id,status,transport,verifiedAt})),history:await repo.list('management_event',{order:'recent',limit:50})};
}
export async function manageWorkspace(repo,identity,actor,args,env={}){
 const grant=await requireManager(repo,actor);
 if(['overview','watch','request_update'].includes(args.action))return secretaryManage(repo,identity,actor,args);
 if(['skills','skill'].includes(args.action))return skillSettings(repo,identity,actor,args.action==='skills'?{action:'list'}:{...args.settings,requestId:args.requestId});
 if(['connections','connection'].includes(args.action))return connectorSettings(repo,identity,actor,args.action==='connections'?{action:'list'}:{...args.settings,requestId:args.requestId},env);
 if(args.action==='list')return workspaceOverview(repo,identity,actor);
 if(args.action==='read')return readChannel(repo,identity,actor,{channelId:args.channelId,...(args.before?{before:args.before}:{})});
 if(args.action==='prepare_connection'){
  const member=identity.members.find(m=>m.id===args.memberId&&m.status!=='disabled');if(!member)fail('invalid_member','成员不可用');
  const forms=formsFor(member.platformId);let form=args.form;if(forms.length===1)form=forms[0].id;
  if(forms.length&&!form){const runtime=await repo.get('remote-runtime',member.id,false);form=runtime?.form;}
  if(forms.length&&!form)fail('native_form_required','先确认该账号使用的软件：'+forms.map(f=>f.name).join('、'));
  if(form)nativeForm(form,member.platformId);
  const result=await issueAgentSkill(repo,identity,args.memberId,env.PUBLIC_ORIGIN,{requestId:'secretary-pair:'+await digest(actor.memberId+':'+args.requestId),authorize:async store=>{const current=await requireManager(store,actor);if(!current.owner&&current.version!==grant.version)fail('delegation_changed','秘书委托已变化',409);}});
  if(Date.parse(result.expiresAt)<=Date.now())fail('pairing_expired','这次说明已过期，请重新准备接入说明');
  if(member.platformId==='claude-code')result.skill=claudeSkill({origin:env.PUBLIC_ORIGIN,member,alias:'claude-'+member.id.slice(7),pairingCode:result.pairingCode});
  else if(form)result.skill=runtimeSkill({origin:env.PUBLIC_ORIGIN,member,form,pairingCode:result.pairingCode});
  return {...result,message:'把这段一次性说明发给要接入的原 Agent；需要官方登录时由用户操作，不改原环境。'};
 }
 let result;
 if(['create_group','update_group'].includes(args.action))result=await conversationCommand(repo,identity,actor,{type:args.action==='create_group'?'channel.create':'channel.update',requestId:args.requestId,...Object.fromEntries(['channelId','name','memberIds','coordinatorId','description'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]))});
 else if(args.action==='prepare_member'){
  if(!env.manageIdentity)fail('not_available','此服务尚未启用成员准备，请在成员与连接中添加',503);
  result=await env.manageIdentity({type:'workspace.prepare-member',actorMemberId:actor.memberId,delegationVersion:grant.owner?undefined:grant.version,payload:{name:required(args.name,'名称',80),platformId:required(args.platformId,'平台',80),requestId:args.requestId}});
 }else fail('invalid_action','管理操作无效');
 await repo.transact('audit:'+args.requestId,{actor,args},tx=>tx.put('management_event',{id:'manage:'+args.requestId,action:args.action,actorId:actor.memberId||'owner',channelId:result.id,name:result.name,createdAt:tx.now}));
 return {...result,link:result.kind==='channel'?{channelId:result.id}:undefined};
}
