import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {proxyCollaboration} from '../local/collaboration-proxy.mjs';

test('本地同源代理转发真实字节及服务端授权，不向前端泄漏管理密钥', async t=>{
 const payload=Buffer.alloc(1100000,83), token='isolated-proxy-key';let received;
 const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received={path:req.url,authorization:req.headers.authorization,bytes:Buffer.concat(chunks)};res.setHeader('Content-Type','application/octet-stream');res.end(payload);});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const gateway=http.createServer((req,res)=>proxyCollaboration(req,res,{endpoint:`http://127.0.0.1:${upstream.address().port}`,adminKey:token}).catch(e=>{res.writeHead(500);res.end(e.message);}));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));});
 const response=await fetch(`http://127.0.0.1:${gateway.address().port}/api/v2/files?x=1`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:payload});
 assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),payload);assert.deepEqual(received.bytes,payload);assert.equal(received.path,'/v2/files?x=1');assert.equal(received.authorization,'Bearer '+token);assert(!JSON.stringify([...response.headers]).includes(token));
});

async function jsonGateway(t,handler){
 const upstream=http.createServer(handler);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const gateway=http.createServer((req,res)=>proxyCollaboration(req,res,{endpoint:`http://127.0.0.1:${upstream.address().port}`,adminKey:'test-only'}).catch(e=>{if(!res.headersSent){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({code:e.code,uncertain:e.uncertain}));}}));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(async()=>{gateway.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));});return `http://127.0.0.1:${gateway.address().port}/api/v2/channel`;
}
test('a truncated JSON read retries before sending any partial body to the renderer',async t=>{
 let calls=0;const value={messages:['complete history','保留用户原话']};
 const url=await jsonGateway(t,(req,res)=>{res.setHeader('Content-Type','application/json');if(++calls===1){res.write('{"messages":');setTimeout(()=>res.destroy(),10);}else res.end(JSON.stringify(value));});
 const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(await response.json(),value);assert.equal(calls,2);
});
test('a lost write response stays uncertain and never replays the committed write',async t=>{
 let writes=0;const url=await jsonGateway(t,(req,res)=>{writes++;res.setHeader('Content-Type','application/json');res.write('{"saved":');setTimeout(()=>res.destroy(),10);});
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"body":"one message"}'});assert.equal(response.status,502);assert.equal((await response.json()).uncertain,true);assert.equal(writes,1);
});
test('compressed JSON uses the decoded byte length rather than the upstream compressed length',async t=>{
 const {gzipSync}=await import('node:zlib');const value={body:'压缩中文消息'.repeat(500)},encoded=gzipSync(Buffer.from(JSON.stringify(value)));
 const url=await jsonGateway(t,(req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',encoded.length);res.end(encoded);});
 const response=await fetch(url);assert.deepEqual(await response.json(),value);assert.equal(Number(response.headers.get('content-length')),Buffer.byteLength(JSON.stringify(value)));assert.equal(response.headers.get('content-encoding'),null);
});
