import assert from 'node:assert/strict';import os from 'node:os';import path from 'node:path';import fs from 'node:fs/promises';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-setup-regression-'));process.env.AGENT_HUB_DATA_DIR=dir;const {start}=await import('../local/server.mjs');const instance=await start({port:0,config:{endpoint:'http://127.0.0.1:8789',adminKey:'local-protocol-test',runnerId:'setup-regression',port:0}});
const call=async(p,b)=>{const r=await fetch(instance.url+'/api/'+p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});const d=await r.json();assert.ok(r.ok,d.message);return d;};
const tool=async(name,args,token)=>{const r=await fetch('http://127.0.0.1:8789/tools/'+name,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});const d=await r.json();assert.ok(r.ok,d.message);return d;};
try{
 const a=(await call('action',{type:'account.create',payload:{platformId:'gemini',label:'重复打开设置回归测试'}})).result;
 const m=(await call('action',{type:'member.create',payload:{accountId:a.id,name:'协议回归成员',mode:'connector'}})).result;
 const setup=await call('member/setup',{memberId:m.id});let s=await call('state');const challenge=s.members.find(x=>x.id===m.id).challenge;
 await tool('hello',{},setup.token);await tool('read_profile',{},setup.token);await tool('write_note',{title:'连接验证/'+m.id,body:challenge,mode:'replace'},setup.token);await call('member/verify',{memberId:m.id});
 assert.equal((await call('state')).members.find(x=>x.id===m.id).status,'ready');
 const reopened=await call('member/setup',{memberId:m.id});s=await call('state');
 assert.equal(s.members.find(x=>x.id===m.id).status,'ready','查看已连接成员的设置，不得撤销其已验证状态');
 assert.equal(reopened.verified,true);await call('member/verify',{memberId:m.id});
 const rotated=await call('member/setup',{memberId:m.id,rotate:true});assert.notEqual(rotated.token,setup.token);
 s=await call('state');assert.equal(s.members.find(x=>x.id===m.id).status,'unverified');assert.notEqual(s.members.find(x=>x.id===m.id).challenge,challenge);
 const stale=await fetch(instance.url+'/api/member/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:m.id})});assert.ok(!stale.ok,'轮换凭证后，旧回执不能被再次使用');
 const report={at:new Date().toISOString(),checks:['reopening setup preserves verified readiness','repeated verification is harmless','explicit credential rotation revokes old readiness','old proof cannot verify rotated credential'],realCommercialAgentTested:false};await fs.writeFile('evidence/setup-stability.json',JSON.stringify(report,null,2));console.log('Setup stability regression passed');
}finally{await instance.close();await fs.rm(dir,{recursive:true,force:true});}
