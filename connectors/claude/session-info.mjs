import {getSessionInfo} from '@anthropic-ai/claude-agent-sdk';

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
