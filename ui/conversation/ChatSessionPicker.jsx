import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,Check,ChevronRight,Folder,Loader2,MessageSquare,Search} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '../v1/api.mjs';
import {sessionErrorMessage} from '../../local/session-presentation.mjs';
import SessionLink from './SessionLink';

export default function ChatSessionPicker({member,channel,onSaved,onConnect}) {
  const [data,setData]=useState(null),[selected,setSelected]=useState(''),[mode,setMode]=useState('existing'),[workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[project,setProject]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const revision=useRef(0),saving=useRef(false);
  const load=async(initial=false)=>{
    const request=++revision.current;setLoading(true);setError('');
    try{
      const value=await api('/local/chat-sessions?'+new URLSearchParams({memberId:member.id,channelId:channel.id}));
      if(request!==revision.current)return;
      setData(value);setSelected(previous=>value.items.some(s=>s.id===previous)?previous:value.binding?.sessionId||'');
      if(initial){setMode('existing');setProject('');}else setProject(previous=>value.projects?.some(p=>p.key===previous)?previous:'');
    }catch(e){if(request===revision.current)setError(sessionErrorMessage(e));}
    finally{if(request===revision.current)setLoading(false);}
  };
  useEffect(()=>{load(true);return()=>{revision.current++;};},[member.id,channel.id]);
  const save=async()=>{
    if(saving.current)return;saving.current=true;setBusy(true);setError('');
    try{await api('/local/chat-sessions',{memberId:member.id,channelId:channel.id,mode,sessionId:selected,...(workspace.trim()?{workspace:workspace.trim()}:{})},undefined,{timeoutMs:180000});await onSaved();}
    catch(e){setError(sessionErrorMessage(e));}
    finally{saving.current=false;setBusy(false);}
  };
  if(!data)return <div className="space-y-3"><p role="status">{error||'正在读取可继续的对话…'}</p>{error&&<div className="flex gap-2"><Button onClick={()=>load(true)} disabled={loading}>重新读取</Button><Button variant="outline" onClick={onConnect}>查看连接</Button></div>}</div>;
  if(!data.record?.enabled)return <div className="space-y-3"><p className="text-sm">请先连接 {member.name} 的账号。</p><Button onClick={onConnect}>去连接</Button></div>;
  const projects=data.projects||[],activeProject=projects.find(p=>p.key===project);
  const visible=(activeProject?.items||[]).filter(s=>`${s.title} ${s.preview||''} ${s.linkedChats?.map(c=>c.name).join(' ')||''}`.toLowerCase().includes(query.toLowerCase()));
  const visibleProjects=projects.filter(p=>`${p.name} ${p.workspace} ${p.items.map(s=>s.title).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const choice=data.items.find(s=>s.id===selected),knownProjects=projects.filter(p=>p.workspace&&p.nameSource!=='hub');
  const enterProject=p=>{setProject(p.key);setQuery('');setSelected(p.items.some(s=>s.id===data.binding?.sessionId)?data.binding.sessionId:'');setWorkspace(p.workspace||'');setMode('existing');setError('');};
  const back=()=>{setProject('');setSelected('');setQuery('');setMode('existing');setError('');};
  const projectRow=p=><button type="button" key={p.key} className="session-option session-project" disabled={busy} onClick={()=>enterProject(p)}><span className="session-option-icon"><Folder size={20}/></span><span className="session-option-content"><strong>{p.name}</strong><span className="session-meta">{p.items.length} 段对话{p.nameSource==='folder'?' · 项目文件夹':p.nameSource==='hub'?' · Hub 中创建':''}</span>{p.workspace&&<span className="session-project-location" title={p.workspace}>{p.workspace}</span>}</span><ChevronRight size={17}/></button>;
  if(mode==='pair')return <section className="session-picker session-link-mode"><div className="session-picker-body"><Button className="self-start" variant="ghost" onClick={()=>setMode('existing')}><ArrowLeft size={16}/>返回项目列表</Button><SessionLink member={member} channel={channel} onSaved={onSaved}/></div></section>;
  return <section className="session-picker" aria-label="聊天的工作会话" aria-busy={busy}>
    <div className="session-picker-body">
    <p className="session-intro">先选项目，再选择让 {member.name} 在「{channel.name}」里继续哪段对话。</p>
    {data.capabilities.linkCurrent&&<Button variant="outline" disabled={busy} onClick={()=>setMode('pair')}>从 Agent 配对当前对话</Button>}
    {!activeProject&&data.binding&&<p className="session-current">当前使用：{data.binding.projectName||'已有项目'} · {data.binding.title||'已有对话'}</p>}
    {activeProject&&<div className="session-breadcrumb"><Button variant="ghost" disabled={busy} onClick={back}><ArrowLeft size={15}/>所有项目</Button><span><Folder size={16}/><strong>{activeProject.name}</strong></span></div>}
    {activeProject&&<div className="session-tabs" role="group" aria-label="选择对话方式"><Button variant={mode==='existing'?'secondary':'ghost'} disabled={busy} onClick={()=>{setMode('existing');setError('');}}>继续已有对话</Button>{data.capabilities.create&&<Button variant={mode==='new'?'secondary':'ghost'} disabled={busy} onClick={()=>{setMode('new');setWorkspace(activeProject.workspace||'');setError('');}}>在此项目新建对话</Button>}</div>}
    {mode==='existing'?<>
      <label className="session-search"><Search size={16} aria-hidden="true"/><Input aria-label={activeProject?'搜索项目内对话':'搜索项目'} placeholder={activeProject?'搜索项目内对话':'搜索项目'} value={query} disabled={busy} onChange={e=>setQuery(e.target.value)}/></label>
      {!activeProject?<div className="session-options" aria-label="可用项目">
        {visibleProjects.filter(p=>!['hub','verification'].includes(p.category)).map(projectRow)}
        {visibleProjects.some(p=>p.category==='hub')&&<><h3 className="session-list-heading">Hub 独立工作区</h3>{visibleProjects.filter(p=>p.category==='hub').map(projectRow)}</>}
        {visibleProjects.some(p=>p.category==='verification')&&<details className="session-history" open={query?true:undefined}><summary>历史验收记录 · {visibleProjects.filter(p=>p.category==='verification').length} 个项目</summary>{visibleProjects.filter(p=>p.category==='verification').map(projectRow)}</details>}
        {!visibleProjects.length&&<p className="session-empty">{query?'没有找到匹配的项目。':'暂时没有可读取的项目。'}</p>}
      </div>:<div className="session-options" role="radiogroup" aria-label="可用工作会话">
        {visible.map(s=><button type="button" key={s.id} role="radio" aria-checked={selected===s.id} disabled={busy} onClick={()=>{setSelected(s.id);setError('');}} className={'session-option '+(selected===s.id?'is-selected':'')}>
          <span className="session-option-icon"><MessageSquare size={17} aria-hidden="true"/></span>
          <span className="session-option-content"><strong>{s.title}</strong>{s.preview&&<span className="session-preview">{s.preview}</span>}<span className="session-meta">{s.sourceLabel||'已有对话'}{s.updatedAt&&<time dateTime={s.updatedAt}> · {new Date(s.updatedAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</time>}</span>{s.linkedChats?.length>0&&<span className="session-linked">用于 {s.linkedChats.map(c=>'「'+c.name+'」').join('、')}</span>}{s.running&&<span className="session-running">正在处理消息，新消息会排队</span>}</span>
          {selected===s.id&&<Check size={17} className="session-check" aria-hidden="true"/>}
        </button>)}
        {!visible.length&&<p className="session-empty">{query?'没有找到匹配的对话。':'这个项目暂时没有可继续的对话。'}{!query&&!data.capabilities.create&&data.capabilities.createHint}</p>}
      </div>}
      {activeProject&&choice&&<details className="session-details"><summary>查看所选对话的项目位置</summary><p>{choice.managedWorkspace?'这是 Hub 为该对话保留的独立工作区。':choice.workspace||'未指定项目'}</p></details>}
    </>:<div className="session-new">
      <div className="session-new-heading"><MessageSquare size={20}/><div><strong>{channel.name}</strong><p>使用 {member.name} 的账号开始，不带入其他对话内容。</p></div></div>
      <label className="session-project-label">项目<select aria-label="新对话项目" value={knownProjects.some(p=>p.workspace===workspace)?workspace:workspace?'custom':''} disabled={busy} onChange={e=>setWorkspace(e.target.value==='custom'?' ':e.target.value)}><option value="">Hub 独立工作区</option>{knownProjects.map(p=><option key={p.key} value={p.workspace}>{p.name} — {p.workspace}</option>)}<option value="custom">其他项目文件夹…</option></select></label>
      {workspace&&!knownProjects.some(p=>p.workspace===workspace)&&<Input aria-label="工作会话项目目录" value={workspace.trimStart()} onChange={e=>setWorkspace(e.target.value||' ')} placeholder="粘贴项目文件夹路径" disabled={busy}/>}
      <p className="session-hint">已有项目和对话都会保留。创建时不会修改项目文件。</p>
      {data.newSessionHint&&<p className="session-hint">{data.newSessionHint}</p>}
    </div>}
    {data.existingHint&&<p className="session-hint">{data.existingHint}</p>}
    {error&&<p role="alert" className="session-error">{error}</p>}
    </div>
    <div className="session-picker-footer">{(activeProject||mode==='new')&&<Button disabled={busy||loading||mode==='existing'&&!selected} onClick={save}>{busy&&<Loader2 size={15} className="animate-spin"/>}{busy?(mode==='new'?'正在创建对话…':'正在连接这段对话…'):mode==='new'?'创建并使用':'继续这段对话'}</Button>}{!activeProject&&data.capabilities.create&&<Button variant="outline" disabled={busy} onClick={()=>{setMode(mode==='new'?'existing':'new');setWorkspace('');setError('');}}>{mode==='new'?'返回项目列表':'新建对话…'}</Button>}<Button variant="ghost" disabled={busy||loading} onClick={()=>load()}>{loading?'正在刷新…':'刷新列表'}</Button></div>
    {busy&&<p role="status" className="session-hint">正在和 {member.name} 建立连接，请稍等，无需重复点击。</p>}
  </section>;
}
