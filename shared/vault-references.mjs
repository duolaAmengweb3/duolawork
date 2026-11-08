const pattern=/vault:\/\/(credential_[a-zA-Z0-9_-]{1,100})\/([A-Za-z_][A-Za-z0-9_-]{0,63})/g;
export const vaultReference=(id,field)=>`vault://${id}/${field}`;
export function vaultReferences(value){
 const found=[];
 const walk=(v,location='')=>{if(typeof v==='string')for(const m of v.matchAll(pattern))found.push({reference:m[0],credentialId:m[1],field:m[2],location});else if(Array.isArray(v))v.forEach((x,i)=>walk(x,location+'.'+i));else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))walk(x,location?location+'.'+k:k);};
 walk(value);return found;
}
export function replaceVaultReferences(value,values){
 if(typeof value==='string')return value.replace(pattern,reference=>{if(!values.has(reference))throw Error('凭证引用未解析');return values.get(reference);});
 if(Array.isArray(value))return value.map(v=>replaceVaultReferences(v,values));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceVaultReferences(v,values)]));
 return value;
}
export function concealSecrets(value,secrets){
 const forms=new Set();for(const v of secrets){if(typeof v!=='string'||!v)continue;forms.add(v);forms.add(JSON.stringify(v).slice(1,-1));forms.add(encodeURIComponent(v));const bytes=new TextEncoder().encode(v);let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));forms.add(btoa(raw));}
 const strings=[...forms].filter(Boolean).sort((a,b)=>b.length-a.length);
 const walk=v=>typeof v==='string'?strings.reduce((s,key)=>s.split(key).join('[已隐藏]'),v):Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[strings.reduce((s,key)=>s.split(key).join('[已隐藏]'),k),walk(x)])):v;
 return walk(value);
}
