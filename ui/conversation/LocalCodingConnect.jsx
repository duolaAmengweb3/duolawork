import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {api} from '../v1/api.mjs';
import NativeSourceConnect from './NativeSourceConnect.jsx';
import DshConnect from './DshConnect.jsx';
import AntigravityConnect from './AntigravityConnect.jsx';
const labels={installing:'正在准备连接组件',connecting:'正在连接',waiting_login:'还差一次官方登录',working:'正在处理',idle:'后台接收已开启',paused:'后台接收已暂停',needs_review:'需要继续检查',disconnected:'准备连接'};
export default function LocalCodingConnect(props){return <NativeSourceConnect {...props} advanced={<LegacyCodingConnect {...props}/>}/>;}
function LegacyCodingConnect({member,connection,refresh,onStartChat}){
 if(member.platformId==='deepseek-harness')return <DshConnect {...{member,connection,refresh,onStartChat}}/>;
 if(member.platformId==='antigravity'||member.platformId==='gemini-cli')return <AntigravityConnect {...{member,connection,refresh,onStartChat}} managedView={<ManagedCodingConnect {...{member,connection,refresh,onStartChat}}/>}/>;
 return <ManagedCodingConnect {...{member,connection,refresh,onStartChat}}/>;
}
function ManagedCodingConnect({member,connection,refresh,onStartChat}){
 const engine=member.platformId==='codex'?'codex':'antigravity',brand=engine==='codex'?'Codex':'Gemini';
 const [status,setStatus]=useState(null),[discovery,setDiscovery]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[answers,setAnswers]=useState({});
 const load=async()=>{setStatus(await api('/local/coding/status'));await refresh();};
 useEffect(()=>{let alive=true,running=false;api('/local/coding/discover').then(x=>alive&&setDiscovery(x)).catch(e=>alive&&setError(e.message));const tick=async()=>{if(running)return;running=true;try{const x=await api('/local/coding/status');if(alive)setStatus(x);}catch(e){if(alive)setError(e.message);}finally{running=false;}};tick();const timer=setInterval(tick,3000);return()=>{alive=false;clearInterval(timer);};},[member.id]);
 const record=status?.members.find(m=>m.memberId===member.id),native=discovery?.engines.find(e=>e.id===engine),ready=connection?.status==='verified'&&record?.enabled&&['idle','working'].includes(record.status);
 const perform=async action=>{setBusy(true);setError('');try{await action();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const working=['connecting','installing','working'].includes(record?.status);
 return <section className="space-y-5 py-3" aria-label="本机原生 Agent 接入">
  <div><h3 className="text-xl font-semibold">把 {member.name} 加入团队</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">连接原生 {brand}，保留它自己的订阅、模型和工具。默认完整授权，正常执行不再逐次确认；空闲时不调用模型。</p></div>
  <div className={`rounded-xl border p-5 space-y-2 ${ready?'bg-emerald-50 border-emerald-200':'bg-slate-50'}`} role="status"><strong>{ready?'✓ 已接入，可以聊天':labels[record?.status]||'准备连接'}</strong><p className="text-sm leading-6">{record?.message||'点击连接，Hub 会检查并准备官方运行组件；需要登录时会在这里提示。'}</p>{record?.status==='installing'&&record.totalBytes>0&&<progress aria-label="组件下载进度" className="w-full" value={record.downloadedBytes||0} max={record.totalBytes}/>}</div>
  {(!record||record.status==='disconnected')&&<><p className="text-sm leading-6 text-muted-foreground">此成员可使用原生文件、终端、联网及 Hub 协作工具。完整授权只用于 Hub 的专用会话，原 IDE 的全局设置保持不变。</p><Button disabled={busy||native?.canInstall===false} onClick={()=>perform(()=>api('/local/coding/connect',{memberId:member.id,engine}))}>{busy?'正在连接':`连接 ${brand}`}</Button></>}
  {record?.status==='waiting_login'&&record.authorizationUrl&&<Button asChild><a href={record.authorizationUrl} target="_blank" rel="noreferrer">{engine==='codex'?'使用 ChatGPT 登录':'使用 Google 登录'}</a></Button>}
  {working&&<p className="text-sm text-muted-foreground">可以关闭此窗口，准备和验证会继续；不用重复点击。</p>}
  {record?.status==='paused'&&<Button disabled={busy} onClick={()=>perform(()=>api('/local/coding/resume',{memberId:member.id}))}>继续接收</Button>}
  {record?.status==='idle'&&<Button variant="outline" disabled={busy} onClick={()=>perform(()=>api('/local/coding/pause',{memberId:member.id}))}>暂停后台接收</Button>}
  {record?.status==='needs_review'&&<Button variant="outline" disabled={busy} onClick={()=>perform(()=>api('/local/coding/resume',{memberId:member.id}))}>继续原会话</Button>}
  {ready&&onStartChat&&<Button disabled={busy} onClick={()=>perform(()=>onStartChat(member))}>开始聊天</Button>}
  {status?.approvals.filter(a=>a.memberId===member.id).map(a=><div key={a.id} className="rounded-xl border p-4 space-y-3"><strong>{a.title}</strong>{a.questions?a.questions.map(q=><label key={q.id} className="grid gap-2 text-sm">{q.question}{q.options?.length?<select aria-label={q.question} value={answers[q.id]||''} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})}><option value="">请选择</option>{q.options.map(o=><option key={o.label} value={o.label}>{o.label}</option>)}</select>:<input aria-label={q.question} value={answers[q.id]||''} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})}/>}</label>):<details><summary className="cursor-pointer text-sm">查看本次操作</summary><pre className="whitespace-pre-wrap text-xs max-h-56 overflow-auto">{a.detail}</pre></details>}<div className="flex gap-2"><Button disabled={busy||a.questions?.some(q=>!answers[q.id])} onClick={()=>perform(()=>api('/local/coding/approve',{id:a.id,allow:true,answers}))}>{a.questions?'提交回答':'仅本次允许'}</Button><Button variant="outline" disabled={busy} onClick={()=>perform(()=>api('/local/coding/approve',{id:a.id,allow:false}))}>拒绝</Button></div></div>)}
  {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  {record&&<details className="border-t pt-3"><summary className="cursor-pointer text-sm text-muted-foreground">权限设置</summary><label className="mt-3 grid gap-2 text-sm">执行权限<select aria-label="执行权限" disabled={busy||working} value={record.permissionMode||'full'} onChange={e=>perform(()=>api('/local/coding/permissions',{memberId:member.id,mode:e.target.value}))}><option value="full">完整授权（默认）</option><option value="ask">操作时确认</option></select></label></details>}
  <p className="border-t pt-3 text-xs leading-6 text-muted-foreground">Hub 使用独立原生会话，重开软件继续保留。已有 IDE 聊天独立使用。退出 Hub 或电脑关机后，本机接收暂停。</p>
 </section>;
}
