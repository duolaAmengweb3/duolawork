import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateJson} from './storage.mjs';
import {findExecutable} from './native-agent.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

// A challenge has no project permissions or work to perform. The original
// native model must receive it through its actual queue and confirm from the
// same native tool environment before the old chat binding can be changed.
export async function queueSessionLink(manager,link,base){
 const journal=path.join(base,'session-links',link.id+'.dispatch.json');
 let old;try{old=JSON.parse(await fs.readFile(journal,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(old){
  // Unknown delivery never causes a duplicate native operation. Nor should a
  // lost confirmation leave the user's dialog spinning forever after restart.
  if(Date.now()-Date.parse(old.at)>30*60000)throw Error('未收到原对话确认，原来的关联保留。请确认原 Agent 已结束当前工作后重新复制说明。');
  return;
 }
 const r=manager.records[link.memberId];if(!r?.enabled)throw Error('原账号连接已解除');
 const host=manager.workingHostFor?manager.workingHostFor(r):manager.hostFor(link.memberId);
 const s=(await host.sessions()).items.find(s=>s.id===link.session.id);
 if(!s||path.resolve(s.workspace)!==path.resolve(link.session.workspace))throw Error('原对话暂未打开，未新建替代对话');
 const helper=path.join(here,'../connectors/runtime/session-link.mjs'),file=path.join(base,'session-links',link.id+'.json');
 await fs.access(file);
 const node=process.versions.electron?await findExecutable('node'):process.execPath;
 if(!node)throw Error('原环境需要 Node.js 才能确认对话，请保留原关联并安装 Node.js 22 或以上');
 const command=[node,helper,'--confirm',file,link.challenge].map(quote).join(' ');
 const prompt='DuolaWork 原对话关联确认 '+link.id+'。用户刚刚在本对话执行了关联说明。现在请使用本对话的终端工具原样运行一次：'+command+'。它只确认本对话与用户指定聊天的关联，不读写项目文件，不改登录、模型或已有任务。执行成功后结束本轮。失败如实报告，不循环重试。';
 await privateJson(journal,{status:'sending',sessionId:s.id,command,at:new Date().toISOString()});
 const stopWatching=await host.watch?.({sessionId:s.id,exactPrompt:prompt,onApproval:a=>manager.approve(r,a)});
 try{
  if(host.queue)await host.queue({sessionId:s.id,workspace:s.workspace,prompt});
  else await host.call('/session-link/prompt',{sessionId:s.id,workspace:s.workspace,prompt,requestId:link.id});
  await privateJson(journal,{status:'sent',sessionId:s.id,command,at:new Date().toISOString()});
  if(stopWatching){const end=Date.now()+180000;while(Date.now()<end){const state=await manager.client(r).api('/v2/self/session-links?id='+link.id);if(state.status!=='confirming')break;await new Promise(r=>setTimeout(r,1000));}}
 }catch(e){await privateJson(journal,{status:'uncertain',sessionId:s.id,command,at:new Date().toISOString()});throw e;}finally{await stopWatching?.();}
}
