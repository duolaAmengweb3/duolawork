import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {startNodeHarness} from './node-server-harness.mjs';
const h=await startNodeHarness(),home=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-tool-package-'));
try{
 const created=await h.request('/v2/connectors',{action:'host.create',name:'isolated package host',requestId:'package-host'});
 const program=await fetch(h.base+'/v2/connectors/host/download'),bytes=Buffer.from(await program.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),program.headers.get('x-content-sha256'));
 const file=path.join(home,'download.cjs'),bin=path.join(home,'bin');await fs.writeFile(file,bytes);await fs.mkdir(bin);for(const name of ['launchctl','systemctl'])await fs.writeFile(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o700});
 const bootstrap=path.join(home,'test-bootstrap.cjs');await fs.writeFile(bootstrap,"if(process.getuid?.()===0)process.getuid=()=>1000;\n");
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require',bootstrap,file,'setup'],{env:{...process.env,HOME:home,AGENT_HUB_DATA_DIR:path.join(home,'isolated-data'),PATH:bin+':'+process.env.PATH},stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.stdin.end(JSON.stringify({endpoint:h.base,hostId:created.hostId,code:created.code}));p.once('error',reject);p.once('exit',code=>code?reject(Error(output)):resolve(output));});
 const first=await run(),config=JSON.parse(await fs.readFile(path.join(home,'.config/duolawork-tool-host/config.json'),'utf8'));assert.equal(config.hostId,created.hostId);assert.equal(first.includes(config.token),false);assert.equal((await fs.stat(path.join(home,'.config/duolawork-tool-host/config.json'))).mode&0o777,0o600);
 assert.equal((await h.request('/v2/connectors?action=hosts')).items[0].online,false,'pairing is not a running heartbeat');await run();assert.equal(JSON.parse(await fs.readFile(path.join(home,'.config/duolawork-tool-host/config.json'),'utf8')).token,config.token,'setup retry retains its same private key');
 assert.ok((await fs.stat(path.join(home,'.local/share/duolawork-tool-host/host.cjs'))).size>0);
 const evidence={at:new Date().toISOString(),scope:'Downloaded standalone package, actual Node subprocess and isolated HTTP backend. Service-manager binaries stubbed; no real OS service or user account modified.',checks:['下载字节 SHA-256 与服务端声明一致','独立程序无源码或 npm 依赖即可完成配对','长期凭证仅保存为 0600 本机文件，不进入输出','setup 重试沿用同一凭证','仅配对未收到心跳时不显示在线','程序保存到稳定独立目录']};await fs.writeFile('/tmp/duolawork-tool-host-package.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await h.stop();await fs.rm(home,{recursive:true,force:true});}
