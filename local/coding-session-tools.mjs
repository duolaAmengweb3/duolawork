import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CodingMemberClient} from './coding-client.mjs';
import {safeError} from './native-agent.mjs';
export async function sessionTool({record,channelId,operation,name,args={}}) {
  const client=new CodingMemberClient(record.grantFile),allowed=w=>w.channelId===channelId||!w.channelId&&record.verificationSessionId===record.chatBindings?.[channelId]?.sessionId;
  if(operation==='list_tools')return{tools:await client.tools()};
  if(operation==='claim_step'||name==='claim_work'){
    const stepId=operation==='claim_step'?name:args.stepId,{work}=await client.tool('list_work');if(!work.some(w=>w.stepId===stepId&&allowed(w)))throw Error('指定工作不属于这个聊天，未领取其他消息');
    return client.tool('claim_work',{requestId:createHash('sha256').update(record.memberId+':claim:'+stepId).digest('hex'),stepId});
  }
  const result=await client.tool(name,args);if(name==='list_work')result.work=result.work.filter(allowed);return result;
}
if(process.argv[1]?.endsWith('/coding-session-tools.mjs')) {
  try{const [file,memberId,channelId,operation,name,raw]=process.argv.slice(2),records=JSON.parse(await fs.readFile(file)),record=records[memberId];if(!record?.enabled||!record.chatBindings?.[channelId])throw Error('这个工作会话的 Hub 连接已解除');
    console.log(JSON.stringify(await sessionTool({record,channelId,operation,name,args:raw?JSON.parse(raw):{}})));
  }catch(e){console.error(safeError(e));process.exitCode=1;}
}
