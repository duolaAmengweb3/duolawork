import {digest,fail} from './repository.mjs';

// Tool schemas are provider data, not connection metadata. A single schema can
// exceed the record limit; chunk the serialized catalog without dropping tools
// or shortening their schemas. Immutable content IDs also reuse repeat checks.
export async function prepareToolCatalog(connectionId,tools){
 const text=JSON.stringify(tools);
 if(new TextEncoder().encode(text).length<120000)return {tools,toolCount:tools.length,catalog:null,chunks:[]};
 const catalogId='catalog_'+await digest(connectionId+':'+text),chunks=[];
 // 20k UTF-16 units fit below 180k even in the worst JSON escaping case.
 for(let start=0;start<text.length;start+=20000)chunks.push({id:catalogId+':'+chunks.length,parentId:connectionId,scopeId:catalogId,data:text.slice(start,start+20000)});
 const names=tools.map(({name,title})=>({name,...(title?{title}:{})}));
 return {tools:new TextEncoder().encode(JSON.stringify(names)).length<80000?names:[],toolCount:tools.length,catalog:{id:catalogId,parts:chunks.length},chunks};
}
export async function readToolCatalog(repo,connection){
 if(!connection.catalog)return connection.tools||[];
 const {id,parts}=connection.catalog,rows=await Promise.all(Array.from({length:parts},(_,index)=>repo.get('service_catalog_chunk',id+':'+index)));
 if(rows.some(r=>r.parentId!==connection.id||r.scopeId!==id))fail('catalog_unavailable','工具目录尚未就绪，请重新检查连接',503);
 return JSON.parse(rows.map(r=>r.data).join(''));
}
