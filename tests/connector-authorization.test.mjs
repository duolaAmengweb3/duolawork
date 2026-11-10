import test from 'node:test';
import assert from 'node:assert/strict';
import {connectorAuthorizationURL,GITHUB_FULL_SCOPES} from '../shared/connector-authorization.mjs';
test('full GitHub authorization includes non-default tools and preserves SDK state and PKCE',()=>{
 const c={provider:'github-mcp',url:'https://api.githubcopilot.com/mcp/x/all'},input=new URL('https://github.com/login/oauth/authorize?scope=repo+read%3Aorg&state=one-use&code_challenge=pkce&redirect_uri=https%3A%2F%2Fhub.test%2Fcallback');
 const u=connectorAuthorizationURL(c,input,{scopes_supported:['offline_access']});
 const scopes=new Set(u.searchParams.get('scope').split(' '));for(const scope of GITHUB_FULL_SCOPES)assert.ok(scopes.has(scope),scope);
 assert.ok(scopes.has('offline_access'));assert.equal(u.searchParams.get('state'),'one-use');assert.equal(u.searchParams.get('code_challenge'),'pkce');assert.equal(u.searchParams.get('redirect_uri'),'https://hub.test/callback');
 assert.equal(scopes.has('read:org'),false);assert.equal(scopes.has('admin:org'),false);assert.equal(scopes.has('admin:enterprise'),false);
 assert.equal(input.searchParams.get('scope'),'repo read:org');
});
test('Cloudflare requests its advertised API capabilities without inventing scopes',()=>{
 const u=connectorAuthorizationURL({provider:'cloudflare',url:'https://mcp.cloudflare.com/mcp'},'https://mcp.cloudflare.com/authorize?scope=account%3Aread',{scopes_supported:['account:read','dns.write','workers-scripts.edit','offline_access']});
 assert.deepEqual(new Set(u.searchParams.get('scope').split(' ')),new Set(['account:read','dns.write','workers-scripts.edit','offline_access']));
});
test('Vercel durable identity excludes unrelated authorization infrastructure management',()=>{
 const u=connectorAuthorizationURL({provider:'vercel',url:'https://mcp.vercel.com'},'https://vercel.com/oauth/authorize?scope=openid',{scopes_supported:['openid','profile','email','offline_access','ema_issuer:manage']});
 assert.deepEqual(new Set(u.searchParams.get('scope').split(' ')),new Set(['openid','profile','email','offline_access']));
});
test('provider policies cannot widen scopes on custom connections, mismatched hosts or foreign issuers',()=>{
 for(const [provider,url,issuer]of [['custom','https://api.githubcopilot.com/mcp/','https://github.com'],['github-mcp','https://other.test/mcp','https://github.com'],['github-mcp','https://api.githubcopilot.com/mcp/','https://other.test']]){
  const u=connectorAuthorizationURL({provider,url},issuer+'/authorize?scope=read',{});assert.equal(u.searchParams.get('scope'),'read');
 }
});
test('Google offline parameters apply only to the corresponding trusted Google services',()=>{
 const input='https://accounts.google.com/o/oauth2/v2/auth?scope=drive';
 const u=connectorAuthorizationURL({provider:'google-drive',url:'https://drivemcp.googleapis.com/mcp/v1'},input,{});assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('prompt'),'consent select_account');
 const unrelated=connectorAuthorizationURL({provider:'google-drive',url:'https://other.test/mcp'},input,{});assert.equal(unrelated.searchParams.has('access_type'),false);
});
