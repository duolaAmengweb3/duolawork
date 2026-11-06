// Read-only live connector check in a disposable SQLite workspace. No token is
// persisted to production, printed, or copied into the evidence.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import fs from 'node:fs/promises';import {setGlobalDispatcher} from 'undici';
import {networkDispatcher} from '../local/transport.mjs';import {fixture} from './collaboration-helper.mjs';import {conversationCommand} from '../cloud/collaboration/conversation.mjs';import {connectorSettings,connectorTool} from '../cloud/collaboration/connectors.mjs';
if(!process.argv.includes('--read-only-live'))throw Error('Explicit read-only live check required');setGlobalDispatcher(networkDispatcher());const cleanup=[];const f=await fixture({after:fn=>cleanup.push(fn)});
try{const {stdout}=await promisify(execFile)('gh',['auth','token'],{maxBuffer:16000});const env={ADMIN_KEY:crypto.randomUUID()};
const c=await conversationCommand(f.repo,f.identity,{owner:true},{type:'channel.create',requestId:'group',name:'isolated GitHub connector',memberIds:['grok']});
const connection=await connectorSettings(f.repo,f.identity,{owner:true},{action:'connect',requestId:'connect',token:stdout.trim(),repositories:['duolaAmengweb3/agent-hub'],channelIds:[c.id],memberIds:['grok']},env);
const result=await connectorTool(f.repo,{memberId:'grok'},{channelId:c.id,connectionId:connection.id,action:'repository',repository:'duolaAmengweb3/agent-hub'},env);
if(result.result?.full_name!=='duolaAmengweb3/agent-hub')throw Error('Expected repository metadata');const evidence={at:new Date().toISOString(),scope:'Live GitHub read via isolated connector; no production credential stored',repository:result.result.full_name,actualAccount:connection.account,passed:true};await fs.writeFile('evidence/github-live.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{for(const fn of cleanup)await fn();}
