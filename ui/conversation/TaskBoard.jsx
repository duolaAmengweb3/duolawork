import React,{useEffect,useState} from 'react';
import {ChevronDown,ChevronRight,Plus,MessageSquare,ListTodo,FileText,Paperclip,Link,Code2,CheckCircle2,Circle,LoaderCircle,AlertCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';
const labels={todo:'待开始',doing:'进行中',blocked:'受阻',done:'已完成',canceled:'已取消'};
const terminal=t=>t.status==='canceled'||t.status==='done'&&!['stale','changes_requested','review'].includes(t.delivery?.stage);
const ref=t=>({kind:'task',id:t.id,title:t.title,version:t.version||1});
export function taskState(t){
 if(t.status==='canceled')return{label:'已取消',tone:'muted'};
 if(t.status==='blocked')return{label:'受阻',tone:'attention'};
 const d=t.delivery;
 if(d?.stage==='changes_requested')return{label:'需修改',tone:'attention'};
 if(d?.stage==='stale')return{label:'需重新核对',tone:'attention'};
 if(d?.stage==='review')return{label:'待核对',tone:'review'};
 if(d?.valid)return{label:'已完成',tone:'done'};
 if(t.status==='done')return{label:'已记录完成',tone:'muted'};
 return{label:t.status==='doing'||t.acceptedAt?'进行中':'待开始',tone:t.status==='doing'||t.acceptedAt?'working':'muted'};
}
function Artifacts({task,onArtifact,onOpen}){
 const d=task.delivery,submission=d?.submission;
 const refs=[...new Map([...(submission?.refs||[]),...(task.refs||[])].filter(r=>['document','file','link'].includes(r.kind)).map(r=>[r.kind+':'+r.id,r])).values()];
 const code=submission?.codeRef;
 return <div className="task-artifacts">{refs.map(r=>{const Icon=r.kind==='file'?Paperclip:r.kind==='link'?Link:FileText;return <button className="task-artifact" key={r.kind+r.id} onClick={()=>onArtifact?.(r)}><Icon size={15}/><span>{r.title||'查看成果'}</span><small>{d?.valid?'已核对':d?.stage==='stale'?'待重新核对':submission?'待核对':''}</small></button>;})}{code&&<a className="task-artifact" href={code.repository.replace(/\/$/,'')+'/commit/'+code.commit} target="_blank" rel="noreferrer"><Code2 size={15}/><span>查看代码改动</span><small>{code.commit.slice(0,7)}</small></a>}{submission&&!refs.length&&!code&&<button className="task-artifact" onClick={()=>onOpen({...ref(task),version:undefined})}><FileText size={15}/><span>查看成果</span><small>{d.valid?'已核对':'待核对'}</small></button>}</div>;
}
function useTaskList({channelId,parentTaskId='',query='',filter='all',revision='',initialItems=[],overview=false}){
 const [data,setData]=useState({items:[],next:null}),[pages,setPages]=useState(1),[busy,setBusy]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const key=JSON.stringify([channelId,parentTaskId,query,filter]);
 useEffect(()=>{setPages(1);},[key]);
 useEffect(()=>{
  let alive=true;setBusy(true);
  const timer=setTimeout(async()=>{
   setBusy(true);setError('');
   try{
    const items=[];let after='';
    for(let page=0;page<pages;page++){
     const r=await api('/v2/space-object?'+new URLSearchParams({channelId,kind:'task',grouped:'1',filter,...(overview?{view:'overview'}:{}),...(parentTaskId?{parentTaskId}:{}),...(query?{query}:{}),...(after?{after}:{})}));
     if(!alive)return;items.push(...r.items);after=r.next;if(!after)break;
    }
    if(alive)setData({key,items,next:after});
   }catch(e){if(alive)setError(e.message);}finally{if(alive)setBusy(false);}
  },query?180:0);
  return()=>{alive=false;clearTimeout(timer);};
 },[key,pages,revision,retry]);
 const seed=initialItems.filter(t=>(!parentTaskId?!t.parentTaskId:t.parentTaskId===parentTaskId)&&(filter==='all'||(filter==='done')===terminal(t))&&(!query||[t.title,t.body,t.progress].some(v=>v?.toLowerCase().includes(query.toLowerCase()))));
 return {items:data.key===key?data.items:seed,next:data.key===key?data.next:null,busy,error,more:()=>setPages(p=>p+1),retry:()=>setRetry(n=>n+1)};
}
function TaskListState({list,empty}){
 return <>{list.error&&<p role="alert" className="space-inline-error">{list.error}<button onClick={list.retry}>重试</button></p>}{!list.items.length&&!list.error&&<p role="status" className="space-muted">{list.busy?'正在读取任务…':empty}</p>}{list.next&&<Button variant="ghost" disabled={list.busy} onClick={list.more}>查看更多</Button>}</>;
}
export function TaskChildren({channelId,parent,revision,name,onOpen,onCreate,onQuote,initialItems=[]}){
 const list=useTaskList({channelId,parentTaskId:parent.id,revision,initialItems,overview:true});
 return <div className="task-children" aria-label={parent.title+'的 Todo'}>{list.items.map(t=>{const state=taskState(t),Icon=state.tone==='done'?CheckCircle2:state.tone==='attention'?AlertCircle:state.tone==='working'?LoaderCircle:Circle;return <div className={'task-child '+(terminal(t)?'task-finished':'')} key={t.id}>
  <button className="task-child-open" onClick={()=>onOpen({...ref(t),version:undefined})}><Icon size={15} className={'task-step-icon '+state.tone}/><span><strong>{t.title}</strong><small>{state.label} · {t.assigneeId?name(t.assigneeId):'未指定成员'}</small>{t.status==='blocked'&&t.blocker&&<p>{t.blocker}</p>}</span></button>
  {onQuote&&<button className="task-quote" aria-label={'引用 '+t.title} onClick={()=>onQuote(ref(t))}><MessageSquare size={14}/></button>}
 </div>;})}<TaskListState list={list} empty="还没有拆分 Todo，小任务可以直接跟进。"/>{!terminal(parent)&&<button className="task-add-todo" onClick={()=>onCreate({kind:'task',prefill:{parentTaskId:parent.id}})}><Plus size={14}/>添加 Todo</button>}</div>;
}
export default function TaskBoard({channelId,revision,query='',filter='active',name,onOpen,onCreate,onQuote,onArtifact,initialItems=[],completed=false}){
 const list=useTaskList({channelId,revision,query,filter,initialItems,overview:true}),[expanded,setExpanded]=useState({}),[showCompleted,setShowCompleted]=useState(false);
 return <div className={'task-board task-overview '+(completed?'task-completed':'')} aria-label={completed?'已完成的任务':'按任务整理的待办'}>{list.items.map((t,index)=>{
  const n=t.subtasks,open=expanded[t.id]??(index===0&&n?.total>0&&!completed),state=taskState(t);
  return <section className="task-group" key={t.id} aria-label={'任务：'+t.title}>
   <div className="task-group-heading">{!!n?.total&&<button className="task-expand" aria-label={(open?'收起':'展开')+t.title} aria-expanded={open} onClick={()=>setExpanded(old=>({...old,[t.id]:!open}))}>{open?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button>}<button className="task-group-title" onClick={()=>onOpen({...ref(t),version:undefined})}><strong>{t.title}</strong><small>{t.assigneeId?name(t.assigneeId)+' 负责':'未指定负责人'}</small></button><span className={'task-overview-state '+state.tone}>{state.label}</span></div>
   {t.status==='blocked'&&t.blocker&&<p className="task-group-progress task-blocker">{t.blocker}</p>}
   {state.tone==='attention'&&t.delivery?.check?.reason&&<p className="task-group-progress">{t.delivery.check.reason}</p>}
   {t.progress&&t.status!=='blocked'&&<p className="task-group-progress">{t.progress}</p>}
   {n?.total>0&&!n.active&&!terminal(t)&&<p className="task-awaiting">Todo 已结束，任务成果仍待核对交付</p>}
   {open&&<TaskChildren channelId={channelId} parent={t} revision={revision} name={name} onOpen={onOpen} onCreate={onCreate} onQuote={onQuote} initialItems={initialItems}/>}
   <Artifacts task={t} onArtifact={onArtifact} onOpen={onOpen}/>
  </section>;
 })}<TaskListState list={list} empty={query?'没有匹配的任务或 Todo。':filter==='done'?'还没有已结束的任务。':'还没有待跟进的任务。'}/>{filter==='active'&&!query&&!completed&&<details className="task-completed-section" onToggle={e=>setShowCompleted(e.currentTarget.open)}><summary><ChevronRight size={15}/>已完成</summary>{showCompleted&&<TaskBoard channelId={channelId} revision={revision} filter="done" name={name} onOpen={onOpen} onCreate={onCreate} onQuote={onQuote} onArtifact={onArtifact} initialItems={initialItems} completed/>}</details>}{!completed&&<button className="task-discuss" onClick={()=>onQuote({kind:'task',...ref(list.items[0]||{id:'',title:''})})} disabled={!list.items.length}><MessageSquare size={15}/>在群里继续讨论</button>}</div>;
}
export function ParentTaskSelect({channelId,currentId,value,onChange,disabled=false}){
 const [query,setQuery]=useState(''),list=useTaskList({channelId,query});
 const choices=list.items.filter(t=>t.id!==currentId);
 return <label>所属任务<select aria-label="所属任务" disabled={disabled} value={value||''} onChange={e=>onChange(e.target.value)}><option value="">独立任务</option>{value&&!choices.some(t=>t.id===value)&&<option value={value}>当前所属任务</option>}{choices.map(t=><option key={t.id} value={t.id} disabled={terminal(t)&&t.id!==value}>{t.title}{terminal(t)?'（已结束）':''}</option>)}</select>{disabled?<small>这项任务已有 Todo，保留在第一层。</small>:<small>具体 Todo 选已有任务；小事可以独立跟进。</small>}{(list.next||query)&&<input aria-label="查找所属任务" placeholder="查找更多任务" value={query} onChange={e=>setQuery(e.target.value)}/>}<TaskListState list={list} empty="还没有其他任务。"/></label>;
}
