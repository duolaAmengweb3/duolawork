import React,{forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {EditorContent,useEditor,useEditorState} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import {presentationMarkdown} from '../shared/document-format.mjs';
import {TableKit} from '@tiptap/extension-table';
import {Bold,Italic,List,ListOrdered,Quote,Undo2,Redo2,Heading2,Check,AlertCircle,RotateCcw,Copy,Download,PenLine} from 'lucide-react';

const extensions=[StarterKit.configure({link:{openOnClick:false,protocols:['https','http'],autolink:true}}),Markdown,TableKit];
async function request(id,value){const r=await fetch('/api/documents/'+id,value===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const result=await r.json();if(!r.ok)throw new Error(result.message||'文稿保存失败');return result;}
const journalKey=id=>'agent-hub-document-buffer-v1:'+id;


const Editor=forwardRef(function Editor({document:initial,onRewrite,onState,onReady},ref){
 const [saveState,setSaveState]=useState('saved'),[error,setError]=useState(''),[original,setOriginal]=useState(false),[copied,setCopied]=useState(false),[selection,setSelection]=useState('');
 const current=useRef(initial),buffer=useRef(initial.body),timer=useRef(null),saving=useRef(null),mounted=useRef(true),savedMessage=useRef(onState);
 savedMessage.current=onState;
 const publish=(state,message='')=>{if(mounted.current){setSaveState(state);setError(message);}savedMessage.current?.(state,message);};
 const writeJournal=()=>{try{localStorage.setItem(journalKey(initial.artifactId),JSON.stringify({body:buffer.current,revision:current.current.revision}));}catch{publish('error','浏览器暂存不可用，请保留此页面并立即保存文稿');}};
 const flush=async()=>{
  clearTimeout(timer.current);
  if(saving.current){await saving.current;if(buffer.current!==current.current.body)return flush();return current.current;}
  if(buffer.current===current.current.body)return current.current;
  publish('saving');const value=buffer.current;
  const job=request(initial.artifactId,{body:value,revision:current.current.revision}).then(next=>{
   current.current=next;
   if(buffer.current===value){localStorage.removeItem(journalKey(initial.artifactId));publish('saved');}else writeJournal();
   return next;
  }).catch(e=>{publish('error',e.message);throw e;}).finally(()=>{saving.current=null;});
  saving.current=job;const next=await job;if(buffer.current!==next.body)return flush();return next;
 };
 const editor=useEditor({extensions,content:presentationMarkdown(initial.body),contentType:'markdown',editorProps:{attributes:{class:'studio-prose',role:'textbox','aria-label':'文稿编辑器','aria-multiline':'true',spellcheck:'false'}},onUpdate:({editor})=>{buffer.current=editor.getMarkdown();writeJournal();publish('unsaved');clearTimeout(timer.current);timer.current=setTimeout(()=>flush().catch(()=>{}),650);},onSelectionUpdate:({editor})=>{const {from,to}=editor.state.selection;setSelection(editor.state.doc.textBetween(from,to,' ').trim());}});
 const state=useEditorState({editor,selector:({editor})=>editor?{bold:editor.isActive('bold'),italic:editor.isActive('italic'),heading:editor.isActive('heading'),bullet:editor.isActive('bulletList'),ordered:editor.isActive('orderedList'),quote:editor.isActive('blockquote'),undo:editor.can().undo(),redo:editor.can().redo()}:null});
 useEffect(()=>{
  mounted.current=true;onReady?.(!!editor);
  try{const local=JSON.parse(localStorage.getItem(journalKey(initial.artifactId))||'null');if(local&&typeof local.body==='string'&&local.body!==initial.body){buffer.current=local.body;editor?.commands.setContent(presentationMarkdown(local.body),{contentType:'markdown',emitUpdate:false});if(local.revision===initial.revision){publish('unsaved');timer.current=setTimeout(()=>flush().catch(()=>{}),650);}else publish('error','发现尚未保存的修改，服务器已有新版本。请先复制当前文稿，再重新读取合并');}}catch{/* A journal never replaces a valid saved original. */}
  const saveKey=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();flush().catch(()=>{});}};
  window.addEventListener('keydown',saveKey);
  return()=>{mounted.current=false;clearTimeout(timer.current);window.removeEventListener('keydown',saveKey);if(buffer.current!==current.current.body)flush().catch(()=>{});};
 },[editor]);
 useImperativeHandle(ref,()=>({flush,body:()=>original?initial.original:buffer.current,revision:()=>current.current.revision}),[original,editor]);
 useEffect(()=>{editor?.setEditable(!original,false);editor?.commands.setContent(presentationMarkdown(original?initial.original:buffer.current),{contentType:'markdown',emitUpdate:false});},[original,editor]);
 if(!editor)return null;
 const tools=[['撤销',Undo2,()=>editor.chain().focus().undo().run(),!state?.undo],['重做',Redo2,()=>editor.chain().focus().redo().run(),!state?.redo],['二级标题',Heading2,()=>editor.chain().focus().toggleHeading({level:2}).run(),false,state?.heading],['加粗',Bold,()=>editor.chain().focus().toggleBold().run(),false,state?.bold],['斜体',Italic,()=>editor.chain().focus().toggleItalic().run(),false,state?.italic],['无序列表',List,()=>editor.chain().focus().toggleBulletList().run(),false,state?.bullet],['有序列表',ListOrdered,()=>editor.chain().focus().toggleOrderedList().run(),false,state?.ordered],['引用',Quote,()=>editor.chain().focus().toggleBlockquote().run(),false,state?.quote]];
 return <div className="studio-editor">
  <div className="studio-formatbar"><div>{tools.map(([label,Icon,fn,disabled,active])=><button key={label} type="button" title={label} aria-label={label} aria-pressed={!!active} disabled={original||disabled} onMouseDown={e=>e.preventDefault()} onClick={fn} className={active?'active':''}><Icon size={15}/></button>)}</div><span>{original?'只读原稿':'可直接编辑'}</span><button className="studio-original" onClick={()=>setOriginal(v=>!v)}><RotateCcw size={13}/>{original?'返回工作稿':'查看原始交付'}</button></div>
  <div className="studio-page-scroll"><div className="studio-paper"><div className="studio-paper-kicker">{original?'AGENT ORIGINAL · 原始交付':'WORKING DOCUMENT · 工作稿'}</div><EditorContent editor={editor}/><div className="studio-paper-end"><span/>{original?'原始交付保留，不受工作稿修改影响':'你的修改会自动保存到这台电脑'}<span/></div></div></div>
  <div className="studio-editor-footer"><span role="status" className={saveState==='error'?'error':''}>{saveState==='saved'?<Check size={13}/>:saveState==='error'?<AlertCircle size={13}/>:<span className="studio-saving-dot"/>}{saveState==='saved'?'已保存至本机':saveState==='saving'?'正在保存…':saveState==='error'?'保存未完成':'修改待保存'}</span>{error&&<span className="studio-save-error" title={error}>{error}</span>}{saveState==='error'&&<button onClick={()=>flush().catch(()=>{})}>重试保存</button>}<span className="studio-charcount">{buffer.current.length.toLocaleString()} 字符</span><button onClick={()=>onRewrite(selection)}><PenLine size={13}/>{selection?'让 Agent 修改选中内容':'让 Agent 继续修改'}</button></div>
 </div>;
});

export default forwardRef(function DocumentPane({artifactId,onRewrite,onState,onReady},ref){
 const [document,setDocument]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0),inner=useRef(null);
 useEffect(()=>{let canceled=false;request(artifactId).then(v=>{if(!canceled){setDocument(v);setError('');}}).catch(e=>{if(!canceled)setError(e.message);});return()=>{canceled=true;};},[artifactId,reload]);
 useImperativeHandle(ref,()=>({flush:async()=>{if(!inner.current)throw new Error('文稿尚未读取完成');return inner.current.flush();},body:()=>inner.current?.body()||'',revision:()=>inner.current?.revision()||0}),[]);
 if(error)return <div role="alert" className="studio-load-error"><AlertCircle size={22}/><strong>文稿暂时未能读取</strong><p>{error}</p><button onClick={()=>setReload(v=>v+1)}>重新读取</button></div>;
 if(!document)return <div className="studio-load-error"><span className="studio-saving-dot"/>正在读取真实成果…</div>;
 return <Editor key={artifactId} ref={inner} document={document} onRewrite={onRewrite} onState={onState} onReady={onReady}/>;
});
