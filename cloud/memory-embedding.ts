// Workspace-only embedding endpoint. No Agent private history or Cloudflare
// deployment token is sent to the VPS. The shared key is configured once.
interface Env { AI: Ai; EMBEDDING_KEY: string; EMBEDDING_LIMIT: RateLimit; }
export default {
  async fetch(request: Request, env: Env) {
    const send = (body: unknown, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
    if (!env.EMBEDDING_KEY || request.headers.get('Authorization') !== 'Bearer '+env.EMBEDDING_KEY) return send({error:'unauthorized'},401);
    if (new URL(request.url).pathname !== '/v1/embeddings' || request.method !== 'POST') return send({error:'not_found'},404);
    if (!(await env.EMBEDDING_LIMIT.limit({key:'workspace'})).success) return send({error:'rate_limited'},429);
    const reader=request.body?.getReader(); if(!reader)return send({error:'invalid_input'},400);
    let bytes=0;const chunks:Uint8Array[]=[];
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>80000){await reader.cancel();return send({error:'too_large'},413);}chunks.push(value);}
    try {
      const raw=new Uint8Array(bytes);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
      const args=JSON.parse(new TextDecoder().decode(raw));const input=typeof args.input==='string'?[args.input]:args.input;
      if(!Array.isArray(input)||!input.length||input.length>8||input.some(t=>typeof t!=='string'||t.length>16000))return send({error:'invalid_input'},400);
      const result=await env.AI.run('@cf/baai/bge-m3',{text:input});
      if(!('data' in result)||!Array.isArray(result.data))throw Error('Embedding result missing');
      return send({object:'list',model:'@cf/baai/bge-m3',data:result.data.map((embedding:number[],index:number)=>({object:'embedding',index,embedding}))});
    } catch {return send({error:'embedding_unavailable'},503);}
  }
};
