import React,{useEffect,useState} from 'react';
import {ChevronDown,ChevronRight,Plus,MessageSquare,ListTodo} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';

const labels={todo:'待办',doing:'进行中',blocked:'受阻',done:'已完成',canceled:'已取消'};
const terminal=t=>['done','canceled'].includes(t.status);
const ref=t=>({kind:'task',id:t.id,title:t.title,version:t.version||1});

function useTaskList({channelId,parentTaskId='',query='',filter='all',revision=''}){
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
     const r=await api('/v2/space-object?'+new URLSearchParams({channelId,kind:'task',grouped:'1',filter,...(parentTaskId?{parentTaskId}:{}),...(query?{query}:{}),...(after?{after}:{})}));
     if(!alive)return;items.push(...r.items);after=r.next;if(!after)break;
    }
    if(alive)setData({key,items,next:after});
   }catch(e){if(alive)setError(e.message);}finally{if(alive)setBusy(false);}
  },query?180:0);
  return()=>{alive=false;clearTimeout(timer);};
 },[key,pages,revision,retry]);
 return {items:data.key===key?data.items:[],next:data.key===key?data.next:null,busy,error,more:()=>setPages(p=>p+1),retry:()=>setRetry(n=>n+1)};
}
function TaskListState({list,empty}){
 return <>{list.error&&<p role="alert" className="space-inline-error">{list.error}<button onClick={list.retry}>重试</button></p>}{!list.items.length&&!list.error&&<p role="status" className="space-muted">{list.busy?'正在读取任务…':empty}</p>}{list.next&&<Button variant="ghost" disabled={list.busy} onClick={list.more}>查看更多</Button>}</>;
}
export function TaskChildren({channelId,parent,revision,name,onOpen,onCreate,onQuote}){
 const list=useTaskList({channelId,parentTaskId:parent.id,revision});
 return <div className="task-children" aria-label={parent.title+'的 Todo'}>{list.items.map(t=><div className={'task-child '+(terminal(t)?'task-finished':'')} key={t.id}>
  <button className="task-child-open" onClick={()=>onOpen({...ref(t),version:undefined})}><span className={'task-status-dot '+t.status}/><span><strong>{t.title}</strong><small>{['blocked','canceled'].includes(t.status)?labels[t.status]:t.delivery?.label&&t.delivery.stage!=='legacy'?t.delivery.label:labels[t.status]} · {t.assigneeId?name(t.assigneeId):'未指定成员'}</small>{(t.blocker&&t.status==='blocked'||t.progress)&&<p>{t.status==='blocked'?t.blocker:t.progress}</p>}</span></button>
  {onQuote&&<button className="task-quote" aria-label={'引用 '+t.title} onClick={()=>onQuote(ref(t))}><MessageSquare size={14}/></button>}
 </div>)}<TaskListState list={list} empty="还没有拆分 Todo，小任务可以直接跟进。"/>{!terminal(parent)&&<button className="task-add-todo" onClick={()=>onCreate({kind:'task',prefill:{parentTaskId:parent.id}})}><Plus size={14}/>添加 Todo</button>}</div>;
}
export default function TaskBoard({channelId,revision,query,filter,name,onOpen,onCreate,onQuote}){
 const list=useTaskList({channelId,revision,query,filter}),[expanded,setExpanded]=useState({});
 return <div className="task-board" aria-label="按任务整理的待办"><p className="space-muted task-board-caption">按要完成的事整理，展开查看具体 Todo。</p>{list.items.map(t=>{
  const n=t.subtasks,open=expanded[t.id]??false;
  return <section className="task-group" key={t.id} aria-label={'任务：'+t.title}>
   <div className="task-group-heading"><button className="task-expand" aria-label={(open?'收起':'展开')+t.title} aria-expanded={open} onClick={()=>setExpanded(old=>({...old,[t.id]:!open}))}>{open?<ChevronDown size={16}/>:<ChevronRight size={16}/>}</button><button className="task-group-title" onClick={()=>onOpen({...ref(t),version:undefined})}><strong>{t.title}</strong><small>{t.assigneeId?name(t.assigneeId):'未指定负责人'} · <span className={'task-state '+t.status}>{['blocked','canceled'].includes(t.status)?labels[t.status]:t.delivery?.label&&t.delivery.stage!=='legacy'?t.delivery.label:labels[t.status]}</span></small></button><button className="task-quote" aria-label={'引用 '+t.title} onClick={()=>onQuote(ref(t))}><MessageSquare size={14}/></button></div>
   {(t.progress||t.status==='blocked'&&t.blocker)&&<p className="task-group-progress">{t.status==='blocked'?t.blocker:t.progress}</p>}
   {n?.total>0&&<div className="task-group-counts"><ListTodo size={13}/><span>{n.done}/{n.total} 项 Todo 完成{n.canceled?` · ${n.canceled} 项取消`:''}{n.blocked?` · ${n.blocked} 项受阻`:''}</span>{!n.active&&!terminal(t)&&<small>待核对交付</small>}</div>}
   {open&&<TaskChildren channelId={channelId} parent={t} revision={revision} name={name} onOpen={onOpen} onCreate={onCreate} onQuote={onQuote}/>}
  </section>;
 })}<TaskListState list={list} empty={query?'没有匹配的任务或 Todo。':filter==='done'?'还没有已结束的任务。':'还没有待跟进的任务。'}/></div>;
}
export function ParentTaskSelect({channelId,currentId,value,onChange,disabled=false}){
 const [query,setQuery]=useState(''),list=useTaskList({channelId,query});
 const choices=list.items.filter(t=>t.id!==currentId);
 return <label>所属任务<select aria-label="所属任务" disabled={disabled} value={value||''} onChange={e=>onChange(e.target.value)}><option value="">独立任务</option>{value&&!choices.some(t=>t.id===value)&&<option value={value}>当前所属任务</option>}{choices.map(t=><option key={t.id} value={t.id} disabled={terminal(t)&&t.id!==value}>{t.title}{terminal(t)?'（已结束）':''}</option>)}</select>{disabled?<small>这项任务已有 Todo，保留在第一层。</small>:<small>具体 Todo 选已有任务；小事可以独立跟进。</small>}{(list.next||query)&&<input aria-label="查找所属任务" placeholder="查找更多任务" value={query} onChange={e=>setQuery(e.target.value)}/>}<TaskListState list={list} empty="还没有其他任务。"/></label>;
}
