import fs from 'node:fs/promises';
import path from 'node:path';
import {privateJson} from './storage.mjs';

const file=(base,sessionId)=>{
 if(!/^[a-f0-9-]{36}$/i.test(sessionId||''))throw Error('无效的原生对话');
 return path.join(base,'native-completion',sessionId+'.json');
};
export async function recordNativeCompletion(base,{memberId,sessionId,stepId,fullyIdle,terminationReason}){
 const target=file(base,sessionId);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
 await privateJson(target,{memberId,sessionId,stepId,fullyIdle:fullyIdle===true,terminationReason:String(terminationReason||'').slice(0,80),observedAt:new Date().toISOString()});
}
export async function readNativeCompletion(base,memberId,sessionId,stepId){
 try{const value=JSON.parse(await fs.readFile(file(base,sessionId),'utf8'));return value.memberId===memberId&&value.sessionId===sessionId&&value.stepId===stepId?value:null;}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
