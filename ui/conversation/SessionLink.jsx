import React,{useEffect,useRef,useState} from 'react';
import {Copy,Check,Loader2,MessageSquare} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';

export default function SessionLink({member,channel,onSaved}){
 const [link,setLink]=useState(null),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[error,setError]=useState('');const done=useRef(false),active=useRef(null);
 useEffect(()=>{let closed=false,pending=false;const tick=async()=>{if(pending)return;pending=true;try{const r=await api('/v2/session-links?'+new URLSearchParams({memberId:member.id,channelId:channel.id}));const value=r.items[0];if(!closed&&value){if(['waiting','confirming','verified','applying'].includes(value.status))active.current=value.id;setLink(old=>old?.id===value.id?{...old,...value}:value);if(value.status==='completed'&&active.current===value.id&&!done.current){done.current=true;await onSaved(value.session ? {sessionId:value.session.id,...value.session} : undefined);}}}catch(e){if(!closed)setError(e.message);}finally{pending=false;}};tick();const timer=setInterval(tick,2500);return()=>{closed=true;clearInterval(timer);};},[member.id,channel.id]);
 const copy=async()=>{setBusy(true);setError('');try{const value=link?.skill&&link.status==='waiting'&&Date.parse(link.expiresAt)>Date.now()+30000?link:await api('/local/session-links',{memberId:member.id,channelId:channel.id});active.current=value.id;done.current=false;setLink(value);await navigator.clipboard.writeText(value.skill);setCopied(true);}catch(e){setError(e.message);}finally{setBusy(false);}};
 const cancel=async()=>{setBusy(true);try{setLink(await api('/v2/session-links',{action:'cancel',id:link.id,requestId:crypto.randomUUID()}));setCopied(false);}catch(e){setError(e.message);}finally{setBusy(false);}};
 const expired=link?.status==='waiting'&&Date.parse(link.expiresAt)<Date.now(),confirming=['confirming','verified','applying'].includes(link?.status);
 return <div className="space-y-4 py-1" aria-label="从 Agent 关联当前对话">
  <div className="flex gap-3"><MessageSquare className="mt-1 shrink-0 text-primary" size={22}/><div><h3 className="font-semibold">复制说明，发到原来的对话</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">复制说明，发到 {member.name} 中你想继续的那段对话。它会自动告诉 DuolaWork 自己正在做哪个项目。</p></div></div>
  <p className="text-xs leading-6 text-muted-foreground">原项目和历史保留；配对成功后，此聊天就会使用那段对话。</p>
  {link?.status==='completed'&&<p className="text-sm text-emerald-700">已关联：{link.session?.title}。如需更换，可复制新的说明发给另一段对话。</p>}
  {confirming?<div role="status" className="rounded-xl border p-4"><div className="flex items-center gap-2"><Loader2 size={16} className="animate-spin"/><strong>{link.status==='confirming'?'已找到原对话，正在确认':'原对话已确认，正在保存'}</strong></div><p className="mt-2 text-sm">{link.session?.title}</p><p className="mt-2 text-xs text-muted-foreground">原 Agent 正忙时会等它完成当前工作。你可以关闭这个窗口，关联会继续。</p></div>:<Button onClick={copy} disabled={busy}>{copied&&!expired?<Check size={16}/>:<Copy size={16}/ >}{busy?'正在准备…':expired?'重新复制说明':copied?'已复制，发给原 Agent':'复制配对说明'}</Button>}
  {link?.status==='waiting'&&!expired&&<p role="status" className="text-sm text-muted-foreground">等待原 Agent 接收说明，完成后这里会自动更新。</p>}
  {(link?.status==='failed'||link?.status==='cancelled'||expired)&&<p role="alert" className="text-sm text-destructive">{expired?'说明已过期，可以重新复制。':link.message||'本次关联已取消。原来的对话关联保留。'}</p>}
  {link?.skill&&!confirming&&<details><summary className="cursor-pointer text-sm text-muted-foreground">查看配对说明</summary><textarea readOnly aria-label="原对话配对说明" rows={7} value={link.skill} className="mt-2 w-full rounded-lg border p-3 text-sm"/></details>}
  {['waiting','confirming','verified'].includes(link?.status)&&<Button variant="ghost" onClick={cancel} disabled={busy}>取消这次关联</Button>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </div>;
}
