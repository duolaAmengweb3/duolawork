import React,{useRef,useState} from 'react';
import {Copy,Check} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {useServiceData} from './service-data.jsx';
export default function WechatConnectorForm({original={},onClose,onSave}){
 const [name,setName]=useState(original.name||''),[appId,setAppId]=useState(original.appId||''),[secret,setSecret]=useState(''),[credentialId,setCredential]=useState(original.vaultReferences?.[0]?.credentialId||''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);const request=useRef(crypto.randomUUID());
 const setup=useServiceData('/v2/connectors?action=setup'),vault=useServiceData('/v2/vault');const ip=setup.data?.wechat?.egressIp,entries=(vault.data?.items||[]).filter(e=>e.status==='active'&&e.fieldNames.includes('app_id')&&e.fieldNames.includes('app_secret'));
 const change=fn=>value=>{request.current=crypto.randomUUID();fn(value);};
 return <Dialog open onOpenChange={v=>!v&&!busy&&onClose()}><DialogContent className="connector-dialog"><DialogHeader><DialogTitle>{original.id?'管理公众号':'连接微信公众号'}</DialogTitle><DialogDescription>由共享服务器统一执行，连接后所有 Agent 都可使用；每个公众号单独保存。</DialogDescription></DialogHeader>
 <form className="connector-form" autoComplete="off" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await onSave({action:'save',provider:'wechat-mp',requestId:request.current,connectionId:original.id,expectedVersion:original.version,name:name.trim()||'微信公众号',appId:appId.trim(),...(secret?{appSecret:secret}:credentialId?{credentialId}:{})});setSecret('');onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}}>
 <label>公众号名称（可选）<Input aria-label="公众号名称" value={name} onChange={e=>change(setName)(e.target.value)} placeholder="例如 哆啦AI百宝箱"/></label>
 <label>AppID<Input aria-label="公众号 AppID" required readOnly={!!original.id} value={appId} onChange={e=>change(setAppId)(e.target.value)} placeholder="wx 开头的公众号 AppID"/></label>
 <label>AppSecret<Input aria-label="公众号 AppSecret" type="password" autoComplete="off" required={!credentialId&&!original.id} value={secret} onChange={e=>change(setSecret)(e.target.value)} placeholder={original.id?'留空保留原凭证；填写新值可轮换':'输入开发密钥，自动加密保存到 Vault'}/></label>
 {!!entries.length&&<details><summary>使用 Vault 已有凭证</summary><select aria-label="公众号 Vault 凭证" value={credentialId} onChange={e=>{change(setCredential)(e.target.value);const found=entries.find(v=>v.id===e.target.value)?.service?.match(/wx[a-zA-Z0-9]{16}/);if(found&&!original.id)setAppId(found[0]);}}><option value="">选择凭证</option>{entries.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></details>}
 <div className="services-note"><strong>API IP 白名单</strong><p>在微信开发者平台 → 基础信息 → API IP 白名单中添加以下地址，保留原有条目。</p>{ip?<div className="connector-inline-actions"><code>{ip}</code><Button type="button" variant="ghost" size="sm" onClick={async()=>{try{await navigator.clipboard.writeText(ip);setCopied(true);}catch{setError('复制未成功，请选中此地址复制。');}}}>{copied?<Check size={14}/>:<Copy size={14}/>}复制 IP</Button></div>:<p>共享服务器出口 IP 暂未配置，请先在服务器设置中填写；不使用电脑或 Agent 自己的 IP 冒充。</p>}<p>AppSecret 在同页的「开发密钥」中管理。素材、草稿和正式发表权限以该公众号的微信接口实际结果为准。</p><a href="https://developers.weixin.qq.com/platform" target="_blank" rel="noreferrer">打开微信开发者平台</a></div>
 {error&&<p className="services-error" role="alert">{error}</p>}<footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy}>{busy?'正在检查公众号…':original.id?'保存并检查':'连接公众号'}</Button></footer></form></DialogContent></Dialog>;
}
