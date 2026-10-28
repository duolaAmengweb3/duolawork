import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DocumentStore,attachDocument} from '../local/documents.mjs';
test('工作稿重开保留修改，原始交付和历史单独留存，文件只限本机用户读取',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hub-documents-')),artifact={id:'artifact_fixture',taskId:'task_fixture'};
 try{const store=new DocumentStore(root),original='# 原始交付\n\n真实的原始文本。';assert.equal((await store.read(artifact,original)).revision,0);
 const first=await store.save(artifact,original,{revision:0,body:'# 用户修改\n\n已经改好的版本。'});assert.equal(first.revision,1);assert.equal(first.original,original);
 const restarted=new DocumentStore(root),loaded=await restarted.read(artifact,original);assert.equal(loaded.body,first.body);assert.equal(loaded.history[0].body,original);assert.equal((await fs.stat(store.file(artifact.id))).mode&0o777,0o600);
 const same=await restarted.save(artifact,original,{revision:0,body:first.body});assert.equal(same.revision,1,'同一内容的网络重试不制造额外版本');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('两个窗口同时保存时阻止旧版本覆盖新稿；损坏文件保留，不重建空稿',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hub-documents-conflict-')),artifact={id:'artifact_fixture',taskId:'task_fixture'};
 try{const store=new DocumentStore(root),results=await Promise.allSettled([store.save(artifact,'original',{revision:0,body:'first edit'}),store.save(artifact,'original',{revision:0,body:'stale edit'})]);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.find(v=>v.status==='rejected').reason.status,409);assert.equal((await store.read(artifact,'original')).body,'first edit');
 await fs.writeFile(store.file(artifact.id),'invalid preserved data');await assert.rejects(store.read(artifact,'original'),/保留原文件/);assert.equal(await fs.readFile(store.file(artifact.id),'utf8'),'invalid preserved data');assert.throws(()=>store.file('../outside'),/编号无效/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('继续改稿带上用户实际修改的全文与版本，禁止带入其他工作的稿件',()=>{
 const command={type:'task.followup',taskId:'task_fixture',payload:{instruction:'压缩成三点',message:'压缩成三点'}},body='用户自己改过的版本。'.repeat(2500);
 const next=attachDocument(command,{taskId:'task_fixture',body,revision:4});assert.ok(next.payload.instruction.includes(body));assert.match(next.payload.instruction,/版本 4/);assert.equal(command.payload.instruction,'压缩成三点');
 assert.throws(()=>attachDocument(command,{taskId:'task_other',body,revision:4}),/只能附上本次工作/);
});


test('非标准文档标题可读化不改社交标签或代码原文',async()=>{
 const {presentationMarkdown}=await import('../shared/document-format.mjs');
 assert.equal(presentationMarkdown('#标题\n##章节\n正文'),'# 标题\n## 章节\n正文');
 assert.equal(presentationMarkdown('#AI 今天的推文'),'#AI 今天的推文');
 assert.equal(presentationMarkdown('#标题\n##章节\n```\n##原样代码\n```'),'# 标题\n## 章节\n```\n##原样代码\n```');
});
