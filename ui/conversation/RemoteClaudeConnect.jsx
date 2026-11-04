import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {api} from '../v1/api.mjs';
export default function RemoteClaudeConnect({member,onStartChat}){
  const [status,setStatus]=useState(null),[setup,setSetup]=useState(null),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  useEffect(()=>{let active=true,pending=false;const tick=async()=>{if(pending)return;pending=true;try{const value=await api('/local/sources/status?memberId='+member.id);if(active)setStatus(value);}catch(e){if(active)setError(e.message);}finally{pending=false;}};tick();const t=setInterval(tick,5000);return()=>{active=false;clearInterval(t);};},[member.id]);
  const begin=async()=>{try{setError('');setSetup(await api('/v2/connect/claude',{memberId:member.id}));}catch(e){setError(e.message);}};
  const online=status?.items?.some(s=>s.online);
  return <section className="space-y-5 py-3" aria-label="Claude 远端接入">
    <div><h3 className="text-xl font-semibold">连接 VPS 上的 {member.name}</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">Claude 继续使用 VPS 上的原登录、项目和工具。这里接收协作消息；工作会话在每个聊天里选择。</p></div>
    <div role="status" className={'rounded-xl border p-4 '+(online?'bg-emerald-50':'bg-muted/30')}><strong>{online?'VPS 会话已在线':'等待 VPS 连接'}</strong><p className="text-sm mt-2">{online?'可以进入聊天，选择要参与的工作会话。首次真实回复会由 Hub 验证。':'由你在 VPS 操作下面的步骤，无需提供服务器密码或 Claude API Key。'}</p></div>
    {online&&<Button onClick={()=>onStartChat?.(member)}>进入聊天，选择会话</Button>}
    <Button variant={online?'outline':'default'} onClick={begin}>{setup?'重新生成配对码':online?'查看安装与新增会话说明':'生成接入步骤'}</Button>
    {setup&&<div className="space-y-4 text-sm leading-7"><p><strong>1. 在 VPS 终端安装连接器</strong>（需要 Node.js 22+）</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.install}</pre><Button size="sm" variant="outline" onClick={async()=>{await navigator.clipboard.writeText(setup.install);setCopied(true);}}>{copied?'已复制':'复制安装命令'}</Button><p><strong>2. 配对</strong>：运行下方命令；提示时粘贴配对码。15 分钟内有效。</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.pair}</pre><code className="rounded border p-2 select-all">{setup.pairingCode}</code><p><strong>3. 回到 VPS 的项目目录，恢复原会话</strong>。先正常退出正在使用的那个会话，再执行；在 Claude 官方选择器里选原会话，确认自定义通道提示。</p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{setup.start}</pre><p>以后在同一 VPS 用这条启动命令即可。新建会话去掉 <code>--resume</code>。Claude 会话打开时接收消息，关闭时 Hub 保留绑定，等待原会话重开。首次接入后，请在 Hub 的聊天里选择会话并发一句话验证。</p><p className="text-muted-foreground">官方自定义 Channels 当前为预览功能；若组织禁用，需要组织管理员开启。接入仅登记通过此启动器打开的会话。</p></div>}
    {error&&<p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
