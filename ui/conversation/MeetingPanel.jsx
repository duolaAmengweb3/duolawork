import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Clock, Copy, FileText, Maximize2, Minimize2, Pause, Sparkles, Users, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

export default function MeetingPanel({ initialId, channel, members, connections, activity=[], notifications=[], onCreated, onClose, onChanged, onChat, onTodo, tasks=[], onTask }) {
  const [id,setId]=useState(initialId || null), [data,setData]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState(''), [syncError,setSyncError]=useState(''),
    [coordinator,setCoordinator]=useState(channel.coordinatorId || ''), [draft,setDraft]=useState(()=>localStorage.getItem('hub-meeting-draft:'+(initialId||channel.id))||''),
    [older,setOlder]=useState([]), [clock,setClock]=useState(Date.now()),[historyCursor,setHistoryCursor]=useState(undefined),
    [prepView,setPrepView]=useState(initialId?'plan':'chat'),[expanded,setExpanded]=useState(false),[copied,setCopied]=useState(false);
  const scroll=useRef(null),pending=useRef(null),bottom=useRef(true),lastCount=useRef(0),lastVersion=useRef(0),lastRevision=useRef(null),changed=useRef(onChanged);
  changed.current=onChanged;
  const m=data?.meeting, preparing=!m||m.status==='preparing', ended=m&&['ended','closed'].includes(m.status);
  const records=[...older,...(data?.records||[])].filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i);
  const prep=records.filter(r=>r.kind==='meeting_preparation');
  const key='hub-meeting-draft:'+(id||channel.id);
  useEffect(()=>{localStorage.setItem(key,draft);},[key,draft]);
  useEffect(()=>{const t=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{
    if(!id)return;
    return startPolling({interval:2000,run:async()=>{const d=await api('/v2/meeting?id='+encodeURIComponent(id));setData(d);setHistoryCursor(old=>old===undefined?d.nextCursor:old);if(lastRevision.current!==null&&lastRevision.current!==d.meeting.revision)changed.current?.();lastRevision.current=d.meeting.revision;},onSuccess:()=>setSyncError(''),onError:e=>setSyncError(e.message)});
  },[id]);
  useEffect(()=>{if(m?.version>lastVersion.current&&m.basedOnOwnerMessageId===m.lastOwnerMessageId)setPrepView('plan');lastVersion.current=m?.version||0;},[m?.version,m?.basedOnOwnerMessageId,m?.lastOwnerMessageId]);
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
    try{await act(id?'say':'prepare',{body:draft,...(!id?{coordinatorId:coordinator}:{}),requestId:pending.current.requestId});setDraft('');setPrepView('chat');localStorage.removeItem('hub-meeting-draft:'+channel.id);pending.current=null;}catch{}
  }
  const remaining=m?.deadlineAt?Math.max(0,Math.ceil((Date.parse(m.deadlineAt)-clock)/1000)):null;
  const usable=members.filter(member=>connections.some(c=>c.id===member.id&&c.status==='verified'));
  const summary=records.filter(r=>r.kind==='meeting_result'&&r.status==='provided').at(-1);
  const opinions=records.filter(r=>r.kind==='meeting_opinion');
  const reviews=records.filter(r=>r.kind==='meeting_review');
  const versions=records.filter(r=>r.kind==='meeting_plan_version');
  const priorResults=records.filter(r=>r.kind==='meeting_result'&&r.status==='superseded');
  async function loadOlder(){
    try{const d=await api('/v2/meeting?id='+id+'&cursor='+encodeURIComponent(historyCursor));setOlder(old=>[...d.records,...old]);setHistoryCursor(d.nextCursor);}catch(e){setError(e.message);}
  }
  const title=preparing?'筹备一场会议':ended?'会议结果':'会议进展';
  const planCurrent=m?.basedOnOwnerMessageId===m?.lastOwnerMessageId;
  const waitingTurn=activity.find(t=>t.meetingId===id&&t.memberId===m?.coordinatorId&&['ready','active','stalled'].includes(t.status));
  const notice=notifications.find(n=>n.stepId===waitingTurn?.id);
  const waitingLabel=waitingTurn?.status==='active'?'负责人已接单，正在整理':notice?.httpStatus===200||notice?.status==='accepted'?'原平台已收到，等待负责人接单':'消息已保存，等待负责人接收';
  return <aside className={'meeting-panel'+(ended?' is-result':'')+(expanded?' is-expanded':'')} aria-label={title}>
    <header className="meeting-panel-header"><span className="meeting-header-mark"><Video size={19}/></span><div><h2>{title}</h2><p>{preparing?'负责人理解需求后组织讨论，完成后交付结果':ended?'负责人交付 · 原始讨论随时可查':status(m)}</p></div><button aria-label={expanded?'收起阅读区':'展开阅读区'} onClick={()=>setExpanded(v=>!v)}>{expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button aria-label="关闭会议面板" onClick={onClose}><X size={19}/></button></header>
    {error&&<div role="alert" className="meeting-inline-error">{error}<button onClick={()=>setError('')} aria-label="关闭会议错误"><X size={13}/></button></div>}
    {syncError&&<p role="status" className="meeting-sync">连接正在恢复，草稿和已收到的记录会保留。</p>}
    {m?.revisionStatus==='requested'&&Date.parse(m.revisionExpiresAt)>clock&&<p role="status" className="meeting-sync">已请负责人重新解释。当前结果保留，新稿完成后会在这里更新。</p>}
    {preparing?<>
      <div className="meeting-person"><span className="meeting-person-face">{nameOf(members,m?.coordinatorId||coordinator).slice(0,1)}</span><div><strong>{nameOf(members,m?.coordinatorId||coordinator)}</strong><small>会议负责人 · 帮你理清议题、安排讨论</small></div><span className="meeting-duration"><Clock size={12}/>默认10分钟</span></div>
      {!id&&(!coordinator||!usable.some(x=>x.id===coordinator))&&<label className="meeting-host-select">本场由谁组织<select aria-label="本场会议负责人" value={coordinator} onChange={e=>setCoordinator(e.target.value)}><option value="">选择一位已连接的成员</option>{usable.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><small>只用于本场，不更改群负责人。</small></label>}
      <Tabs value={prepView} onValueChange={setPrepView} className="meeting-prep-tabs">
        <TabsList aria-label="会议筹备视图"><TabsTrigger value="chat">筹备记录</TabsTrigger><TabsTrigger value="plan">本场安排{m?.version>0&&<span className="meeting-tab-dot"/>}</TabsTrigger></TabsList>
        <TabsContent value="chat" className="meeting-prep-messages" ref={scroll} onScroll={e=>{bottom.current=e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<90;}}>
          {historyCursor&&<Button variant="ghost" onClick={loadOlder}>查看更早筹备记录</Button>}
          {!prep.length&&<div className="meeting-welcome"><div><Sparkles size={25}/></div><h3>先说说，<br/>你想和大家聊什么？</h3><p>想法还不明确也没关系。负责人会帮你理清这一场要解决的问题，提出合适的讨论安排。</p><button onClick={()=>setDraft('我有个想法，还没想清楚，先帮我梳理一下。')}>先帮我理清一个想法 <ArrowUp size={13}/></button></div>}
          {prep.map(r=><article key={r.id} className={'meeting-prep-message '+(r.authorId==='owner'?'from-owner':'from-host')}><small>{nameOf(members,r.authorId)} <time>{new Date(r.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></small><div className="meeting-richtext" dangerouslySetInnerHTML={html(r.body)}/></article>)}
          {id&&prep.at(-1)?.authorId==='owner'&&!(m?.version>0&&planCurrent)&&<div className="meeting-wait" role="status"><i/><span>{waitingLabel}</span><small>{waitingTurn&&<>已发送{Math.max(0,Math.floor((clock-Date.parse(waitingTurn.createdAt))/1000))}秒 · </>}可以继续补充，关闭后也会保留</small></div>}
        </TabsContent>
        <TabsContent value="plan" className="meeting-plan-scroll">
          {m?.version>0?<section className="meeting-proposed-plan" aria-label="负责人提出的会议安排">
            <div className="meeting-section-label">负责人提出的安排<span>第{m.version}版</span></div>
            <h3>{m.title}</h3><p className="meeting-plan-goal">{m.goal}</p>
            <div className="meeting-plan-delivery"><FileText size={18}/><div><h4>这场会结束，你会拿到</h4><div className="meeting-richtext" dangerouslySetInnerHTML={html(m.deliverable)}/></div></div>
            <h4 className="meeting-plan-subtitle">准备讨论这些问题</h4><ol className="meeting-plan-agenda">{m.agenda.filter(a=>a.status!=='canceled').map((a,i)=><li key={a.id}><span>{i+1}</span><p>{a.title}</p></li>)}</ol>
            <div className="meeting-plan-meta"><span><Users size={14}/>{m.memberIds.map(mid=>nameOf(members,mid)).join('、')}</span><span><Clock size={14}/>{Math.round(m.durationSeconds/60)}分钟，包含收尾</span></div>
            <details><summary>具体怎么讨论 <ChevronDown size={14}/></summary><div className="meeting-richtext" dangerouslySetInnerHTML={html(m.organization)}/><p>{m.closure==='deadline'?'按约定时间结束':'负责人整理结果后结束，最多到本场时限'}</p></details>
            <p className="meeting-plan-hint">要调整什么，回到群里告诉负责人。</p>
          </section>:<div className="meeting-welcome"><FileText size={25}/><h3>先和负责人聊聊</h3><p>明确本场问题和交付后，负责人会把安排放在这里。</p><Button variant="outline" onClick={()=>setPrepView('chat')}>返回沟通</Button></div>}
        </TabsContent>
      </Tabs>
      {m?.version>0&&<div className="meeting-ready-bar"><div><strong>{planCurrent?'本场安排已整理':'正在按你的补充调整'}</strong><small>{planCurrent?'负责人将直接组织讨论，你可随时补充或停止':'负责人正在理解最新要求'}</small></div>{prepView!=='plan'&&<Button variant="outline" onClick={()=>setPrepView('plan')}>查看本场安排</Button>}</div>}
      {id&&onChat?<div className="meeting-prep-composer"><p>补充想法或调整安排，直接在群里告诉负责人。</p><Button onClick={onChat}><ArrowUp size={15}/>回到群聊继续沟通</Button></div>:(<form className="meeting-prep-composer" onSubmit={send}><Textarea aria-label="与会议负责人沟通" placeholder="说说你的想法，或继续补充要求…" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send(e);}}}/><div><small>Enter发送 · 关闭后草稿保留</small><Button size="icon" type="submit" aria-label="发送给会议负责人" disabled={busy||!draft.trim()||(!id&&!coordinator)}><ArrowUp size={18}/></Button></div></form>)}

    </>:<div className="meeting-record-scroll">
      <div className="meeting-live-status"><span><i className={ended?'is-ended':''}/>{ended?'已结束':m?.phase}</span>{remaining!==null&&!ended&&<time><Clock size={13}/>{Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</time>}</div>
      <h3 className="meeting-record-title">{m?.title}</h3><p className="meeting-record-goal">{m?.goal||m?.summary}</p>
      {!ended&&m?.version!==undefined&&<section className="meeting-issue-list"><div className="meeting-section-label">这场会在讨论</div>{m.agenda.filter(a=>a.status!=='canceled').map((a,i)=><div key={a.id}><span>{i+1}</span><p>{a.title}</p></div>)}</section>}
      {(summary||m?.summary)&&<>
        <section className="meeting-final-summary" aria-label="负责人整理的结果"><div className="meeting-section-label"><FileText size={15}/>负责人整理的结果{m.summaryRevisedAt&&<span>已按你的反馈更新</span>}</div><div className="meeting-richtext" dangerouslySetInnerHTML={html(summary?.summary||m.summary)}/></section>
        <div className="meeting-result-actions"><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText(summary?.summary||m.summary);setCopied(true);}catch{setError('复制未成功，请重试。');}}}><Copy size={14}/>{copied?'已复制':'复制结果'}</Button>{ended&&<Button variant="ghost" disabled={busy||(m.revisionStatus==='requested'&&Date.parse(m.revisionExpiresAt)>clock)} onClick={()=>act('request_revision').catch(()=>{})}>{m.revisionStatus==='requested'&&Date.parse(m.revisionExpiresAt)>clock?'已交给负责人重新解释':'让负责人解释清楚'}</Button>}</div>
        <details className="meeting-record-details meeting-answers"><summary>按议题查看具体回答 <ChevronDown size={14}/></summary>{(summary?.answers||m.answers||[]).map((a,i)=><article key={i}><h4>{m.agenda?.find(x=>x.id===a.agendaId)?.title||'议题回应'}</h4><div className="meeting-richtext" dangerouslySetInnerHTML={html(a.body)}/>{a.dissent&&<p className="meeting-dissent">保留意见：{a.dissent}</p>}</article>)}</details>
      </>}
      {ended&&!m?.summary&&<div className="meeting-empty-summary"><FileText size={22}/><strong>讨论记录已保存</strong><p>负责人纪要尚未完成，下面可以查看实际收到的意见。未将到时结束视为目标已经达成。</p><Button variant="outline" disabled={busy||(m.recoveryStatus==='requested'&&Date.parse(m.recoveryExpiresAt)>clock)} onClick={()=>act('retry_summary').catch(()=>{})}>{m.recoveryStatus==='requested'&&Date.parse(m.recoveryExpiresAt)>clock?'负责人正在补齐':'让负责人补齐总结'}</Button></div>}
      {!ended&&m?.version!==undefined&&<Button variant="outline" className="meeting-stop" disabled={busy} onClick={()=>act('stop').catch(()=>{})}><Pause size={14}/>结束本场会议</Button>}
      {!ended&&m?.version!==undefined&&<details className="meeting-adjust"><summary>调整本场安排 <ChevronDown size={13}/></summary><label>接续负责人<select aria-label="更换本场会议负责人" value={m.coordinatorId} onChange={e=>act('coordinator',{coordinatorId:e.target.value}).catch(()=>{})} disabled={busy}>{members.filter(x=>m.memberIds.includes(x.id)&&usable.some(u=>u.id===x.id)).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><Button variant="outline" disabled={busy} onClick={()=>act('extend',{durationSeconds:300}).catch(()=>{})}><Clock size={13}/>延长5分钟</Button><small>只调整本场，已有记录和群配置保留。</small></details>}
      <details className="meeting-record-details" open={ended&&!m?.summary}><summary>讨论与核验记录 <span>{opinions.length+reviews.length}条</span><ChevronDown size={14}/></summary>{opinions.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>{r.publishedAt?'已公开':'独立意见 · 尚未公开'}{r.status==='late'?' · 迟到回应':''}</small></header><div className="meeting-richtext" dangerouslySetInnerHTML={html(r.body)}/>{r.changeReason&&<p>修改原因：{r.changeReason}</p>}{r.sources?.map((s,i)=><Source key={i} value={s}/>)}</article>)}{reviews.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>具体核验</small></header><h4>{r.claim}</h4><p>{r.method}</p><div dangerouslySetInnerHTML={html(r.finding)}/>{r.sources?.map((s,i)=><Source key={i} value={s}/>)}</article>)}</details>
      <details className="meeting-record-details"><summary>会前沟通与安排变更 <span>{prep.length+versions.length}条</span><ChevronDown size={14}/></summary>{prep.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)}</strong><small>{time(r.createdAt)}</small></header><div className="meeting-richtext" dangerouslySetInnerHTML={html(r.body)}/></article>)}{versions.map(r=><article key={r.id}><header><strong>第{r.version}版安排</strong><small>{time(r.createdAt)}</small></header><h4>{r.title}</h4><p>{r.goal}</p><p>交付：{r.deliverable}</p><ol>{r.agenda?.map(a=><li key={a.id}>{a.title}{a.status==='canceled'?'（已取消）':''}</li>)}</ol>{r.reason&&<p>{r.reason}</p>}</article>)}</details>
      {!!priorResults.length&&<details className="meeting-record-details"><summary>之前的结果版本 <span>{priorResults.length}份</span><ChevronDown size={14}/></summary>{priorResults.map(r=><article key={r.id}><header><strong>{nameOf(members,r.authorId)} · 原稿</strong><small>{time(r.createdAt)}</small></header><div className="meeting-richtext" dangerouslySetInnerHTML={html(r.summary)}/></article>)}</details>}
      {historyCursor&&<Button variant="ghost" onClick={loadOlder}>查看更早记录</Button>}
      <section className="space-section meeting-todos"><h3>会后跟进 <Button size="sm" variant="outline" onClick={()=>onTodo?.(m)}>留下 Todo</Button></h3>{tasks.filter(t=>t.meetingIds?.includes(m.id)).map(t=><button className="space-related" key={t.id} onClick={()=>onTask?.(t)}><Check size={14}/>{t.title}<small>{t.status==='done'?'已完成':t.status==='blocked'?'受阻':'待跟进'}</small></button>)}{!tasks.some(t=>t.meetingIds?.includes(m.id))&&<p className="space-muted">有后续行动时，留在这里继续跟进。</p>}</section>
      {m?.judgmentLabel&&<p className="space-muted">{m.judgmentLabel}</p>}<footer className="meeting-record-footer"><Users size={13}/>{m?.memberIds?.length||0}位成员<span>·</span>{m?.wakeCount??'—'}次自动唤醒{ended&&<><span>·</span>{m.endReason==='deadline'?'达到时限':m.endReason==='stopped'?'用户停止':m.endReason==='completed'?'负责人已交付':m.endReason||'已归档'}</>}</footer>
    </div>}
  </aside>;
}
function Source({value}){let safe;try{const url=new URL(value);if(['https:','http:'].includes(url.protocol))safe=url.href;}catch{}return safe?<a className="meeting-source" href={safe} target="_blank" rel="noreferrer">{value}</a>:<small className="meeting-source">{value}</small>;}
