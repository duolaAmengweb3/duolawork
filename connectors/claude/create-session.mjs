import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {privateJson} from '../../local/storage.mjs';
import {macTerminalBridge} from './native-terminal.mjs';

const run=promisify(execFile),read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

export async function launchNative(binary,args,options){
  try{return await run(binary,args,options);}catch(e){
    if(!/Workspace not trusted/.test(e.stderr||'')||!options.createdEmptyWorkspace)throw e;
    // A user-requested, empty DuolaWork folder contains no third-party project
    // settings. Accept only its normal native trust prompt through a terminal;
    // never edit Claude's trust database or accept unrelated permission prompts.
    const mac=process.platform==='darwin',terminal=mac?'/usr/bin/python3':'/usr/bin/script';
    const argv=mac?['-c',macTerminalBridge,binary,...args]:['-q','-e','-c',[binary,...args].map(quote).join(' '),'/dev/null'];
    return new Promise((resolve,reject)=>{
      const p=spawn(terminal,argv,{cwd:options.cwd,env:options.env,detached:true,stdio:['pipe','pipe','pipe']});let text='',selected=false,sent=false,selectionOutput='',accepted=false,selectionTimer,confirmTimer;
      const clear=()=>{clearTimeout(timer);clearTimeout(selectionTimer);clearTimeout(confirmTimer);};
      const timer=setTimeout(()=>{try{process.kill(-p.pid,'SIGTERM');}catch{}clear();reject(Error('新对话正在等待原环境确认'));},30000);
      const data=d=>{text=(text+d.toString()).slice(-30000);if(sent)selectionOutput=(selectionOutput+d.toString()).slice(-10000);const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        const compact=plain.replace(/\s/g,'');
        // The first paint precedes Ink's input subscription. Sending arrow and
        // Enter together can select the default No, or be swallowed entirely.
        if(!selected&&compact.includes('Yes,Itrustthisfolder')&&compact.includes('❯No,exit')&&compact.includes(options.cwd.replace(/\s/g,''))){selected=true;selectionTimer=setTimeout(()=>{sent=true;p.stdin.write('\x1b[B');},1000);}
        // Confirm only after the native terminal visibly selects this option.
        // With colour disabled Ink redraws only the arrow, one row below No.
        const movedToYes=/\x1b\[1B(?:\x1b\[[0-?]*[ -/]*[@-~])*❯/.test(selectionOutput);
        if(sent&&!accepted&&(compact.includes('❯Yes,Itrustthisfolder')||movedToYes)){accepted=true;confirmTimer=setTimeout(()=>p.stdin.write('\r'),150);}
      };
      p.stdout.on('data',data);p.stderr.on('data',data);p.on('error',e=>{clear();reject(e);});p.on('exit',code=>{clear();code===0?resolve({stdout:text}):reject(Error('新对话未启动，请在原环境查看 Claude 的提示'));});
    });
  }
}

// Use the running native Claude, never download a different agent or read its
// credentials. Preserve explicit model/effort options when the parent has them.
export async function nativeLauncher(session,{execute=run,readFile=fs.readFile,readlink=fs.readlink}={}){
  if(!session.pid)return null;
  try{
    let binary,args=[];
    if(process.platform==='linux'){
      binary=await readlink('/proc/'+session.pid+'/exe');
      args=(await readFile('/proc/'+session.pid+'/cmdline','utf8')).split('\0');
    }else{
      binary=(await execute('/bin/ps',['-o','comm=','-p',String(session.pid)],{timeout:2000})).stdout.trim();
      await execute('/usr/bin/python3',['-c','import pty'],{timeout:5000});
    }
    if(!path.isAbsolute(binary))return null;
    const {stdout}=await execute(binary,['--help'],{timeout:10000,maxBuffer:100000});
    if(!['--bg','--name'].every(flag=>stdout.includes(flag)))return null;
    const options=[];
    for(let i=0;i<args.length;i++)if(['--model','--effort','--agent'].includes(args[i])&&args[i+1])options.push(args[i],args[++i]);
    return {binary,options};
  }catch{return null;}
}

export class NativeSessionCreator {
  constructor({connectionDir,client,launcher,execute=launchNative,query=run,now=Date.now}){Object.assign(this,{connectionDir,client,launcher,execute,query,now});this.jobs=new Map();}
  tick(session,commands=[]){
    for(const c of commands.filter(c=>c.engine==='claude'&&c.runtimeId===session.runtimeId&&c.status==='pending')){
      if(this.jobs.has(c.id))continue;
      const job=this.advance(session,c).catch(()=>{}).finally(()=>this.jobs.delete(c.id));this.jobs.set(c.id,job);
    }
  }
  action(session,c,action,extra={}){
    return this.client.api('/v2/self/native-sessions',{method:'POST',body:{action,commandId:c.id,sessionId:session.sessionId,instanceId:session.instanceId,requestId:randomUUID(),...extra}});
  }
  async advance(session,c){
    if(!/^nativecmd_[a-zA-Z0-9_-]+$/.test(c.id)||!/^channel_[a-zA-Z0-9_-]+$/.test(c.channelId))throw Error('创建请求无效');
    const command=await this.action(session,c,'claim-create');if(!command.owned)return;
    const file=path.join(this.connectionDir,'create-commands',c.id+'.json');let state;
    try{state=await read(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!state){
      try{
        let workspace=c.workspace;
        if(!workspace){workspace=path.join(this.connectionDir,'workspaces',c.channelId);await fs.mkdir(workspace,{recursive:true,mode:0o700});}
        workspace=await fs.realpath(workspace);if(!(await fs.stat(workspace)).isDirectory())throw Error('not_directory');
        state={workspace,startedAt:this.now(),stage:'launching'};
        // Exclusive journal creation is the final guard against two processes
        // issuing the same native launch after a reconnect or retry.
        await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
        try{await fs.writeFile(file,JSON.stringify(state),{flag:'wx',mode:0o600});}
        catch(e){if(e.code==='EEXIST')return;throw e;}
        const env={...process.env};for(const key of ['CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_CODE_CHILD_SESSION','CLAUDE_PID','CLAUDE_CODE_SESSION_ATTENDED','CLAUDE_CODE_AGENT','CLAUDE_CODE_ENTRYPOINT','CLAUDE_JOB_DIR','CLAUDE_CODE_EXECPATH'])delete env[key];
        // The official native background session owns execution and history.
        // No initial model task, shell wrapper, provider override or global edit.
        const createdEmptyWorkspace=!c.workspace&&(await fs.readdir(workspace)).length===0;
        const result=await this.execute(this.launcher.binary,['--bg','--name',c.title,'--dangerously-skip-permissions',...this.launcher.options],{cwd:workspace,env,timeout:30000,maxBuffer:200000,createdEmptyWorkspace});
        const plain=(result.stdout||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        state.nativeShortId=plain.match(/backgrounded\s*·\s*([a-f0-9]{8,36})/i)?.[1];state.stage='started';await privateJson(file,state);
      }catch(e){
        if(!state){await this.action(session,c,'fail-create',{message:'Claude 所在环境无法打开这个项目文件夹，请选择该环境中已有的项目。'});return;}
        if(/Workspace not trusted/.test(e.stderr||'')){await this.action(session,c,'fail-create',{message:'Claude 尚未信任这个项目。请在原环境打开该项目并确认一次，或选择已经使用过的项目。'});return;}
        state.launchError=typeof e.code==='number'?'native_exit_'+e.code:'native_start_uncertain';await privateJson(file,state);
        // A timeout may follow a successful spawn. Never relaunch blindly;
        // wait for the exact new session's native monitor to register.
      }
    }
    if(!state.sessionId){
      // --bg owns its UUID. Resolve the actual result through official metadata,
      // rather than making up a session ID or selecting the newest conversation.
      const {stdout}=await this.query(this.launcher.binary,['agents','--all','--json'],{timeout:10000,maxBuffer:1000000});
      const candidates=JSON.parse(stdout).filter(s=>s.cwd===state.workspace&&s.name===c.title&&s.startedAt>=state.startedAt-1000&&(!state.nativeShortId||s.id===state.nativeShortId||s.sessionId===state.nativeShortId));
      if(candidates.length===1&&/^[0-9a-f-]{36}$/.test(candidates[0].sessionId)){
        state.sessionId=candidates[0].sessionId;await privateJson(file,state);
        await privateJson(path.join(this.connectionDir,'linked-sessions',state.sessionId+'.json'),{sessionId:state.sessionId,workspace:state.workspace,createdBy:c.id});
      }else{if(this.now()-state.startedAt>180000)await this.action(session,c,'fail-create',{message:'无法确认新对话是否启动，原对话保留。本次不会重复创建，请检查原环境。'});return;}
    }
    try{
      const result=await this.action(session,c,'complete-create',{workspace:state.workspace,createdSessionId:state.sessionId});
      if(result.status==='completed'){state.stage='completed';await privateJson(file,state);}
    }catch(e){
      if(e.status!==409)throw e;
      if(this.now()-state.startedAt>180000)await this.action(session,c,'fail-create',{message:'新对话尚未接通，原对话保留。请在 Claude 原环境检查新对话；本次不会重复创建。'});
    }
  }
}
