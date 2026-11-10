import {seedSkills} from './builtin-skills.mjs';
import {access} from './workspace-objects.mjs';
import {fail,required} from './repository.mjs';
import {connectorAllowed,CONNECTOR_CATALOG} from '../../shared/connector-catalog.mjs';
import {skillAllowed} from './skill-bindings.mjs';

export const CHANNEL_RESOURCE_TOOL={name:'channel_resources',description:'查看或调整本群使用的连接器、默认账号、技能和默认资料目录。默认沿用全局开放设置；本群开关不能扩大全局已关闭的范围。选择默认账号不关闭其他可用账号。',inputSchema:{type:'object',properties:{channelId:{type:'string'},action:{type:'string',enum:['list','connection','skill','default_account','folder']},requestId:{type:'string'},expectedVersion:{type:'integer',minimum:0},connectionId:{type:['string','null']},skillId:{type:'string'},provider:{type:'string'},enabled:{type:'boolean'},folderId:{type:['string','null']}},required:['channelId','action'],additionalProperties:false}};
const defaults={version:0,disabledConnectionIds:[],disabledSkillIds:[],defaultConnections:{},defaultFolderId:null};
const preferences=c=>({...defaults,...c.resourcePreferences});
const providerOf=c=>c.provider||'github';
export async function channelResources(repo,actor,args){
 const channel=await access(repo,args.channelId,actor);
 if(args.action!=='list'){
  required(args.requestId,'请求编号',160);
  await repo.transact(args.requestId,{actor,args},async tx=>{
   const current=await access(tx,args.channelId,actor),p=preferences(current);
   if(args.expectedVersion!==p.version)fail('version_conflict','本群资源已更新，请刷新后再试',409);
   if(['connection','skill'].includes(args.action)){
    if(typeof args.enabled!=='boolean')fail('invalid_input','请选择开启或关闭');
    const connection=args.action==='connection',key=required(connection?args.connectionId:args.skillId,'资源编号',160);
    const resource=await tx.get(connection?'service_connection':'workspace_skill',key);
    // Global restrictions remain authoritative. A group toggle never opens
    // another group's private source, a disconnected account or a disabled skill.
    const permitted=connection?connectorAllowed(resource,actor,current.id):skillAllowed(resource,actor,current.id);
    if(args.enabled&&!permitted)fail('resource_unavailable','该资源未在全局向本群开放，请在全局管理查看范围',403);
    const field=connection?'disabledConnectionIds':'disabledSkillIds',values=new Set(p[field]);
    args.enabled?values.delete(key):values.add(key);p[field]=[...values];
   }else if(args.action==='default_account'){
    const provider=required(args.provider,'服务类型',100),key=args.connectionId||null;
    if(key){const c=await tx.get('service_connection',key);if(providerOf(c)!==provider||c.status!=='connected'||!connectorAllowed(c,actor,current.id,p))fail('resource_unavailable','请选择本群已连接并开启的账号',403);}
    p.defaultConnections={...p.defaultConnections,...(key?{[provider]:key}:{})};if(!key)delete p.defaultConnections[provider];
   }else if(args.action==='folder'){
    if(args.folderId){const f=await tx.get('channel_folder',args.folderId);if(f.scopeId!==current.id||f.status==='deleted')fail('invalid_folder','请选择本群的资料文件夹');}
    p.defaultFolderId=args.folderId||null;
   }else fail('invalid_action','资源操作无效');
   p.version++;tx.put('channel',{...current,resourcePreferences:p});
   return {version:p.version};
  });
 }
 const latest=await access(repo,args.channelId,actor),p=preferences(latest);
 await seedSkills(repo);
 const [connections,skills]=await Promise.all([repo.list('service_connection',{limit:500}),repo.list('workspace_skill',{limit:500})]);
 const folder=p.defaultFolderId?await repo.get('channel_folder',p.defaultFolderId,false):null;
 return {channelId:latest.id,version:p.version,defaultConnections:p.defaultConnections,defaultFolderId:folder&&folder.scopeId===latest.id&&folder.status!=='deleted'?folder.id:null,
  connections:connections.filter(c=>c.status!=='disconnected'&&(actor.owner||connectorAllowed(c,actor,latest.id))).map(c=>({id:c.id,provider:providerOf(c),name:c.name||CONNECTOR_CATALOG.find(x=>x.id===providerOf(c))?.name||'GitHub',account:c.account||c.name||'已配置账号',globalAllowed:connectorAllowed(c,actor,latest.id),enabled:connectorAllowed(c,actor,latest.id,p),connected:c.status==='connected',health:c.health||(c.status==='connected'?'ready':'unchecked'),preferred:p.defaultConnections[providerOf(c)]===c.id})),
  skills:skills.filter(s=>actor.owner||skillAllowed(s,actor,latest.id)).map(s=>({id:s.id,name:s.builtin?s.description.split('：')[0]:s.name,description:s.description,version:s.version,globalAllowed:skillAllowed(s,actor,latest.id),enabled:skillAllowed(s,actor,latest.id,p)}))};
}
