import test from 'node:test';import assert from 'node:assert/strict';import {initialState,reduce} from '../shared/domain.mjs';import {Runner} from '../local/runner.mjs';
function fixture(){let s=initialState();const calls=[];const action=async a=>{calls.push(a);const r=reduce(s,a);s=r.state;return{result:r.result};};return{get s(){return s},calls,action,cloud:{state:async()=>structuredClone(s),action,artifact:async()=>({body:'actual'})}};}
test('更新交接保留原浏览器，正常退出才关闭专用浏览器',async()=>{
 let closes=0;const r=new Runner({cloud:{},vault:{},config:{},browsers:{closeAll:async()=>{closes++;}}});
 await r.stop({keepBrowsers:true});assert.equal(closes,0);assert.equal(r.stopped,true);
 await r.stop();assert.equal(closes,1);
});
test('Muse 通过原 Agent 回传后才完成，任务输入不携带工作台领取密钥',async()=>{
 const f=fixture(),a=(await f.action({type:'account.create',payload:{platformId:'muse',label:'Muse 测试'}})).result,m=(await f.action({type:'member.create',payload:{accountId:a.id,name:'Muse',mode:'browser'}})).result;
 const challenge=(await f.action({type:'member.challenge',memberId:m.id})).result;
 await f.action({type:'member.browser.verify',memberId:m.id,payload:{nonce:challenge.nonce,transport:'muse-web',reply:`<<<HUB_RESULT_${challenge.nonce}>>>${JSON.stringify({id:challenge.nonce,status:'complete',body:'42',sources:[]})}<<<HUB_END_${challenge.nonce}>>>`}});await f.action({type:'account.update',accountId:a.id,payload:{status:'connected'}});
 const t=(await f.action({type:'task.create',payload:{title:'原 Agent 任务',goal:'交付真实结果',steps:[{memberId:m.id,title:'一步',instruction:'读取公开资料',minLength:5,requireSources:true}]}})).result;
 let actualAttempt,input;
 const connections={sync:async()=>{},jobs:new Map(),supports:()=>true,run:async(_a,attempt,value,onState)=>{actualAttempt=attempt;input=value;assert.ok(f.calls.some(c=>c.type==='step.dispatch'));await onState('working');return{body:'来自原 Agent 的完整测试成果',sources:['https://example.com/source']};}};
 const r=new Runner({cloud:f.cloud,vault:{data:{members:{}}},browsers:{active:new Map()},connections,config:{runnerId:'r',adminKey:'owner-only-secret'}});
 await r.execute(f.state||f.s,t,t.steps[0],m,a,{});
 assert.ok(actualAttempt.lease);assert.ok(!JSON.stringify(input).includes(actualAttempt.lease));assert.ok(!JSON.stringify(input).includes('owner-only-secret'));assert.equal(f.s.tasks[0].status,'completed');assert.equal(f.s.artifacts[0].transport,'muse-web');
});
test('后台状态默认静默，系统通知仅用户开启后发出且不重复轰炸',async()=>{
 const config={runnerId:'quiet-runner'},notifications=[];
 const state={accounts:[],tasks:[],settings:{automation:false}};
 const r=new Runner({config,cloud:{state:async()=>structuredClone(state),action:async()=>({})},vault:{data:{members:{}}},browsers:{active:new Map()},notify:(...args)=>notifications.push(args)});
 await r.tick();
 state.tasks.push({id:'quiet-task',title:'测试任务',status:'needs_approval',updatedAt:'first',steps:[]});
 await r.tick();assert.equal(notifications.length,0);
 config.desktopNotifications=true;
 await r.tick();assert.equal(notifications.length,0,'开启通知不补发过去的状态');
 state.tasks[0].status='completed';state.tasks[0].updatedAt='second';
 await r.tick();assert.equal(notifications.length,1);
 await r.tick();assert.equal(notifications.length,1,'相同状态不会每次同步都通知');
 config.desktopNotifications=false;
 state.tasks[0].updatedAt='third';await r.tick();assert.equal(notifications.length,1);
});
test('未验证成员不会自动触发外部模型',async()=>{const f=fixture(),a=(await f.action({type:'account.create',payload:{platformId:'grok-bot',label:'a'}})).result,m=(await f.action({type:'member.create',payload:{accountId:a.id,name:'m',mode:'webhook'}})).result;await f.action({type:'task.create',payload:{title:'t',goal:'g',steps:[{memberId:m.id,title:'s',instruction:'i'}]}});const r=new Runner({cloud:f.cloud,vault:{data:{members:{}}},browsers:{active:new Map(),closeAll:async()=>{}},config:{runnerId:'r'}});await r.tick();assert.equal(r.status.blocked[0].message,'等待真实读写验证');assert.ok(!f.calls.some(a=>a.type==='step.claim'));});
test('重启恢复把本地不明派发转成待核对，不重复派发',async()=>{const f=fixture(),a=(await f.action({type:'account.create',payload:{platformId:'grok-bot',label:'a'}})).result,m=(await f.action({type:'member.create',payload:{accountId:a.id,name:'m',mode:'webhook'}})).result,t=(await f.action({type:'task.create',payload:{title:'t',goal:'g',steps:[{memberId:m.id,title:'s',instruction:'i'}]}})).result;await f.action({type:'step.claim',taskId:t.id,stepId:t.steps[0].id,payload:{runnerId:'r'}});const r=new Runner({cloud:f.cloud,vault:{data:{members:{}}},browsers:{active:new Map(),closeAll:async()=>{}},config:{runnerId:'r'}});await r.tick();assert.equal(f.s.tasks[0].steps[0].status,'needs_review');assert.equal(f.calls.filter(a=>a.type==='step.claim').length,1);});

test('退出时迟到的同步不会重新打开账号或派发下一步',async()=>{
 let resolve,connects=0;const statePromise=new Promise(r=>resolve=r),connections={sync:async()=>{connects++;},jobs:new Map()};
 const r=new Runner({cloud:{state:()=>statePromise},vault:{data:{members:{}}},browsers:{active:new Map(),closeAll:async()=>{}},connections,config:{}});
 const tick=r.tick(),stop=r.stop({keepBrowsers:true});resolve({accounts:[],tasks:[],settings:{automation:true}});await Promise.all([tick,stop]);assert.equal(connects,0);assert.equal(connections.stopped,true);
});

test('重启后只读恢复原 Muse 结果，不重新领取或派发',async()=>{
 const f=fixture(),a=(await f.action({type:'account.create',payload:{platformId:'muse',label:'恢复账号'}})).result,m=(await f.action({type:'member.create',payload:{accountId:a.id,name:'Muse',mode:'browser'}})).result;
 const t=(await f.action({type:'task.create',payload:{title:'恢复任务',goal:'保留原结果',steps:[{memberId:m.id,title:'原步骤',instruction:'完成一份原始成果'}]}})).result,attempt=(await f.action({type:'step.claim',taskId:t.id,stepId:t.steps[0].id,payload:{runnerId:'test'}})).result;
 await f.action({type:'step.dispatch',taskId:t.id,stepId:t.steps[0].id,attemptId:attempt.id});
 const count=f.calls.length;let resumed=0;
 const r=new Runner({cloud:f.cloud,config:{runnerId:'test'},vault:{data:{members:{}}},browsers:{active:new Map()},connections:{resume:async(_a,original,onState)=>{assert.equal(original.id,attempt.id);resumed++;await onState('awaiting_result');return{body:'这是原尝试已经完成的完整真实成果，不需要重新派发。',sources:[]};}}});
 await r.resume(t,t.steps[0],a,attempt);assert.equal(resumed,1);assert.equal(f.s.tasks[0].status,'completed');assert.ok(!f.calls.slice(count).some(a=>['step.claim','step.dispatch'].includes(a.type)));assert.equal(f.s.tasks[0].steps[0].attempts.length,1);
});
