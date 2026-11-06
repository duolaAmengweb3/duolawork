import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CodingMemberClient} from './coding-client.mjs';
import {safeError} from './native-agent.mjs';
export async function sessionTool({record,channelId,operation,name,args={},client=new CodingMemberClient(record.grantFile)}) {
  const allowed=w=>w.channelId===channelId||!w.channelId&&record.verificationSessionId===record.chatBindings?.[channelId]?.sessionId;
  if(operation==='list_tools')return{tools:await client.tools()};
  if(operation==='claim_step'||name==='claim_work'){
    const stepId=operation==='claim_step'?name:args.stepId,requestId=args.requestId||createHash('sha256').update(record.memberId+':claim:'+stepId).digest('hex');
    if(stepId?.startsWith('inbox:after:')){
      const sessionId=record.chatBindings?.[channelId]?.sessionId;
      if(!sessionId||args.channelId&&args.channelId!==channelId)throw Error('续接不属于当前工作会话');
      // Virtual continuations are absent from list_work. The server validates
      // the original receipt, fixed channel and binding atomically when claiming.
      return client.tool('claim_work',{requestId,stepId,channelId,expectedSessionId:sessionId});
    }
    const {work}=await client.tool('list_work'),workItem=work.find(w=>w.stepId===stepId&&allowed(w));
    if(!workItem)throw Error('指定工作不属于这个聊天，未领取其他消息');
    const sessionId=record.chatBindings?.[channelId]?.sessionId;
    return client.tool('claim_work',{requestId,stepId,...(workItem.channelId&&sessionId?{channelId,expectedSessionId:sessionId}:{})});
  }
  const result=await client.tool(name,args);if(name==='list_work')result.work=result.work.filter(allowed);return result;
}
if(process.argv[1]?.endsWith('/coding-session-tools.mjs')) {
  try{const [file,memberId,channelId,operation,name,raw]=process.argv.slice(2),records=JSON.parse(await fs.readFile(file)),record=records[memberId];if(!record?.enabled||!record.chatBindings?.[channelId])throw Error('这个工作会话的 Hub 连接已解除');
    console.log(JSON.stringify(await sessionTool({record,channelId,operation,name,args:raw?JSON.parse(raw):{}})));
  }catch(e){console.error(safeError(e));process.exitCode=1;}
}
