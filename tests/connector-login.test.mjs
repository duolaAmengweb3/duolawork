import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConnectorLogin} from '../ui/conversation/connector-login.mjs';

test('OAuth reserves a tab during the click and navigates it after the async request',async()=>{
 const calls=[],tab={document:{body:{}},location:{replace:url=>calls.push(['navigate',url])},close:()=>calls.push(['close'])};
 const login=prepareConnectorLogin(true,{open:(...args)=>{calls.push(args);return tab;}});
 assert.deepEqual(calls,[['about:blank','_blank']]);assert.equal(tab.opener,null);
 await Promise.resolve();login.open('https://auth.example.com/authorize?state=isolated');login.cancel();
 assert.deepEqual(calls,[['about:blank','_blank'],['navigate','https://auth.example.com/authorize?state=isolated']]);
});
test('Electron HTTPS fallback works when the desktop denies a blank popup',()=>{
 const calls=[],login=prepareConnectorLogin(true,{open:(...args)=>{calls.push(args);return null;}});
 login.open('https://auth.example.com/authorize');login.cancel();
 assert.deepEqual(calls,[['about:blank','_blank'],['https://auth.example.com/authorize','_blank','noopener,noreferrer']]);
});
test('failed connections close the waiting tab and never navigate to unsafe login URLs',()=>{
 let closed=0,navigated=0;const login=prepareConnectorLogin(true,{open:()=>({document:{body:{}},close:()=>closed++,location:{replace:()=>navigated++}})});
 for(const url of ['javascript:alert(1)','http://auth.example.com','https://user:password@auth.example.com'])assert.throws(()=>login.open(url));
 login.cancel();assert.equal(closed,1);assert.equal(navigated,0);
 assert.equal(prepareConnectorLogin(false,{open:()=>{throw Error('must not open');}}),null);
});
