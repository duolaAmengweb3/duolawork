import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MuseTransport,parseMuseResult,resultStart,resultEnd} from '../local/muse.mjs';
import {AgentConnections} from '../local/connections.mjs';
import {collectLoginSignals} from '../local/login-status.mjs';
import {initialState,reduce} from '../shared/domain.mjs';

const envelope=(id,body='42')=>resultStart(id)+'\n'+JSON.stringify({id,status:'complete',body,sources:[]})+'\n'+resultEnd(id);
test('原 Agent 成果必须带当前尝试的完整信封，半截、旧回复和自述完成都不足以交付',()=>{
 assert.equal(parseMuseResult(envelope('current'),'current').body,'42');
 assert.equal(parseMuseResult(envelope('previous'),'current'),null);
 assert.equal(parseMuseResult(envelope('current').replace(resultEnd('current'),''),'current'),null);
 assert.equal(parseMuseResult('我已经完成了。','current'),null);
 assert.equal(parseMuseResult(resultStart('current')+'{"id":"current","status":"working","body":"未完成"}'+resultEnd('current'),'current'),null);
});

test('发送使用原窗口，不覆盖草稿、不跳转、不擅自批准，可能发送前先记账',async()=>{
 const events=[];let snapshot={inputs:1,draft:true,busy:false,approval:false};
 const page={url:()=> 'https://muse.ai/',isClosed:()=>false,evaluate:async fn=>fn===collectLoginSignals?{ready:true,composer:true,settings:true,library:true,goals:true}:snapshot,locator:()=>({inputValue:async()=>'',fill:async text=>events.push(['fill',text]),press:async key=>events.push(['press',key])})};
 const account={id:'account_test'},transport=new MuseTransport({active:new Map([[account.id,{context:{pages:()=>[page]}}]])});
 await assert.rejects(transport.send(account,'attempt1','任务',async()=>events.push(['record'])),e=>e.code==='WAITING_IDLE');assert.equal(events.length,0);
 snapshot={...snapshot,draft:false,approval:true};await assert.rejects(transport.send(account,'attempt1','任务',async()=>events.push(['record'])),e=>e.code==='PLATFORM_APPROVAL');assert.equal(events.length,0);
 snapshot={...snapshot,approval:false};await transport.send(account,'attempt1','任务',async()=>events.push(['record']));
 assert.deepEqual(events.map(e=>e[0]),['record','fill','press']);assert.equal(events[2][1],'Enter');assert.match(events[1][1],/保留你原来的记忆、规划、工具/);
});

function fixture(){let state=initialState();const cloud={state:async()=>structuredClone(state),action:async action=>{const result=reduce(state,action);state=result.state;return{result:result.result};}};return{cloud,get state(){return state;}};}
test('登录后自动创建唯一成员并验证真实回传机制，查看状态不重复发验证任务',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-muse-connection-'));
 try{
  const f=fixture(),account=(await f.cloud.action({type:'account.create',payload:{platformId:'muse',label:'测试 Muse'}})).result;
  let authenticated=false,sends=0;
  const c=new AgentConnections({cloud:f.cloud,browsers:{},logins:{check:async()=>({status:authenticated?'authenticated':'unknown'})},file:path.join(dir,'connections.json')});
  c.transport={inspect:async()=>({draft:false,busy:false,approval:false}),send:async(_a,_id,_input,before)=>{await before();sends++;},wait:async(_a,id)=>({body:'42',reply:envelope(id)})};
  await c.sync(f.state);assert.equal(f.state.members.length,0);assert.equal(sends,0);
  authenticated=true;await c.sync(f.state);await Promise.all(c.jobs.values());
  assert.equal(sends,1);assert.equal(f.state.members.length,1);assert.equal(f.state.members[0].name,'测试 Muse');assert.equal(f.state.members[0].evidence.kind,'browser_roundtrip');assert.equal(f.state.accounts[0].status,'connected');
  await c.sync(f.state);assert.equal(sends,1);assert.equal(f.state.members.length,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('重启只核对原验证回执，不重发；操作记录损坏时停止而不重置',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-muse-resume-'));
 try{
  const f=fixture(),account=(await f.cloud.action({type:'account.create',payload:{platformId:'muse',label:'恢复测试'}})).result,file=path.join(dir,'connections.json');
  let sends=0;const options={cloud:f.cloud,browsers:{},logins:{check:async()=>({status:'authenticated'})},file};
  const first=new AgentConnections(options);first.transport={inspect:async()=>({}),send:async(_a,_id,_i,before)=>{await before();sends++;},wait:async()=>{throw new Error('回执暂时不明');}};
  await first.sync(f.state);await Promise.all(first.jobs.values());assert.equal(sends,1);assert.equal(f.state.members[0].status,'unverified');
  const next=new AgentConnections(options);next.transport={send:async()=>{throw new Error('不应重发');},wait:async(_a,id)=>({body:'42',reply:envelope(id)})};
  await next.sync(f.state);await Promise.all(next.jobs.values());assert.equal(sends,1);assert.equal(f.state.members[0].status,'ready');
  await fs.writeFile(file,'invalid json');await assert.rejects(new AgentConnections(options).load(),/记录无法读取/);assert.equal(await fs.readFile(file,'utf8'),'invalid json');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('旧账号不存网址时，后台恢复使用产品维护入口，不能要求用户补填',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-muse-entry-'));
 try{const f=fixture(),account=(await f.cloud.action({type:'account.create',payload:{platformId:'muse',label:'旧账号'}})).result;
  let restored;
  const c=new AgentConnections({cloud:f.cloud,browsers:{ensureBackground:async(a,options)=>{restored={id:a.id,...options};}},logins:{records:{[account.id]:{status:'authenticated'}},check:async()=>({status:'unknown'})},file:path.join(dir,'connections.json')});
  await c.sync(f.state);assert.deepEqual(restored,{id:account.id,url:'https://muse.ai/'});assert.equal(f.state.members.length,0,'恢复页面不冒充任务接通');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('浏览器回执必须匹配挑战，旧挑战和错误正文不能点亮连接',async()=>{
 const f=fixture(),a=(await f.cloud.action({type:'account.create',payload:{platformId:'muse',label:'回执验证'}})).result,m=(await f.cloud.action({type:'member.create',payload:{accountId:a.id,name:'Muse',mode:'browser'}})).result,c=(await f.cloud.action({type:'member.challenge',memberId:m.id})).result;
 for(const payload of [{nonce:'old',reply:envelope('old'),transport:'muse-web'},{nonce:c.nonce,reply:envelope(c.nonce,'wrong'),transport:'muse-web'}])await assert.rejects(f.cloud.action({type:'member.browser.verify',memberId:m.id,payload}),/不匹配|完整正确/);
 assert.equal(f.state.members[0].status,'unverified');await f.cloud.action({type:'member.browser.verify',memberId:m.id,payload:{nonce:c.nonce,reply:envelope(c.nonce),transport:'muse-web'}});
 assert.equal(f.state.members[0].evidence.kind,'browser_roundtrip');assert.equal(f.state.notes[0].author,'browser-bridge');
});

test('网页吃掉 JSON 转义时只恢复真实原文，新协议直接传正文无需嵌套转义',()=>{
 const id='attempt_escape',body='{"ok":true,"time":"2026-10-27T12:08:02.386Z"}',source='https://example.com/health';
 const legacy=resultStart(id)+'\n{"id":"'+id+'","status":"complete","body":"'+body+'","sources":["'+source+'"]}\n'+resultEnd(id);
 assert.deepEqual(parseMuseResult(legacy,id),{body,sources:[source]});
 const plain=resultStart(id)+'\n'+body+'\n<<<HUB_SOURCES_'+id+'>>>\n["'+source+'"]\n'+resultEnd(id);
 assert.deepEqual(parseMuseResult(plain,id),{body,sources:[source]});assert.equal(parseMuseResult(plain,'old'),null);
});
