import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '../v1/api.mjs';

export default function ChatSessionPicker({member,channel,onSaved,onConnect}) {
  const [data,setData]=useState(null),[selected,setSelected]=useState(''),[mode,setMode]=useState('existing'),[workspace,setWorkspace]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=async()=>{const value=await api('/local/chat-sessions?'+new URLSearchParams({memberId:member.id,channelId:channel.id}));setData(value);setSelected(value.binding?.sessionId||'');setMode(value.binding?'existing':value.items.length?'existing':value.capabilities.create?'new':'existing');};
  useEffect(()=>{let active=true;api('/local/chat-sessions?'+new URLSearchParams({memberId:member.id,channelId:channel.id})).then(value=>{if(!active)return;setData(value);setSelected(value.binding?.sessionId||'');setMode(value.binding||value.items.length?'existing':value.capabilities.create?'new':'existing');}).catch(e=>active&&setError(e.message));return()=>{active=false;};},[member.id,channel.id]);
  const save=async()=>{setBusy(true);setError('');try{await api('/local/chat-sessions',{memberId:member.id,channelId:channel.id,mode,sessionId:selected,...(workspace.trim()?{workspace:workspace.trim()}:{})});await onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}};
  if(!data)return <div className="space-y-3"><p role="status">{error||'正在读取工作会话…'}</p>{error&&<div className="flex gap-2"><Button onClick={()=>load().catch(e=>setError(e.message))}>重新读取</Button><Button variant="outline" onClick={onConnect}>查看连接</Button></div>}</div>;
  if(!data.record?.enabled)return <div className="space-y-3"><p className="text-sm">请先连接 {member.name} 的账号。</p><Button onClick={onConnect}>去连接</Button></div>;
  return <section className="space-y-4" aria-label="聊天的工作会话">
    <p className="text-sm leading-7 text-muted-foreground">为“{channel.name}”选择 {member.name} 处理哪个项目、继续哪段工作会话。更换只影响这个聊天，原生会话和历史会保留。</p>
    {data.binding&&<div className="rounded-lg border bg-muted/30 p-3 text-sm"><strong>当前：{data.binding.title||'原工作会话'}</strong><p className="mt-1 text-xs break-all text-muted-foreground">{data.binding.workspace}</p></div>}
    <div className="flex gap-2"><Button variant={mode==='existing'?'default':'outline'} onClick={()=>setMode('existing')}>选择已有会话</Button>{data.capabilities.create&&<Button variant={mode==='new'?'default':'outline'} onClick={()=>setMode('new')}>新建工作会话</Button>}</div>
    {mode==='existing'?<><div className="max-h-72 overflow-auto space-y-2" role="radiogroup" aria-label="可用工作会话">{data.items.map(s=><button type="button" key={s.id} role="radio" aria-checked={selected===s.id} onClick={()=>setSelected(s.id)} className={'w-full rounded-lg border p-3 text-left '+(selected===s.id?'bg-primary/5 border-primary':'hover:bg-muted')}><strong className="text-sm">{s.title}</strong><span className="block mt-1 text-xs break-all text-muted-foreground">{s.workspace||'尚未关联项目'}{s.running?' · 正在工作，消息排队':''}</span><span className="block mt-1 text-[11px] text-muted-foreground">{s.id.slice(0,14)}</span></button>)}</div>{!data.items.length&&<p className="text-sm text-muted-foreground">暂无可选会话。{data.capabilities.create?'可以新建工作会话。':data.capabilities.createHint}</p>}</>:<label className="grid gap-2 text-sm">项目目录（可选）<Input aria-label="工作会话项目目录" value={workspace} onChange={e=>setWorkspace(e.target.value)} placeholder="例如 /Users/you/Projects/my-app"/><span className="text-xs leading-6 text-muted-foreground">留空会为这个聊天创建独立工作目录。只创建会话，不会自动修改项目文件。</span></label>}
    {data.existingHint&&mode==='existing'&&<p className="text-xs leading-6 text-muted-foreground">{data.existingHint}</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button disabled={busy||mode==='existing'&&!selected} onClick={save}>{busy?'正在保存…':'用于这个聊天'}</Button><Button variant="ghost" disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>刷新会话</Button></div>
  </section>;
}
