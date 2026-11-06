const coding=new Set(['codex','gemini-cli','antigravity','deepseek-harness','claude-code']);
// Absence of Hub work is not proof that the native environment is idle.
export function memberAvailability(member,connection,native,channelId,turns=[]){
 const active=turns.find(t=>t.memberId===member.id&&t.scopeId===channelId&&t.status==='active');
 const pending=turns.filter(t=>t.memberId===member.id&&t.scopeId===channelId&&t.status==='ready');
 const bound=native?.assignments?.find(b=>b.channelId===channelId);
 if(coding.has(member.platformId)&&!native)return {state:'unknown',label:'状态待更新',detail:'正在读取原运行端的连接与对话信息。'};
 if(coding.has(member.platformId)&&channelId&&!bound)return {state:'unbound',label:'待选择对话',detail:'账号连接与当前聊天的工作对话分开选择。'};
 if(active)return {state:'working',label:processingLabel(active),detail:active.progress||'已领取本聊天的消息，正在处理；不代表正在生成回复文字。'};
 if(pending.length)return {state:'waiting',label:'等待回复',detail:`本聊天有 ${pending.length} 条消息等待处理，可在消息进度中查看原文。`};
 if(coding.has(member.platformId)){
  if(!native?.enabled)return {state:'offline',label:'暂未连接',detail:'原环境未报告可用连接。登录与原对话保留。'};
  if(['disconnected','waiting_login','offline'].includes(native.status))return {state:'offline',label:'需要连接',detail:native.message||'请在原环境恢复连接。'};
  if(bound?.pendingStepId&&!turns.some(t=>t.id===bound.pendingStepId&&['done','silent','stalled','merged','removed'].includes(t.status)))return {state:bound.workState==='working'?'working':'waiting',label:bound.workState==='working'?'处理中':'等待原对话',detail:bound.workMessage||'消息已保存，原工作继续。'};
  const observed=Date.now()-Date.parse(bound?.observedAt||0)<30000?bound?.nativeState:null;
  if(observed==='idle')return {state:'idle',label:'空闲',detail:'原运行端已报告当前对话空闲。'};
  if(observed==='running')return {state:'working',label:'运行中',detail:'当前绑定的原对话正在工作。'};
  if(['disconnected','waiting_login'].includes(native.status))return {state:'offline',label:'需要连接',detail:native.message||'请在原环境恢复连接。'};
  return {state:'connected',label:'已连接',detail:'连接可用；原对话是否正在执行其他工作尚未提供。'};
 }
 if(connection?.status==='verified')return {state:'connected',label:'已连接',detail:'已完成真实回复验证；当前原生工作状态未提供。'};
 return {state:'offline',label:'待连接',detail:'尚未完成原生回复验证。'};
}
import {processingLabel} from './chat-activity.mjs';
