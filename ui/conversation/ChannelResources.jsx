import React,{useState} from 'react';
import {ArrowUpRight,Folder,Plug,Sparkles} from 'lucide-react';
import {api} from '../v1/api.mjs';
import {useServiceData,serviceStore} from './service-data.jsx';
import ServiceIcon from './ServiceIcon.jsx';

function Toggle({checked,disabled,label,onChange}){return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={'resource-toggle '+(checked?'on':'')} onClick={()=>onChange(!checked)}><span/></button>;}
export default function ChannelResources({channelId,folders=[],onGlobalService}){
 const key='/v2/channel-resources?'+new URLSearchParams({channelId}),{data,loading,error,refresh}=useServiceData(key),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 async function change(args){setBusy(true);setFailure('');try{const next=await api('/v2/channel-resources',{channelId,requestId:crypto.randomUUID(),expectedVersion:data.version,...args});serviceStore.invalidate(key,{refresh:false});serviceStore.update(key,()=>next);}catch(e){setFailure(e.message);if(e.status===409)await refresh().catch(()=>{});}finally{setBusy(false);}}
 const groups=new Map();for(const c of data?.connections||[]){const id=c.provider==='custom'?c.id:c.provider;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(c);}
 const path=f=>{const seen=new Set(),names=[];while(f&&!seen.has(f.id)){seen.add(f.id);names.unshift(f.title);f=folders.find(x=>x.id===f.parentFolderId);}return names.join(' / ');};
 return <section className="channel-resources" aria-label="本群资源"><div className="resource-heading"><h2>本群使用</h2><small>沿用全局连接，可在这里调整</small></div>
  {(failure||error)&&<p role="alert" className="space-inline-error">{failure||error}<button onClick={()=>refresh().catch(()=>{})}>重试</button></p>}
  {!data&&<p role="status" className="space-muted">{loading?'正在读取本群资源…':'暂未读取到资源'}</p>}
  {data&&<><section className="resource-section"><h3>连接器<button onClick={()=>onGlobalService('connectors')}>管理<ArrowUpRight size={12}/></button></h3>
   {!groups.size&&<div className="resource-empty"><Plug size={21}/><p>连接外部服务后，本群即可使用。</p><button onClick={()=>onGlobalService('connectors')}>连接服务<ArrowUpRight size={12}/></button></div>}
   {[...groups.entries()].map(([key,accounts])=>{const c=accounts.find(a=>a.preferred)||accounts.find(a=>a.enabled&&a.connected)||accounts.find(a=>a.globalAllowed)||accounts[0],ready=c.connected&&(c.health==='ready'||!c.health),label=!c.globalAllowed?'未向本群开放':!c.enabled?'本群已关闭':ready?'已连接':c.health==='authorization_required'?'需要登录':'连接需要处理';return <div className="resource-group" key={key}>
    <div className="resource-row"><ServiceIcon provider={c.provider}/><div className="resource-row-main"><strong>{c.provider==='custom'?c.name:({feishu:'飞书','github-mcp':'GitHub',github:'GitHub','wechat-mp':'微信公众号','google-drive':'Google Drive','google-gmail':'Gmail','google-calendar':'Google Calendar'})[c.provider]||c.name}</strong>
     {accounts.length>1&&c.provider!=='custom'?<select aria-label={(c.provider==='feishu'?'飞书':c.name)+' 本群默认账号'} disabled={busy} value={data.defaultConnections[c.provider]||''} onChange={e=>change({action:'default_account',provider:c.provider,connectionId:e.target.value||null})}><option value="">不指定默认账号</option>{accounts.map(a=><option key={a.id} value={a.id} disabled={!a.globalAllowed||!a.enabled||!a.connected}>{a.account}{!a.enabled?'（本群未启用）':''}</option>)}</select>:<span>{c.account}</span>}
     <small className={ready&&c.enabled?'resource-ready':''}>{label}</small></div><Toggle label={'本群使用 '+c.name+' '+c.account} checked={c.enabled} disabled={busy||!c.globalAllowed||!c.connected} onChange={enabled=>change({action:'connection',connectionId:c.id,enabled})}/></div>
    {accounts.length>1&&<details className="resource-accounts"><summary>账号使用范围</summary>{accounts.filter(a=>a.id!==c.id).map(a=><div className="resource-account" key={a.id}><span>{a.account}<small>{!a.globalAllowed?'未向本群开放':!a.connected?'需在全局连接':a.preferred?'本群默认账号':''}</small></span><Toggle label={'本群使用 '+a.name+' '+a.account} checked={a.enabled} disabled={busy||!a.globalAllowed||!a.connected} onChange={enabled=>change({action:'connection',connectionId:a.id,enabled})}/></div>)}<p>默认账号用于未明确指定账号的操作，其他已开启账号仍可指定使用。</p></details>}
   </div>;})}
  </section><section className="resource-section"><h3>技能<button onClick={()=>onGlobalService('skills')}>管理<ArrowUpRight size={12}/></button></h3>
   {!data.skills.length&&<p className="space-muted">添加做事方法后，成员可按需参考。</p>}
   {data.skills.map(s=><div className="resource-row resource-skill" key={s.id}><Sparkles size={19}/><div className="resource-row-main"><strong>{s.name}</strong><span title={s.description}>{s.description}</span>{!s.globalAllowed&&<small>未向本群开放</small>}</div><Toggle label={'本群使用技能 '+s.name} checked={s.enabled} disabled={busy||!s.globalAllowed} onChange={enabled=>change({action:'skill',skillId:s.id,enabled})}/></div>)}
  </section><section className="resource-section"><h3>项目配置</h3><label className="resource-folder"><Folder size={18}/><span>默认资料目录</span><select aria-label="默认资料目录" disabled={busy} value={data.defaultFolderId||''} onChange={e=>change({action:'folder',folderId:e.target.value||null})}><option value="">全部资料</option>{folders.map(f=><option key={f.id} value={f.id}>{path(f)}</option>)}</select></label><p className="resource-help">从聊天上传文件、新建文档时使用；在具体文件夹中操作仍保存在当前文件夹。</p></section>
  <footer className="resource-global"><button onClick={()=>onGlobalService('connectors')}>前往全局管理<ArrowUpRight size={14}/></button></footer></>}
 </section>;
}
