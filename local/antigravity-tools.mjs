import fs from 'node:fs/promises';
const [file,sessionId,operation,name,args]=process.argv.slice(2);
const state=JSON.parse(await fs.readFile(file,'utf8')),url=new URL(state.controlUrl);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('Invalid Hub local tool endpoint');
const nativeId=process.env.ANTIGRAVITY_CONVERSATION_ID;
if(nativeId&&nativeId!==sessionId)throw Error('Hub tools belong to a different native conversation');
const r=await fetch(new URL('/tool',url),{method:'POST',headers:{Authorization:'Bearer '+state.controlToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId,operation,name,args:args?JSON.parse(args):{}}),redirect:'error',signal:AbortSignal.timeout(45000)});
const result=await r.json();if(!r.ok)throw Error(result.error||'Hub tool failed');console.log(JSON.stringify(result));
