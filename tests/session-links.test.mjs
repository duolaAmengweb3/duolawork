import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';

test('current-conversation code reuses the account and binds only after native challenge and atomic original-runtime commit',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'antigravity',name:'Antigravity'}});
 const m=await h.member('antigravity','Original'),other=await h.member('antigravity','Other'),channel=await h.command('channel.create',{name:'当前工作',memberIds:[m.id]});
 const runtimeId=randomUUID(),instanceId=randomUUID(),native={id:'original-native',title:'原项目的对话',workspace:'/srv/project'};
 const self=b=>h.request('/v2/self/session-links',{requestId:randomUUID(),...b},m.token);
 const runtime=b=>h.request('/v2/self/runtime',{runtimeId,instanceId,...b},m.token);
 await runtime({action:'heartbeat',form:'antigravity-cli',label:'VPS',sourceReady:true,status:'idle',items:[native],projects:[]});
 const create=()=>h.request('/v2/session-links',{action:'create',memberId:m.id,channelId:channel.id});
 const r=await create(),input=JSON.parse(r.skill.match(/传入：(\{.+?\})。/)[1]);
 assert.match(r.skill,/账号已经连接/);assert.equal(r.codeHash,undefined);
 await assert.rejects(h.request('/v2/self/session-links',{action:'redeem',...input,runtimeId,session:native,requestId:randomUUID()},other.token),/其他成员/);
 await assert.rejects(self({action:'redeem',...input,code:'wrong',runtimeId,session:native}),/不属于/);
 await self({action:'redeem',...input,runtimeId,session:native});
 const pending=(await h.request('/v2/self/session-links',undefined,m.token)).items.find(i=>i.id===r.id);
 assert.equal(pending.status,'confirming');assert.equal(pending.codeHash,undefined);
 assert.equal((await h.request('/v2/native-runtime?memberId='+m.id)).bindings[channel.id],undefined);
 await assert.rejects(runtime({action:'link',linkId:r.id,requestId:randomUUID()}),/尚未/);
 await assert.rejects(self({action:'confirm',id:r.id,challenge:pending.challenge,sessionId:'wrong-native'}),/不是这段/);
 await self({action:'confirm',id:r.id,challenge:pending.challenge,sessionId:native.id});
 const state=await runtime({action:'link',linkId:r.id,requestId:randomUUID()}),c=state.commands[0];assert.equal(c.sessionId,native.id);
 await runtime({action:'complete',commandId:c.id,requestId:randomUUID(),binding:{sessionId:native.id,workspace:native.workspace,title:native.title}});
 await runtime({action:'activate',commandId:c.id,requestId:randomUUID()});
 const complete=await h.request('/v2/session-links?id='+r.id);assert.equal(complete.status,'completed');assert.equal(complete.challenge,undefined);
 assert.equal((await h.request('/v2/native-runtime?memberId='+m.id)).bindings[channel.id].sessionId,native.id);
 const newLink=await create(),next=JSON.parse(newLink.skill.match(/传入：(\{.+?\})。/)[1]);await self({action:'redeem',...next,runtimeId,session:native});
 await h.request('/v2/session-links',{action:'cancel',id:newLink.id,requestId:randomUUID()});
 await assert.rejects(self({action:'redeem',...next,runtimeId,session:{...native,id:'another'}}),/另一段/);
 await assert.rejects(self({action:'redeem',...next,runtimeId,session:native}),/取消/);
 const current=await h.request('/v2/native-runtime?memberId='+m.id);assert.equal(current.bindings[channel.id].sessionId,native.id);
 const members=(await h.request('/v2/workspace')).members;assert.equal(members.length,2,'Conversation selection never adds another account or member');
});

test('local conversation binding requires a native confirmation and protects the applying transition',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const m=await h.member('codex','Codex'),channel=await h.command('channel.create',{name:'local link',memberIds:[m.id]});
 const link=await h.request('/v2/session-links',{action:'create',executor:'local',form:'codex',memberId:m.id,channelId:channel.id,locator:{dataDir:'/fixture',file:'native-coding.json'}}),input=JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]);
 const self=b=>h.request('/v2/self/session-links',{requestId:randomUUID(),...b},m.token),owner=action=>h.request('/v2/session-links',{action,id:link.id,requestId:randomUUID()});
 await self({action:'redeem',...input,session:{id:'current',workspace:'/srv/project',title:'original'}});
 await assert.rejects(owner('completed'),/回执/);await assert.rejects(owner('begin'),/尚未/);
 const p=(await h.request('/v2/self/session-links',undefined,m.token)).items.find(l=>l.id===link.id);
 await self({action:'confirm',id:link.id,challenge:p.challenge,sessionId:'current'});await owner('begin');await assert.rejects(owner('cancel'),/正在保存/);
 await owner('completed');const r=await h.request('/v2/session-links?memberId='+m.id+'&channelId='+channel.id);assert.equal(r.items[0].status,'completed');assert.equal(r.items[0].locator,undefined);
});
