import React,{useEffect,useState} from 'react';
import {Plug,Plus,RefreshCw,ArrowUpRight,Monitor,Search,Settings2,FileUp} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '../v1/api.mjs';
import {CONNECTOR_CATALOG} from '../../shared/connector-catalog.mjs';
import ServiceIcon from './ServiceIcon.jsx';
import {serviceStore,useServiceData} from './service-data.jsx';
import {ConnectorEditor,ConnectorDetails,HostSetup,LegacyEditor} from './ConnectorForms.jsx';
import './connectors.css';
const labels={ready:'已连接',unchecked:'待检查',offline:'运行端离线',authorization_required:'需要登录',attention:'需要检查'};
const post=async args=>{
 const result=await api('/v2/connectors',{requestId:crypto.randomUUID(),...args},'POST',{timeoutMs:60000}),item=result.connection||result;
 if(item.id&&(item.tools||item.account))serviceStore.patch('/v2/connectors',(data,p)=>p.get('action')==='hosts'?data:{...data,items:[...data.items.filter(c=>c.id!==item.id),item]});
 serviceStore.invalidate('/v2/connectors');return result;
};
export default function ConnectorWorkspace({workspace,channels,onChannel}){
 const {data,loading,error:readError,refresh}=useServiceData('/v2/connectors');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[category,setCategory]=useState('全部'),[editor,setEditor]=useState(null),[detail,setDetail]=useState(null),[auth,setAuth]=useState(null),[hostSetup,setHostSetup]=useState(false);
 const items=data?.items||[],loaded=!!data,needHosts=hostSetup||!!editor||items.some(c=>c.transport==='stdio'&&c.status!=='disconnected');
 const hostData=useServiceData('/v2/connectors?action=hosts',{enabled:needHosts}),hosts=hostData.data?.items||[];
 const load=async()=>{setError('');try{await refresh();}catch{/* The shared metadata state retains the list and reports the refresh error. */}};
 useEffect(()=>{if(!auth)return;const timer=setInterval(()=>{void refresh().catch(e=>setError(e.message));},2500);return()=>clearInterval(timer);},[auth,refresh]);
 const check=async item=>{setBusy(true);try{const r=await post({action:item.health==='authorization_required'?'authorize':'check',connectionId:item.id});if(r.authorizationUrl)setAuth({url:r.authorizationUrl,id:r.connection.id,name:r.connection.name});await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const name=id=>id==='owner'?'你':workspace.members.find(m=>m.id===id)?.name||'成员',choose=p=>setEditor({...p,provider:p.id,id:undefined});
 const active=items.filter(c=>c.status!=='disconnected').map(c=>c.transport==='stdio'&&hostData.data&&!hosts.some(h=>h.id===c.hostId&&h.online)?{...c,health:'offline',message:'工具所在电脑或 VPS 不在线'}:c);
 const matches=c=>((c.name||c.account||'')+' '+(c.description||'')+' '+(c.repositories||[]).join(' ')).toLowerCase().includes(query.toLowerCase());
 const connected=active.filter(c=>matches(c)&&(category==='全部'||CONNECTOR_CATALOG.find(p=>p.id===(c.provider||'github-mcp'))?.category===category)),disconnected=items.filter(c=>c.status==='disconnected'&&matches(c));
 const connectedProviders=new Set(active.map(c=>c.serviceType==='mcp'?c.provider:'github-mcp'));
 const available=CONNECTOR_CATALOG.filter(p=>p.id!=='custom'&&!connectedProviders.has(p.id)&&matches(p)&&(category==='全部'||p.category===category));
 return <section className="workspace-services connector-workspace">
 <header className="services-header"><div><span className="service-heading-icon"><Plug size={23}/></span><h1>连接器</h1></div><p>连接一次，团队里的 Agent 都能按需使用。</p><div className="services-header-actions"><Button variant="ghost" size="icon" aria-label="刷新连接器" disabled={busy||loading} onClick={load}><RefreshCw size={16} className={loading?'animate-spin':''}/></Button><Button variant="outline" onClick={()=>setHostSetup(true)}><Monitor size={15}/>运行端</Button><Button variant="outline" onClick={()=>setEditor({provider:'custom',mode:'import',name:''})}><FileUp size={15}/>导入配置</Button><Button onClick={()=>choose(CONNECTOR_CATALOG.find(p=>p.id==='custom'))}><Plus size={15}/>自定义连接</Button></div></header>
 <div className="connector-browse"><div className="connector-search"><Search size={17}/><Input aria-label="搜索连接器" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索服务或已连接的账号"/></div><div className="connector-categories" role="group" aria-label="服务分类">{['全部','开发','办公','设计'].map(c=><button key={c} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div></div>
 {(error||readError&&!data)&&<p className="services-error" role="alert">{error||readError}<button onClick={load}>重试</button></p>}
 {data&&readError&&<p className="services-note" role="status">更新暂未成功，保留上次显示的连接。<button onClick={load}>重试</button></p>}
 {auth&&<div className="connector-auth" role="status"><div><strong>{items.find(c=>c.id===auth.id)?.health==='ready'?'连接已就绪':'继续连接 '+auth.name}</strong><p>{items.find(c=>c.id===auth.id)?.health==='ready'?'现在可以在聊天里让 Agent 使用了。':'在服务方完成登录后，这里会自动更新。'}</p></div>{items.find(c=>c.id===auth.id)?.health!=='ready'&&<a className="connector-login" href={auth.url} target="_blank" rel="noreferrer">打开登录 <ArrowUpRight size={14}/></a>}<Button variant="ghost" onClick={()=>setAuth(null)}>关闭</Button></div>}
 <section className="connector-section" aria-label="已连接"><div className="connector-section-heading"><h2>已连接{loaded&&<span>{active.length}</span>}</h2><small>{loading&&data?'正在更新…':'团队共享的服务与账号'}</small></div>
 {!loaded&&!readError?<div className="service-card-skeletons" aria-label="正在读取已连接服务" role="status">{[0,1].map(n=><div key={n}/>)}</div>:<div className="connector-list connector-grid">{connected.map(c=><ConnectedCard key={c.id} item={c} hosts={hosts} busy={busy} check={check} manage={()=>setDetail(c)} add={()=>choose(CONNECTOR_CATALOG.find(p=>p.id===(c.provider||'github-mcp'))||CONNECTOR_CATALOG.find(p=>p.id==='custom'))}/>)}</div>}
 {loaded&&!active.length&&<p className="connector-empty-inline">还没有连接服务，选择下方卡片即可连接。</p>}{loaded&&active.length>0&&!connected.length&&<p className="connector-empty-inline">没有匹配的已连接账号。</p>}
 </section>
 <section className="connector-section" aria-label="未连接"><div className="connector-section-heading"><h2>未连接<span>{available.length}</span></h2><small>选择服务即可开始连接</small></div><div className="connector-grid connector-available">{available.map(p=><button className="connector-card connector-service-card" key={p.id} aria-label={'连接 '+p.name} onClick={()=>choose(p)}><div className="connector-card-top"><ServiceIcon provider={p.id}/><span className="connector-category">{p.category}</span></div><h3>{p.name}{p.preview&&<small>预览</small>}</h3><p>{p.description}</p><span className="connector-card-link">连接服务 <Plus size={15}/></span></button>)}</div>{!available.length&&<p className="connector-empty-inline">{query?'没有找到匹配的服务。':'此分类的服务已全部连接。'}也可以添加自定义连接。</p>}</section>
 {!!disconnected.length&&<details className="connector-disconnected"><summary>已断开的连接 · {disconnected.length}</summary>{disconnected.map(c=><div key={c.id}><span>{c.name||c.account}</span><Button variant="ghost" onClick={()=>setEditor(c)}>重新连接</Button></div>)}</details>}
 {editor&&(editor.id&&editor.serviceType!=='mcp'?<LegacyEditor original={editor} onClose={()=>setEditor(null)} onSave={async args=>{await post(args);setEditor(null);await load();}}/>:<ConnectorEditor original={editor} hosts={hosts} onHosts={hostData.refresh} onClose={()=>setEditor(null)} onHostSetup={()=>setHostSetup(true)} onSave={async args=>{setBusy(true);try{const r=await post(args);if(r.authorizationUrl)setAuth({url:r.authorizationUrl,id:r.connection.id,name:r.connection.name});const failures=r.items?.filter(i=>i.error)||[];setEditor(null);await load();if(failures.length)setError(failures.map(i=>i.name+'：'+i.error).join('；'));}finally{setBusy(false);}}}/>)}
 {detail&&<ConnectorDetails item={detail} members={workspace.members} channels={channels} name={name} onClose={()=>setDetail(null)} onChannel={onChannel} onEdit={()=>{setEditor(detail);setDetail(null);}} onSave={async args=>{await post(args);setDetail(null);await load();}}/>}
 {hostSetup&&<HostSetup hosts={hosts} onClose={()=>{setHostSetup(false);void hostData.refresh().catch(()=>{});}} onRefresh={hostData.refresh}/>}
 </section>;
}
function ConnectedCard({item:c,hosts,busy,check,manage,add}){return <article className="connector-row connector-card"><div className="connector-card-top"><ServiceIcon provider={c.provider||'github'}/><span className={'connector-health '+(c.health||'ready')}>{c.serviceType==='mcp'?(labels[c.health]||'已配置'):'已连接'}</span></div><div className="connector-main"><h3>{c.name||'GitHub · '+c.account}</h3><p>{c.serviceType==='mcp'?c.transport==='stdio'?(hosts.find(h=>h.id===c.hostId)?.name||'原运行端')+' · '+c.tools.length+' 个工具':(c.url?new URL(c.url).hostname:'远程服务')+' · '+c.tools.length+' 个工具':c.repositories.join('、')}</p>{c.message&&<small>{c.message}</small>}<small>{c.channelIds?.length||c.memberIds?.length?'沿用已指定的使用范围':c.blockedMemberIds?.length||c.blockedChannelIds?.length?'已设置使用范围':'全工作区可用'}</small></div><div className="connector-card-actions"><Button variant="outline" size="sm" disabled={busy} onClick={()=>check(c)}>{c.health==='authorization_required'?'继续登录':'检查连接'}</Button><Button variant="ghost" size="sm" aria-label={'管理 '+(c.name||c.account)} onClick={manage}><Settings2 size={15}/>管理</Button><Button variant="ghost" size="icon" aria-label={'添加另一个 '+(CONNECTOR_CATALOG.find(p=>p.id===c.provider)?.name||c.account||'服务')+' 账号'} title="连接另一个账号" onClick={add}><Plus size={15}/></Button></div></article>;}
