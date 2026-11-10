import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {CodingMemberClient} from '../../local/coding-client.mjs';
import {privateJson} from '../../local/storage.mjs';
import {CodexWorkingHost} from '../../local/codex-working-host.mjs';
import {AntigravityDesktopHost} from '../../local/antigravity-host.mjs';
import {AntigravityCliHost,attachCurrentCli} from '../../local/antigravity-cli-bridge.mjs';
import {DshOriginalHost,originalDshContext} from '../../local/dsh-original-host.mjs';
import {DshDesktopHost} from '../../local/dsh-desktop.mjs';
import {safeError} from '../../local/native-agent.mjs';
import {installService} from './cli.mjs';

const read=file=>fs.readFile(file,'utf8').then(JSON.parse),entry=fileURLToPath(import.meta.url);
export async function linkLocation(input){
 if(!/^member_[a-zA-Z0-9_-]+$/.test(input.memberId||''))throw Error('成员编号无效');
 if(input.executor==='runtime'){
  const base=path.join(process.env.DUOLAWORK_RUNTIME_DIR||path.join(os.homedir(),'.config/duolawork-runtime'),input.memberId),config=await read(path.join(base,'runtime.json'));
  if(config.memberId!==input.memberId||config.endpoint!==input.endpoint||config.form!==input.form)throw Error('这不是此账号已连接的原环境，请把说明发给正确的 Agent');
  return{base,grantFile:path.join(base,'grant.json'),runtimeId:config.runtimeId};
 }
 const {dataDir,file}=input.locator||{};
 if(!path.isAbsolute(dataDir||'')||!['native-coding.json','dsh-members.json','antigravity-desktop-members.json'].includes(file))throw Error('原环境连接信息无效');
 const r=(await read(path.join(dataDir,file)))[input.memberId];if(!r?.enabled||!r.grantFile)throw Error('这个账号在当前电脑尚未连接，请把说明发给正确的 Agent');
 return{base:dataDir,grantFile:r.grantFile};
}
export async function currentNativeSession(input,location,{env=process.env}={}){
 let id,host;
 if(input.form==='codex'){id=env.CODEX_THREAD_ID;host=new CodexWorkingHost();}
 else if(input.form==='antigravity-cli'){
  const a=await attachCurrentCli(location.base,{env});if(!a.attached)throw Error('请在原 Antigravity CLI 对话中执行这段说明');id=a.sessionId;host=new AntigravityCliHost(location.base);
 }else if(input.form==='antigravity-desktop'){
  id=env.ANTIGRAVITY_CONVERSATION_ID;if(path.basename(env.ANTIGRAVITY_APP_DATA_DIR||'')==='antigravity-cli')throw Error('这是 CLI，对应账号连接的是桌面版');host=new AntigravityDesktopHost(location.base);
 }else if(['deepseek-harness','deepseek-desktop'].includes(input.form)){
  const context=await originalDshContext(env);id=context.sessionId;host=input.form==='deepseek-desktop'?new DshDesktopHost(location.base):new DshOriginalHost(location.base);
  const original=await host.discover();if(await fs.realpath(original.profile)!==context.profile)throw Error('这个 Harness 对话不属于已连接的原环境');
 }else throw Error('这个形态尚未适配从当前对话关联');
 if(!id)throw Error('没有取得当前原生对话身份，请让原 Agent 自己用终端工具执行，不要另开系统终端');
 const s=(await host.sessions()).items.find(s=>s.id===id);if(!s?.workspace)throw Error('原生运行端未确认当前对话，未猜测或新建替代对话');
 return{id:s.id,title:s.title,workspace:s.workspace};
}
async function validatedClient(input,location){const c=new CodingMemberClient(location.grantFile),g=await c.credentials();if(g.memberId!==input.memberId||g.endpoint!==input.endpoint)throw Error('连接授权与这份说明不匹配');return c;}
export async function redeemLink(input){
 const location=await linkLocation(input),session=await currentNativeSession(input,location),client=await validatedClient(input,location);
 const file=path.join(location.base,'session-links',input.id+'.json');if(!/^sessionlink_[a-zA-Z0-9]+$/.test(input.id||''))throw Error('关联编号无效');
 const {code,...metadata}=input;await privateJson(file,{...metadata,session,grantFile:location.grantFile,base:location.base});
 const result=await client.api('/v2/self/session-links',{method:'POST',body:{action:'redeem',id:input.id,code:input.code,runtimeId:location.runtimeId,session,requestId:'link-redeem-'+createHash('sha256').update(input.id+session.id).digest('hex')}});
 if(input.executor==='runtime')await installService(input.memberId,location.base);
 return{stage:result.status,message:'已识别当前原对话。请结束本轮，DuolaWork 会自动发来关联确认，无需重新登录或重复添加账号。'};
}
export async function confirmLink(file,challenge){
 const input=await read(file),location=await linkLocation(input),session=await currentNativeSession(input,location),client=await validatedClient(input,location);
 if(session.id!==input.session.id||session.workspace!==input.session.workspace)throw Error('当前不是等待确认的原对话');
 await client.api('/v2/self/session-links',{method:'POST',body:{action:'confirm',id:input.id,challenge,sessionId:session.id,requestId:'link-confirm-'+input.id}});
 return{message:'原对话已确认，DuolaWork 将自动完成关联。'};
}
if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>'')===entry){(async()=>{let result;if(process.argv[2]==='--confirm')result=await confirmLink(process.argv[3],process.argv[4]);else{let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>12000)throw Error('说明过长');}result=await redeemLink(JSON.parse(raw));}console.log(JSON.stringify(result));})().catch(e=>{console.error('DuolaWork: '+safeError(e));process.exitCode=1;});}
