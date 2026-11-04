import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';

export default function NativeSourceConnect({member,refresh,onStartChat,advanced}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true,pending=false;const tick=async()=>{if(pending)return;pending=true;try{const value=await api('/local/sources/status?memberId='+member.id);if(active)setData(value);}catch(e){if(active)setError(e.message);}finally{pending=false;}};tick();const timer=setInterval(tick,3000);return()=>{active=false;clearInterval(timer);};},[member.id]);
  const record=data?.record,ready=record?.enabled&&['idle','working'].includes(record.status);
  const connect=async()=>{setBusy(true);setError('');try{setData(await api('/local/sources/connect',{memberId:member.id}));await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <section className="space-y-5 py-3" aria-label="连接 Agent 账号">
    <div><h3 className="text-xl font-semibold">连接 {member.name}</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">先连接 Agent 账号，沿用已有登录、模型与工具。工作项目和会话在每个单聊或群聊里选择。</p></div>
    <div role="status" className={'rounded-xl border p-5 space-y-2 '+(ready?'bg-emerald-50 border-emerald-200':'bg-muted/30')}><strong>{ready?'✓ 账号已连接':record?.status==='connecting'?'正在连接账号':'等待连接'}</strong><p className="text-sm leading-6">{ready?(record?.accountLabel?'已连接账号：'+record.accountLabel+'。在聊天中选择要处理的项目。':'可以加入聊天；每个聊天会显示当前使用的工作会话。'):record?.message||'连接时不要求选择项目，也不会向已有会话发送任务。'}</p></div>
    {record?.authorizationUrl&&<Button asChild><a href={record.authorizationUrl} target="_blank" rel="noreferrer">打开官方登录</a></Button>}
    {ready?<Button onClick={async()=>{setBusy(true);setError('');try{await onStartChat?.(member);}catch(e){setError(e.message);}finally{setBusy(false);}}} disabled={busy||!onStartChat}>进入聊天，选择工作会话</Button>:<Button onClick={connect} disabled={busy||['installing','connecting','waiting_login'].includes(record?.status)}>{busy?'正在连接':'连接这台电脑上的账号'}</Button>}
    <p className="text-xs leading-6 text-muted-foreground">同一个账号只需连接一次。不同聊天可以选择不同项目；添加另一个账号不会退出或替换已有登录。</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <details className="border-t pt-3"><summary className="cursor-pointer text-sm text-muted-foreground">高级连接与权限</summary>{advanced}</details>
  </section>;
}
