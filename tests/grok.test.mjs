import test from 'node:test';import assert from 'node:assert/strict';
import {grokBotUrl,GrokTransport} from '../local/grok.mjs';
import {initialState,reduce} from '../shared/domain.mjs';
import {resultStart,resultSources,resultEnd} from '../shared/muse-protocol.mjs';
test('Grok 原生 Bot 与普通聊天、仿冒站点严格分开',()=>{
 assert.equal(grokBotUrl('https://grok.com/bot/abc-123'),true);
 for(const u of ['https://grok.com/c/abc','https://grok.com/','https://grok.com.evil.example/bot/abc'])assert.equal(grokBotUrl(u),false);
});
test('原生 Grok 回执必须匹配本次挑战，网页登录与伪回复均不能点亮成员',()=>{
 let state=initialState();const act=a=>{const r=reduce(state,a);state=r.state;return r.result;};
 const account=act({type:'account.create',payload:{platformId:'grok-bot',label:'fixture'}});
 const member=act({type:'member.create',payload:{accountId:account.id,name:'original Bot',mode:'webhook'}});
 const old=act({type:'member.challenge',memberId:member.id});
 assert.throws(()=>act({type:'member.challenge',memberId:member.id,payload:{renew:true,previousNonce:'wrong'}}),/必须匹配/);
 const {nonce}=act({type:'member.challenge',memberId:member.id,payload:{renew:true,previousNonce:old.nonce}});assert.notEqual(nonce,old.nonce);
 const reply=[resultStart(nonce),'42',resultSources(nonce),'[]',resultEnd(nonce)].join('\n');
 assert.throws(()=>act({type:'member.browser.verify',memberId:member.id,payload:{nonce,reply,transport:'muse-web'}}),/不匹配/);
 assert.throws(()=>act({type:'member.browser.verify',memberId:member.id,payload:{nonce:'old',reply,transport:'grok-bot-web'}}),/不匹配/);
 const verified=act({type:'member.browser.verify',memberId:member.id,payload:{nonce,reply,transport:'grok-bot-web'}});
 assert.equal(verified.id,member.id);assert.equal(verified.mode,'browser');assert.equal(verified.evidence.transport,'grok-bot-web');assert.equal(verified.status,'ready');
});
test('Grok 原生会话草稿与本人批准阻断发送，不能退回普通聊天',async()=>{
 let state={inputs:1,draft:true,busy:false,approval:false},writes=0;
 const page={url:()=> 'https://grok.com/bot/fixture',isClosed:()=>false,evaluate:async fn=>fn.name==='collectLoginSignals'?{ready:true,accountMenu:true,composer:true}:state,locator:()=>{writes++;throw new Error('must not write');}};
 const transport=new GrokTransport({active:new Map([['account_fixture',{context:{pages:()=>[page]}}]])}),account={id:'account_fixture'};
 await assert.rejects(transport.send(account,'one','test',async()=>{}),/草稿/);assert.equal(writes,0);
 state={...state,draft:false,approval:true};await assert.rejects(transport.send(account,'two','test',async()=>{}),/本人批准/);assert.equal(writes,0);
 page.url=()=> 'https://grok.com/c/fixture';await assert.rejects(transport.send(account,'three','test',async()=>{}),/原生 Bot/);assert.equal(writes,0);
});
