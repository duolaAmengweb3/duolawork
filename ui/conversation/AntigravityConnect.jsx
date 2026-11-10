import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Monitor,FolderOpen,CheckCircle2,Loader2,RefreshCw} from 'lucide-react';
import {api} from '../v1/api.mjs';
export default function AntigravityConnect({member,connection,refresh,onStartChat,managedView}){
 const [status,setStatus]=useState(null),[sessions,setSessions]=useState([]),[selected,setSelected]=useState(''),[choosing,setChoosing]=useState(false),[managed,setManaged]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const record=status?.members.find(r=>r.memberId===member.id),legacy=status?.managedMembers.find(r=>r.memberId===member.id),ready=record?.enabled&&record.verified&&['idle','working'].includes(record.status)&&connection?.status==='verified';
 useEffect(()=>{let active=true,loading=false;const tick=async()=>{if(loading)return;loading=true;try{const s=await api('/local/antigravity/status');if(!active)return;setStatus(s);if(s.online){const d=await api('/local/antigravity/sessions');if(active)setSessions(d.items);}await refresh();}catch(e){if(active)setError(e.message);}finally{loading=false;}};tick();const timer=setInterval(tick,3000);return()=>{active=false;clearInterval(timer);};},[member.id]);
 const perform=async fn=>{setBusy(true);setError('');try{await fn();setStatus(await api('/local/antigravity/status'));await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const prepare=()=>perform(async()=>{setChoosing(true);setManaged(false);await api('/local/antigravity/prepare',{memberId:member.id});});
 const useManaged=()=>perform(async()=>{await api('/local/antigravity/use-managed',{memberId:member.id});setManaged(true);setChoosing(false);});
 if((managed||legacy&&!record?.enabled&&!choosing)&&status)return <div className="space-y-5"><div className="rounded-xl border bg-blue-50 p-4 space-y-3"><p className="text-sm leading-6 text-muted-foreground">当前是 Hub 独立后台会话。要让正在官方桌面干活的那位 Agent 加入，可以选择原会话；原后台会话和登录会保留。</p><Button variant="outline" disabled={busy} onClick={prepare}>连接桌面原会话</Button></div>{managedView}{error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</div>;
 return <section className="space-y-5 py-3" aria-label="Antigravity 原会话接入">
  <div><h3 className="text-xl font-semibold">把 {member.name} 加入团队</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">选择官方 Antigravity 桌面里正在工作的会话，沿用原项目、模型、工具与聊天上下文。</p></div>
  {!status?<p className="flex gap-2 items-center text-sm"><Loader2 className="animate-spin" size={16}/>正在读取桌面环境</p>:ready?<>
   <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 space-y-2"><strong className="flex gap-2 items-center text-emerald-800"><CheckCircle2 size={18}/>已连接原会话，可以聊天</strong><p className="text-sm">{record.title}</p><p className="break-all text-xs leading-6 text-muted-foreground">{record.cwd}</p></div>
   <div className="flex flex-wrap gap-2">{onStartChat&&<Button onClick={()=>perform(()=>onStartChat(member))}>开始聊天</Button>}<Button variant="outline" onClick={()=>perform(()=>api('/local/antigravity/open',{}))}>查看官方桌面</Button></div>
   <p className="text-xs leading-6 text-muted-foreground">原会话忙碌时消息排队，当前一轮结束后处理。桌面版需保持运行，可最小化；Hub 重开沿用原绑定。</p>
  </>:record?.enabled?<>
   <div role="status" className="rounded-xl border bg-muted/40 p-5 space-y-2"><strong>{record.status==='offline'?'原桌面暂不可用':'正在连接原会话'}</strong><p className="text-sm leading-6">{record.message}</p><p className="break-all text-xs text-muted-foreground">{record.title} · {record.cwd}</p></div>
   {['needs_review','offline'].includes(record.status)&&<Button disabled={busy} onClick={()=>perform(()=>api('/local/antigravity/resume',{memberId:member.id}))}>继续连接原会话</Button>}
   <Button variant="outline" onClick={()=>perform(()=>api('/local/antigravity/open',{}))}>查看官方桌面</Button>
  </>:<>
   <p className="flex gap-2 items-center text-sm"><Monitor size={16}/>{status.installed?'已找到官方桌面版 '+status.version:'请先安装并登录官方 Antigravity 桌面版'}</p>
   {status.installed&&status.supported===false&&<p className="text-sm text-destructive">此版本尚未通过兼容验证，原软件、登录和会话保留。</p>}
   {!choosing?<Button disabled={busy||!status.installed||!status.supported} onClick={prepare}>继续连接</Button>:!status.online||status.preparing?<div role="status" className="rounded-xl border p-5 space-y-3"><p className="flex items-center gap-2"><Loader2 className="animate-spin" size={16}/>{status.progress||'正在准备原会话连接'}</p>{status.prepareError&&<><p className="text-sm text-destructive">{status.prepareError}</p><Button variant="outline" onClick={prepare}>重新连接</Button></>}</div>:<div className="space-y-4">
    <p className="text-sm text-muted-foreground">选择确切的工作会话，Hub 不会替它新建另一个 Agent。</p>
    <div className="space-y-2 max-h-64 overflow-auto" role="radiogroup" aria-label="Antigravity 已有工作会话">{sessions.map(s=><button type="button" key={s.id} role="radio" aria-checked={selected===s.id} onClick={()=>setSelected(s.id)} className={'w-full rounded-lg border p-3 text-left hover:bg-muted '+(selected===s.id?'border-primary bg-primary/5':'border-border')}><span className="flex gap-2 items-center text-sm font-medium"><FolderOpen size={15}/>{s.title}</span><span className="mt-1 block break-all text-xs leading-5 text-muted-foreground">{s.workspace||'尚未关联本地项目'}{s.running?' · 正在工作，Hub 消息将排队':''}</span></button>)}</div>
    {!sessions.length&&<p className="text-sm text-muted-foreground">暂无工作会话，请在官方桌面打开项目并开始一段对话。</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy||!selected||!sessions.find(s=>s.id===selected)?.workspace} onClick={()=>perform(()=>api('/local/antigravity/connect',{memberId:member.id,sessionId:selected}))}>连接这个会话</Button><Button variant="outline" onClick={()=>perform(()=>api('/local/antigravity/open',{}))}>打开官方桌面</Button><Button variant="ghost" aria-label="刷新 Antigravity 会话" onClick={()=>perform(async()=>setSessions((await api('/local/antigravity/sessions')).items))}><RefreshCw size={16}/></Button></div>
   </div>}
  </>}
  {(error||status?.prepareError&&!choosing)&&<Alert variant="destructive"><AlertDescription>{error||status.prepareError}</AlertDescription></Alert>}
  <details className="border-t pt-3"><summary className="cursor-pointer text-sm text-muted-foreground">其他接入方式</summary><p className="my-3 text-xs leading-6 text-muted-foreground">也可使用由 Hub 管理的独立后台助手。它使用另一段会话，不继承桌面原会话；旧连接资料会保留。</p><Button variant="outline" disabled={busy||record?.status==='working'} onClick={useManaged}>使用独立后台助手</Button></details>
 </section>;
}
