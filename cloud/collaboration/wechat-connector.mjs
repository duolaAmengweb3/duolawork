import {access as channelAccess} from './workspace-objects.mjs';
import {id,digest,fail,required} from './repository.mjs';
import {seal,unseal,readBounded,unbase64} from './security.mjs';
import {assertVaultUses,resolveVaultConfig,recordVaultUse,vaultSettings} from './vault.mjs';
import {connectorAllowed} from '../../shared/connector-catalog.mjs';
import {fileBytes} from './shared-space.mjs';
import {publicMcpURL} from '../../shared/mcp-client.mjs';
import {concealSecrets,vaultReference} from '../../shared/vault-references.mjs';
import {renderWechatMarkdown} from '../../shared/wechat-markdown.mjs';

export const WECHAT_ORIGIN='https://api.weixin.qq.com';
const string={type:'string'},object={type:'object',additionalProperties:true};
export const WECHAT_TOOLS=[
 {name:'wechat_status',description:'读取公众号连接及素材、草稿和已发表记录的实际接口检查结果。正式发布和向粉丝群发是不同动作；未实际发表不能声称已发布。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'wechat_api',description:'以所选公众号调用微信官方完整业务 API。固定账号并自动管理 access_token；path 例 /cgi-bin/draft/count（GET）、/cgi-bin/freepublish/submit（POST，body:{media_id}）、/cgi-bin/freepublish/get（POST，body:{publish_id}）。返回 publish_id 仅代表提交，需查状态再报告发表结果。支持菜单、用户、客服、统计、草稿、素材、发表等官方业务接口，实际权限由微信决定。不要把草稿当成发表、发表当成群发；按用户要求执行，不额外要求逐次权限确认。HTTP/网络结果未知时查原调用结果，不换编号重发。',inputSchema:{type:'object',properties:{path:string,method:{type:'string',enum:['GET','POST']},query:object,body:{}},required:['path'],additionalProperties:false}},
 {name:'wechat_upload',description:'上传共享文件或公开 HTTPS 地址中的素材。kind=material 上传永久封面/素材，返回 media_id；kind=image 上传图文正文图片，返回 url；kind=temporary 上传临时素材。优先 fileId，读取后上传的是真实共享文件字节，不能用另一台电脑的本地路径。小文件也可传 base64/filename/mime。正文图片上传后用微信返回的 url 替换原图。视频可传 description:{title,introduction}。',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['material','image','temporary']},mediaType:{type:'string',enum:['image','thumb','voice','video']},fileId:string,version:{type:'integer'},url:string,base64:string,filename:string,mime:string,description:object},required:['kind'],additionalProperties:false}},
 {name:'wechat_draft',description:'公众号草稿和排版。count/list/get/create/update/delete；创建/更新前可用 render 将 markdown 转为微信兼容内联样式 HTML。create 的 articles 是官方图文数组，每篇含 title、content 或 markdown、thumb_media_id，可选 author、digest、content_source_url、need_open_comment。先上传封面和正文图片，再创建并 get 读回。草稿成功不代表已公开发表。更新单篇用 media_id/index/article。只删除用户指定的草稿。',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['count','list','get','create','update','delete','render']},media_id:string,index:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:20},no_content:{type:'integer',enum:[0,1]},articles:{type:'array',items:object},article:object,markdown:string},required:['operation'],additionalProperties:false}}
];
const refreshing=new Map();
function wxError(data){
 const code=Number(data?.errcode);if(!code)return null;
 const messages={40013:'AppID 无效',40125:'AppSecret 无效，请更新此公众号的凭证',40001:'公众号凭证无效或已变更',40164:'调用服务器的出口 IP 未加入微信 API IP 白名单',48001:'微信未向这个公众号开放此接口权限',48002:'用户或公众号未获准执行此操作',45009:'微信接口调用额度已用尽',45047:'微信接口调用次数超限',40007:'素材或草稿 media_id 无效',40014:'微信访问令牌无效',42001:'微信访问令牌过期',41001:'缺少微信访问令牌'};
 return {code:'wechat_'+code,message:messages[code]||'微信接口返回错误 '+code,errcode:code,detail:String(data.errmsg||'').slice(0,600)};
}
export function wechatIssue(e){return typeof e?.code==='string'&&e.code.startsWith('wechat_')?{code:e.code,message:e.message,state:'attention'}:null;}
async function jsonResponse(response){
 const bytes=await readBounded(response,1500000);let result;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('outcome_unknown','微信未返回可确认的 JSON 结果，请核对原调用，勿重复写入',502);}
 if(!response.ok)fail('outcome_unknown','微信请求未取得明确结果，请核对服务记录，勿重复写入',502);return result;
}
async function account(repo,c,actor,channelId,env){
 const current=await repo.get('service_connection',c.id);if(current.version!==c.version||!connectorAllowed(current,actor,channelId,channelId?(await channelAccess(repo,channelId,actor)).resourcePreferences:undefined))fail('connection_changed','公众号连接或使用范围已变化',409);
 const sealed=await unseal(c.credentials,env.ADMIN_KEY),resolved=await resolveVaultConfig(repo,sealed,actor,channelId,env,{targetOrigin:WECHAT_ORIGIN});
 const {appId,appSecret}=resolved.config.wechat||{};
 if(!/^wx[a-zA-Z0-9]{16}$/.test(appId||'')||typeof appSecret!=='string'||!appSecret)fail('wechat_credentials_required','请选择保存了 AppID、AppSecret 的 Vault 凭证');
 return {...resolved,secrets:resolved.secrets.filter(value=>value!==appId),appId,appSecret};
}
async function stillAllowed(repo,c,a,actor,channelId){const now=await repo.get('service_connection',c.id);if(now.version!==c.version||!connectorAllowed(now,actor,channelId,channelId?(await channelAccess(repo,channelId,actor)).resourcePreferences:undefined))fail('connection_changed','公众号连接或使用范围已变化',409);await assertVaultUses(repo,a.uses,actor,channelId);}
async function token(repo,c,a,actor,channelId,env,{expired}={}){
 const key=await digest(a.appId+':'+a.appSecret+':'+JSON.stringify(a.uses)),row=await repo.get('service_wechat_token',c.id,false);
 const read=async record=>{if(record?.key===key&&Date.parse(record.expiresAt)>Date.now()+180000){const t=await unseal(record.sealed,env.ADMIN_KEY);if(t.access_token!==expired)return t.access_token;}return null;};
 const available=await read(row);if(available)return available;
 const lock=repo.workspaceId+':'+c.id+':'+key;if(refreshing.has(lock)){await refreshing.get(lock);return token(repo,c,a,actor,channelId,env,{expired});}
 const work=(async()=>{
  const latest=await read(await repo.get('service_wechat_token',c.id,false));if(latest)return latest;
  const response=await (env.CONNECTOR_FETCH||fetch)(WECHAT_ORIGIN+'/cgi-bin/stable_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credential',appid:a.appId,secret:a.appSecret,force_refresh:!!expired}),redirect:'error',signal:AbortSignal.timeout(20000)}),data=await jsonResponse(response),error=wxError(data);
  if(error)throw Object.assign(new Error(error.message),error);
  if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)fail('wechat_invalid_token_response','微信未返回有效的访问令牌',502);
  await stillAllowed(repo,c,a,actor,channelId);
  await repo.transact(id('wechattoken'),{},async tx=>{await stillAllowed(tx,c,a,actor,channelId);tx.put('service_wechat_token',{id:c.id,key,sealed:await seal({access_token:data.access_token},env.ADMIN_KEY),expiresAt:new Date(Date.now()+data.expires_in*1000).toISOString()});return {saved:true};});return data.access_token;
 })().finally(()=>refreshing.delete(lock));refreshing.set(lock,work);return work;
}
function requestPath(path){
 if(typeof path!=='string'||!/^\/(?:cgi-bin|customservice|datacube|semantic|card|shakearound|merchant|bizwifi)\/[a-zA-Z0-9_/-]+$/.test(path)||path.includes('..')||['/cgi-bin/token','/cgi-bin/stable_token'].includes(path))fail('invalid_wechat_path','请选择微信官方业务接口路径，访问令牌由连接器管理');return path;
}
async function request(repo,c,a,actor,channelId,env,path,{method='GET',query={},body,form}={}){
 requestPath(path);if(!['GET','POST'].includes(method))fail('invalid_method','微信接口仅支持 GET 或 POST');
 if(method==='GET'&&(body!==undefined||form))fail('invalid_arguments','GET 请求不能带正文');
 if(!query||typeof query!=='object'||Array.isArray(query)||Object.entries(query).some(([k,v])=>k.toLowerCase()==='access_token'||typeof v==='object'))fail('invalid_arguments','查询参数无效，不能覆盖公众号访问令牌');
 let accessToken=await token(repo,c,a,actor,channelId,env);
 for(let attempt=0;attempt<2;attempt++){
  await stillAllowed(repo,c,a,actor,channelId);const url=new URL(path,WECHAT_ORIGIN);for(const [k,v]of Object.entries(query))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));url.searchParams.set('access_token',accessToken);
  const response=await (env.CONNECTOR_FETCH||fetch)(url.href,{method,...(form?{body:form()} : body!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)}),data=await jsonResponse(response);
  const error=wxError(data);if(error&&[40014,42001,41001].includes(error.errcode)&&attempt===0){accessToken=await token(repo,c,a,actor,channelId,env,{expired:accessToken});continue;}
  await stillAllowed(repo,c,a,actor,channelId);await recordVaultUse(repo,a.uses,actor,channelId,actor.owner?'connector_check':'connector_call',error?'failed':'succeeded');
  return {data:concealSecrets(data,[...a.secrets,accessToken]),error:error?concealSecrets(error,[...a.secrets,accessToken]):null};
 }
}
async function upload(repo,c,a,actor,channelId,env,args){
 let bytes,mime=args.mime||'application/octet-stream',filename=args.filename||'media';const limit=env.CONNECTOR_UPLOAD_LIMIT||20*1024*1024;
 if([args.fileId,args.url,args.base64].filter(Boolean).length!==1)fail('invalid_upload','请选择一个共享文件、HTTPS 地址或小文件 base64');
 if(args.fileId){const result=await fileBytes(repo,actor,{resourceId:args.fileId,version:args.version},env,{download:true});bytes=await readBounded(result,limit);const meta=await repo.get('shared_file',args.fileId);filename=args.filename||meta.name||filename;mime=args.mime||meta.mime||mime;}
 else if(args.url){const url=publicMcpURL(args.url),response=await(env.CONNECTOR_FETCH||fetch)(url,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)fail('upload_source_unavailable','素材地址暂不可读取',502);bytes=await readBounded(response,limit);mime=args.mime||response.headers.get('Content-Type')?.split(';')[0]||mime;filename=args.filename||new URL(url).pathname.split('/').pop()||filename;}
 else{try{bytes=unbase64(args.base64);}catch{fail('invalid_upload','素材 base64 无效');}}
 if(!bytes?.length||bytes.length>limit)fail('invalid_upload','素材为空或超过本次上传上限');
 const kind=args.kind||'material';if(!['material','image','temporary'].includes(kind))fail('invalid_upload','请选择素材用途');const mediaType=args.mediaType||'image';if(!['image','thumb','voice','video'].includes(mediaType))fail('invalid_upload','素材类型无效');
 const path=kind==='image'?'/cgi-bin/media/uploadimg':kind==='temporary'?'/cgi-bin/media/upload':'/cgi-bin/material/add_material';
 return request(repo,c,a,actor,channelId,env,path,{method:'POST',query:kind==='image'?{}:{type:mediaType},form:()=>{const form=new FormData();form.append('media',new Blob([bytes],{type:mime}),filename.replace(/[\r\n]/g,''));if(args.description)form.append('description',JSON.stringify(args.description));return form;}});
}
export async function checkWechat(repo,c,env,{actor={owner:true},channelId}={}){
 const a=await account(repo,c,actor,channelId,env);await token(repo,c,a,actor,channelId,env);
 const probes=await Promise.all([request(repo,c,a,actor,channelId,env,'/cgi-bin/draft/count'),request(repo,c,a,actor,channelId,env,'/cgi-bin/material/get_materialcount'),request(repo,c,a,actor,channelId,env,'/cgi-bin/freepublish/batchget',{method:'POST',body:{offset:0,count:1,no_content:1}})]);
 const names=['drafts','materials','publishedArticles'],capabilities=Object.fromEntries(probes.map((p,i)=>[names[i],p.error?{state:'not_available',code:p.error.errcode,message:p.error.message}:{state:'verified'}]));capabilities.publish={state:'not_tested',message:'未用测试文章公开发表；正式发表结果以微信接口实际返回为准'};
 await stillAllowed(repo,c,a,actor,channelId);return {tools:WECHAT_TOOLS,capabilities,message:!probes[0].error&&!probes[1].error?'素材与草稿接口已验证；正式发表按公众号实际权限执行':'已连接微信；部分接口权限未开放，请查看账号能力'};
}
export async function performWechat(repo,c,actor,args,env){
 if(args.action==='tools')return (await checkWechat(repo,c,env,{actor,channelId:args.channelId})).tools;
 if(args.tool==='wechat_status'){const s=await checkWechat(repo,c,env,{actor,channelId:args.channelId});return {content:[{type:'text',text:JSON.stringify({account:c.accountName||c.name,appId:c.appId,execution:'DuolaWork 共享服务器',capabilities:s.capabilities})}]};}
 const input=args.arguments||{};let a,result;
 if(args.tool==='wechat_draft'&&input.operation==='render')return {content:[{type:'text',text:JSON.stringify({html:renderWechatMarkdown(required(input.markdown,'Markdown 正文',120000))})}]};
 a=await account(repo,c,actor,args.channelId,env);
 if(args.tool==='wechat_api')result=await request(repo,c,a,actor,args.channelId,env,input.path,input);
 else if(args.tool==='wechat_upload')result=await upload(repo,c,a,actor,args.channelId,env,input);
 else if(args.tool==='wechat_draft'){
  const article=value=>{if(!value||typeof value!=='object')fail('invalid_arguments','请提供图文内容');const {markdown,...fields}=value;return {...fields,...(markdown!==undefined?{content:renderWechatMarkdown(markdown)}:{})};};
  const op=input.operation;
  if(op==='count')result=await request(repo,c,a,actor,args.channelId,env,'/cgi-bin/draft/count');
  else if(op==='list')result=await request(repo,c,a,actor,args.channelId,env,'/cgi-bin/draft/batchget',{method:'POST',body:{offset:input.offset||0,count:input.count||20,no_content:input.no_content??1}});
  else if(op==='get'||op==='delete')result=await request(repo,c,a,actor,args.channelId,env,'/cgi-bin/draft/'+op,{method:'POST',body:{media_id:required(input.media_id,'草稿 media_id')}});
  else if(op==='create'){if(!Array.isArray(input.articles)||!input.articles.length)fail('invalid_arguments','请提供 articles 图文数组');result=await request(repo,c,a,actor,args.channelId,env,'/cgi-bin/draft/add',{method:'POST',body:{articles:input.articles.map(article)}});}
  else if(op==='update')result=await request(repo,c,a,actor,args.channelId,env,'/cgi-bin/draft/update',{method:'POST',body:{media_id:required(input.media_id,'草稿 media_id'),index:input.index||0,articles:article(input.article)}});
  else fail('invalid_action','请选择草稿操作');
 }else fail('unknown_tool','此公众号没有该工具');
 return {isError:!!result.error,content:[{type:'text',text:JSON.stringify({...result.data,...(result.error?{duolaworkError:result.error}:{})})}]};
}

export async function saveWechat(repo,identity,actor,args,env){
 required(args.requestId,'请求编号',160);
 const old=args.connectionId?await repo.get('service_connection',args.connectionId):null;if(old&&(old.provider!=='wechat-mp'||old.version!==args.expectedVersion||!connectorAllowed({...old,status:'connected'},actor,args.channelId,args.channelId?(await channelAccess(repo,args.channelId,actor)).resourcePreferences:undefined)))fail('version_conflict','公众号连接已更新或不在当前使用范围，请刷新',409);
 let secret=old?.credentials?await unseal(old.credentials,env.ADMIN_KEY):{};
 const appId=args.appId||old?.appId;if(!/^wx[a-zA-Z0-9]{16}$/.test(appId||''))fail('invalid_appid','请填写 wx 开头的公众号 AppID');
 if(old?.appId&&old.appId!==appId)fail('account_changed','此连接属于另一个公众号，请使用添加账号');
 const expectedId='mcp_'+(await digest('wechat-mp:'+appId+':'+args.requestId)).slice(0,32),same=(await repo.list('service_connection',{limit:500})).find(c=>c.provider==='wechat-mp'&&c.appId===appId&&c.status!=='disconnected');
 if(!old&&same){if(!connectorAllowed(same,actor,args.channelId,args.channelId?(await channelAccess(repo,args.channelId,actor)).resourcePreferences:undefined))fail('forbidden','这个公众号不在当前使用范围',403);if(same.id===expectedId)return same;fail('account_exists','这个公众号已经接入，请检查连接或在原连接更新凭证');}
 let credentialId=args.credentialId;
 if(args.appSecret){const targetId=credentialId||old?.vaultReferences?.[0]?.credentialId,previous=targetId?await repo.get('vault_entry',targetId):null;
  if(previous){const binding=await resolveVaultConfig(repo,{appId:vaultReference(previous.id,'app_id')},actor,args.channelId,env,{targetOrigin:WECHAT_ORIGIN});if(binding.config.appId!==appId)fail('account_changed','所选 Vault 凭证属于另一个公众号');}
  const e=await vaultSettings(repo,identity,actor,{action:'save',requestId:args.requestId+':vault',channelId:args.channelId,...(previous?{credentialId:previous.id,expectedVersion:previous.version}:{}),name:(args.name||old?.name||'微信公众号')+' · 接入凭证',type:'custom',service:'微信公众号 · '+appId,fields:{app_id:appId,app_secret:args.appSecret},allowedOrigins:[WECHAT_ORIGIN]},env);credentialId=e.id;}
 if(credentialId)secret={wechat:{appId:vaultReference(credentialId,'app_id'),appSecret:vaultReference(credentialId,'app_secret')}};
 if(!secret.wechat)fail('wechat_credentials_required','请填写 AppSecret 或选择已保存的公众号凭证');
 const resolved=await resolveVaultConfig(repo,secret,actor,args.channelId,env,{targetOrigin:WECHAT_ORIGIN});if(resolved.config.wechat.appId!==appId)fail('account_changed','所选凭证的 AppID 与公众号不一致');
 const refs=[...new Set(resolved.uses.map(u=>u.id))].map(credentialId=>({credentialId})),connectionId=old?.id||expectedId;
 const row={...old,id:connectionId,serviceType:'mcp',provider:'wechat-mp',name:required(args.name||old?.name||'微信公众号','公众号名称',120),accountName:args.name||old?.accountName||'微信公众号',appId,transport:'wechat',url:WECHAT_ORIGIN,authType:'none',hostId:null,execution:{kind:'server',egressIp:env.CONNECTOR_EGRESS_IP||null},blockedMemberIds:old?.blockedMemberIds||[],blockedChannelIds:old?.blockedChannelIds||[],tools:WECHAT_TOOLS,toolCount:WECHAT_TOOLS.length,catalog:null,status:'configured',health:'unchecked',version:(old?.version||0)+1,vaultReferences:refs};
 await repo.transact(args.requestId,{action:'wechat.save',id:connectionId,appId,name:row.name,secretHash:await digest(JSON.stringify(secret)),version:row.version},async tx=>{if(old){const current=await tx.get('service_connection',old.id);if(current.version!==old.version||!connectorAllowed({...current,status:'connected'},actor,args.channelId,args.channelId?(await channelAccess(tx,args.channelId,actor)).resourcePreferences:undefined))fail('version_conflict','公众号连接已更新',409);}await assertVaultUses(tx,resolved.uses,actor,args.channelId);return tx.put('service_connection',{...row,credentials:await seal(secret,env.ADMIN_KEY),createdAt:old?.createdAt||tx.now});});
 return repo.get('service_connection',connectionId);
}
