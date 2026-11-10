import test from 'node:test';
import assert from 'node:assert/strict';
import {closeOwnedBrowser} from '../local/browser-process.mjs';
import {ManualLoginSessions} from '../local/manual-login.mjs';

test('归属不匹配的进程不接收退出信号',async()=>{
 const signals=[];
 await closeOwnedBrowser({child:{exitCode:null,kill:signal=>signals.push(signal)}},()=>false);
 assert.deepEqual(signals,[]);
});

test('CDP 已断开仍等待已归属的 Chrome 进程退出',async()=>{
 const signals=[],child={exitCode:null,signalCode:null,kill(signal){signals.push(signal);this.signalCode=signal;}};
 await closeOwnedBrowser({child,browser:{isConnected:()=>false}},()=>true);
 assert.deepEqual(signals,['SIGTERM']);
});

test('一个手动登录窗口退出失败仍回收其余账号并保留失败状态',async()=>{
 const sessions=new ManualLoginSessions({}),attempts=[];
 sessions.entries.set('account_first',{});sessions.entries.set('account_second',{});
 sessions.close=async id=>{attempts.push(id);if(id==='account_first')throw new Error('isolated close failure');};
 await assert.rejects(sessions.closeAll(),/尚未保存退出/);
 assert.deepEqual(attempts,['account_first','account_second']);
 assert(sessions.entries.has('account_first'));
});
