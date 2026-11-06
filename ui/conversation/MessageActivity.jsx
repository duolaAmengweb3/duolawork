import React,{useEffect,useState} from 'react';
import {ArrowLeft,ArrowUpRight,ChevronDown} from 'lucide-react';
import {api,time} from '../v1/api.mjs';
import AgentAvatar from './AgentAvatar.jsx';
const pending=new Set(['ready','active','stalled','unavailable','limited']);
export function activityLabel(turn,notification,native){
 if(turn.status==='active')return '正在回复';
 if(turn.status==='ready')return native?.pendingStepId===turn.id&&['queued','sent'].includes(native.deliveryState)?'原对话正在工作，已排队':notification?.status==='accepted'?'已送达，等待接收':'等待接收';
 return {done:'已回复',silent:'已读，暂无补充',merged:'已合并处理',removed:'已取消后续通知',limited:'连续回应已暂停',stalled:'尚未收到回复',unavailable:'等待成员连接'}[turn.status]||'等待更新';
}
function Entry({turn,message,member,notification,native,onSource}){
 const [source,setSource]=useState(message);
 useEffect(()=>{if(message){setSource(message);return;}let alive=true;api('/v2/space-object?'+new URLSearchParams({channelId:turn.scopeId,kind:'message',id:turn.messageId})).then(x=>{if(alive)setSource(x);}).catch(()=>{});return()=>{alive=false;};},[message,turn.messageId,turn.scopeId]);
 return <article className="delivery-entry"><header><AgentAvatar small name={member?.name} platformId={member?.platformId}/><strong>{member?.name||'成员'}</strong><span className={'delivery-state '+(turn.status==='active'?'active':'')}>{activityLabel(turn,notification,native)}</span></header><button className="delivery-source" onClick={()=>onSource(turn.messageId)}><span>{source?.body||'打开对应消息'}</span><ArrowUpRight size={14}/></button><footer><time>{time(turn.createdAt)}</time>{source?.authorId==='owner'&&<span>你发出的消息</span>}</footer>{turn.reason&&<details><summary>{turn.status==='silent'?'暂无补充的原因':'详情'}</summary><p>{turn.reason}</p></details>}</article>;
}
export default function MessageActivity({snapshot,messages,members,nativeMembers,onBack,onSource,onRetry}){
 const current=snapshot.activity.filter(t=>pending.has(t.status)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const history=snapshot.activity.filter(t=>!pending.has(t.status)&&t.status!=='merged').sort((a,b)=>(b.completedAt||b.createdAt).localeCompare(a.completedAt||a.createdAt));
 const row=t=><Entry key={t.id} turn={t} message={messages.find(m=>m.id===t.messageId)} member={members.find(m=>m.id===t.memberId)} notification={snapshot.notifications.find(n=>n.stepId===t.id)} native={nativeMembers.find(m=>m.memberId===t.memberId)} onSource={onSource}/>;
 return <aside className="collaboration-space space-redesign"><div className="space-title"><button className="space-back" onClick={onBack}><ArrowLeft size={16}/>返回</button><h3>消息进度</h3></div><div className="space-content delivery-list"><h4>待处理 <span>{current.length}</span></h4>{current.length?current.map(row):<p className="space-empty">当前没有待处理的消息。</p>}{current.some(t=>['stalled','unavailable','limited'].includes(t.status))&&<button className="delivery-retry" onClick={onRetry}>重新通知未回应的成员</button>}<details className="delivery-history"><summary><ChevronDown size={15}/>已处理记录 · {history.length}</summary>{history.map(row)}</details></div></aside>;
}
