import {digest,fail} from './repository.mjs';

// External tools may return far more than one repository record can hold.
// Store immutable pieces in the same completion transaction as the receipt;
// replaying a request only reads that receipt and never repeats the operation.
export async function prepareConnectorResult(connectionId,invocationId,result){
 if(result===undefined)return {chunks:[]};
 const text=JSON.stringify(result);
 if(new TextEncoder().encode(text).length<120000)return {result,resultRef:null,chunks:[]};
 const key='result_'+await digest(invocationId+':'+text),chunks=[];
 for(let start=0;start<text.length;start+=20000)chunks.push({id:key+':'+chunks.length,parentId:connectionId,scopeId:invocationId,data:text.slice(start,start+20000)});
 return {resultRef:{id:key,parts:chunks.length},chunks};
}
export async function readConnectorResult(repo,record){
 if(!record.resultRef)return record.result;
 const {id,parts}=record.resultRef;
 if(!Number.isInteger(parts)||parts<1||parts>100)fail('result_unavailable','调用结果暂不可读取，请查看服务记录；不要重复执行',503);
 const rows=await Promise.all(Array.from({length:parts},(_,i)=>repo.get('service_result_chunk',id+':'+i)));
 if(rows.some(r=>r.parentId!==record.scopeId||r.scopeId!==record.id))fail('result_unavailable','调用结果暂不可读取，请查看服务记录；不要重复执行',503);
 return JSON.parse(rows.map(r=>r.data).join(''));
}
