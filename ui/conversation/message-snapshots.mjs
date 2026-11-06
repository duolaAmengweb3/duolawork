// A send receipt is newer than a list request that was already in flight.
// Keep it visible until a server snapshot has caught up; never let an older
// overlapping read replace a newer one after that receipt is released.
export class MessageSnapshots {
 constructor(){this.views=new Map();this.receipts=new Map();this.started=new Map();this.applied=new Map();}
 get(id){return this.views.get(id);}
 beginRead(id){const n=(this.started.get(id)||0)+1;this.started.set(id,n);return n;}
 append(id,message){
  if(!message?.id)return this.get(id);
  let receipts=this.receipts.get(id);if(!receipts)this.receipts.set(id,receipts=new Map());receipts.set(message.id,message);
  const old=this.get(id);if(!old)return;
  const next={...old,messages:[...old.messages.filter(m=>m.id!==message.id),message]};this.views.set(id,next);return next;
 }
 apply(id,snapshot,sequence){
  if(sequence<(this.applied.get(id)||0))return null;
  this.applied.set(id,sequence);
  const receipts=this.receipts.get(id),messages=snapshot.messages||[];
  if(receipts)for(const [key,message] of receipts){
   const observed=messages.some(m=>m.id===key||message.requestId&&m.requestId===message.requestId);
   // The latest page can already have moved past a very fast burst of sends.
   const passed=messages.length>0&&Number.isFinite(message.number)&&messages.every(m=>m.number>message.number);
   if(observed||passed)receipts.delete(key);
  }
  const next={...snapshot,messages:[...messages,...(receipts?.values()||[])].sort((a,b)=>a.number-b.number)};
  this.views.set(id,next);return next;
 }
}
