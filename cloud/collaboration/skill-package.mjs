import {fail} from './repository.mjs';
import {readJSON} from './security.mjs';

export const fileText=value=>typeof value==='string'?value:null;
export function fileBytes(value){
 if(typeof value==='string')return new TextEncoder().encode(value);
 if(!value||value.encoding!=='base64'||typeof value.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))fail('invalid_skill','技能资源编码无效');
 return Uint8Array.from(atob(value.data),c=>c.charCodeAt(0));
}
export async function fileHash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',fileBytes(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export function resourceWarnings(files){
 const text=files['SKILL.md']||'',paths=[...new Set(String(text).match(/(?:scripts|references|assets)\/[a-zA-Z0-9_./-]+/g)||[])];
 return paths.filter(p=>!p.endsWith('/')&&!Object.hasOwn(files,p)).map(path=>({path,message:'正文引用了未随包提供的资源，请补齐或说明外部来源'}));
}
export async function importGithubSkill(sourceUrl,fetchImpl=fetch){
 let url;try{url=new URL(sourceUrl);}catch{fail('invalid_source','请填写公开 GitHub 技能目录或 SKILL.md 链接');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('invalid_source','请使用不含登录资料的 HTTPS GitHub 链接');
 let p;try{p=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);}catch{fail('invalid_source','技能来源路径编码无效');}let owner,repository,ref,folder;
 if(url.hostname==='raw.githubusercontent.com'&&p.length>=4&&p.at(-1)==='SKILL.md'){[owner,repository,ref]=p;folder=p.slice(3,-1).join('/');}
 else if(url.hostname==='github.com'&&p.length>=4&&['tree','blob'].includes(p[2])){[owner,repository]=p;ref=p[3];folder=p.slice(4).join('/');if(p[2]==='blob'){if(p.at(-1)!=='SKILL.md')fail('invalid_source','请选择 SKILL.md');folder=p.slice(4,-1).join('/');}}
 else fail('invalid_source','支持公开 GitHub 技能目录和 SKILL.md 原文链接');
 if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repository)||!ref||[ref,...folder.split('/')].some(x=>x==='..'||x==='.'||x.includes('\\')))fail('invalid_source','技能来源路径无效');
 const get=async path=>{let r;try{r=await fetchImpl('https://api.github.com/repos/'+owner+'/'+repository+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'DuolaWork'},redirect:'error',signal:AbortSignal.timeout(12000)});}catch{fail('source_unavailable','暂时无法读取技能来源，请稍后重试');}if(!r.ok)fail('source_unavailable',r.status===403||r.status===429?'GitHub 来源读取受限，请稍后重试或导入文件夹':'无法读取公开技能来源，请核对链接与版本');return readJSON(r,3000000);};
 const commit=await get('/commits/'+encodeURIComponent(ref));if(!/^[a-f0-9]{40}$/.test(commit.sha||''))fail('invalid_source','无法固定技能来源版本');
 const tree=await get('/git/trees/'+commit.sha+'?recursive=1');if(tree.truncated)fail('source_too_large','来源仓库目录过大，请直接导入技能文件夹');
 const prefix=folder?folder+'/':'';
 const entries=(tree.tree||[]).filter(x=>x.path.startsWith(prefix)&&x.type!=='tree');
 if(entries.some(x=>x.type!=='blob'||x.mode==='120000'))fail('invalid_skill','技能目录包含外部引用或符号链接，请导入实际文件');
 if(entries.length>40||entries.reduce((sum,x)=>sum+(x.size||0),0)>150000)fail('too_large','技能包最多40个文件、150KB，请选择具体技能目录');
 const files=Object.create(null);let total=0;
 for(const entry of entries){
  const blob=await get('/git/blobs/'+entry.sha);if(blob.encoding!=='base64'||typeof blob.content!=='string')fail('invalid_skill','技能来源文件格式不支持');
  const encoded={encoding:'base64',data:blob.content.replace(/\s/g,'')},bytes=fileBytes(encoded);total+=bytes.length;if(total>150000)fail('too_large','技能资源超过150KB');
  let content=encoded;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.includes('\0'))content=text;}catch{}
  files[entry.path.slice(prefix.length)]=content;
 }
 return {files,source:sourceUrl,sourceRevision:commit.sha,sourceRepository:owner+'/'+repository};
}
