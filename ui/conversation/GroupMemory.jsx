import React,{useEffect,useState} from 'react';
import {ArrowLeft,ChevronRight,MessageSquare,Search,RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api,time} from '../v1/api.mjs';

const phases={goal:'需求',change:'变化',evidence:'依据',decision:'决定',result:'结果',question:'未决问题',dissent:'分歧',correction:'纠正'};
export default function GroupMemory({channelId,revision,name,onSource,onQuote}){
 const [data,setData]=useState(null),[topicId,setTopicId]=useState(null),[detail,setDetail]=useState(null),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),200);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{setTopicId(null);setData(null);setDetail(null);setQuery('');},[channelId]);
 useEffect(()=>{let alive=true;setError('');const params=new URLSearchParams({channelId,...(topicId?{topicId}:{query:search})});api('/v2/group-memory?'+params).then(r=>{if(alive){if(topicId)setDetail(r);else setData(r);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[channelId,topicId,revision,refresh,search]);
 const open=id=>{setDetail(null);setTopicId(id);};
 async function more(){try{const current=topicId?detail:data;if(!current?.next)return;const r=await api('/v2/group-memory?'+new URLSearchParams({channelId,...(topicId?{topicId}:{query:search}),after:current.next}));if(topicId)setDetail(d=>({...r,episodes:[...d.episodes,...r.episodes]}));else setData(d=>({...r,items:[...d.items,...r.items]}));}catch(e){setError(e.message);}}
 return <section className="group-memory" aria-label="群记忆">
  {topicId?<Button size="sm" variant="ghost" onClick={()=>{setTopicId(null);setDetail(null);}}><ArrowLeft size={15}/>返回话题</Button>:<><p className="space-explainer">负责人和成员自动留下关键需求、变化与结果。你可以随时在聊天中纠正。</p><label className="space-search"><Search size={15}/><input aria-label="搜索群记忆" placeholder="查找一个话题…" value={query} onChange={e=>setQuery(e.target.value)}/></label></>}
  {error&&<div role="alert" className="space-inline-error">{error}<Button size="sm" variant="ghost" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={13}/>重试</Button></div>}
  {topicId?detail?<>
   <div className="space-detail-heading"><h2>{detail.title}</h2><small>更新于 {time(detail.updatedAt||detail.createdAt)}</small></div>
   <p className="group-memory-summary">{detail.body}</p>
   {detail.needsReconcile&&<p className="space-muted">有待核对的补充或分歧，尚未形成一致结论。</p>}
   <Button variant="outline" size="sm" onClick={()=>onQuote({kind:'memory',id:detail.id,version:detail.version,title:detail.title})}><MessageSquare size={14}/>在聊天中讨论</Button>
   <ol className="group-memory-timeline">{(detail.episodes||[]).map(e=><li key={e.id}><div><strong>{phases[e.phase]||'记录'}{e.supersededBy?' · 已被纠正':''}</strong><small>{name(e.authorId)} · {time(e.createdAt)}</small></div><p>{e.body}</p><div className="group-memory-sources">{(e.refs||[]).map(r=><button key={r.kind+r.id} onClick={()=>r.kind==='message'?onSource(r.id):onQuote(r)}>{r.kind==='message'?'查看原消息':'引用依据'}<ChevronRight size={12}/></button>)}</div></li>)}</ol>
   {!!detail.relatedTopicIds?.length&&<div className="space-section"><h3>关联话题</h3>{detail.relatedTopicIds.map(key=><Button key={key} size="sm" variant="ghost" onClick={()=>open(key)}>{data?.items?.find(x=>x.id===key)?.title||'查看相关经历'}<ChevronRight size={12}/></Button>)}</div>}
   {detail.next&&<Button variant="ghost" onClick={more}>继续查看经历</Button>}
  </>:<p role="status" className="space-muted">正在读取话题…</p>:data?<>
   <div className="space-object-list">{data.items.map(item=><div className="space-object" key={item.id}><button className="space-object-main" onClick={()=>open(item.id)}><span><strong>{item.title}</strong><p>{item.body}</p><small>{item.needsReconcile?'保留未决问题 · ':''}{time(item.updatedAt||item.createdAt)}</small></span><ChevronRight size={15}/></button></div>)}</div>
   {!data.items.length&&<div className="space-blank"><strong>关键经历会留在这里</strong><p>正常交流即可，不需要手动建档或批准记忆。</p></div>}
   {data.next&&<Button variant="ghost" onClick={more}>更多话题</Button>}
   {!!data.coverage?.pending&&<p className="space-muted">最近的讨论还在整理，Agent 仍能读取原消息继续工作。</p>}
  </>:<p role="status" className="space-muted">正在读取群记忆…</p>}
 </section>;
}
