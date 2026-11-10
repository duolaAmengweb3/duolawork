// A burst of changes needs one trailing refresh, not one full read per message.
// Keys include the channel AND projection; slow materials never hold up chat.
export function createReadCoalescer(){
 const pending=new Map();
 return (key,read)=>{
  const previous=pending.get(key);if(previous){previous.dirty=true;return previous.promise;}
  const state={dirty:false};pending.set(key,state);
  state.promise=(async()=>{do{state.dirty=false;await read();}while(state.dirty);})().finally(()=>{if(pending.get(key)===state)pending.delete(key);});
  return state.promise;
 };
}
