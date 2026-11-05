import React,{useEffect,useState} from 'react';
import {Copy,Check,ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';
import {CLAUDE_RESUME_HELP} from '../../shared/claude-onboarding.mjs';
export default function RemoteClaudeConnect({member,connection,onStartChat}){
  const [status,setStatus]=useState(null),[setup,setSetup]=useState(null),[error,setError]=useState(''),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false),[copiedAction,setCopiedAction]=useState('');
  useEffect(()=>{let active=true,pending=false;const tick=async()=>{if(pending)return;pending=true;try{const value=await api('/local/sources/status?memberId='+member.id);if(active){setStatus({...value,memberId:member.id});setError('');}}catch(e){if(active)setError(e.message);}finally{pending=false;}};tick();const t=setInterval(tick,5000);return()=>{active=false;clearInterval(t);};},[member.id]);
  const copy=async()=>{if(busy)return;setBusy(true);setError('');try{const value=setup&&Date.parse(setup.expiresAt)>Date.now()+30000?setup:await api('/v2/connect/claude',{memberId:member.id});setSetup(value);await navigator.clipboard.writeText(value.skill);setCopied(true);}catch(e){setError(e.message);}finally{setBusy(false);}};
  const copyAction=async(text,kind)=>{try{await navigator.clipboard.writeText(text);setCopiedAction(kind);setError('');}catch(e){setError('复制失败，请展开命令后手动复制。');}};
  const online=status?.memberId===member.id&&status?.items?.some(s=>s.online),verified=connection?.status==='verified',waiting=connection?.setup?.stage==='waiting_owner';
  const connected=online&&verified,action=connection?.setup?.ownerAction?.type==='claude_resume'?connection.setup.ownerAction:null;
  return <section className="space-y-5 py-2" aria-label="Claude 账号接入">
    <div><h3 className="text-xl font-semibold">{connected?`${member.name} 已加入团队`:waiting&&!online?'还差一次重新打开 Claude':`让 ${member.name} 加入团队`}</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{waiting&&!online?'安装已完成。Claude 需要重新打开，才能开始接收 DuolaWork 的消息；原账号、项目和对话都会保留。':'复制接入说明，发给你正在使用的 Claude Code。它在原来的电脑或服务器完成准备，继续使用原账号和项目。'}</p></div>
    {waiting&&!online?<>
      <ol className="space-y-4 text-sm leading-6" aria-label="完成连接的步骤">
        <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">1</span><div><strong>先退出这一次 Claude</strong><p className="text-muted-foreground">等当前工作结束，在 Claude 输入 <code>/exit</code>，回到终端。</p></div></li>
        <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">2</span><div className="min-w-0 flex-1"><strong>用恢复命令重新打开</strong><p className="text-muted-foreground">{action?'把下方命令粘贴到刚才退出后的终端，按回车。它会自动回到原项目。':'把 Claude 刚才回复中的那条恢复命令，粘贴到退出后的终端，按回车。先进入它说明的原项目目录。'}直接输入 claude 不会启用这次连接。</p>{action&&<div className="mt-3 space-y-2"><Button onClick={()=>copyAction(action.command,'resume')}>{copiedAction==='resume'?<Check size={16}/>:<Copy size={16}/ >}{copiedAction==='resume'?'已复制，粘贴到原终端':'复制恢复命令'}</Button>{!action.exactSession&&<p className="text-muted-foreground">打开后，在 Claude 的列表里选择刚才那段对话。</p>}<details><summary className="cursor-pointer text-xs text-muted-foreground">查看命令与原项目</summary><p className="mt-2 break-all text-xs">{action.workspace}</p><pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{action.command}</pre></details></div>}</div></li>
        <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">3</span><div><strong>确认连接，等待自动验证</strong><p className="text-muted-foreground">如果 Claude 出现 DuolaWork / Agent Hub 连接提示，确认它。恢复后不用再发配对码，也不用重新交代任务。</p></div></li>
      </ol>
      <div role="status" className="rounded-xl border bg-muted/30 p-4 text-sm leading-6">正在等 Claude 重新打开。收到它的真实回复后，这里会自动显示“已连接，可以聊天”。</div>
      <details className="text-sm leading-6"><summary className="cursor-pointer text-muted-foreground">重新打开后没有反应？</summary><p className="mt-3">把这句话发给刚才恢复的 Claude：</p><p className="my-2 rounded-lg bg-muted p-3">{CLAUDE_RESUME_HELP}</p><Button variant="outline" onClick={()=>copyAction(CLAUDE_RESUME_HELP,'help')}>{copiedAction==='help'?'已复制':'复制这句话'}</Button><p className="mt-2 text-muted-foreground">无需重新添加成员或重新配对。</p></details>
    </>:<div role="status" className={'rounded-xl border p-4 '+(connected?'bg-emerald-50 border-emerald-200':'bg-muted/30')}>
      <strong>{connected?'已连接，可以聊天':online?'Claude 已打开，正在验证回复':copied?'说明已复制，发给 Claude 即可':verified?'已接入，等待 Claude 上线':'从你现有的 Claude 开始'}</strong>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{connected?'需要处理项目时，在聊天里选对应的工作对话。':online?'无需再发配对码。收到 Claude 的真实回复后，这里会自动更新。':verified?'用原来的 DuolaWork 恢复命令打开 Claude，即可继续接收消息。':copied?'Claude 会自动安装和配对。此页会显示下一步，不用手填地址、密钥或服务器信息。':'不用把账号密码交给 DuolaWork，也不用重新购买 API。'}</p>
    </div>}
    {connected?<Button onClick={()=>onStartChat?.(member)}>开始聊天<ChevronRight size={16}/></Button>:!online&&!waiting&&<Button onClick={copy} disabled={busy}>{copied?<Check size={16}/>:<Copy size={16}/ >}{busy?'正在准备说明…':copied?'再次复制接入说明':'复制接入说明'}</Button>}
    {!connected&&!online&&!waiting&&<p className="text-xs leading-6 text-muted-foreground">首次安装后需要重新打开原 Claude 一次，页面会给出步骤。以后不用重复安装或配对。</p>}
    {setup&&!waiting&&<details className="border-t pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">查看接入说明</summary><textarea readOnly aria-label="发给 Claude 的接入说明" value={setup.skill} rows={7} className="mt-4 w-full rounded-lg border p-3 text-sm"/></details>}
    {error&&<p role="alert" className="text-destructive text-sm">{error}</p>}
  </section>;
}
