import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startNodeHarness} from './node-server-harness.mjs';
const h=await startNodeHarness();
try{
 const a=await h.member('External MCP protocol member A'),b=await h.member('External MCP protocol member B');
 const c=await h.command('channel.create',{name:'Isolated external connector proof',memberIds:[a.id,b.id]});
 const connected=await h.request('/v2/connectors',{action:'save',requestId:'live-docs',provider:'custom',name:'Cloudflare public documentation',url:'https://docs.mcp.cloudflare.com/mcp',authType:'none'});
 assert.equal(connected.connection.health,'ready',JSON.stringify(connected.issue));
 const tools=await b.client.tool('connector',{channelId:c.id,connectionId:connected.connection.id,action:'tools'});assert.ok(tools.tools.some(t=>t.name==='search_cloudflare_documentation'));
 const response=await a.client.tool('connector',{channelId:c.id,connectionId:connected.connection.id,action:'call',tool:'search_cloudflare_documentation',requestId:'public-docs-search',arguments:{query:'Cloudflare Workers documentation'}});
 assert.equal(response.status,'succeeded',response.message);const content=JSON.stringify(response.result.content);assert.ok(content.length>20);
 const evidence={at:new Date().toISOString(),scope:'Actual external MCP via isolated built Node HTTP server and two authenticated protocol members; no commercial Agent/model or Cloudflare account authorization involved.',endpoint:'https://docs.mcp.cloudflare.com/mcp',tools:tools.tools.map(t=>t.name),invocationStatus:response.status,contentBytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')};
 await fs.writeFile('/tmp/duolawork-connectors-live.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await h.stop();}
