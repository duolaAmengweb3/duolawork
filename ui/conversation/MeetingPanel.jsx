import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Clock, FileText, MessageSquare, Pause, Sparkles, Users, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, command, time } from '../v1/api.mjs';
import { startPolling } from '../v1/polling.mjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './meetings.css';
const html = text => ({ __html: DOMPurify.sanitize(marked.parse(text || '')) });
const status = m => m.status === 'preparing' ? '与负责人筹备' : m.status === 'running' ? '会议进行中' : m.status === 'closing' ? '正在整理结果' : m.status === 'open' ? '历史讨论' : '会议已结束';
const nameOf = (members, id) => id === 'owner' ? '我' : members.find(m => m.id === id)?.name || '会议记录';

export function MeetingCard({ meeting, onOpen, ended = false }) {
  if (!meeting) return null;
  return <button className={'meeting-chat-card ' + (ended ? 'is-ended' : '')} onClick={onOpen}>
    <span className="meeting-card-icon">{ended ? <Check size={20}/> : <Video size={20}/>}</span>
    <span><small>{ended ? '会议结果' : status(meeting)}</small><strong>{meeting.title}</strong><em>{ended ? (meeting.summary ? '查看结论、依据与完整记录' : '原始讨论已保存 · 纪要尚未完成') : meeting.phase || '打开会议'}</em></span>
    <span className="meeting-card-arrow">↗</span>
  </button>;
}

export default function MeetingPanel({ initialId, channel, members, connections, onCreated, onClose, onChanged }) {
  const [id,setId]=useState(initialId || null), [data,setData]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState(''), [syncError,setSyncError]=useState(''),
    [coordinator,setCoordinator]=useState(channel.coordinatorId || ''), [draft,setDraft]=useState(()=>localStorage.getItem('hub-meeting-draft:'+(initialId||channel.id))||''),
    [older,setOlder]=useState([]), [clock,setClock]=useState(Date.now()),[historyCursor,setHistoryCursor]=useState(undefined);
  const scroll=useRef(null),pending=useRef(null),bottom=useRef(true),lastCount=useRef(0);
  const m=data?.meeting, preparing=!m||m.status==='preparing', ended=m&&['ended','closed'].includes(m.status);
  const records=[...older,...(data?.records||[])].filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i);
  const prep=records.filter(r=>r.kind==='meeting_preparation');
  const key='hub-meeting-draft:'+(id||channel.id);
  useEffect(()=>{localStorage.setItem(key,draft);},[key,draft]);
  useEffect(()=>{const t=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{
    if(!id)return;
    return startPolling({interval:3500,run:async()=>{const d=await api('/v2/meeting?id='+encodeURIComponent(id));setData(d);setHistoryCursor(old=>old===undefined?d.nextCursor:old);},onSuccess:()=>setSyncError(''),onError:e=>setSyncError(e.message)});
  },[id]);
  useEffect(()=>{if(prep.length!==lastCount.current&&bottom.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'smooth'});lastCount.current=prep.length;},[prep.length]);
  async function act(action,args={}) {
    setBusy(true);setError('');
    try {
      const result=await command('channel.meeting',{channelId:channel.id,meetingId:id,action,...args});
      const nextId=result.meetingId||result.id||id;
      if(!id&&nextId){setId(nextId);onCreated(nextId);}
      try{setData(await api('/v2/meeting?id='+encodeURIComponent(id||nextId)));onChanged?.();}catch(e){setSyncError(e.message);}
      return result;
    }catch(e){setError(e.message);throw e;}finally{setBusy(false);}
  }
  async function send(e){
    e.preventDefault();if(!draft.trim()||busy)return;
    const fingerprint=(id||channel.id)+':'+draft;
    if(pending.current?.key!==fingerprint)pending.current={key:fingerprint,requestId:crypto.randomUUID()};
    try{await act(id?'say':'prepare',{body:draft,...(!id?{coordinatorId:coordinator}:{}),requestId:pending.current.requestId});setDraft('');localStorage.removeItem('hub-meeting-draft:'+channel.id);pending.current=null;}catch{}
  }
  const remaining=m?.deadlineAt?Math.max(0,Math.ceil((Date.parse(m.deadlineAt)-clock)/1000)):null;
  const usable=members.filter(member=>connections.some(c=>c.id===member.id&&c.status==='verified'));
  const summary=records.filter(r=>r.kind==='meeting_result'&&r.status==='provided').at(-1);
  const opinions=records.filter(r=>r.kind==='meeting_opinion');
  const reviews=records.filter(r=>r.kind==='meeting_review');
  const versions=records.filter(r=>r.kind==='meeting_plan_version');
  async function loadOlder(){
    try{const d=await api('/v2/meeting?id='+id+'&cursor='+encodeURIComponent(historyCursor));setOlder(old=>[...d.records,...old]);setHistoryCursor(d.nextCursor);}catch(e){setError(e.message);}
  }
  const title=preparing?'筹备一场会议':ended?'会议记录':'会议进展';
  const planCurrent=m?.basedOnOwnerMessageId===m?.lastOwnerMessageId;
  return <aside className="meeting-panel" aria-label={title}>
    <header className="meeting-panel-header"><span className="meeting-header-mark"><Video size={19}/></span><div><h2>{title}</h2><p>{preparing?'先和负责人聊清楚，再把大家叫进来':status(m)}</p></div><button aria-label="关闭会议面板" onClick={onClose}><X size={19}/></button></header>
    {error&&<div role="alert" className="meeting-inline-error">{error}<button onClick={()=>setError('')} aria-label="关闭会议错误"><X size={13}/></button></div>}
    {syncError&&<p role="status" className="meeting-sync">连接正在恢复，草稿和已收到的记录会保留。</p>}
    {preparing?<>
      <div className="meeting-person"><span className="meeting-person-face">{nameOf(members,m?.coordinatorId||coordinator).slice(0,1)}</span><div><strong>{nameOf(members,m?.coordinatorId||coordinator)}</strong><small>会议负责人 · 帮你理清议题、安排讨论</small></div><span className="meeting-duration"><Clock size={12}/>默认10分钟</span></div>
      {!id&&(!coordinator||!usable.some(x=>x.id===coordinator))&&<label className="meeting-host-select">本场由谁组织<select aria-label="本场会议负责人" value={coordinator} onChange={e=>setCoordinator(e.target.value)}><option value="">选择一位已连接的成员</option>{usable.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><small>只用于本场，不更改群负责人。</small></label>}
      <div className="meeting-prep-messages" ref={scroll} onScroll={e=>{bottom.current=e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<90;}}>
        {historyCursor&&<Button variant="ghost" onClick={loadOlder}>查看更早筹备记录</Button>}
        {!prep.length&&<div className="meeting-welcome"><div><Sparkles size={25}/></div><h3>一个还没想清楚的想法，<br/>也可以从这里开始。</h3><p>说说你正在考虑什么。负责人会和你一起明确这场会要解决的问题，以及最后给你什么。</p><button onClick={()=>setDraft('我有个想法，还没想清楚，先帮我梳理一下。')}>先帮我理清一个想法 <ArrowUp size={13}/></button></div>}
        {prep.map(r=><article key={r.id} className={'meeting-prep-message '+(r.authorId==='owner'?'from-owner':'from-host')}><small>{nameOf(members,r.authorId)} <time>{new Date(r.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></small><div dangerouslySetInnerHTML={html(r.body)}/></article>)}
        {id&&prep.at(-1)?.authorId==='owner'&&!(m?.version>0&&planCurrent)&&<div className="meeting-wait" role="status"><i/><span>已发送给负责人，等待真实回应</span><small>关闭面板后仍会保留</small></div>}
        {m?.version>0&&<section className="meeting-proposed-plan" aria-label="负责人提出的会议安排"><div className="meeting-section-label"><Sparkles size={14}/>本场准备这样进行<span>可继续聊、随时改</span></div><h3>{m.title}</h3><p>{m.goal}</p><ol>{m.agenda.filter(a=>a.status!=='canceled').map(a=><li key={a.id}>{a.title}</li>)}</ol><div className="meeting-deliverable"><FileText size={16}/><div><small>最后交付给你</small><p>{m.deliverable}</p></div></div><p className="meeting-organization">{m.organization}</p><details><summary>成员、时间和具体安排 <ChevronDown size={13}/></summary><p>{m.memberIds.map(mid=>nameOf(members,mid)).join('、')}</p><p>{Math.round(m.durationSeconds/60)}分钟，包含收尾 · {m.closure==='deadline'?'到时结束':'负责人整理结果'}</p><p>{data?.modes?.[m.mode]?.name} · 你可以直接告诉负责人需要调整什么。</p></details></section>}
      </div>
      {m?.version>0&&<div className="meeting-ready-bar"><div><strong>{planCurrent?'本场安排已整理':'负责人正在处理你的补充'}</strong><small>{planCurrent?'可以开始，也可以继续聊聊再调整':'最新安排形成后即可开始'}</small></div><Button disabled={busy||!planCurrent} onClick={()=>act('start',{expectedVersion:m.version}).catch(()=>{})}><Video size={14}/>开始会议</Button></div>}
      <form className="meeting-prep-composer" onSubmit={send}><Textarea aria-label="与会议负责人沟通" placeholder="说说你的想法，或继续补充要求…" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send(e);}}}/><div><small>Enter发送 · 关闭后草稿保留</small><Button size="icon" type="submit" aria-label="发送给会议负责人" disabled={busy||!draft.trim()||(!id&&!coordinator)}><ArrowUp size={18}/></Button></div></form>
    </>:<div className="meeting-record-scroll">
      <div className="meeting-live-status"><span><i className={ended?'is-ended':''}/>{ended?'已结束':m?.phase}</span>{remaining!==null&&!ended&&<time><Clock size={13}/>{Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</time>}</div>
      <h3 className="meeting-record-title">{m?.title}</h3><p className="meeting-record-goal">{m?.goal||m?.summary}</p>
      {m?.version!==undefined&&<section className="meeting-issue-list"><div className="meeting-section-label">本场需要回答的问题</div>{m.agenda.map((a,i)=><div key={a.id} className={a.status==='canceled'?'is-canceled':''}><span>{i+1}</span><p>{a.title}</p>{(m.answers||[]).some(x=>x.agendaId===a.id)&&<Check size={14}/>}</div>)}</section>}
      {(summary||m?.summary)&&<section className="meeting-final-summary"><div className="meeting-section-label"><FileText size={15}/>负责人整理的结果</div><div dangerouslySetInnerHTML={html(summary?.summary||m.summary)}/>{(summary?.answers||m.answers||[]).map((a,i)=><div className="meeting-answer" key={i}><h4>{m.agenda?.find(x=>x.id===a.agendaId)?.title||'议题回应'}</h4><div dangerouslySetInnerHTML={html(a.body)}/>{a.dissent&&<p className="meeting-dissent">保留意见：{a.dissent}</p>}</div>)}</section>}
      {ended&&!m?.summary&&<div className="meeting-empty-summary"><FileText size={22}/><strong>讨论记录已保存</strong><p>负责人纪要尚未完成，下面可以查看实际收到的意见。未将到时结束视为目标已经达成。</p></div>}
      {!ended&&m?.version!==undefined&&<Button variant="outline" className="meeting-stop" disabled={busy} onClick={()=>act('stop').catch(()=>{})}><Pause size={14}/>结束本场会议</Button>}
      {!ended&&m?.version!==undefined&&<details className="meeting-adjust"><summary>调整本场安排 <ChevronDown size={13}/></summary><label>接续负责人<select aria-label="更换本场会议负责人" value={m.coordinatorId} onChange={e=>act('coordinator',{coordinatorId:e.target.value}).catch(()=>{})} disabled={busy}>{members.filter(x=>m.memberIds.includes(x.id)&&usable.some(u=>u.id===x.id)).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><Button variant="outline" disabled={busy} onClick={()=>act('extend',{durationSeconds:300}).catch(()=>{})}><Clock size={13}/>延长5分钟</Button><small>只调整本场，已有记录和群配置保留。</small></details>}
      <details className="meeting-record-details" open={ended&&!m?.summary}><summary>讨论与核验记录 <span>{opinions.length+reviews.length}条</span><ChevronDown size={14}/></summary>{opinions.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>{r.publishedAt?'已公开':'独立意见 · 尚未公开'}{r.status==='late'?' · 迟到回应':''}</small></header><div dangerouslySetInnerHTML={html(r.body)}/>{r.changeReason&&<p>修改原因：{r.changeReason}</p>}{r.sources?.map((s,i)=><Source key={i} value={s}/>)}</article>)}{reviews.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>具体核验</small></header><h4>{r.claim}</h4><p>{r.method}</p><div dangerouslySetInnerHTML={html(r.finding)}/>{r.sources?.map((s,i)=><Source key={i} value={s}/>)}</article>)}</details>
      <details className="meeting-record-details"><summary>会前沟通与安排变更 <span>{prep.length+versions.length}条</span><ChevronDown size={14}/></summary>{prep.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>{time(r.createdAt)}</small></header><div dangerouslySetInnerHTML={html(r.body)}/></article>)}{versions.map(r=><article key={r.id}><header><strong>第{r.version}版安排</strong><small>{time(r.createdAt)}</small></header><h4>{r.title}</h4><p>{r.goal}</p><p>交付：{r.deliverable}</p><ol>{r.agenda?.map(a=><li key={a.id}>{a.title}{a.status==='canceled'?'（已取消）':''}</li>)}</ol>{r.reason&&<p>{r.reason}</p>}</article>)}</details>
      {historyCursor&&<Button variant="ghost" onClick={loadOlder}>查看更早记录</Button>}
      <footer className="meeting-record-footer"><Users size={13}/>{m?.memberIds?.length||0}位成员<span>·</span>{m?.wakeCount??'—'}次自动唤醒{ended&&<><span>·</span>{m.endReason==='deadline'?'达到时限':m.endReason==='stopped'?'用户停止':m.endReason==='completed'?'负责人已交付':m.endReason||'已归档'}</>}</footer>
    </div>}
  </aside>;
}
function Source({value}){let safe;try{const url=new URL(value);if(['https:','http:'].includes(url.protocol))safe=url.href;}catch{}return safe?<a className="meeting-source" href={safe} target="_blank" rel="noreferrer">{value}</a>:<small className="meeting-source">{value}</small>;}
