import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {seal,unseal} from './security.mjs';
import {fail,id,digest} from './repository.mjs';
import {publicMcpURL} from '../../shared/mcp-client.mjs';
import {applicationKey,configuredApplication} from './connector-applications.mjs';

export async function oauthProvider(repo,connection,env,{begin=false}={}){
 const key=connection.id,old=await repo.get('service_oauth',key,false);
 const data=old?.sealed?await unseal(old.sealed,env.ADMIN_KEY):{};
 const config={...await configuredApplication(repo,connection,env),...(connection.credentials?await unseal(connection.credentials,env.ADMIN_KEY):{})};
 if(!begin&&!data.tokens?.access_token&&(!data.state||data.expires<=Date.now()))begin=true;
 if(!data.client&&config.oauthClientId)data.client={client_id:config.oauthClientId,...(config.oauthClientSecret?{client_secret:config.oauthClientSecret}:{})};
 if(begin){data.state=id('oauth');data.expires=Date.now()+15*60000;delete data.verifier;delete data.authorizationUrl;}
 const origin=connection.callbackOrigin;
 const persist=(fields,{invalidate=false}={})=>repo.transact(id('oauthsave'),{},async tx=>{
  const current=await tx.get('service_connection',key);
  if(current.version!==connection.version||current.status==='disconnected')fail('connection_changed','连接已变化，请重新连接',409);
  const row=await tx.get('service_oauth',key,false),latest=row?.sealed?await unseal(row.sealed,env.ADMIN_KEY):{};
  if(invalidate&&fields.includes('tokens')&&latest.tokens&&JSON.stringify(latest.tokens)!==JSON.stringify(data.tokens))return row;
  for(const field of fields){
   // An expired-token failure from one caller cannot erase another caller's
   // successful token rotation or a newly started browser authorization.
   if(invalidate&&JSON.stringify(latest[field])!==JSON.stringify(data[field]))continue;
   if(invalidate||data[field]===undefined)delete latest[field];else latest[field]=data[field];
  }
  return tx.put('service_oauth',{...row,id:key,sealed:await seal(latest,env.ADMIN_KEY),state:latest.state||null,expiresAt:new Date(latest.expires||Date.now()+15*60000).toISOString(),...(begin?{status:'pending'}:{})});
 });
 const save=()=>persist(['state','expires','verifier','authorizationUrl']);
 const provider={
  redirectUrl:origin+'/v2/connectors/oauth/callback',
  clientMetadataUrl:origin+'/v2/connectors/oauth/client.json',
  get clientMetadata(){
   const supported=data.discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
   const method=!supported||supported.includes('none')?'none':supported.includes('client_secret_basic')?'client_secret_basic':supported.includes('client_secret_post')?'client_secret_post':'none';
   return {client_name:'DuolaWork',client_uri:origin,redirect_uris:[origin+'/v2/connectors/oauth/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:method};
  },
  state:()=>data.state,
  clientInformation:()=>data.client,
  saveClientInformation:async v=>{data.client=v;await persist(['client']);},
  tokens:async()=>{const row=await repo.get('service_oauth',key,false);if(row?.sealed)data.tokens=(await unseal(row.sealed,env.ADMIN_KEY)).tokens;return data.tokens;},
  saveTokens:async v=>{data.tokens=v;await persist(['tokens']);},
  saveCodeVerifier:async v=>{data.verifier=v;await persist(['verifier']);},
  codeVerifier:()=>data.verifier,
  redirectToAuthorization:async u=>{
   // A resource's default scopes can omit offline_access even when its
   // authorization server supports refresh tokens. Request durable access
   // without adding any new resource permissions or dropping existing scopes.
   if(data.discovery?.authorizationServerMetadata?.scopes_supported?.includes('offline_access')){
    const scopes=new Set((u.searchParams.get('scope')||'').split(/\s+/).filter(Boolean));scopes.add('offline_access');u.searchParams.set('scope',[...scopes].join(' '));
   }
   // Google does not issue refresh tokens for offline_access alone. Keep this
   // provider requirement confined to the registered Google service origins.
   if(applicationKey(connection.provider,connection.url)==='google-workspace'&&u.origin==='https://accounts.google.com'){
    u.searchParams.set('access_type','offline');u.searchParams.set('prompt','consent select_account');
   }
   data.authorizationUrl=publicMcpURL(u.href);await persist(['authorizationUrl']);
  },
  invalidateCredentials:async scope=>{const fields=scope==='all'?['tokens','client','verifier','discovery']:[{tokens:'tokens',client:'client',verifier:'verifier',discovery:'discovery'}[scope]];await persist(fields,{invalidate:true});const row=await repo.get('service_oauth',key,false);const latest=row?.sealed?await unseal(row.sealed,env.ADMIN_KEY):{};for(const field of fields)data[field]=latest[field];},
  saveDiscoveryState:async v=>{data.discovery=v;await persist(['discovery']);},
  discoveryState:()=>data.discovery,
 };
 // Serialize only OAuth token rotation, not tools or Agent work. Multiple
 // machines may share a connection and a provider may issue one-use refresh tokens.
 const request=(input,init={})=>{
  publicMcpURL(String(input instanceof Request?input.url:input));
  return (env.CONNECTOR_FETCH||fetch)(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
 };
 const fetcher=async(input,init={})=>{
  const params=new URLSearchParams(typeof init.body==='string'||init.body instanceof URLSearchParams?init.body:'');
  if(params.get('grant_type')!=='refresh_token')return request(input,init);
  const presented=params.get('refresh_token'),initialAccess=data.tokens?.access_token,lease=id('refresh');
  for(let attempt=0;attempt<60;attempt++){
   if(init.signal?.aborted)throw init.signal.reason;
   const row=await repo.get('service_oauth',key,false),latest=row?.sealed?await unseal(row.sealed,env.ADMIN_KEY):{};
   if(latest.tokens?.access_token&&(latest.tokens.refresh_token!==presented||latest.tokens.access_token!==initialAccess))return Response.json(latest.tokens);
   const claim=await repo.transact(id('refreshclaim'),{},async tx=>{const lock=await tx.get('service_oauth_refresh',key,false);if(lock?.lease&&Date.parse(lock.expiresAt)>Date.now())return {acquired:false};tx.put('service_oauth_refresh',{id:key,lease,tokenHash:await digest(presented),expiresAt:new Date(Date.now()+60000).toISOString()});return {acquired:true};});
   if(!claim.acquired){await new Promise(r=>setTimeout(r,400));continue;}
   try{
    // Re-read after acquiring: a previous rotation may have just committed.
    const freshRow=await repo.get('service_oauth',key,false),fresh=freshRow?.sealed?await unseal(freshRow.sealed,env.ADMIN_KEY):{};
    if(fresh.tokens?.access_token&&(fresh.tokens.refresh_token!==presented||fresh.tokens.access_token!==initialAccess))return Response.json(fresh.tokens);
    const response=await request(input,init);
    if(response.ok){const tokens=await response.clone().json();if(tokens.access_token){
     // RFC 6749 permits refresh responses to omit a replacement refresh token.
     // Return the retained token to the SDK too, or its saveTokens would erase it.
     const retained={...tokens,refresh_token:tokens.refresh_token||presented};
     data.tokens={...retained,...(data.client?.issuer?{issuer:data.client.issuer}:{})};await persist(['tokens']);
     return Response.json(retained,{status:response.status});
    }}
    return response;
   }finally{await repo.transact(id('refreshrelease'),{},async tx=>{const lock=await tx.get('service_oauth_refresh',key,false);if(lock?.lease===lease)tx.put('service_oauth_refresh',{...lock,lease:null});return {};});}
  }
  fail('authorization_busy','服务授权正在更新，请稍后重试',503);
 };
 if(begin)await save();
 return {provider,data,save,fetch:fetcher};
}
export async function finishConnectorOAuth(repo,env,params){
 const state=params.get('state');if(!state)fail('invalid_oauth','授权状态缺失');
 const rows=await repo.list('service_oauth',{limit:501});const record=rows.find(r=>r.state===state);
 if(!record||Date.parse(record.expiresAt)<Date.now())fail('oauth_expired','授权页面已过期，请回到连接器重新连接');
 const connection=await repo.get('service_connection',record.id);
 const {provider,data,save,fetch:fetcher}=await oauthProvider(repo,connection,env);
 if(data.state!==state||!data.verifier)fail('invalid_oauth','此授权已处理，请回到连接器查看状态');
 if(params.get('error'))fail('oauth_declined','此次授权未完成，请回到连接器重试');
 // Consume before exchange so callbacks cannot race or replay authorization codes.
 await repo.transact(id('oauthconsume'),{state},async tx=>{const r=await tx.get('service_oauth',record.id);if(r.state!==state||r.status==='used')fail('invalid_oauth','此授权已处理');return tx.put('service_oauth',{...r,status:'used'});});
  delete data.state;
 const result=await auth(provider,{serverUrl:publicMcpURL(connection.url),authorizationCode:params.get('code'),fetchFn:fetcher});
 if(result!=='AUTHORIZED')fail('oauth_incomplete','服务尚未完成授权，请重新连接');
 delete data.state;delete data.verifier;delete data.authorizationUrl;await save();
 return connection;
}
