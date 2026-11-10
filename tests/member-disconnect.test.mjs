import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './collaboration-helper.mjs';
import {mutate,load} from '../cloud/store.ts';
import {Repository} from '../cloud/collaboration/repository.mjs';
import {grant} from '../cloud/collaboration/pairing.mjs';
import {resolveActor} from '../cloud/collaboration/api.mjs';
import {configureConnection} from '../cloud/collaboration/connections.mjs';
import {conversationCommand,claimConversation} from '../cloud/collaboration/conversation.mjs';

async function fixture(t){
 const db=database();t.after(()=>db.close());const env={DB:db,WORKSPACE_ID:'test',ADMIN_KEY:'isolated-test-only'};
 const account=(await mutate(env,{type:'account.create',payload:{platformId:'grok-bot',label:'同一账号'}})).result;
 const members=[];for(const name of ['移除对象','保留对象'])members.push((await mutate(env,{type:'member.create',payload:{accountId:account.id,name,mode:'connector'}})).result);
 const repo=new Repository(db,'test'),identity=(await load(env)).state;
 let tokens;
 await repo.transact('init',{},async tx=>{for(const m of members)tx.put('connection',{id:m.id,platform:'grok-bot',status:'verified',resourceKey:account.id,transport:'muse-poll',configVersion:1,credentials:{opaque:'isolated-fixture'},verifiedAt:tx.now});tokens=await grant(tx,members[0].id,'test-client',tx.now);tx.put('subscription',{id:'sub',parentId:members[0].id,status:'active'});return{};});
 const send=(type,args={})=>conversationCommand(repo,identity,{owner:true},{type,requestId:crypto.randomUUID(),...args});
 const group=await send('channel.create',{name:'群聊',memberIds:members.map(m=>m.id),coordinatorId:members[0].id});
 const dm=await send('channel.create',{name:'私聊',memberIds:[members[0].id],direct:true});
 const message=await send('channel.post',{channelId:dm.id,body:'历史消息要保留'});
 return{env,db,repo,identity,account,members,tokens,group,dm,message,send};
}

test('解除单个成员原子撤销权限与通知，保留账号、历史、共享账号中的其他成员',async t=>{
 const f=await fixture(t),[target,peer]=f.members;
 const beforePeer=await f.repo.get('connection',peer.id);
 await f.repo.transact('peer-running',{},tx=>{tx.put('resource',{id:f.account.id,status:'busy',memberId:peer.id});return{};});
 await mutate(f.env,{type:'member.disconnect',memberId:target.id});
 const identity=(await load(f.env)).state;
 assert.equal(identity.members.find(m=>m.id===target.id).status,'disabled');
 assert.equal(identity.members.find(m=>m.id===peer.id).status,peer.status);
 assert.deepEqual(identity.accounts.find(a=>a.id===f.account.id),f.identity.accounts.find(a=>a.id===f.account.id));
 assert.deepEqual(await f.repo.get('connection',peer.id),beforePeer);
 assert.equal((await f.repo.get('resource',f.account.id)).memberId,peer.id);
 const c=await f.repo.get('connection',target.id);assert.equal(c.status,'disconnected');assert.equal(c.credentials,undefined);
 assert((await f.repo.list('member_auth')).every(x=>x.status==='revoked'));
 assert((await f.repo.list('oauth_refresh')).every(x=>x.status==='revoked'));
 assert.equal((await f.repo.get('subscription','sub')).status,'revoked');
 assert((await f.repo.list('outbox')).every(x=>x.status==='canceled'));
 assert.equal((await f.repo.get('channel',f.dm.id)).status,'archived');
 assert.deepEqual((await f.repo.get('channel',f.group.id)).memberIds,[peer.id]);
 assert.equal((await f.repo.get('channel',f.group.id)).coordinatorId,null);
 assert.equal((await f.repo.get('channel_message',f.message.id)).body,'历史消息要保留');
 await assert.rejects(()=>resolveActor(new Request('https://hub.test/v2/mcp',{headers:{Authorization:'Bearer '+f.tokens.access_token}}),f.env,identity));
  await assert.rejects(()=>configureConnection(f.repo,f.identity,{requestId:'stale-agent-request',memberId:target.id,platform:'grok-bot',url:'https://api2.cursor.sh/automations/webhook/fixture',token:'crsr_isolated_fixture_only'},f.env.ADMIN_KEY),e=>e.code==='member_disconnected');
});

test('成员正在回复时解除被完整拒绝，不半撤销凭证或隐藏成员',async t=>{
 const f=await fixture(t),target=f.members[0];
 const work=(await f.repo.list('channel_turn'))[0];
 await claimConversation(f.repo,f.identity,{memberId:target.id},{requestId:'claim',stepId:work.id});
 const before=(await load(f.env)).state,connection=await f.repo.get('connection',target.id);
 await assert.rejects(()=>mutate(f.env,{type:'member.disconnect',memberId:target.id}),e=>e.code==='member_busy');
 assert.deepEqual((await load(f.env)).state,before);assert.deepEqual(await f.repo.get('connection',target.id),connection);
 assert((await f.repo.list('member_auth')).every(x=>x.status==='active'));
});

test('单聊被并发创建也只保留一份，不能把单聊改成其他成员可读的群',async t=>{
 const f=await fixture(t);
 const calls=await Promise.all([1,2].map(()=>f.send('channel.create',{name:'重复点击',memberIds:[f.members[0].id],direct:true})));
 assert.equal(calls[0].id,f.dm.id);assert.equal(calls[1].id,f.dm.id);
 assert.equal((await f.repo.list('channel')).filter(c=>c.direct).length,1);
 await assert.rejects(()=>f.send('channel.update',{channelId:f.dm.id,memberIds:f.members.map(m=>m.id)}),e=>e.code==='invalid_direct');
});

test('领取和解除连接竞争时不能同时成功，保留明确的执行或撤销结果',async t=>{
 const f=await fixture(t),target=f.members[0],turn=(await f.repo.list('channel_turn'))[0];
 const results=await Promise.allSettled([
  claimConversation(f.repo,f.identity,{memberId:target.id},{requestId:'racing-claim',stepId:turn.id}),
  mutate(f.env,{type:'member.disconnect',memberId:target.id}),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const member=(await load(f.env)).state.members.find(m=>m.id===target.id),after=await f.repo.get('channel_turn',turn.id);
 if(member.status==='disabled')assert.notEqual(after.status,'active');else assert.equal(after.status,'active');
});
