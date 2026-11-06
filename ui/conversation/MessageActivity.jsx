import React,{useEffect,useState} from 'react';
import {ArrowLeft,ArrowUpRight,CheckCircle2,Clock3,ShieldCheck} from 'lucide-react';
import {api,time} from '../v1/api.mjs';
import AgentAvatar from './AgentAvatar.jsx';
import {pendingTurnState,turnNotification} from '../../shared/chat-activity.mjs';
import {deliveryView} from '../../shared/delivery-view.mjs';
export function activityLabel(turn,notification,native){
 const pending=pendingTurnState(turn,notification,native);if(pending)return pending.label;
 return {done:'已回复',silent:'已读，无需补充',merged:'已合并处理',removed:'已收尾',limited:'正在核对重复通知',stalled:turn.claimedAt?'正在核对原执行结果':'尚未收到领取回执',unavailable:'等待恢复连接'}[turn.status]||'等待更新';
}
function Source({id,channelId,messages,onSource,label='相关消息'}){
 const known=messages.find(m=>m.id===id),[loaded,setLoaded]=useState(null);
 useEffect(()=>{setLoaded(null);if(!id||known)return;let alive=true;api('/v2/space-object?'+new URLSearchParams({channelId,kind:'message',id})).then(x=>{if(alive)setLoaded(x);}).catch(()=>{});return()=>{alive=false;};},[id,channelId,!!known]);
 const source=known||loaded;
 return <button className="delivery-source" onClick={()=>onSource(id)}><span><small>{label}</small>{source?.body?.replace(/[*#`]/g,'')||'查看原消息'}</span><ArrowUpRight size={14}/></button>;
}
export default function MessageActivity({snapshot,messages,members,nativeMembers,onBack,onSource,onResolve,onConnect,onDiscuss,onSelectSession}){
 const view=deliveryView(snapshot,members,nativeMembers),[working,setWorking]=useState(null),[error,setError]=useState('');
 const followup=view.recovering.filter(i=>i.action==='review_incomplete'),automatic=view.recovering.filter(i=>i.action!=='review_incomplete');
 const name=id=>members.find(m=>m.id===id)?.name||'成员';
 const resolutionLabel=i=>{
  const rows=(snapshot.activity||[]).filter(t=>i.turnIds?.includes(t.id)),kinds=[...new Set(rows.map(t=>t.resolution||t.status))];
  const result=i.resolution||(rows.length===i.turnIds?.length&&kinds.length===1?kinds[0]:null);
  return {covered:'旧通知已被后续回复覆盖',dismiss:'不再通知',mixed:'通知已分别处理'}[result]||'通知处理记录';
 };
 const act=async(issue,action)=>{setWorking(issue.id);setError('');try{await onResolve(issue,action);}catch(e){setError(e.message);}finally{setWorking(null);}};
 const issueCard=(issue,attention=false)=><article className={'delivery-case '+(attention?'attention':'')} key={issue.id}>
  <header><span className="delivery-case-icon">{attention?<Clock3 size={16}/>:<ShieldCheck size={16}/>}</span><strong>{attention?'需要你处理':issue.action==='review_incomplete'?'负责人核对未完成':issue.status==='recovering'?'正在恢复投递':'已交给负责人核对'}</strong></header>
  <p className="delivery-impact">{issue.summary||issue.impact}</p>
  {issue.cause==='automatic_burst'&&issue.summary&&issue.summary!==issue.impact&&<p className="delivery-next">{issue.impact}</p>}
  {issue.nextAction?<p className="delivery-next">{issue.nextAction}</p>:<p className="delivery-next">{issue.status==='recovering'?'等待实际回执，无需重复发送。':'无需操作。负责人会核对已有结果，再决定是否继续通知。'}</p>}
  <Source id={issue.rootId||issue.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource} label="相关需求"/>
  <footer><span>{issue.memberIds.map(name).join('、')}</span>{issue.reviewerId&&<span>由 {name(issue.reviewerId)} 跟进</span>}{issue.reviewCheckedAt&&<span>最近核对 {time(issue.reviewCheckedAt)}</span>}</footer>
  {attention&&<div className="delivery-case-actions">
   {issue.action==='select_session'?<button onClick={()=>onSelectSession(issue.memberIds[0])}>选择工作对话</button>:issue.action==='connect'?issue.memberIds.filter(id=>issue.local||snapshot.activity.some(t=>issue.turnIds.includes(t.id)&&t.memberId===id&&t.status==='unavailable')).map(id=><button key={id} onClick={()=>onConnect(id)}>连接 {name(id)}</button>):['coordinator','reviewer_unreachable'].includes(issue.action)&&snapshot.channel.coordinatorId?<button onClick={()=>onConnect(snapshot.channel.coordinatorId)}>连接负责人</button>:null}
   <button onClick={()=>onDiscuss(issue)}>和负责人沟通</button>
   {issue.cause==='not_received'&&<button disabled={!!working} onClick={()=>act(issue,'retry')}>{working===issue.id?'正在通知…':'再次通知'}</button>}
   {!issue.local&&<button disabled={!!working} className="quiet" onClick={()=>act(issue,'dismiss')}>不再需要</button>}
  </div>}
  <details className="delivery-diagnostics"><summary>处理详情</summary><p>{issue.impact}</p><small>{time(issue.createdAt)}</small>{issue.messageId!==issue.rootId&&<Source id={issue.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource}/>}</details>
 </article>;
 return <aside className="collaboration-space space-redesign"><div className="space-title"><button className="space-back" onClick={onBack}><ArrowLeft size={16}/>返回</button><h3>消息进度</h3></div><div className="space-content delivery-list">
  {error&&<p role="alert" className="delivery-error">{error}</p>}
  <section aria-label="需要你处理"><h4>需要你处理 <span>{view.attention.length||''}</span></h4>{view.attention.length?view.attention.map(i=>issueCard(i,true)):<div className="delivery-clear"><CheckCircle2 size={18}/><span>暂时没有需要你操作的事情</span></div>}</section>
  {followup.length>0&&<section aria-label="待负责人跟进"><h4>待负责人跟进</h4>{followup.map(i=>issueCard(i))}</section>}
  {(view.waiting.length>0||automatic.length>0)&&<section className="delivery-auto"><h4>接收与处理</h4>{automatic.map(i=>issueCard(i))}{view.waiting.map(group=><article className="delivery-case" key={group.id}><Source id={group.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource}/>{group.turns.map(t=>{const m=members.find(m=>m.id===t.memberId),state=pendingTurnState(t,turnNotification(t,snapshot.notifications),nativeMembers.find(m=>m.memberId===t.memberId),snapshot.activity);return <React.Fragment key={t.id}><div className="delivery-recipient"><AgentAvatar small name={m?.name} platformId={m?.platformId}/><strong>{name(t.memberId)}</strong><span>{state.label}</span></div><p className="delivery-next">{state.detail}</p>{state.waitingForMessageId&&<Source id={state.waitingForMessageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource} label="正在处理的前一条消息"/>}</React.Fragment>;})}</article>)}</section>}
  <details className="delivery-history"><summary>已处理记录 · {view.history.length+view.resolved.length}</summary>{view.resolved.map(i=><article key={i.id} className="delivery-case">
   <strong>{resolutionLabel(i)}</strong><p className="delivery-impact">{i.summary}</p>
   <Source id={i.rootId||i.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource} label="原需求"/>
   {i.rootId&&i.messageId!==i.rootId&&<Source id={i.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource} label="原通知"/>}
   {i.evidenceMessageIds?.map(id=><Source key={id} id={id} channelId={snapshot.channel.id} messages={messages} onSource={onSource} label="核对依据"/>)}
   <footer>{i.reviewedBy&&<span>处理：{i.reviewedBy==='owner'?'我':name(i.reviewedBy)}</span>}<span>{time(i.resolvedAt)}</span></footer>
   <button className="quiet" onClick={()=>onDiscuss(i)}>对结果有疑问</button>
  </article>)}{view.history.map(t=><article className="delivery-entry" key={t.id}><header><strong>{name(t.memberId)}</strong><span className="delivery-state">{activityLabel(t)}</span></header><Source id={t.messageId} channelId={snapshot.channel.id} messages={messages} onSource={onSource}/>{t.reason&&<p className="delivery-next">{t.reason}</p>}<footer>{time(t.completedAt||t.createdAt)}</footer></article>)}</details>
 </div></aside>;
}
