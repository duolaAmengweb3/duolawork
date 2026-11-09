import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const FEISHU_DOMAINS=['application','approval','apps','attendance','base','calendar','contact','docs','drive','im','mail','markdown','mindnotes','minutes','note','okr','sheets','slides','task','vc','whiteboard','wiki'];
const blocked=new Set(['profile','as','yes','help','version','token','access-token','refresh-token','app-id','app-secret','client-secret','endpoint','base-url','debug','verbose','trace','jq']);
export function redactFeishu(value){
 if(Array.isArray(value))return value.map(redactFeishu);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(access_token|refresh_token|app_secret|client_secret|authorization)$/i.test(k)?'[凭证已隐藏]':redactFeishu(v)]));
 return value;
}
export async function runFeishu(command,args,{cwd,timeout=18000}={}){
 try{const r=await exec(command,args,{cwd,timeout,maxBuffer:1800000,encoding:'utf8',env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});return {exitCode:0,text:r.stdout};}
 catch(e){let text=e.stdout||'';if(!text.trim())try{const d=JSON.parse(e.stderr);if(d&&typeof d==='object')text=e.stderr;}catch{}return {exitCode:Number.isInteger(e.code)?e.code:-1,text,interrupted:!!e.killed};}
}
export function parseFeishu(r){try{return JSON.parse(r.text);}catch{throw new Error(r.interrupted?'飞书执行超时，结果尚未确认；写操作请先核对，勿重复执行':'飞书未返回有效数据，请检查原账号登录和官方 CLI');}}
export async function feishuIdentity(binding){
 const r=await runFeishu(binding.command,['--profile',binding.profile,'whoami'],{cwd:binding.cwd}),who=parseFeishu(r);
 if(r.exitCode||!who.available||who.identity!=='user'||who.profile!==binding.profile||who.appId!==binding.appId||who.onBehalfOf?.openId!==binding.openId)throw Object.assign(new Error('原飞书账号已退出或改变，请先在飞书官方 CLI 恢复原账号登录，再检查连接；不会切换到其他账号'),{code:'authorization_required'});
 return who;
}
export function feishuPath(value){
 if(!Array.isArray(value)||value.length<1||value.length>5||!FEISHU_DOMAINS.includes(value[0])||value.some(x=>typeof x!=='string'||!/^\+?[a-z][a-z0-9_.-]*$/.test(x)))throw new Error('请选择飞书业务命令；登录、凭证、配置和任意 HTTP 命令不对 Agent 开放');
 if(value[0]==='apps'&&/^\+(init|plugin-|git-credential-|openapi-key-|env-pull)/.test(value[1]||''))throw new Error('原环境的安装、凭证和本地开发配置不对共享工具开放');
 return value;
}
export function feishuArgs(input){
 const args=[...feishuPath(input.path)],options=input.options||{};
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length>50)throw new Error('命令参数无效');
 for(const [key,v] of Object.entries(options)){
  if(!/^[a-z][a-z0-9-]*$/.test(key)||blocked.has(key))throw new Error('不支持覆盖账号、凭证、输出过滤或官方确认参数');
  if(v===false||v===undefined||v===null)continue;
  const value=typeof v==='object'?JSON.stringify(v):String(v);
  // The CLI supports @file and XML local attachments. This shared entry accepts
  // inline content only: it must never expose the host's private files to peers.
  if(/^(file|input|output|dir|cwd|path)$|^output-|-(file|path|dir)$/.test(key)||value==='-'||/^@(?!@)/.test(value)||/<source\b[^>]*\bpath\s*=|\b(?:path|src|href)\s*=\s*["']?\s*@|!\[[^\]]*\]\([^)]*@/i.test(value))throw new Error('共享调用请直接传入内容或飞书资源地址；不读取运行端本地文件');
  if(value.length>120000)throw new Error('单个参数过大，请分段修改文档');
  for(const m of value.matchAll(/<img\b[^>]*\b(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi))if(!/^https?:\/\//i.test(m[1].replace(/^["']|["']$/g,'')))throw new Error('共享图片请使用公开 HTTPS 地址或飞书图片 token，不读取本地文件');
  args.push('--'+key+(v===true?'':'='+value));
 }
 return args;
}
export async function callFeishu(binding,name,input={}){
 await feishuIdentity(binding);
 let args;
 if(name==='feishu_help')args=[...feishuPath(input.path),'--help'];
 else if(name==='feishu_schema'){
  if(typeof input.method!=='string'||!FEISHU_DOMAINS.includes(input.method.split('.')[0])||!/^\w[\w.+-]{1,180}$/.test(input.method))throw new Error('请输入飞书业务接口名称');
  args=['schema',input.method];
 }else if(name==='feishu_call')args=[...feishuArgs(input),'--as','user'];
 else throw new Error('未知飞书工具');
 const r=await runFeishu(binding.command,['--profile',binding.profile,...args],{cwd:binding.cwd});
 // A concurrent local profile change must not silently rebind the connector.
 await feishuIdentity(binding);
 let data;try{data=JSON.parse(r.text);}catch{data=r.exitCode===0?r.text:null;}
 if(data?.error?.subtype==='missing_scope')data={...data,error:{...data.error,hint:'当前飞书账号尚未取得这些权限。请在原飞书应用中完成授权后检查连接；其他已授权能力仍可使用，不代表资源不存在。'}};
 const ok=r.exitCode===0&&data?.ok!==false;
 return {isError:!ok,content:[{type:'text',text:JSON.stringify(redactFeishu({ok,exitCode:r.exitCode,...(data!==null?{data}:{message:r.interrupted?'执行超时，结果未确认；请核对后再决定是否重试':r.exitCode===10?'该操作需要飞书官方确认；请在原环境按官方提示操作':'飞书调用失败，请检查登录、参数或所需权限'})}))}]};
}
export const FEISHU_TOOLS=[
 {name:'feishu_help',description:'查看飞书官方命令及所需权限。先查询领域（docs/drive/wiki/sheets/base/im/task/calendar 等）及命令帮助，再调用。仅已授权能力可用；缺权限不等于资源不存在。',inputSchema:{type:'object',properties:{path:{type:'array',items:{type:'string'}}},required:['path'],additionalProperties:false}},
 {name:'feishu_schema',description:'查看官方飞书接口参数、类型和权限，例如 drive.files.list；优先使用帮助中的 +快捷命令。',inputSchema:{type:'object',properties:{method:{type:'string'}},required:['method'],additionalProperties:false}},
 {name:'feishu_call',description:'以已连接的飞书用户执行官方业务命令。path 例 ["docs","+fetch"]，options 例 {"doc":"飞书文档链接","doc-format":"markdown"}。修改前先读原文，用 docs +update 局部修改并读回；不要自动创建副本或扩大分享。固定账号，不接受 auth/config/api/--yes 或本地文件参数。调用写操作后未收到确认不得盲目重试。权限未获批会返回官方错误，需用户在原平台授权。',inputSchema:{type:'object',properties:{path:{type:'array',items:{type:'string'}},options:{type:'object',additionalProperties:true}},required:['path'],additionalProperties:false}}
];
