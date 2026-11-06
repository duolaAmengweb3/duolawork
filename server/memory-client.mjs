export function memoryClient(url){
 const endpoint=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('Memory service must use loopback');
 const call=async(path,body)=>{const r=await fetch(new URL(path,endpoint),{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path==='/search'?6000:1500)});if(!r.ok)throw Error('Memory service unavailable');return r.json();};
 return {search:async(query,options)=>(await call('/search',{query,...options})).results,status:async()=>{try{return await call('/status');}catch{return {configured:true,state:'unavailable',message:'语义服务暂不可用，已保存的约定继续生效。'};}}};
}
