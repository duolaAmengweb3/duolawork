import React,{useCallback,useEffect,useState,useSyncExternalStore} from 'react';
import {ArrowLeft,Check,ChevronRight,Folder,Loader2,MessageSquare,RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '../v1/api.mjs';
import {sessionErrorMessage} from '../../local/session-presentation.mjs';
import {createSessionPickerStore} from './session-picker-store.mjs';
import SessionLink from './SessionLink';

export const sessionPickerStore=createSessionPickerStore(api);
export default function ChatSessionPicker({member,channel,onSaved,onConnect}) {
  const subscribe=useCallback(fn=>sessionPickerStore.subscribe(member.id,channel.id,fn),[member.id,channel.id]);
  const getSnapshot=useCallback(()=>sessionPickerStore.snapshot(member.id,channel.id),[member.id,channel.id]);
  const {data,loading,pending,error,uncertain}=useSyncExternalStore(subscribe,getSnapshot);
  const [selected,setSelected]=useState(''),[mode,setMode]=useState('existing'),[workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[project,setProject]=useState('');
  useEffect(()=>{void sessionPickerStore.load(member.id,channel.id);},[member.id,channel.id]);
  const load=()=>sessionPickerStore.load(member.id,channel.id,{force:true});
  const busy=!!pending,items=data?.items||[],projects=data?.projects||[],activeProject=projects.find(p=>p.key===project);
  const selectedId=selected||data?.binding?.sessionId||'';
  const choice=items.find(s=>s.id===selectedId),knownProjects=projects.filter(p=>p.workspace&&!['hub','verification'].includes(p.category));
  const visible=(activeProject?.items||[]).filter(s=>`${s.title} ${s.preview||''}`.toLowerCase().includes(query.toLowerCase()));
  const visibleProjects=projects.filter(p=>`${p.name} ${p.workspace} ${p.items.map(s=>s.title).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const enterProject=p=>{setProject(p.key);setQuery('');setSelected(p.items.some(s=>s.id===data.binding?.sessionId)?data.binding.sessionId:'');setWorkspace(p.workspace||'');};
  const save=async()=>{
    try{const result=await sessionPickerStore.save({memberId:member.id,channelId:channel.id,mode,sessionId:selectedId,...(workspace.trim()?{workspace:workspace.trim()}:{})});onSaved(result.binding);}
    catch{/* The shared store preserves this error even if the picker is closed. */}
  };
  const paired=binding=>{sessionPickerStore.invalidate(member.id);onSaved(binding);};
  const projectRow=p=><button type="button" key={p.key} className="session-option session-project" disabled={busy} onClick={()=>enterProject(p)}><span className="session-option-icon"><Folder size={19}/></span><span className="session-option-content"><strong>{p.name}</strong><span className="session-meta">{p.items.length} 段对话</span><span className="session-project-location" title={p.workspace}>{p.category==='hub'?'为聊天保留的独立项目':p.workspace}</span></span><ChevronRight size={17}/></button>;
  return <section className="session-picker" aria-label="聊天的工作会话">
    <div className="session-binding-summary">{data?.binding?<><span className="session-dot connected"/><span>当前：{data.binding.projectName||'已有项目'} · {data.binding.title||'已有对话'}</span></>:<><span className="session-dot unbound"/><span>{data?'尚未选择工作对话':'正在读取连接状态…'}{data?.record?.enabled?' · 选择后即可在本聊天回应':''}</span></>}</div>
    <div className="session-tabs" role="group" aria-label="选择对话方式">
      <Button aria-pressed={mode==='existing'} variant={mode==='existing'?'secondary':'ghost'} disabled={busy} onClick={()=>setMode('existing')}>已有对话</Button>
      {data?.capabilities.create&&<Button aria-pressed={mode==='new'} variant={mode==='new'?'secondary':'ghost'} disabled={busy} onClick={()=>setMode('new')}>新建对话</Button>}
      {data?.capabilities.linkCurrent&&<Button aria-pressed={mode==='pair'} variant={mode==='pair'?'secondary':'ghost'} disabled={busy} onClick={()=>setMode('pair')}>配对当前对话</Button>}
    </div>
    <div className="session-picker-body">
      {!data?<div className="session-empty" role="status"><Loader2 size={20} className="animate-spin"/>正在读取 {member.name} 的项目…</div>:!data.record?.enabled?<div className="session-empty"><p>请先连接 {member.name} 的账号。</p><Button onClick={onConnect}>查看连接</Button></div>:mode==='pair'?<SessionLink member={member} channel={channel} onSaved={paired}/>:mode==='existing'?<>
        {activeProject&&<div className="session-breadcrumb"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>{setProject('');setSelected('');setQuery('');}}><ArrowLeft size={15}/>项目</Button><span><Folder size={16}/><strong>{activeProject.name}</strong></span></div>}
        <Input className="session-search-input" aria-label={activeProject?'搜索项目内对话':'搜索项目'} placeholder={activeProject?'搜索对话':'搜索项目或对话'} value={query} onChange={e=>setQuery(e.target.value)}/>
        {!activeProject?<div className="session-options" aria-label="可用项目">
          {visibleProjects.filter(p=>!['hub','verification'].includes(p.category)).map(projectRow)}
          {visibleProjects.some(p=>p.category==='hub')&&<><h3 className="session-list-heading">为聊天创建的项目</h3>{visibleProjects.filter(p=>p.category==='hub').map(projectRow)}</>}
          {visibleProjects.some(p=>p.category==='verification')&&<details className="session-history" open={query?true:undefined}><summary>历史验收记录 · {visibleProjects.filter(p=>p.category==='verification').length}</summary>{visibleProjects.filter(p=>p.category==='verification').map(projectRow)}</details>}
          {!visibleProjects.length&&<p className="session-empty">{query?'没有找到匹配的项目。':'暂时没有可读取的项目。'}{data.capabilities.linkCurrent&&'也可以把配对说明发到原 Agent 的对话里。'}</p>}
        </div>:<div className="session-options" role="radiogroup" aria-label="可用工作会话">
          {visible.map(s=><button type="button" key={s.id} role="radio" aria-checked={selectedId===s.id} disabled={busy} onClick={()=>setSelected(s.id)} className={'session-option '+(selectedId===s.id?'is-selected':'')}>
            <span className="session-option-icon"><MessageSquare size={17}/></span><span className="session-option-content"><strong>{s.title}</strong>{s.preview&&<span className="session-preview">{s.preview}</span>}<span className="session-meta">{s.sourceLabel||'已有对话'}{s.updatedAt&&<time dateTime={s.updatedAt}> · {new Date(s.updatedAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</time>}</span>{s.linkedChats?.length>0&&<span className="session-linked">用于 {s.linkedChats.map(c=>'「'+c.name+'」').join('、')}</span>}{s.running&&<span className="session-running">正在工作，新消息会等待</span>}</span>{selectedId===s.id&&<Check size={17} className="session-check"/>}
          </button>)}
          {!visible.length&&<p className="session-empty">{query?'没有找到匹配的对话。':'这个项目暂时没有可继续的对话。'}</p>}
        </div>}
        {activeProject&&choice&&<details className="session-details"><summary>项目位置</summary><p>{choice.workspace||'未指定项目'}</p></details>}
      </>:<div className="session-new">
        <p className="session-intro">新对话名为「{channel.name}」，使用 {member.name} 现有的账号和模型。</p>
        <label className="session-project-label">在哪个项目里开始<select aria-label="新对话项目" value={knownProjects.some(p=>p.workspace===workspace)?workspace:workspace?'custom':''} disabled={busy} onChange={e=>setWorkspace(e.target.value==='custom'?' ':e.target.value)}><option value="">为这个聊天创建独立项目</option>{knownProjects.map(p=><option key={p.key} value={p.workspace}>{p.name} — {p.workspace}</option>)}<option value="custom">其他项目文件夹…</option></select></label>
        {workspace&&!knownProjects.some(p=>p.workspace===workspace)&&<Input aria-label="工作会话项目目录" value={workspace.trimStart()} onChange={e=>setWorkspace(e.target.value||' ')} placeholder="粘贴 Agent 所在电脑或服务器上的路径" disabled={busy}/>}
        <p className="session-hint">{workspace.trim()?'沿用所选项目，原对话保留。':'项目保存在这位 Agent 所在的电脑或服务器上，下次可以继续。'}</p>
        {data.newSessionHint&&<p className="session-hint">{data.newSessionHint}</p>}
      </div>}
      {data?.existingHint&&mode==='existing'&&<p className="session-hint">{data.existingHint}</p>}
      {error&&<p role="alert" className="session-error">{sessionErrorMessage(error)}</p>}
      {uncertain&&<p className="session-hint">请先刷新列表核对结果。新建暂不可重复提交；可选择已经创建的对话。</p>}
    </div>
    {mode!=='pair'&&<div className="session-picker-footer">
      <Button disabled={!data?.record?.enabled||busy||mode==='existing'&&(!activeProject||!selectedId)||mode==='new'&&uncertain} onClick={save}>{busy&&<Loader2 size={15} className="animate-spin"/>}{busy?(pending.mode==='new'?'正在创建…':'正在关联…'):mode==='new'?'创建并使用':'用于这个聊天'}</Button>
      <Button variant="ghost" size="sm" aria-label="刷新列表" disabled={busy||loading} onClick={load}><RefreshCw size={15} className={loading?'animate-spin':''}/>{loading?'更新中':'刷新'}</Button>
    </div>}
    {busy&&<p role="status" className="session-hint">正在由 {member.name} 的原环境处理。可以关闭此窗口，操作会继续。</p>}
  </section>;
}
