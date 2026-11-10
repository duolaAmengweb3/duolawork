import {getSessionInfo} from '@anthropic-ai/claude-agent-sdk';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

// Used only for a durable deferred Stop. Query native process metadata for this
// project, never transcripts. Idle/done means the native main loop can continue;
// it does not mean background business work succeeded or produced a receipt.
export async function nativeExecutionState(session,{binary,run=execute}={}){
 if(!binary||!session.pid||!session.workspace)return 'unknown';
 try{
  const {stdout}=await run(binary,['agents','--all','--json','--cwd',session.workspace],{timeout:5000,maxBuffer:1000000});
  const row=JSON.parse(stdout).find(r=>r.sessionId===session.sessionId&&r.pid===session.pid&&r.cwd===session.workspace);
  return row?.status==='idle'&&row.state==='done'?'ended':'unknown';
 }catch{return 'unknown';}
}

// Runs beside the user's original Claude, never on the Hub computer on its behalf.
// Request only this registered session's metadata; do not enumerate other projects.
export async function refreshSessionInfo(session,{readInfo=getSessionInfo}={}){
 if(!session.sessionId||!session.workspace)return session;
 try{
  const info=await readInfo(session.sessionId,{dir:session.workspace});
  if(!info||info.sessionId!==session.sessionId)return session;
  return{...session,title:(info.customTitle||info.summary||session.title||'未命名对话').slice(0,200)};
 }catch{return session;}
}
