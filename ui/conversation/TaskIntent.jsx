import React,{useState,useEffect} from 'react';
import {ArrowUpRight,Check,MessageSquare,Send} from 'lucide-react';
import {Button} from '@/components/ui/button';

export function TaskIntentCard({message,onOpen}){
 const card=message.taskCard;if(!card)return null;
 const intent=card.intent||{},extra=Object.entries(intent).filter(([key])=>key!=='goal');
 return <div className="task-intent-card"><button onClick={()=>onOpen({kind:'task',id:message.taskId})}><span><small>{{plan:'正在推进',associate:'已关联任务',revise:'任务已更新',merge:'已合并任务',supplement:'补充到任务'}[card.action]||'任务'} · v{card.intentVersion}</small><strong>{intent.goal}</strong></span><ArrowUpRight size={17}/></button>{extra.length>0&&<details><summary>查看当前理解</summary><dl>{extra.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{typeof value==='string'?value:JSON.stringify(value,null,2)}</dd></div>)}</dl></details>}<p>可在任务里补充或修改，工作继续推进。</p></div>;
}

export function TaskIntentEditor({task,onChange}){
 const [editing,setEditing]=useState(false),[goal,setGoal]=useState(task.intent?.goal||task.title),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 if(!task.intent)return null;
 return <section className="space-section task-understanding"><h3>任务理解<Button size="sm" variant="ghost" onClick={()=>{setGoal(task.intent.goal);setEditing(!editing);}}>修改</Button></h3>{editing?<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await onChange({action:'revise',taskId:task.id,expectedVersion:task.version,intent:{...task.intent,goal},reason:'用户修改任务理解'});setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}}><textarea aria-label="任务目标" value={goal} onChange={e=>setGoal(e.target.value)} required maxLength={4000}/><Button size="sm" disabled={busy||!goal.trim()}><Check size={14}/>保存并继续</Button>{error&&<p role="alert">{error}</p>}</form>:<p>{task.intent.goal}</p>}{Object.keys(task.intent).length>1&&<details><summary>范围与交付约定</summary><dl>{Object.entries(task.intent).filter(([key])=>key!=='goal').map(([key,value])=><div key={key}><dt>{key}</dt><dd>{typeof value==='string'?value:JSON.stringify(value,null,2)}</dd></div>)}</dl></details>}</section>;
}

export function TaskSupplement({task,members,coordinatorId,name,onSend,onQuote}){
 const key='duolawork-task-draft:'+task.scopeId+':'+task.id;
 const [body,setBody]=useState(()=>{try{return localStorage.getItem(key)||'';}catch{return '';}}),[mentions,setMentions]=useState([]),[all,setAll]=useState(false),[error,setError]=useState('');
 useEffect(()=>{try{if(body)localStorage.setItem(key,body);else localStorage.removeItem(key);}catch{}},[key,body]);
 return <section className="task-supplement"><h3>补充这项任务</h3><form onSubmit={e=>{e.preventDefault();setError('');try{onSend(task,{body,mentions,mentionAll:all});setBody('');setMentions([]);setAll(false);}catch(e){setError(e.message);}}}><textarea aria-label="补充任务" placeholder="补充要求、纠正理解，或问问进展…" value={body} maxLength={12000} onChange={e=>setBody(e.target.value)}/><div className="task-supplement-routing"><label>@<select aria-label="补充任务通知对象" value="" onChange={e=>{if(e.target.value==='all'){setAll(true);setMentions([]);}else if(e.target.value){setAll(false);setMentions(old=>[...new Set([...old,e.target.value])]);}}}><option value="">选择成员</option><option value="all">全员</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><small>{all?'通知全员':mentions.length?mentions.map(name).join('、'):'默认发给负责人 '+name(coordinatorId)}</small></div>{(all||mentions.length>0)&&<button type="button" className="task-clear-target" onClick={()=>{setAll(false);setMentions([]);}}>恢复默认</button>}<div className="task-supplement-actions"><Button type="button" size="sm" variant="ghost" onClick={()=>onQuote({kind:'task',id:task.id,version:task.version,title:task.title})}><MessageSquare size={14}/>添加到会话</Button><Button size="sm" disabled={!body.trim()}><Send size={14}/>发送补充</Button></div>{error&&<p role="alert">{error}</p>}</form><small>发送后同步到群聊，关联当前任务并继续推进。</small></section>;
}
