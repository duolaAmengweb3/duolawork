import {fetch,EnvHttpProxyAgent} from 'undici';
import {execFileSync} from 'node:child_process';
import {createNetworkRequest} from './network.mjs';
let dispatcher,proxyMode='环境代理或直连';
function network({refresh=false}={}){if(refresh&&dispatcher){const previous=dispatcher;dispatcher=undefined;proxyMode='环境代理或直连';previous.close().catch(()=>{});}if(dispatcher)return dispatcher;
 if(process.platform==='darwin'&&!process.env.HTTPS_PROXY&&!process.env.https_proxy&&!process.env.ALL_PROXY&&!process.env.all_proxy){try{const raw=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:3000});const get=k=>raw.match(new RegExp('\\b'+k+'\\s*:\\s*([^\\n]+)'))?.[1].trim();const host=get('HTTPSProxy'),port=Number(get('HTTPSPort'));if(get('HTTPSEnable')==='1'&&host&&port){dispatcher=new EnvHttpProxyAgent({httpProxy:`http://${host}:${port}`,httpsProxy:`http://${host}:${port}`,noProxy:'127.0.0.1,localhost,::1'});proxyMode='读取系统代理（未改系统配置）';}}catch{}}
 dispatcher??=new EnvHttpProxyAgent();return dispatcher;}
export function networkStatus(){network();return proxyMode;}
export function networkDispatcher(options){return network(options);}
const health={successes:0,recoveries:0,failures:0,lastSuccessAt:null,lastFailureAt:null,events:[]};
function observe(event){const at=new Date().toISOString();if(event.kind==='failure'){health.failures++;health.lastFailureAt=at;}else{health.successes++;health.lastSuccessAt=at;if(event.kind==='recovered')health.recoveries++;}if(event.kind!=='success'){health.events.push({...event,at});health.events=health.events.slice(-20);}}
export function networkDiagnostics(){return structuredClone({...health,mode:networkStatus()});}
export const requestNetwork=createNetworkRequest({fetchImpl:fetch,dispatcher:network,observe});
export async function requestJson(url,{method='GET',token,body,timeout=25000,headers={},signal}={}){return requestNetwork(url,{method,timeout,signal,headers:{...headers,...(token?{Authorization:`Bearer ${token}`} :{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)},async response=>{const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data={message:'远端未返回有效 JSON'};}if(!response.ok){const err=new Error(data.message||`远端返回 ${response.status}`);err.status=response.status;err.code=data.error;throw err;}return data;});}
export function cloudClient(config){const call=(p,o)=>{if(!config.endpoint||!config.adminKey)throw new Error('尚未配置本产品的 Cloudflare 工作区，未切换到演示数据。');return requestJson(config.endpoint+p,{...o,token:config.adminKey});};return{state:()=>call('/admin/state'),action:a=>call('/admin/action',{method:'POST',body:a}),artifact:id=>call('/admin/artifacts/'+encodeURIComponent(id)),credential:memberId=>call('/admin/member-credential',{method:'POST',body:{memberId}})};}
