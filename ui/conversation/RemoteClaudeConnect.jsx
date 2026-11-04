import React,{useEffect,useState} from 'react';
import {Copy,Check,ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';
export default function RemoteClaudeConnect({member,connection,onStartChat}){
  const [status,setStatus]=useState(null),[setup,setSetup]=useState(null),[error,setError]=useState(''),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true,pending=false;const tick=async()=>{if(pending)return;pending=true;try{const value=await api('/local/sources/status?memberId='+member.id);if(active){setStatus(value);setError('');}}catch(e){if(active)setError(e.message);}finally{pending=false;}};tick();const t=setInterval(tick,5000);return()=>{active=false;clearInterval(t);};},[member.id]);
  const copy=async()=>{if(busy)return;setBusy(true);setError('');try{const value=setup&&Date.parse(setup.expiresAt)>Date.now()+30000?setup:await api('/v2/connect/claude',{memberId:member.id});setSetup(value);await navigator.clipboard.writeText(value.skill);setCopied(true);}catch(e){setError(e.message);}finally{setBusy(false);}};
  const online=status?.items?.some(s=>s.online),verified=connection?.status==='verified',waiting=connection?.setup?.stage==='waiting_owner';
  const connected=online&&verified;
  return <section className="space-y-5 py-2" aria-label="Claude 账号接入">
    <div><h3 className="text-xl font-semibold">让 {member.name} 加入团队</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">复制接入说明，发给你正在使用的 Claude Code。它在原来的电脑或服务器完成准备，继续使用原账号和项目。</p></div>
    <div role="status" className={'rounded-xl border p-4 '+(connected?'bg-emerald-50 border-emerald-200':'bg-muted/30')}>
      <strong>{connected?'已连接，可以聊天':online?'已连上，正在验证回复':waiting?'准备好了，还差 Claude 的官方确认':copied?'说明已复制，发给 Claude 即可':verified?'已接入，等待 Claude 上线':'从你现有的 Claude 开始'}</strong>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{connected?'需要处理项目时，在聊天里选对应的工作会话。':online?'收到原 Claude 的真实回复后，这里会自动更新。':waiting?connection.setup.message:verified?'在原来的环境打开已接入的 Claude，连接会自动恢复。':copied?'Claude 会自动安装和配对。此页会显示进度，不用手填地址、密钥或服务器信息。':'不用把账号密码交给 Hub，也不用重新购买 API。'}</p>
    </div>
    {connected?<Button onClick={()=>onStartChat?.(member)}>开始聊天<ChevronRight size={16}/></Button>:!online&&<Button onClick={copy} disabled={busy}>{copied?<Check size={16}/>:<Copy size={16}/ >}{busy?'正在准备说明…':copied?'再次复制接入说明':'复制接入说明'}</Button>}
    {!connected&&!online&&<p className="text-xs leading-6 text-muted-foreground">首次接入若需要恢复原会话，Claude 会给你一条已准备好的命令；完成工作后再操作，并确认它自己的官方提示。账号连接以后，各聊天可以使用不同的工作会话。</p>}
    {setup&&<details className="border-t pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">查看接入说明与手动操作</summary><div className="mt-4 space-y-4 text-sm leading-6"><textarea readOnly aria-label="发给 Claude 的接入说明" value={setup.skill} rows={7} className="w-full rounded-lg border p-3 text-sm"/><p>说明内的配对码 15 分钟有效。以下命令仅供自行配置，在 Claude 所在环境执行。</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.install}</pre><p>运行配对命令，按提示输入一次性码：</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.pair}</pre><code className="select-all">{setup.pairingCode}</code><p>在原项目目录恢复工作会话：</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.start}</pre><p>基于官方 MCP Channels（预览功能）。会话打开时接收消息；组织禁用该功能时，需要管理员开启。</p></div></details>}
    {error&&<p role="alert" className="text-destructive text-sm">{error}</p>}
  </section>;
}
