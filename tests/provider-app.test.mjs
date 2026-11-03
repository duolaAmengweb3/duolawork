import test from 'node:test';
import assert from 'node:assert/strict';
import {openProviderApp} from '../local/provider-app.mjs';
test('首次确认只打开已知官方应用，不接受命令、路径或任意平台',async()=>{
 let calls=0;
 const exec=async(command,args,options)=>{calls++;assert.equal(command,'/usr/bin/open');assert.deepEqual(args,['-b','com.anysphere.sand']);assert.equal(options.timeout,10000);};
 assert.deepEqual(await openProviderApp('grok-bot',{platform:'darwin',exec}),{opened:true});
 await assert.rejects(()=>openProviderApp('grok-bot; touch /tmp/unsafe',{platform:'darwin',exec}));
 await assert.rejects(()=>openProviderApp('grok-bot',{platform:'linux',exec}),/手动打开/);
 assert.equal(calls,1);
 await assert.rejects(()=>openProviderApp('grok-bot',{platform:'darwin',exec:async()=>{throw new Error('not installed');}}),/未能打开/);
});
