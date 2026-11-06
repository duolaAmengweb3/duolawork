import React,{useState,useEffect,useRef} from 'react';
import {Settings2,X,Maximize2,Minimize2,ArrowUp,ArrowUpRight,ChevronRight,FileText,ChartNoAxesCombined,Users,ScanText,Eye,Search,Folder,Workflow,Clock,Check,RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Textarea} from '@/components/ui/textarea';
import {api,time} from '../v1/api.mjs';
import {startPolling} from '../v1/polling.mjs';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import BrandMark from './BrandMark.jsx';
import AgentAvatar from './AgentAvatar.jsx';
import ChatSessionPicker from './ChatSessionPicker.jsx';
import './secretary.css';
const scenarios=[
 ['日报',FileText,'生成今天的项目日报：按项目列出负责人实际汇报、今天完成的事、正在推进的事、卡点和需要我决定的事。附原始记录，缺少信息明确标出。'],
 ['项目概览',ChartNoAxesCombined,'overview'],['团队动态',Users,'activity'],
 ['三句话看懂',ScanText,'请把当前群的讨论总结成三句话：定了什么、卡在哪里、需要我决定什么。附原消息，区分建议与已完成。'],
 ['盯一件事',Eye,'帮我持续关注：'],['找上次的决定',Search,'帮我找到之前关于这件事的决定和原始记录：'],
 ['整理资料',Folder,'帮我整理当前资料：'],['安排协作',Workflow,'帮我组织协作：']
];
const html=s=>({__html:DOMPurify.sanitize(marked.parse(String(s||'')))});
const progressText=p=>typeof p==='string'?p:p?.message||'';
const stored=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const persist=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
export default function SecretaryDesk({open,onClose,workspace,codingStatus,context,onSource,onConnect,onChanged}) {
 const [data,setData]=useState(null),[error,setError]=useState(''),[settings,setSettings]=useState(false),[full,setFull]=useState(false),[tab,setTab]=useState('requests');
 const [draft,setDraft]=useState(()=>stored('duolawork-secretary-draft-v1','')),[outbox,setOutbox]=useState(()=>stored('duolawork-secretary-outbox',[]).map(r=>({...r,status:'failed',error:'上次发送结果尚未确认，重试不会重复交办。'}))),[picker,setPicker]=useState(null),[choice,setChoice]=useState('');
 const [daily,setDaily]=useState(false),[dailyTime,setDailyTime]=useState('18:00'),[saving,setSaving]=useState(false);
 const coding=['codex','antigravity','gemini-cli','deepseek-harness','claude-code'];
 const input=useRef(null),alive=useRef(true),settingsDirty=useRef(false),loading=useRef(false);
 const members=workspace.members||[],secretary=members.find(m=>m.id===data?.secretary?.memberId),name=id=>members.find(m=>m.id===id)?.name||'未指定';
 const load=async()=>{if(loading.current)return;loading.current=true;try{const next=await api('/v2/secretary');if(alive.current){setData(next);setError('');if(!settingsDirty.current){setDaily(next.schedule?.status==='enabled');setDailyTime(next.schedule?.time||'18:00');}}}catch(e){if(alive.current)setError(e.message);}finally{loading.current=false;}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!open)return;return startPolling({run:load,interval:4000});},[open]);
 useEffect(()=>{persist('duolawork-secretary-draft-v1',draft);},[draft]);
 useEffect(()=>{persist('duolawork-secretary-outbox',outbox);},[outbox]);
 useEffect(()=>{if(!open)return;const key=e=>{if(e.key==='Escape'&&!settings&&!picker){e.stopPropagation();onClose();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[open,settings,picker,onClose]);
 const send=async item=>{
  setOutbox(old=>[...old.filter(x=>x.requestId!==item.requestId),{...item,status:'sending'}]);
  try{await api('/v2/secretary',{action:'send',...item});await load();setOutbox(old=>old.filter(x=>x.requestId!==item.requestId));}
  catch(e){setOutbox(old=>old.map(x=>x.requestId===item.requestId?{...x,status:'failed',error:e.message}:x));}
 };
 const submit=()=>{if(!draft.trim()||!secretary)return;const item={requestId:crypto.randomUUID(),body:draft.trim(),context,memberId:secretary.id,grantVersion:data.secretary.version};setDraft('');setTab('requests');void send(item);};
 const configure=async()=>{setSaving(true);try{await api('/v2/management',{requestId:crypto.randomUUID(),memberId:choice,expectedVersion:data?.secretary?.version||0});setChoice('');await load();onChanged?.();}catch(e){setError(e.message);}finally{setSaving(false);}};
 const bind=async()=>{try{const channel=await api('/v2/secretary',{requestId:crypto.randomUUID(),action:'open'});setPicker(channel);}catch(e){setError(e.message);}};
 if(!open)return null;
 return <aside className={'secretary-desk '+(full?'expanded':'')} aria-label="秘书工作台">
  <header className="secretary-toolbar"><BrandMark size={34}/><div><h2>秘书</h2><small>{secretary?secretary.name+' · 全局协作助手':'交代一句，帮你跟进'}</small></div><Button size="icon" variant="ghost" aria-label={full?'收起全屏':'全屏展开秘书'} onClick={()=>setFull(!full)}>{full?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</Button><Button size="icon" variant="ghost" aria-label="秘书设置" onClick={()=>setSettings(true)}><Settings2 size={16}/></Button><Button size="icon" variant="ghost" aria-label="关闭秘书" onClick={onClose}><X size={18}/></Button></header>
  <div className="secretary-content">
   {error&&<p role="alert" className="secretary-error">{error}<button onClick={load}>重试</button></p>}
   {!data?<div className="secretary-loading"><BrandMark motion="hand" loop size={54}/><span>正在查看最新进展…</span></div>:<>
    {!secretary?<div className="secretary-onboarding"><BrandMark motion="hand" size={64}/><h3>选一位熟悉你的 Agent</h3><p>从这里直接交办、看进展。秘书保留自己的原环境和能力。</p><label>由谁担任<select aria-label="选择全局秘书" value={choice} onChange={e=>setChoice(e.target.value)}><option value="">选择一位 Agent</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><Button disabled={!choice||saving} onClick={configure}>设为秘书</Button></div>:<>
     {coding.includes(secretary.platformId)&&!codingStatus?.members?.find(m=>m.memberId===secretary.id)?.assignments?.some(a=>a.channelId===data.directChannel?.id)&&<div className="secretary-connection-hint"><p>先为秘书选择工作对话，交办的事情才能送达。</p><Button size="sm" variant="outline" onClick={bind}>选择工作对话</Button></div>}
     <section className="secretary-attention"><div><span className="attention-dot"/><h3>待我处理</h3><span>{data.questions.length}</span></div>{data.questions.length?data.questions.slice(0,5).map(q=><button key={q.id} onClick={()=>onSource(q.scopeId,q.messageId?{kind:'message',id:q.messageId}:{kind:'question',id:q.id})}><span>{q.question}</span><ArrowUpRight size={14}/></button>):<p>当前没有等待你回答的问题。</p>}</section>
     <div className="secretary-shortcuts">{scenarios.map(([label,Icon,prompt])=><button key={label} onClick={()=>{if(['overview','activity'].includes(prompt))setTab(prompt);else{setDraft(prompt);input.current?.focus();}}}><Icon size={17}/><span>{label}</span><ChevronRight size={12}/></button>)}</div>
     <nav className="secretary-tabs" aria-label="秘书视图">{[['requests','办事记录'],['overview','项目概览'],['activity','团队动态']].map(([key,label])=><button key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</nav>
     {tab==='requests'?<div className="secretary-requests">
      {outbox.map(item=><article className="secretary-receipt" key={item.requestId}><small>{item.status==='failed'?'发送未确认':'正在发送'}</small><p>{item.body}</p>{item.error&&<p role="alert">{item.error}</p>}{item.status==='failed'&&<><button onClick={()=>send(item)}>重试这条</button><button onClick={()=>{setDraft(item.body);setOutbox(old=>old.filter(x=>x.requestId!==item.requestId));input.current?.focus();}}>取回编辑</button></>}</article>)}
      {!data.requests.length&&!outbox.length&&<div className="secretary-empty"><BrandMark motion="hand" size={52}/><h3>你的事情，在这里跟进</h3><p>先交代一件事，或者让秘书整理一份项目日报。</p></div>}
      {data.requests.map(r=><article className="secretary-receipt" key={r.id}><header><span className={'receipt-state '+r.status}>{r.displayStatus}</span><time>{time(r.createdAt)}</time></header><h3>{r.body}</h3>{r.context&&<button className="secretary-source" onClick={()=>onSource(r.context.channelId,r.context.ref)}>{r.context.name}{r.context.ref?.title?' · '+r.context.ref.title:''}<ArrowUpRight size={12}/></button>}{r.progress&&<p className="secretary-progress">{progressText(r.progress)}</p>}{r.replies.map(reply=><div key={reply.id} className="secretary-answer"><div className="message-markdown" dangerouslySetInnerHTML={html(reply.body)}/>{reply.refs?.map(ref=><button key={ref.id} onClick={()=>onSource(ref.channelId||r.context?.channelId||r.channelId,ref)}>{ref.title||'查看引用'}<ArrowUpRight size={12}/></button>)}</div>)}{r.refs?.map(ref=><button key={ref.id} onClick={()=>onSource(ref.channelId||r.context?.channelId||r.channelId,ref)}>{ref.title||'查看结果'}<ArrowUpRight size={12}/></button>)}<button className="secretary-followup" onClick={()=>{setDraft('关于「'+r.body.slice(0,80)+'」：');input.current?.focus();}}>继续交代</button></article>)}
      {data.watches.length>0&&<section className="secretary-watches"><h3>持续关注</h3>{data.watches.map(w=><div key={w.id}><Eye size={14}/><button onClick={()=>onSource(w.scopeId,{kind:w.kindName,id:w.targetId})}>{w.title}</button><Button size="sm" variant="ghost" onClick={async()=>{try{await api('/v2/secretary',{action:'cancel_watch',requestId:crypto.randomUUID(),watchId:w.id});await load();}catch(e){setError(e.message);}}}>停止关注</Button></div>)}</section>}
     </div>:tab==='overview'?<div className="secretary-overview"><p className="secretary-caption">基于各群 Todo 的实际记录 · 不等同于项目完成率</p>{data.groups.length?data.groups.map(g=><button className="secretary-project" key={g.id} onClick={()=>onSource(g.id)}><div><strong>{g.name}</strong><ArrowUpRight size={14}/></div><small>负责人 {name(g.coordinatorId)} · {g.total?`${g.done}/${g.total} 项待办完成`:'还没有待办'}</small>{g.total>0&&<progress max={g.total} value={g.done}/>}<span>{g.blocked?`${g.blocked} 项受阻`:g.overdue?`${g.overdue} 项逾期`:'当前没有记录到阻碍'}</span></button>):<p>还没有项目群。</p>}</div>:<div className="secretary-team"><p className="secretary-caption">Hub 收到的工作状态 · {time(data.measuredAt)}</p>{members.map(m=>{const turns=data.activity.filter(t=>t.memberId===m.id);return <div key={m.id}><AgentAvatar small name={m.name} platformId={m.platformId}/><div><strong>{m.name}</strong><p>{turns.length?turns.map(t=>progressText(t.progress)||'正在处理 Hub 消息').join('；'):'当前没有已领取的 Hub 消息'}</p><small>{turns.length?time(turns[0].updatedAt):'原环境中的其他工作未观测'}</small></div></div>;})}</div>}
    </>}
   </>}
  </div>
  {secretary&&<footer className="secretary-composer">{context?.channelId&&<div className="secretary-context"><Folder size={13}/><span>{context.name}{context.ref?.title?' · '+context.ref.title:''}</span></div>}<Textarea ref={input} aria-label="交代秘书" value={draft} onChange={e=>setDraft(e.target.value)} placeholder="交代一句，或接着补充…" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit();}}}/><div><span>Enter 发送 · Shift + Enter 换行</span><Button size="icon" aria-label="发送给秘书" disabled={!draft.trim()} onClick={submit}><ArrowUp size={17}/></Button></div></footer>}
  <Dialog open={settings} onOpenChange={setSettings}><DialogContent><DialogHeader><DialogTitle>秘书设置</DialogTitle><DialogDescription>指定协作助手，设置提醒。原账号、项目和历史保留。</DialogDescription></DialogHeader><label>由谁担任<select aria-label="选择全局秘书" value={choice||secretary?.id||''} onChange={e=>setChoice(e.target.value)}><option value="">选择一位 Agent</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><Button disabled={!choice||choice===secretary?.id||saving} onClick={configure}>{secretary?'更换秘书':'设为秘书'}</Button>{secretary&&<><p className="secretary-caption">可读写你授权的单聊与群聊，并以自己的身份办理。更换后旧秘书失去全局委托。</p>{['codex','antigravity','gemini-cli','deepseek-harness','claude-code'].includes(secretary.platformId)&&<Button variant="outline" onClick={bind}>选择秘书使用的工作对话</Button>}<div className="secretary-schedule"><label><input type="checkbox" checked={daily} onChange={e=>{settingsDirty.current=true;setDaily(e.target.checked);}}/>每天给我项目日报</label><input type="time" aria-label="日报时间" value={dailyTime} onChange={e=>{settingsDirty.current=true;setDailyTime(e.target.value);}}/><Button variant="outline" onClick={async()=>{try{await api('/v2/secretary',{requestId:crypto.randomUUID(),action:'schedule',enabled:daily,time:dailyTime,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});settingsDirty.current=false;await load();setSettings(false);}catch(e){setError(e.message);}}}>保存提醒</Button><small>按 {Intl.DateTimeFormat().resolvedOptions().timeZone} 发送，秘书回复后显示在办事记录。</small></div></>}</DialogContent></Dialog>
  <Dialog open={!!picker} onOpenChange={v=>!v&&setPicker(null)}><DialogContent className="session-picker-dialog"><DialogHeader><DialogTitle>秘书的工作对话</DialogTitle><DialogDescription>选择一个原生对话来接住交办的事情。</DialogDescription></DialogHeader>{picker&&secretary&&<ChatSessionPicker member={secretary} channel={picker} onConnect={()=>{setPicker(null);onConnect(secretary);}} onSaved={()=>{setPicker(null);setSettings(false);onChanged?.();}}/>}</DialogContent></Dialog>
 </aside>;
}
