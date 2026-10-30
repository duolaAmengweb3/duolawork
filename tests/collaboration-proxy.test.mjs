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
