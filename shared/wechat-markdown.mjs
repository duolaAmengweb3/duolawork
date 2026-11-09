import {marked,Renderer} from 'marked';
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function renderWechatMarkdown(markdown){
 if(typeof markdown!=='string'||markdown.length>120000)throw Error('Markdown 正文无效或过大');
 const r=new Renderer();r.heading=function({tokens,depth}){return `<h${depth} style="font-size:${depth===1?24:depth===2?21:18}px;font-weight:700;line-height:1.5;margin:24px 0 12px;color:#172b4d">${this.parser.parseInline(tokens)}</h${depth}>`;};
 r.paragraph=function({tokens}){return `<p style="font-size:16px;line-height:1.9;margin:14px 0;color:#283548">${this.parser.parseInline(tokens)}</p>`;};
 r.blockquote=function({tokens}){return `<blockquote style="border-left:3px solid #4b75db;background:#f3f6fc;padding:8px 16px;margin:20px 0;color:#63728a">${this.parser.parse(tokens)}</blockquote>`;};
 r.code=({text})=>`<pre style="background:#172033;color:#e6edf7;padding:16px;border-radius:8px;overflow:auto;white-space:pre-wrap;font-size:13px;line-height:1.7"><code>${escape(text)}</code></pre>`;
 r.codespan=({text})=>`<code style="background:#eef2f8;padding:2px 4px;color:#315391;font-size:14px">${text}</code>`;
 r.html=({text})=>escape(text);
 r.image=({href,text})=>/^https?:\/\//i.test(href)?`<img src="${escape(href)}" alt="${escape(text)}" style="max-width:100%;height:auto;display:block;margin:18px auto"/>`:escape(text);
 r.link=function({href,tokens}){const text=this.parser.parseInline(tokens);return /^https?:\/\//i.test(href)?`<a href="${escape(href)}" style="color:#3767be;text-decoration:none">${text}</a>`:text;};
 return `<section style="max-width:100%;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;word-wrap:break-word">${marked.parse(markdown,{renderer:r,gfm:true,breaks:true,async:false})}</section>`;
}
