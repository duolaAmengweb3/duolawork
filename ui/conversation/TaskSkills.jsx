import React,{useEffect,useState} from 'react';
import {api} from '../v1/api.mjs';
import {Button} from '@/components/ui/button';
import {ActivityRows} from './ServiceDetails.jsx';
export function TaskSkillSelect({channelId,parentTaskId,value,onChange}){
 const [items,setItems]=useState([]),[inherited,setInherited]=useState([]),[error,setError]=useState('');
 useEffect(()=>{let alive=true;Promise.all([api('/v2/skills?'+new URLSearchParams({action:'catalog',channelId})),parentTaskId?api('/v2/space-object?'+new URLSearchParams({kind:'task',channelId,id:parentTaskId})):Promise.resolve(null)]).then(([r,parent])=>{if(alive){setItems(r.items);setInherited(parent?.skillRefs||[]);setError('');}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[channelId,parentTaskId]);
 const selected=value??inherited;
 return <details className="task-skill-picker" open={!!selected.length}><summary>选用技能（可选）{selected.length?' · '+selected.length+' 项':''}</summary><p className="space-muted">按任务需要参考，保留选定版本；新 Todo 默认沿用所属任务的方法。</p>{error&&<p role="alert">{error}</p>}{items.map(s=><label key={s.id}><input type="checkbox" checked={selected.some(r=>r.skillId===s.id)} onChange={e=>onChange(e.target.checked?[...selected,{skillId:s.id,version:s.version}]:selected.filter(r=>r.skillId!==s.id))}/><span>{s.name} <small>v{selected.find(r=>r.skillId===s.id)?.version||s.version} · {s.description}</small></span></label>)}{selected.filter(r=>!items.some(s=>s.id===r.skillId)).map(r=><label key={r.skillId}><input type="checkbox" checked onChange={()=>onChange(selected.filter(x=>x.skillId!==r.skillId))}/><span>{r.name||'原选用技能'} v{r.version} · 当前不可用</span></label>)}</details>;
}
export function TaskSkillSummary({channelId,task,name}){
 const [events,setEvents]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{setBusy(true);try{const r=await api('/v2/skill-activity?'+new URLSearchParams({channelId,taskId:task.id,...(events?.next?{after:events.next}:{})}));setEvents(old=>({items:[...(old?.items||[]),...r.items],next:r.next}));setError('');}catch(e){setError(e.message);}finally{setBusy(false);}};
 useEffect(()=>{setEvents(null);setError('');},[task.id]);
 return <section className="space-section"><h3>本任务的技能</h3>{task.skillRefs?.length?task.skillRefs.map(s=><p key={s.skillId}>{s.name||'选用技能'} <small>v{s.version}</small></p>):<p className="space-muted">未指定；成员可根据实际需要选用。</p>}<Button variant="ghost" size="sm" disabled={busy} onClick={events?()=>setEvents(null):load}>{busy?'读取中…':events?'收起使用记录':'查看实际使用记录'}</Button>{error&&<p role="alert">{error}</p>}{events&&<><ActivityRows items={events.items} name={name}/>{!events.items.length&&<p className="space-muted">还没有实际使用记录。</p>}{events.next&&<Button disabled={busy} variant="ghost" onClick={load}>查看更多</Button>}</>}</section>;
}
