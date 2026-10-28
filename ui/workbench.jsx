import React,{useEffect,useRef,useState,lazy,Suspense} from 'react';
import {ArrowUp,ArrowRight,Plus,MessageSquare,Check,Clock,FileText,Copy,ChevronDown,ExternalLink,AlertCircle,Paperclip,BookOpen,History,Search,Download,Sparkles,X} from 'lucide-react';
import {parseWorkPlan} from '../shared/workspace.mjs';
import {STATUS_LABELS} from '../shared/platforms.mjs';
import {downloadDocument} from './studio-download.mjs';
const DocumentPane=lazy(()=>import('./document.jsx'));
import {AgentMark,PlanEditor,EmptyDocument,Sources,Execution,time,phase} from './studio-panels.jsx';
import './workbench.css';
const examples=[['找资料，带出处','找 3 个值得参考的 AI 实操案例，附上原始来源，说明我可以学什么。'],['比较产品，给结论','对比我提供的几个产品，整理适用场景、区别和推荐理由。'],['先商量执行方案','先帮我拟定一期 AI 工具选题的研究与写作方案。']];
const excerpt=value=>String(value||'').replace(/[#*_>|\x60]/g,'').replace(/\s+/g,' ').trim().slice(0,140);
const label=value=>STATUS_LABELS[value]||value;
export default function Workbench({data,taskId,onSelect,draft,onDraft,busy,onStart,onFollowup,onExecutePlan,onAccounts,onOpenAccount,onDetails,onControl}){
 const task=data.tasks.find(t=>t.id===taskId),members=data.members.filter(m=>m.status!=='disabled'),ready=data.local.memberAvailability||{},runnable=members.filter(m=>ready[m.id]?.canDispatch);
 const memberId=draft.memberId||task?.steps.at(-1)?.memberId||runnable[0]?.id||'';
 const [artifacts,setArtifacts]=useState({}),[readError,setReadError]=useState(''),[error,setError]=useState(''),[reload,setReload]=useState(0),[tab,setTab]=useState('document'),[selectedId,setSelectedId]=useState(null),[copied,setCopied]=useState(false),[documentReady,setDocumentReady]=useState(false),[mobilePane,setMobilePane]=useState('conversation'),[historyOpen,setHistoryOpen]=useState(false),[historySearch,setHistorySearch]=useState('');
 const input=useRef(null),bottom=useRef(null),request=useRef(null),planRequest=useRef(null),documentRef=useRef(null),attachmentInput=useRef(null);
 const key=task?.steps.map(s=>s.artifactId||'').join(',')||'',delivered=task?.steps.filter(s=>s.artifactId)||[],lastDelivered=delivered.at(-1)?.artifactId;
 const selected=delivered.find(s=>s.artifactId===selectedId)||delivered.at(-1),selectedMeta=data.artifacts.find(a=>a.id===selected?.artifactId);
 const platform=id=>data.platforms.find(p=>p.id===members.find(m=>m.id===id)?.platformId);
 const originPlan=task?.originPlanId&&data.tasks.find(t=>t.id===task.originPlanId),originArtifact=originPlan?.steps.at(-1)?.artifactId;
 useEffect(()=>{let canceled=false;setReadError('');const ids=[...(task?.steps.map(s=>s.artifactId).filter(Boolean)||[]),...(originArtifact?[originArtifact]:[])];
  Promise.allSettled(ids.filter(id=>!artifacts[id]).map(async id=>{const r=await fetch('/api/artifacts/'+id),value=await r.json();if(!r.ok)throw new Error(value.message||'成果读取失败');return[id,value];})).then(results=>{if(canceled)return;const values=Object.fromEntries(results.filter(r=>r.status==='fulfilled').map(r=>r.value));if(Object.keys(values).length)setArtifacts(previous=>({...previous,...values}));const failure=results.find(r=>r.status==='rejected');if(failure)setReadError(failure.reason.message);});return()=>{canceled=true;};
 },[taskId,key,originArtifact,reload]);
 useEffect(()=>{setSelectedId(lastDelivered||null);setTab('document');},[taskId,lastDelivered]);
 useEffect(()=>{setDocumentReady(false);},[selected?.artifactId]);
 useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[taskId,key,task?.messages?.length]);
 const requestId=(ref,payload)=>{const signature=JSON.stringify(payload);if(ref.current?.signature!==signature)ref.current={signature,id:'req_'+crypto.randomUUID()};return ref.current.id;};
 const blocked=task&&['canceled','needs_review'].includes(task.status);
 const submit=async event=>{event.preventDefault();if(!draft.goal.trim())return;setError('');try{
  const attachments=(draft.attachments||[]).map(a=>'\n\n【用户提供的文本资料：'+a.name+'】\n'+a.body).join(''),message=draft.goal+attachments;
  if(message.length>(task?8000:6000))throw new Error('文字与资料合计不能超过 '+(task?'8,000':'6,000')+' 字符，请缩减资料后发送。');
  const payload=task?{taskId:task.id,message,memberId}:{goal:message,memberId,mode:draft.mode};
  if(task?.kind!=='plan'&&selected&&documentRef.current){const document=await documentRef.current.flush();payload.documentId=document.artifactId;payload.documentRevision=document.revision;}
  const result=await(task?onFollowup({...payload,requestId:requestId(request,payload)}):onStart({...payload,requestId:requestId(request,payload)}));request.current=null;onDraft({...draft,goal:'',attachments:[],memberId});onSelect(result.id);
 }catch(e){setError(e.message);}};
 const last=task?.steps.at(-1),planBody=last?.artifactId&&artifacts[last.artifactId]?.body;let plan=null,planError='',originSummary='';
 if(task?.kind==='plan'&&task.status==='completed'&&planBody)try{plan=parseWorkPlan(planBody);}catch(e){planError=e.message;}
 if(originArtifact&&artifacts[originArtifact])try{originSummary=parseWorkPlan(artifacts[originArtifact].body).summary;}catch{}
 const execution=task?.kind==='plan'&&data.tasks.find(t=>t.originPlanId===task.id);
 const execute=async(steps,id)=>{if(id){onSelect(id);return;}const payload={planTaskId:task.id,steps},result=await onExecutePlan({...payload,requestId:requestId(planRequest,payload)});planRequest.current=null;onSelect(result.id);};
 const recent=data.tasks.slice().reverse().filter(t=>(t.kind!=='plan'||!data.tasks.some(other=>other.originPlanId===t.id))&&(!historySearch||t.title.toLowerCase().includes(historySearch.toLowerCase()))).slice(0,30);
 const showDocument=id=>{setSelectedId(id);setTab('document');setMobilePane('document');};
 const rewrite=selection=>{onDraft({...draft,goal:selection?'请修改文稿中的这段内容：\n「'+selection.slice(0,3000)+'」\n修改要求：':'请根据右侧这份工作稿继续修改。\n修改要求：'});setMobilePane('conversation');input.current?.focus();};
 const copy=async()=>{try{if(!documentRef.current)throw new Error('请先打开一份完整文稿');await navigator.clipboard.writeText(documentRef.current.body());setCopied(true);setTimeout(()=>setCopied(false),2000);}catch(e){setError(e.message);}};
 const attach=async event=>{try{const items=[];for(const file of event.target.files){if(!/\.(txt|md|csv|json)$/i.test(file.name)||file.size>24000)throw new Error('支持 24KB 以内的 TXT、Markdown、CSV、JSON 文本资料。');items.push({name:file.name,body:await file.text()});}const next=[...(draft.attachments||[]),...items];if(next.length>3)throw new Error('每次最多附 3 份文本资料');if(next.reduce((n,a)=>n+a.body.length,0)+draft.goal.length>(task?8000:6000))throw new Error('所附文本超出本轮输入长度，请缩减资料或提供原文链接。');onDraft({...draft,attachments:next});setError('');}catch(e){setError(e.message);}finally{event.target.value='';}};
 return <section className={'studio studio-show-'+mobilePane} aria-label="对话与成果工作台">
  <div className="studio-mobile-switch"><button onClick={()=>setMobilePane('conversation')} aria-label="查看对话区"><MessageSquare size={15}/>对话</button><button onClick={()=>setMobilePane('document')} aria-label="查看成果区"><FileText size={15}/>成果</button></div>
  <div className="studio-chat">
   <header className="studio-chat-header"><div><MessageSquare size={17}/><h2>团队对话</h2></div><div className="studio-chat-actions"><button aria-label="打开最近工作" title="最近工作" onClick={()=>setHistoryOpen(v=>!v)}><History size={17}/></button><button aria-label="新工作" title="新工作" onClick={()=>{onSelect(null);setHistoryOpen(false);setError('');}}><Plus size={18}/></button></div>
    {historyOpen&&<div className="studio-history"><label><Search size={14}/><input autoFocus placeholder="搜索工作…" aria-label="搜索最近工作" value={historySearch} onChange={e=>setHistorySearch(e.target.value)}/><button aria-label="关闭最近工作" onClick={()=>setHistoryOpen(false)}><X size={14}/></button></label>{recent.length?recent.map(t=><button key={t.id} onClick={()=>{onSelect(t.id);setHistoryOpen(false);setError('');}}><FileText size={15}/><span>{t.title}<small>{label(t.status)} · {time(t.updatedAt)}</small></span>{t.id===taskId&&<Check size={14}/>}</button>):<p>没有匹配的工作</p>}</div>}
   </header>
   <div className="studio-chat-log" role="log" aria-label="任务对话" aria-live="polite">
    {!task?<div className="studio-welcome"><span className="studio-welcome-icon"><Sparkles size={23}/></span><span className="studio-eyebrow">LET'S MAKE SOMETHING</span><h1>把想做的事，<br/>交给你的 Agent。</h1><p>在这里说要求，右侧收成果。<br/>需要调整，就接着聊。</p><div className="studio-examples">{examples.map(([title,goal],i)=><button key={title} onClick={()=>{onDraft({...draft,goal,mode:i===2?'plan':'execute'});input.current?.focus();}}><span>{title}</span><ArrowRight size={14}/></button>)}</div><div className="studio-availability"><div>{members.map(m=><span key={m.id} title={m.name+' · '+(ready[m.id]?.canDispatch?'可以接任务':ready[m.id]?.reason)}><AgentMark platform={platform(m.id)}/><i className={ready[m.id]?.canDispatch?'ready':''}/></span>)}</div><span>{runnable.length?runnable.length+' 位成员可以接任务':'先连接一位成员，再开始工作'}<button onClick={onAccounts}>管理成员 <ArrowRight size={11}/></button></span></div></div>:
    <><div className="studio-work-topic"><span>这次工作</span><h3 title={task.title}>{task.title}</h3></div>{originSummary&&<div className="studio-plan-note"><Check size={13}/><span>按已确认方案执行：{originSummary}</span><button onClick={()=>onSelect(originPlan.id)}>查看方案</button></div>}
     {task.steps.map((step,index)=>{const author=members.find(m=>m.id===step.memberId),output=artifacts[step.artifactId],meta=data.artifacts.find(a=>a.id===step.artifactId),messages=task.messages?.filter(m=>m.stepId===step.id)||[];
      return <React.Fragment key={step.id}>{index===0&&!messages.length&&<UserMessage body={task.goal} at={task.createdAt}/>}{messages.map(message=><UserMessage key={message.id} body={message.body} at={message.at}/>)}
       <div className="studio-message agent"><div className="studio-message-who"><AgentMark platform={platform(step.memberId)}/><strong>{author?.name||'原成员'}</strong><time>{time(meta?.createdAt||step.attempts.at(-1)?.dispatchedAt)}</time></div>
        {output?<>{task.kind==='plan'?<div className="studio-agent-text">{plan?.summary||excerpt(output.body)}{plan?.questions.length>0&&<p>还需要你补充，请看右侧问题，直接在这里回答。</p>}</div>:<div className="studio-agent-text">已交付「{step.title}」。完整内容在右侧，可以直接修改。<p className="studio-excerpt">{excerpt(output.body)}</p></div>}<button className={'studio-result-card '+(selected?.artifactId===step.artifactId?'selected':'')} onClick={()=>showDocument(step.artifactId)}><span className="studio-result-icon"><FileText size={19}/></span><span><strong>{task.kind==='plan'?'执行方案':step.title}</strong><small>{task.kind==='plan'?'查看与调整方案':output.body.length.toLocaleString()+' 字符 · '+(meta?.sources?.length||0)+' 个来源'}</small></span><ArrowRight size={15}/></button></>:
         <div className={'studio-run-state '+step.status}><span className={step.status==='running'?'studio-saving-dot':''}>{step.status==='running'?null:<Clock size={13}/>}</span><div><strong>{step.title}</strong><p>{phase(step)}</p>{step.attempts.at(-1)?.status==='platform_approval'&&<button className="studio-text-button" onClick={()=>onOpenAccount(step.accountId)}>在原平台处理批准 <ExternalLink size={12}/></button>}</div></div>}
       </div>
      </React.Fragment>;})}
     {task.status==='completed'&&<div className="studio-chat-complete"><Check size={12}/>{task.kind==='plan'?'方案已返回，确认后开始执行。':'本轮已交付，继续说你想怎么改。'}</div>}
    </>}
    {readError&&<div className="studio-error" role="alert">{readError}<button onClick={()=>setReload(v=>v+1)}>重新读取成果</button></div>}<div ref={bottom}/>
   </div>
   <form className="studio-composer" onSubmit={submit}>
    <div className="studio-compose-settings"><label>交给 <select aria-label="选择接收成员" value={memberId} onChange={e=>onDraft({...draft,memberId:e.target.value})}>{!members.length&&<option value="">还没有成员</option>}{members.map(m=><option key={m.id} value={m.id} disabled={!ready[m.id]?.canDispatch}>{m.name}{!ready[m.id]?.canDispatch?' · 尚未接通':''}</option>)}</select><ChevronDown size={12}/></label>{!task&&<label className="studio-plan-mode"><input type="checkbox" aria-label="先给我方案" checked={draft.mode==='plan'} onChange={e=>onDraft({...draft,mode:e.target.checked?'plan':'execute'})}/>先给我方案</label>}</div>
    <textarea ref={input} aria-label={task?'补充要求':'你想让团队做什么'} maxLength={task?8000:6000} rows={3} placeholder={task?'继续提要求，或告诉我怎么改…':'交代目标、贴上链接，让 Agent 开始工作…'} value={draft.goal} onChange={e=>onDraft({...draft,goal:e.target.value})}/>
    {draft.attachments?.length>0&&<div className="studio-attached">{draft.attachments.map((a,i)=><span key={i}><FileText size={12}/>{a.name}<button type="button" aria-label={'移除资料 '+a.name} onClick={()=>onDraft({...draft,attachments:draft.attachments.filter((_,j)=>j!==i)})}><X size={11}/></button></span>)}</div>}
    {task?.kind!=='plan'&&selected&&<div className="studio-context-chip"><FileText size={11}/>会附上右侧选中的工作稿</div>}
    {error&&<p role="alert" className="studio-error">{error}</p>}
    <div className="studio-compose-bottom"><div><input ref={attachmentInput} type="file" accept=".txt,.md,.csv,.json" multiple hidden onChange={attach}/><button type="button" title="添加文本资料（TXT / Markdown / CSV / JSON）" aria-label="添加文本资料" onClick={()=>attachmentInput.current?.click()}><Paperclip size={17}/></button><span>{blocked?'上一轮需要先处理':!ready[memberId]?.canDispatch?'需要先接通一位成员':task&&task.status!=='completed'?'补充会排在当前步骤之后':'原 Agent 执行，成果自动返回'}</span></div><button className="studio-send" type="submit" aria-label={task?'发送补充要求':draft.mode==='plan'?'请成员拟定方案':'交给成员执行'} disabled={busy||!draft.goal.trim()||!ready[memberId]?.canDispatch||blocked}>{busy?<span className="studio-saving-dot"/>:<ArrowUp size={19}/>}</button></div>
    {!runnable.length&&<button type="button" className="studio-text-button" onClick={onAccounts}>去连接账号 <ArrowRight size={12}/></button>}
   </form>
  </div>
  <div className="studio-workspace">
   <header className="studio-workspace-header"><div role="tablist" aria-label="成果空间">{[['document','文稿',FileText],['sources','素材',BookOpen],['execution','执行记录',History]].map(([id,text,Icon])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)} className={tab===id?'selected':''}><Icon size={15}/>{text}</button>)}</div><div className="studio-document-actions"><button aria-label="复制文稿" disabled={!documentReady||!selected||task?.kind==='plan'||tab!=='document'} onClick={copy}><Copy size={14}/><span>{copied?'已复制':'复制'}</span></button><button className="studio-export" aria-label="导出文稿" disabled={!documentReady||!selected||task?.kind==='plan'||tab!=='document'} onClick={()=>documentRef.current&&downloadDocument(documentRef.current.body(),selected?.title||task?.title)}><Download size={14}/><span>导出</span></button></div></header>
   <div hidden={tab!=='document'} className="studio-tab-content" role="tabpanel" aria-label="文稿">
    {plan?<PlanEditor key={last.artifactId} plan={plan} data={data} busy={busy} onExecute={execute} execution={execution}/>:planError?<div className="studio-load-error" role="alert"><AlertCircle size={23}/><h2>方案需要完善</h2><p>{planError}</p><p>请在左侧要求成员补充完整方案。</p></div>:selected&&task?.kind!=='plan'?<><div className="studio-document-meta"><label><FileText size={13}/>{delivered.length>1?<select aria-label="选择成果文稿" value={selected.artifactId} onChange={e=>setSelectedId(e.target.value)}>{delivered.map((step,i)=><option key={step.artifactId} value={step.artifactId}>{i+1}. {step.title}</option>)}</select>:<span>{selected.title}</span>}</label><span>{members.find(m=>m.id===selected.memberId)?.name} 的交付 · {time(selectedMeta?.createdAt)}</span></div><Suspense fallback={<div className="studio-load-error">正在打开文稿…</div>}><DocumentPane ref={documentRef} key={selected.artifactId} artifactId={selected.artifactId} onRewrite={rewrite} onReady={setDocumentReady}/></Suspense></>:<EmptyDocument task={task} onActivity={()=>setTab('execution')}/>}
   </div>{tab==='sources'&&<Sources task={task} data={data} onDocument={showDocument}/>} {tab==='execution'&&<Execution task={task} data={data} onDocument={showDocument} onDetails={onDetails} onControl={onControl} onOpenAccount={onOpenAccount}/>}
  </div>
 </section>;
}
function UserMessage({body,at}){return <div className="studio-message user"><div className="studio-message-who"><span className="studio-you">我</span><strong>我</strong><time>{time(at)}</time></div><div className="studio-user-body">{body}</div></div>;}
