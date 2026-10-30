import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, command, memberName, records, label } from "./api.mjs";

export function RunHistory({projectId,members}) {
  const [rows,setRows]=useState([]),[next,setNext]=useState(null),[details,setDetails]=useState({}),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;records("run",{projectId}).then(r=>{if(active){setRows(r.items);setNext(r.nextCursor)}}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[projectId]);
  async function more(){setBusy(true);try{const r=await records("run",{projectId,cursor:next});setRows(old=>[...old,...r.items]);setNext(r.nextCursor)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <section className="space-y-3" aria-label="项目运行历史">{error&&<p role="alert">{error}</p>}{rows.filter(r=>r.purpose==="goal"&&!r.probe).map(r=><details key={r.id} className="source-row" onToggle={e=>{if(e.currentTarget.open&&!details[r.id])api("/v2/run?id="+r.id).then(d=>setDetails(old=>({...old,[r.id]:d}))).catch(e=>setError(e.message))}}><summary>{r.createdAt} · {label(r.status)} · {r.topic?.slice(0,60)}</summary>{details[r.id]?.steps.map(s=><div className="my-3" key={s.id}><strong>{memberName(members,s.memberId)} · {s.title}</strong><p>{label(s.status)} · 内部修订 {s.internalRound||0} 次</p><p>{s.issues?.join("；")}</p><small>领取：{details[r.id].attempts.find(a=>a.id===s.activeAttemptId)?.claimedAt||"尚未领取"}</small></div>)}</details>)}{!rows.length&&<p>还没有运行记录。</p>}{next&&<Button variant="outline" disabled={busy} onClick={more}>加载更早运行</Button>}</section>;
}

export function RuleScope({ value, onChange, project }) {
  return <label className="grid gap-2 text-sm">适用范围
    <select aria-label="规则适用范围" className="border rounded-md px-3 py-2" value={value} onChange={e=>onChange(e.target.value)}>
      <option value="project">本项目</option>
      <option value="type" disabled={!project?.projectType}>同类项目{project?.projectType ? ` · ${project.projectType}` : "（先设置项目类型）"}</option>
      <option value="global">全部项目</option>
    </select>
    {value==="type" && <small>只用于项目类型同为“{project.projectType}”的项目。</small>}
  </label>;
}

export function PairingFacts({project,members,all=false}) {
  const [rows,setRows]=useState([]);
  useEffect(()=>{let active=true;api("/v2/pairing-facts"+(all?"":"?"+new URLSearchParams({projectId:project?.id||"",projectType:project?.projectType||"",members:(project?.arrangement?.members||[]).join(",")}))).then(d=>{if(active)setRows(all?d.groups||[]:d.facts?[d.facts]:[]);}).catch(()=>{if(active)setRows([])});return()=>{active=false};},[all,project?.id,project?.revision,project?.projectType,(project?.arrangement?.members||[]).join(",")]);
  return rows.map((f,i)=><p className="scope-note" key={i}>{f.memberIds.map(id=>memberName(members,id)).join(" + ")} · {f.samples}轮 · 有据纠错 {f.corrections} · 独立互证 {f.independent}（样本{f.samples}轮，{f.projectType||"本项目"}）</p>);
}

export function ResultFilters({projects,value,onChange}) {
  const patch=x=>onChange({...value,...x});
  return <div className="result-filters">
    <label>所属项目<select aria-label="成果项目" value={value.projectId} onChange={e=>patch({projectId:e.target.value})}><option value="">全部项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>成果状态<select aria-label="成果状态" value={value.status} onChange={e=>patch({status:e.target.value})}>{[["all","全部状态"],["pending","待审阅"],["adopted","已采用"],["discarded","已弃用"],["partially_met","部分达标"]].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    <label>起始日期<Input type="date" aria-label="成果起始日期" value={value.from} onChange={e=>patch({from:e.target.value})}/></label>
    <label>结束日期<Input type="date" aria-label="成果结束日期" value={value.to} onChange={e=>patch({to:e.target.value})}/></label>
    <Button variant="ghost" onClick={()=>onChange({projectId:"",status:"all",from:"",to:""})}>清除筛选</Button>
  </div>;
}

export function RuleNote({rule,project,members,onAction,busy}) {
  const [scope,setScope]=useState("project"),[editing,setEditing]=useState(false),[body,setBody]=useState(rule.body),[baseRevision,setBaseRevision]=useState(rule.revision);
  const call=fn=>onAction(fn).catch(()=>{});
  return <aside className="rule-note" aria-label="改稿偏好便签">
    <small>{memberName(members,rule.author)} 从你的修改里总结</small>
    <p>{rule.body.length>40?rule.body.slice(0,40)+"…":rule.body}</p>
    {rule.body.length>40&&<details><summary>规则全文</summary><p>{rule.body}</p></details>}
    <RuleScope value={scope} onChange={setScope} project={project}/>
    {editing&&<div className="grid gap-2 mt-3"><Textarea aria-label="修改规则措辞" value={body} onChange={e=>setBody(e.target.value)}/><Button disabled={busy||!body.trim()} size="sm" onClick={()=>call(async()=>{await command("knowledge.write",{projectId:rule.scopeId,knowledgeId:rule.id,revision:baseRevision,title:rule.title,body,scopeMode:scope,approved:false});setEditing(false);})}>保存措辞</Button></div>}
    <div className="flex gap-2 flex-wrap mt-3">
      <Button disabled={busy} size="sm" onClick={()=>call(()=>command("knowledge.review",{knowledgeId:rule.id,revision:rule.revision,status:"approved",scopeMode:scope}))}>以后都这样</Button>
      <Button disabled={busy} variant="outline" size="sm" onClick={()=>call(()=>command("knowledge.review",{knowledgeId:rule.id,revision:rule.revision,status:"rejected"}))}>只这次</Button>
      <Button disabled={busy} variant="ghost" size="sm" onClick={()=>{setBody(rule.body);setBaseRevision(rule.revision);setEditing(!editing)}}>改措辞</Button>
    </div>
  </aside>;
}

export function RuleNotice({notice,rule,onAction,onEdit,busy}) {
  const call=(action)=>onAction(()=>command("rule.notice.resolve",{noticeId:notice.id,action,ruleRevision:rule?.revision})).catch(()=>{});
  return <aside className="rule-note warning" aria-label="规则提醒">
    <strong>{notice.type==="drift"?`“${rule?.title||"这条规则"}”好像没有起作用，要改一下吗？`:`成员说明本次要求与规则“${rule?.title||"已携带规则"}”冲突，已按本次要求执行。`}</strong>
    <p>{notice.reason}</p>
    <div className="flex gap-2 flex-wrap">
      {notice.type==="drift"&&<Button disabled={busy||!rule} size="sm" variant="outline" onClick={()=>onEdit(rule,notice)}>改措辞</Button>}
      <Button disabled={busy||!rule} size="sm" variant="ghost" onClick={()=>call(notice.type==="drift"?"revoke":"keep")}>{notice.type==="drift"?"删除这条":"保留原规则"}</Button>
      {notice.type==="conflict"&&<Button disabled={busy} size="sm" onClick={()=>onEdit(null,notice)}>为这类情况另建规则</Button>}
    </div>
  </aside>;
}
