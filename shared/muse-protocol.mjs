export const resultStart=id=>`<<<HUB_RESULT_${id}>>>`;
export const resultEnd=id=>`<<<HUB_END_${id}>>>`;
export const resultSources=id=>`<<<HUB_SOURCES_${id}>>>`;
export function parseMuseResult(text,id){
 const start=resultStart(id),end=resultEnd(id),a=text.lastIndexOf(start);
 if(a<0)return null;const b=text.indexOf(end,a+start.length);if(b<0)return null;
 let raw=text.slice(a+start.length,b).trim();
 const split=raw.lastIndexOf(resultSources(id));
 if(split>=0){try{const sources=JSON.parse(raw.slice(split+resultSources(id).length).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));const body=raw.slice(0,split).trim().replace(/^```(?:json|text|markdown)?\s*\n/i,'').replace(/\n```$/,'');if(!body||!Array.isArray(sources))return null;return{body,sources:sources.filter(s=>typeof s==='string'&&/^https:\/\//.test(s))};}catch{return null;}}
 raw=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try{const value=JSON.parse(raw);if(value.id!==id||value.status!=='complete'||typeof value.body!=='string'||!value.body.trim())return null;return{body:value.body,sources:Array.isArray(value.sources)?value.sources.filter(s=>typeof s==='string'&&/^https:\/\//.test(s)):[]};}
 catch{
  // Legacy: Markdown rendering may consume quote escapes around a JSON body.
  // Recover only an exact current-id envelope whose inner body is itself valid
  // JSON, without generating, rewriting or guessing any part of its content.
  const prefix=JSON.stringify({id,status:'complete'}).slice(0,-1)+',"body":"';
  if(!raw.startsWith(prefix))return null;const delimiter='","sources":',at=raw.lastIndexOf(delimiter);if(at<prefix.length||!raw.endsWith('}'))return null;
  try{const body=raw.slice(prefix.length,at);JSON.parse(body);const sources=JSON.parse(raw.slice(at+delimiter.length,-1));if(!Array.isArray(sources))return null;return{body,sources:sources.filter(s=>typeof s==='string'&&/^https:\/\//.test(s))};}catch{return null;}
 }
}
