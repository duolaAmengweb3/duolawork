import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Use the official project registry and session metadata. Never pick "latest",
// fabricate a title from a UUID, or inspect provider authentication material.
export class GeminiCliProjects {
  constructor({home=os.homedir(),execute=exec}={}){this.root=path.join(home,'.gemini');this.execute=execute;}
  async sessions(){
    let registry;try{registry=JSON.parse(await fs.readFile(path.join(this.root,'projects.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return{items:[],projects:[],existingHint:'请先在 Gemini CLI 打开项目。当前版本未提供可读取的项目登记表。'};throw Error('Gemini 项目登记表无法读取，原文件保留');}
    const items=[],projects=[];
    for(const [workspace,slug] of Object.entries(registry.projects||{})){
      if(!path.isAbsolute(workspace)||typeof slug!=='string'||!/^[a-z0-9-]+$/.test(slug))continue;
      projects.push({id:slug,name:path.basename(workspace),workspace});
      const dir=path.join(this.root,'tmp',slug,'chats');let files;try{files=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      for(const name of files.filter(f=>/^session-.*\.json$/.test(f))){
        const file=path.join(dir,name);if((await fs.stat(file)).size>20*1024*1024)continue;
        let s;try{s=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(s.sessionId||''))continue;
        const first=s.messages?.find(m=>m.type==='user');
        const text=typeof first?.content==='string'?first.content:Array.isArray(first?.content)?first.content.map(p=>p.text||'').join(' '):'';
        items.push({id:s.sessionId,title:s.summary||s.title||text.replace(/\s+/g,' ').slice(0,100)||'未命名对话',workspace,projectId:slug,projectName:path.basename(workspace),updatedAt:s.lastUpdated,source:'gemini-cli',mode:'existing'});
      }
    }return{items,projects};
  }
  async assertAvailable(workspace){
    const {stdout}=await this.execute('ps',['-ax','-o','pid=,args=']);
    for(const line of stdout.split('\n')){
      const m=line.match(/^\s*(\d+)\s+(.+)$/);if(!m||!/(?:\/|\s)gemini(?:\.js)?(?:\s|$)/.test(m[2])||/--(?:acp|experimental-acp)/.test(m[2]))continue;
      let cwd;try{if(process.platform==='linux')cwd=await fs.readlink('/proc/'+m[1]+'/cwd');else{const r=await this.execute('lsof',['-a','-p',m[1],'-d','cwd','-Fn']);cwd=r.stdout.split('\n').find(l=>l.startsWith('n'))?.slice(1);}}catch{throw Error('无法确认 Gemini 原终端是否还在使用该项目，未同时写入原对话');}
      if(cwd&&path.resolve(cwd)===path.resolve(workspace))throw Error('这个项目的 Gemini 终端还在打开。请完成当前工作并正常退出该终端，随后 Hub 会继续同一段对话；不会中断或另开替代对话。');
    }
  }
}
