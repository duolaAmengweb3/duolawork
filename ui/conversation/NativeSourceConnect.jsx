import React,{useEffect,useRef,useState} from 'react';
import {Copy,Check,Monitor,Server,ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';
import {formsFor} from '../../shared/native-forms.mjs';

export default function NativeSourceConnect({member,refresh,onStartChat,advanced}) {
  const forms=formsFor(member.platformId),initial=forms.find(f=>f.id==='antigravity-cli')?.id||forms[0]?.id;
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[location,setLocation]=useState('remote'),[form,setForm]=useState(initial),[setup,setSetup]=useState(null),[copied,setCopied]=useState(false);
  const [repair,setRepair]=useState(false),[updateCopied,setUpdateCopied]=useState(false);
  const epoch=useRef(0);
  useEffect(()=>{const generation=++epoch.current;let pending=false;const tick=async()=>{if(pending)return;pending=true;try{const value=await api('/local/sources/status?memberId='+member.id);if(epoch.current===generation){setData(value);}}catch(e){if(epoch.current===generation)setError(e.message);}finally{pending=false;}};tick();const timer=setInterval(tick,4000);return()=>{epoch.current++;clearInterval(timer);};},[member.id]);
  const record=data?.record,selectedForm=record?.form||form,ready=record?.enabled&&record.sourceReady&&['idle','working','syncing'].includes(record.status),registered=record?.enabled;
  const connect=async()=>{setBusy(true);setError('');try{setData(await api('/local/sources/connect',{memberId:member.id,...(!registered?{form}:{})}));await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const copy=async()=>{setBusy(true);setError('');try{const value=setup?.form===selectedForm&&Date.parse(setup.expiresAt)>Date.now()+30000?setup:await api('/v2/connect/native',{memberId:member.id,form:selectedForm});setSetup(value);await navigator.clipboard.writeText(value.skill);setCopied(true);}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <section className="space-y-5 py-2" aria-label="连接 Agent 账号">
    <p className="text-sm leading-7 text-muted-foreground">连接你正在使用的账号，保留原来的登录、模型和项目。之后在每个聊天里选择工作对话。</p>
    {registered&&<div role="status" className={'rounded-xl border p-4 '+(ready?'bg-emerald-50 border-emerald-200':'bg-muted/30')}><strong>{ready?'✓ 原环境已连接':record.pendingReply?'账号连接已保留':record.status==='needs_review'?'原环境需要处理':'连接已保留，等待原环境上线'}</strong><p className="mt-2 text-sm leading-6">{record.message}</p>{record.runtimeLabel&&<p className="mt-1 text-xs text-muted-foreground">运行在 {record.runtimeLabel}</p>}{!ready&&!record.pendingReply&&<Button className="mt-3" variant="outline" onClick={()=>{setRepair(v=>!v);setLocation(data?.remote?'remote':'local');}}>重新连接</Button>}</div>}
    {registered&&record.updateAvailable&&data.updateSkill&&<div className="rounded-xl border p-4 space-y-3"><p className="text-sm leading-6">原环境的连接器有更新。把说明发给这位 Agent 即可，现有账号和工作对话会保留。</p><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText(data.updateSkill);setUpdateCopied(true);}catch(e){setError(e.message);}}}>{updateCopied?<Check size={16}/>:<Copy size={16}/ >}{updateCopied?'已复制，发给 Agent':'复制更新说明'}</Button>{updateCopied&&<p role="status" className="text-xs text-muted-foreground">收到新版在线回执后，这条提示会自动消失。</p>}</div>}
    {(!registered||repair)&&<>
      {!registered&&<div className="flex gap-2 rounded-xl bg-muted p-1" role="group" aria-label="Agent 所在位置"><Button className="flex-1" variant={location==='remote'?'secondary':'ghost'} onClick={()=>{setLocation('remote');if(!registered)setForm(initial);}}><Server size={16}/>复制说明接入</Button><Button className="flex-1" variant={location==='local'?'secondary':'ghost'} onClick={()=>{setLocation('local');if(!registered)setForm(forms.find(f=>f.id==='antigravity-desktop')?.id||initial);}}><Monitor size={16}/>连接这台电脑</Button></div>}
      {forms.length>1&&!registered&&<label className="block text-sm">你使用的软件<select aria-label="Agent 软件" className="mt-2 w-full rounded-lg border bg-background p-3" value={form} onChange={e=>{setForm(e.target.value);setCopied(false);setSetup(null);}}>{forms.filter(f=>location!=='local'||f.id!=='deepseek-harness').map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
      {location==='remote'?<div className="space-y-4"><p className="text-sm leading-6 text-muted-foreground">把说明发给这个账号的 Agent，它会在自己所在的电脑或服务器完成连接。你不需要填写地址、密钥或 SSH 信息。</p><Button onClick={copy} disabled={busy}>{copied?<Check size={16}/>:<Copy size={16}/ >}{busy?'正在准备…':copied?'已复制，发给 Agent':'复制接入说明'}</Button>{copied&&<p role="status" className="text-sm text-muted-foreground">此页会自动显示连接进度。</p>}{setup&&<details><summary className="text-sm cursor-pointer text-muted-foreground">查看说明</summary><textarea aria-label="接入说明" readOnly value={setup.skill} rows={7} className="mt-2 w-full rounded-lg border p-3 text-sm"/></details>}</div>:<div className="space-y-3"><Button onClick={connect} disabled={busy}>{busy?'正在连接…':'连接本机账号'}</Button><p className="text-xs leading-6 text-muted-foreground">使用这台电脑上已有的登录。另一个账号在其他设备上时，请使用“复制说明接入”。</p></div>}
    </>}
    {record?.authorizationUrl&&<Button asChild><a href={record.authorizationUrl} target="_blank" rel="noreferrer">打开官方登录</a></Button>}
    {ready&&<Button onClick={()=>onStartChat?.(member)} disabled={!onStartChat}>选择项目，开始聊天<ChevronRight size={16}/></Button>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <details className="border-t pt-3"><summary className="cursor-pointer text-sm text-muted-foreground">高级连接与权限</summary>{advanced}</details>
  </section>;
}
