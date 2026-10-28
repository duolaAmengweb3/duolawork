import {hasVerifiedTools} from './platforms.mjs';

const text=(value,label,max=10000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}不能为空且不能超过 ${max} 字符`);return value.trim();};
export function requestKey(value){if(typeof value!=='string'||!/^req_[a-z0-9-]{12,80}$/.test(value))throw new Error('请求编号无效，请重新提交');return value;}
export function availableMember(state,id,availability){
 const member=state.members.find(m=>m.id===id),account=state.accounts.find(a=>a.id===member?.accountId);
 if(!member||member.paused||!hasVerifiedTools(member)||account?.status!=='connected')throw new Error('这个成员尚未接通任务，不能派发。请选择已就绪的成员。');
 if(availability&&!availability[id]?.canDispatch)throw new Error(availability[id]?.reason||'这个成员的自动任务接入尚未完成');
 return member;
}
export function automaticAvailability(state,{supports,credentials={},locked=false}={}){
 return Object.fromEntries(state.members.filter(m=>m.status!=='disabled').map(m=>{
  const a=state.accounts.find(a=>a.id===m.accountId);let reason='';
  if(m.paused)reason='成员已暂停';
  else if(!hasVerifiedTools(m)||a?.status!=='connected')reason='任务接入尚未完成';
  else if(supports?.(a,m))return[m.id,{canDispatch:true,reason:''}];
  else if(!['webhook','workspace-api'].includes(m.mode))reason='自动派发尚未验证';
  else if(locked)reason='原有工具凭证需要解锁';
  else if(!credentials[m.id]?.triggerUrl||!credentials[m.id]?.triggerToken)reason='官方任务入口尚未接通';
  return[m.id,{canDispatch:!reason,reason}];
 }));
}
export function planPrompt(state,goal,availability){
 const team=state.members.filter(m=>availability?.[m.id]?.canDispatch).map(m=>({memberId:m.id,name:m.name,platform:m.platformId}));
 return ['只为下面的目标拟定可执行方案，本轮不要执行最终任务，不发布、不发送消息、不花钱、不改设置。',
  '用户目标：'+goal,'可安排的真实成员：'+JSON.stringify(team),
  '请根据实际可用成员安排必要步骤；可以只用一名成员，不捏造其他成员或能力。缺少关键资料时提出具体问题。',
  '成果正文必须是一个有效 JSON 对象，不能套成字符串，结构如下：',
  JSON.stringify({summary:'你对目标与交付物的理解',questions:[],steps:[{memberId:team[0]?.memberId||'',title:'具体工作',instruction:'能直接执行的要求与交付物',requireSources:false}]}),
  'questions 是确有必要由用户补充的问题，没有则为空数组；steps 为 1 到 8 步。memberId 必须原样使用上面的成员编号。用户会先看到方案，确认执行后工作台才派发。',
 ].join('\n');
}
export function parseWorkPlan(body){
 const raw=String(body||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
 try{value=JSON.parse(raw);}catch{throw new Error('成员没有交回有效方案；可以在下方要求它补充或重写。');}
 if(!value||Array.isArray(value)||typeof value.summary!=='string'||!value.summary.trim()||!Array.isArray(value.questions)||value.questions.length>8||value.questions.some(q=>typeof q!=='string'||!q.trim()||q.length>1000)||!Array.isArray(value.steps)||value.steps.length>8||(!value.steps.length&&!value.questions.length))throw new Error('方案内容不完整，请补充要求让成员完善。');
 return{summary:value.summary.trim(),questions:value.questions.map(q=>q.trim()),steps:value.steps.map(s=>({memberId:text(s.memberId,'成员编号',100),title:text(s.title,'步骤名称',160),instruction:text(s.instruction,'步骤要求',8000),requireSources:s.requireSources===true,minLength:20,requiresApproval:s.requiresApproval===true,outputType:'text'}))};
}
export function workspaceStart(state,input,availability){
 const goal=text(input.goal,'你的目标',6000),member=availableMember(state,input.memberId,availability),kind=input.mode==='plan'?'plan':'work';
 return{type:'task.create',payload:{title:goal.replace(/\s+/g,' ').slice(0,70),goal,kind,clientRequestId:requestKey(input.requestId),source:'workspace',steps:[{memberId:member.id,title:kind==='plan'?'拟定执行方案':'完成你的目标',instruction:kind==='plan'?planPrompt(state,goal,availability):goal,minLength:20,requireSources:input.requireSources===true,outputType:kind==='plan'?'json':'text'}]}};
}
export function workspaceFollowup(state,input,availability){
 const task=state.tasks.find(t=>t.id===input.taskId);if(!task)throw new Error('未找到这次对话');
 if(['canceled','needs_review'].includes(task.status))throw new Error('上一轮需要先核对或重做，请查看右侧的处理入口；你的补充仍保留在输入框。');
 const message=text(input.message,'补充要求',8000),member=availableMember(state,input.memberId,availability);
 return{type:'task.followup',taskId:task.id,payload:{memberId:member.id,message,clientRequestId:requestKey(input.requestId),instruction:task.kind==='plan'?planPrompt(state,task.goal,availability)+'\n用户本轮补充：'+message:message,outputType:task.kind==='plan'?'json':'text'}};
}
export function workspaceExecute(state,input,body,availability){
 const task=state.tasks.find(t=>t.id===input.planTaskId);
 if(!task||task.kind!=='plan'||task.status!=='completed')throw new Error('请等待方案完成后再执行');
 const original=parseWorkPlan(body);if(original.questions.length)throw new Error('方案还有待补充的问题，请先在会话里回答');
 if(!Array.isArray(input.steps)||input.steps.length<1||input.steps.length>8)throw new Error('执行方案需要 1 到 8 个步骤');
 const steps=input.steps.map(s=>({memberId:availableMember(state,s.memberId,availability).id,title:text(s.title,'步骤名称',160),instruction:text(s.instruction,'步骤要求',8000),minLength:20,requireSources:s.requireSources===true,requiresApproval:s.requiresApproval===true,outputType:'text'}));
 return{type:'task.create',payload:{title:task.title,goal:task.goal,kind:'work',originPlanId:task.id,clientRequestId:requestKey(input.requestId),source:'workspace',steps}};
}
