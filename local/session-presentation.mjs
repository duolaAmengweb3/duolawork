const normalize=value=>String(value||'').replaceAll('\\','/').replace(/\/$/,'');
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
const generic=value=>!clean(value)||/^(?:原工作会话|Codex 原工作会话|独立工作会话|新会话|新对话|Untitled)$/i.test(clean(value));
const timestamp=value=>typeof value==='number'?new Date(value<1e12?value*1000:value).toISOString():value||null;
export const sessionCategory=(workspace,managed=false)=>/(?:\/T|\/tmp)\/hub-(?:.*proof|v1-integration|session-)|\/\.local\/share\/agent-hub\/session-proof\//.test(normalize(workspace))?'verification':managed?'hub':'native';

// Only labels and metadata change. Native IDs, paths, and saved bindings stay exact.
export function presentSessions(items,{bindings={},channels=[],dataDir,platform='Agent'}={}){
 return items.map((item,index)=>{
  const linked=Object.entries(bindings).filter(([,b])=>b.sessionId===item.id).map(([id])=>channels.find(c=>c.id===id)).filter(Boolean);
  const managed=!!dataDir&&!!item.workspace&&(normalize(item.workspace)===normalize(dataDir)||normalize(item.workspace).startsWith(normalize(dataDir)+'/'));
  const native=item.mode==='native-existing'||(!managed&&!!item.source);
  const preview=clean(item.preview).slice(0,140);
  const title=generic(item.title)?linked[0]?.name||preview||`未命名对话 ${index+1}`:clean(item.title);
  const projectNameSource=clean(item.projectName)?'native':managed?'hub':item.workspace?'folder':'unknown';
  const projectName=clean(item.projectName)||(managed?'Hub 独立工作区':item.workspace?normalize(item.workspace).split('/').pop()||item.workspace:'未指定项目');
  const projectKey=item.projectId?'native:'+item.projectId:managed?'hub':item.workspace?'folder:'+normalize(item.workspace):'unknown';
  return{...item,title,preview:preview!==title?preview:'',projectKey,projectName,projectNameSource,category:sessionCategory(item.workspace,managed),sourceLabel:native?`${platform} 中的对话`:managed?'Hub 中创建的对话':`${platform} 对话`,managedWorkspace:managed,linkedChats:linked.map(c=>({id:c.id,name:c.name})),updatedAt:timestamp(item.updatedAt||item.createdAt)};
 });
}

export function sessionProjects(items,registered=[]){
 const groups=new Map();
 for(const p of registered){if(!p.id||!p.name)continue;const key='native:'+p.id;groups.set(key,{key,name:p.name,nameSource:'native',category:sessionCategory(p.workspace),workspace:p.workspace||'',items:[]});}
 for(const s of items){let group=groups.get(s.projectKey);if(!group&&!s.projectId&&!s.managedWorkspace){const matches=[...groups.values()].filter(p=>p.nameSource==='native'&&p.workspace&&normalize(p.workspace)===normalize(s.workspace));if(matches.length===1){group=matches[0];s.projectKey=group.key;s.projectName=group.name;s.projectNameSource='native';}}
  if(!group){group={key:s.projectKey,name:s.projectName,nameSource:s.projectNameSource,category:s.category||'native',workspace:s.managedWorkspace?'':s.workspace,items:[]};groups.set(s.projectKey,group);}group.items.push(s);}
 return [...groups.values()].map(p=>({...p,items:p.items.sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))}));
}

export function sessionErrorMessage(error){
 const text=String(error?.message||error||'');
 if(error?.code==='ENOENT'||/ENOENT/.test(text))return '找不到这个项目文件夹，请确认路径后重试。';
 if(error?.code==='ENOTDIR'||/ENOTDIR|EEXIST/.test(text))return '请选择项目文件夹，不能使用单个文件。';
 if(/SIGTERM|SIGKILL|原生进程已退出|原生连接已经关闭|原 Codex 连接已关闭/.test(text))return '与 Agent 的连接暂时中断，原对话和项目都已保留。请刷新列表后再试。';
 if(/接口等待超时|Connect Timeout|fetch failed|aborted due to timeout/i.test(text))return 'Agent 暂时没有响应。请稍后刷新列表；原对话和项目都已保留。';
 return text||'暂时无法读取对话，请重试。';
}
