import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
import {presentSessions,sessionProjects} from '../local/session-presentation.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[],saves=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const members=[];
 for(const [id,name]of [['codex','Codex'],['antigravity','Gemini'],['deepseek-harness','DeepSeek'],['claude-code','Claude']]){
  await h.request('/admin/action',{type:'platform.create',payload:{id,name}});members.push(await h.member(id,name));
 }
 const group=await h.command('channel.create',{name:'项目选择验收',memberIds:members.map(m=>m.id)});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,17),config:{endpoint:h.base,adminKey:h.key,runnerId:'session-picker-test'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));
 let failure='',slow=false;
 await p.route('**/api/local/chat-sessions**',async route=>{
  if(route.request().method()==='POST'){
   saves.push(route.request().postDataJSON());if(slow)await new Promise(r=>setTimeout(r,700));
   return route.fulfill({status:failure?400:200,json:failure?{message:failure}:{ok:true}});
  }
  const id=new URL(route.request().url()).searchParams.get('memberId'),member=members.find(m=>m.id===id);
  const items=presentSessions([{id:'one',title:'购物车修复',workspace:'/work/store',projectName:'我的商店',projectId:'p1',source:'desktop'},{id:'two',title:'支付接口',workspace:'/work/store',projectName:'我的商店',projectId:'p1',source:'desktop'},{id:'other',title:'另一个项目',workspace:'/client/store',source:'desktop'},{id:'legacy',title:'原工作会话',workspace:'/hub/coding/internal',mode:'new'}],{dataDir:'/hub',platform:member.name,bindings:{[group.id]:{sessionId:'legacy'}},channels:[group]});
  return route.fulfill({json:{record:{enabled:true},capabilities:{create:!['claude-code','antigravity'].includes(member.platformId)},items,projects:sessionProjects(items),binding:null}});
 });
 await p.goto(local.url);await p.getByRole('button',{name:/项目选择验收/}).first().click();
 for(const member of members){
  await p.getByRole('button',{name:member.name+' · 选择项目与对话',exact:true}).click();const dialog=p.getByRole('dialog');
  await dialog.getByRole('button',{name:/我的商店 2 段对话/}).click();await dialog.getByRole('radio',{name:/购物车修复/}).click();
  assert.equal(await dialog.getByRole('radio').count(),2);assert.equal(await dialog.getByText('原工作会话',{exact:true}).count(),0);
  if(member.name==='Codex'){await fs.mkdir('evidence',{recursive:true});await p.screenshot({path:'evidence/session-picker-dialogs.png'});}
  await dialog.getByRole('button',{name:'继续这段对话',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(saves.at(-1).sessionId,'one');assert.equal(saves.at(-1).memberId,member.id);
  checks.push(member.name+' 按项目选择准确对话');
 }
 await p.getByRole('button',{name:'Codex · 选择项目与对话',exact:true}).click();let d=p.getByRole('dialog');await p.screenshot({path:'evidence/session-picker-projects.png'});
 await d.getByRole('textbox',{name:'搜索项目',exact:true}).fill('/client');assert.equal(await d.getByRole('button',{name:/段对话/}).count(),1);await d.getByRole('textbox',{name:'搜索项目',exact:true}).fill('');
 await d.getByRole('button',{name:/我的商店 2 段对话/}).click();await d.getByRole('button',{name:'在此项目新建对话',exact:true}).click();assert.equal(await d.getByLabel('新对话项目').inputValue(),'/work/store');
 failure='原生进程已退出 SIGTERM';await d.getByRole('button',{name:'创建并使用',exact:true}).click();await d.getByRole('alert').getByText(/与 Agent 的连接暂时中断/).waitFor();assert.equal((await d.innerText()).includes('SIGTERM'),false);checks.push('错误友好呈现，原选择和项目保留');
 failure='';slow=true;const count=saves.length;await d.getByRole('button',{name:'创建并使用',exact:true}).click();assert.equal(await d.getByRole('button',{name:/正在创建对话/}).isDisabled(),true);await d.waitFor({state:'hidden'});assert.equal(saves.length,count+1);assert.equal(saves.at(-1).workspace,'/work/store');checks.push('原项目内新建、提交期间禁用，避免重复创建');
 assert.deepEqual(errors,[]);await fs.writeFile('evidence/session-picker-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'isolated UI and protocol fixtures, not native agent acceptance',checks,errors},null,2));console.log(JSON.stringify({checks}));
}finally{await browser?.close();await local?.close();await h.stop();}
