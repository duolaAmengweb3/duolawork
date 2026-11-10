// Read cache and in-flight writes are scoped to a member AND a chat. Closing the
// picker must not cancel a native creation or permit a second copy of that write.
export function createSessionPickerStore(api, {now=Date.now, ttl=20000}={}) {
  const entries=new Map();
  function entry(memberId,channelId) {
    const key=memberId+':'+channelId;
    if(!entries.has(key))entries.set(key,{memberId,channelId,version:0,at:0,listeners:new Set(),state:{data:null,loading:false,pending:null,error:null,uncertain:false}});
    return entries.get(key);
  }
  function update(e,patch) {e.state={...e.state,...patch};for(const notify of e.listeners)notify();}
  return {
    snapshot(memberId,channelId){return entry(memberId,channelId).state;},
    subscribe(memberId,channelId,notify){const e=entry(memberId,channelId);e.listeners.add(notify);return()=>e.listeners.delete(notify);},
    invalidate(memberId){for(const e of entries.values())if(e.memberId===memberId){e.at=0;e.version++;}},
    load(memberId,channelId,{force=false}={}) {
      const e=entry(memberId,channelId);
      if(e.read)return e.read;
      if(!force&&e.state.data&&now()-e.at<ttl)return Promise.resolve(e.state.data);
      const version=e.version;
      update(e,{loading:true,error:null});
      e.read=api('/local/chat-sessions?'+new URLSearchParams({memberId,channelId})).then(data=>{
        if(e.version===version){e.at=now();update(e,{data});}
        return data;
      }).catch(error=>{update(e,{error});return null;}).finally(()=>{e.read=null;update(e,{loading:false});});
      return e.read;
    },
    save(input) {
      const e=entry(input.memberId,input.channelId);
      if(e.write)return e.write;
      if(e.state.uncertain&&input.mode==='new')return Promise.reject(Error('上次创建结果尚未确认，请刷新列表查看原环境，避免重复新建。'));
      e.version++;update(e,{pending:{mode:input.mode,sessionId:input.sessionId},error:null});
      e.write=api('/local/chat-sessions',{...input,requestId:crypto.randomUUID()},undefined,{timeoutMs:180000}).then(result=>{
        for(const cached of entries.values())if(cached.memberId===input.memberId){cached.at=0;cached.version++;}
        if(result.binding&&e.state.data)update(e,{data:{...e.state.data,binding:result.binding}});
        update(e,{uncertain:false});return result;
      }).catch(error=>{
        update(e,{error,uncertain:!!error.uncertain||/不要重复新建|结果尚未确认/.test(error.message)});throw error;
      }).finally(()=>{e.write=null;update(e,{pending:null});});
      return e.write;
    },
  };
}
