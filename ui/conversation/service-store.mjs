// One in-memory metadata cache for navigation. Never cache secret values,
// credential reveal/backup responses, OAuth links, or write responses wholesale.
export function createServiceStore(request,{now=Date.now,ttl=30000,limit=80}={}){
 let scope='',epoch=0;const entries=new Map(),listeners=new Map();
 const notify=key=>{for(const fn of listeners.get(key)||[])fn();};
 const safe=key=>{const u=new URL(key,'https://local.invalid');return (u.pathname==='/v2/channel-resources'&&u.searchParams.has('channelId')&&!u.searchParams.has('action'))||(u.pathname==='/v2/connectors'&&['list','hosts','setup'].includes(u.searchParams.get('action')||'list'))||(u.pathname==='/v2/vault'&&(u.searchParams.get('action')||'list')==='list')||(u.pathname==='/v2/skills'&&!u.searchParams.has('skillId')&&!u.searchParams.has('action'));};
 function entry(key){if(!safe(key))throw Error('Only service-list metadata may be cached');if(!entries.has(key)){if(entries.size>=limit){for(const [k,v]of entries)if(!v.pending&&!listeners.get(k)?.size){entries.delete(k);break;}}entries.set(key,{value:Object.freeze({data:null,loading:false,error:''}),at:0,sequence:0});}return entries.get(key);}
 function publish(key,e,changes){e.value=Object.freeze({...e.value,...changes});notify(key);}
 function load(key,{force=false}={}){
  const e=entry(key);if(e.pending)return e.pending;if(!force&&e.value.data&&!e.value.error&&now()-e.at<ttl)return Promise.resolve(e.value.data);
  const generation=epoch,sequence=++e.sequence,controller=new AbortController();e.controller=controller;publish(key,e,{loading:true,error:''});
  const pending=Promise.resolve().then(()=>request(key,controller.signal)).then(data=>{if(epoch===generation&&e.sequence===sequence){e.at=now();publish(key,e,{data,loading:false,error:''});}return data;}).catch(error=>{if(epoch===generation&&e.sequence===sequence)publish(key,e,{loading:false,error:error.message,...([401,403].includes(error.status)?{data:null}:{})});throw error;}).finally(()=>{if(e.pending===pending)e.pending=null;});e.pending=pending;return pending;
 }
 function invalidate(prefix,{refresh=true,onlyCached=false}={}){for(const [key,e]of entries)if(key.startsWith(prefix)&&(!onlyCached||e.value.data)){e.at=-Infinity;e.sequence++;e.controller?.abort();e.pending=null;if(e.value.loading)publish(key,e,{loading:false});if(refresh&&listeners.get(key)?.size)void load(key,{force:true}).catch(()=>{});}}
 return{
  get generation(){return epoch;},
  snapshot:key=>entry(key).value,
  subscribe(key,fn){entry(key);if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);return()=>{listeners.get(key)?.delete(fn);if(!listeners.get(key)?.size)listeners.delete(key);};},
  load,invalidate,
  setScope(next){if(scope===next)return;const previous=scope;scope=next;if(!previous)return;epoch++;for(const e of entries.values())e.controller?.abort();entries.clear();for(const key of listeners.keys()){notify(key);if(listeners.get(key)?.size)void load(key).catch(()=>{});}},
  update(key,update){const e=entry(key);if(e.value.data)publish(key,e,{data:update(e.value.data)});},
  patch(prefix,update){for(const [key,e]of entries)if(key.startsWith(prefix)&&e.value.data)publish(key,e,{data:update(e.value.data,new URL(key,'https://local.invalid').searchParams)});},
  prefetch(page){const key={connectors:'/v2/connectors',vault:'/v2/vault?query=',skills:'/v2/skills'}[page];return key?load(key).catch(()=>{}):Promise.resolve();},
 };
}
