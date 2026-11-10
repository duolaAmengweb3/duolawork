import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';

export function publicMcpURL(raw){
 let u;try{u=new URL(raw);}catch{throw Error('请填写完整的 HTTPS 服务地址');}
 const h=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.hash||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||!h.includes('.')||/^[\d.]+$/.test(h)||h.includes(':'))throw Error('远程连接需要公开的 HTTPS 地址；本机和内网工具请通过运行端连接');
 return u.href;
}
// Use the official SDK for sessions, SSE framing, discovery, PKCE and refresh.
// No automatic retry of tool calls: a lost response may already have changed data.
export async function openRemoteMcp({url,headers={},authProvider,fetch:fetcher=fetch}){
 publicMcpURL(url);
 const safeFetch=async(input,init={})=>{
  publicMcpURL(String(input instanceof Request?input.url:input));
  const r=await fetcher(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  return r;
 };
 let client=new Client({name:'DuolaWork',version:'1.0.0'});
 let transport=new StreamableHTTPClientTransport(new URL(url),{authProvider,requestInit:{headers},fetch:safeFetch,reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
 try{await client.connect(transport,{timeout:30000});}catch(e){
  await client.close().catch(()=>{});
  if(![404,405].includes(e.code))throw e;
  client=new Client({name:'DuolaWork',version:'1.0.0'});
  transport=new SSEClientTransport(new URL(url),{authProvider,requestInit:{headers},fetch:safeFetch});
  try{await client.connect(transport,{timeout:30000});}catch(error){await client.close().catch(()=>{});throw error;}
 }
 return {client,transport};
}
export async function mcpTools(client){
 const result=[],seen=new Set();let cursor;
 do{const page=await client.listTools(cursor?{cursor}:{});result.push(...page.tools);cursor=page.nextCursor;if(result.length>3000||seen.size>1000||cursor&&seen.has(cursor))throw Error('服务工具目录过大或分页异常，请在服务端检查');if(cursor)seen.add(cursor);}while(cursor);
 return result.map(({name,title,description,inputSchema,annotations})=>({name,title,description,inputSchema,annotations}));
}
