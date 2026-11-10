import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {api} from '../v1/api.mjs';
import {createServiceStore} from './service-store.mjs';
export const serviceStore=createServiceStore((path,signal)=>api(path,undefined,undefined,{signal}));
export function useServiceData(path,{enabled=true}={}){
 const subscribe=useCallback(fn=>enabled?serviceStore.subscribe(path,fn):()=>{},[path,enabled]),snapshot=useCallback(()=>serviceStore.snapshot(path),[path]);
 const value=useSyncExternalStore(subscribe,snapshot);
 useEffect(()=>{if(!enabled)return;const load=()=>{void serviceStore.load(path).catch(()=>{});};load();window.addEventListener('focus',load);return()=>window.removeEventListener('focus',load);},[path,enabled]);
 const refresh=useCallback(()=>serviceStore.load(path,{force:true}),[path]);return {...value,refresh};
}
