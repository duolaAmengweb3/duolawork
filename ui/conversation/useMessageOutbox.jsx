import {useEffect,useRef,useState} from 'react';
import {api} from '../v1/api.mjs';
const storageKey='duolawork-outbox-v1';
function read(){try{const rows=JSON.parse(localStorage.getItem(storageKey)||'[]');return Array.isArray(rows)?rows.filter(x=>x.input?.requestId&&x.input?.channelId&&typeof x.input?.body==='string'):[];}catch{return[];}}
export default function useMessageOutbox(onCommitted){
 const [items,setItems]=useState(read),rows=useRef(items),active=useRef(new Set()),callback=useRef(onCommitted);callback.current=onCommitted;
 const update=(fn,required=false)=>{const next=fn(rows.current);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch(e){if(required)throw e;}rows.current=next;setItems(next);};
 const send=async entry=>{
  const key=entry.input.requestId;if(active.current.has(key)||rows.current.some(x=>x.input.channelId===entry.input.channelId&&active.current.has(x.input.requestId)))return;active.current.add(key);
  update(all=>all.map(x=>x.input.requestId===key?{...x,status:'sending',error:null}:x));
  try{
   const response=await api('/v2/commands',entry.input);callback.current(response.result,entry.input.channelId);
   update(all=>all.filter(x=>x.input.requestId!==key));
  }catch(e){update(all=>all.map(x=>x.input.requestId===key?{...x,status:e.uncertain?'waiting':'failed',error:e.message,retryAt:Date.now()+15000}:x));}
  finally{active.current.delete(key);}
 };
 const enqueue=input=>{const entry={input:{...input,type:'channel.post',requestId:crypto.randomUUID()},createdAt:new Date().toISOString(),status:'queued'};update(all=>[...all,entry],true);return entry;};
 const retry=key=>{const e=rows.current.find(x=>x.input.requestId===key);if(e)void send(e);};
 const remove=key=>{const e=rows.current.find(x=>x.input.requestId===key);if(e?.status!=='failed'||active.current.has(key))return null;update(all=>all.filter(x=>x.input.requestId!==key));return e.input;};
 useEffect(()=>{const channels=new Set();for(const e of items){if(channels.has(e.input.channelId))continue;channels.add(e.input.channelId);if(e.status==='queued')void send(e);}},[items]);
 useEffect(()=>{const resume=()=>{for(const entry of rows.current)if(['sending','waiting'].includes(entry.status))void send(entry);};resume();window.addEventListener('online',resume);return()=>window.removeEventListener('online',resume);},[]);
 useEffect(()=>{const waiting=items.filter(x=>x.status==='waiting');if(!waiting.length)return;const timer=setTimeout(()=>{for(const x of rows.current)if(x.status==='waiting'&&x.retryAt<=Date.now())void send(x);},Math.max(500,Math.min(...waiting.map(x=>x.retryAt||Date.now()))-Date.now()));return()=>clearTimeout(timer);},[items]);
 return {items,enqueue,retry,remove};
}
