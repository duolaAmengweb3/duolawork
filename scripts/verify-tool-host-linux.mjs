import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const target=JSON.parse(await fs.readFile(path.join(os.homedir(),'.config/agent-hub/server-deploy/target.json'),'utf8'));
if(!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target.ssh))throw Error('Invalid deployment host');
const options=[...(target.identityFile?['-i',target.identityFile]:[]),...(target.directSSH?['-o','ProxyCommand=none']:[])];if(process.env.HUB_SSH_CONTROL)options.push('-o','ControlPath='+process.env.HUB_SSH_CONTROL);
const remote=execFileSync('ssh',[...options,target.ssh,'mktemp -d /tmp/duolawork-mcp-candidate-XXXXXX'],{encoding:'utf8',timeout:30000}).trim();if(!/^\/tmp\/duolawork-mcp-candidate-[A-Za-z0-9]+$/.test(remote))throw Error('Unexpected isolated test directory');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-linux-upload-')),archive=path.join(directory,'candidate.tgz');
try{
 await fs.copyFile('tests/mcp-host-linux-proof.mjs','release/server/proof.mjs');await fs.copyFile('tests/fixtures/mcp-stdio.mjs','release/server/mcp-stdio.mjs');
 execFileSync('tar',[...(process.platform==='darwin'?['--no-xattrs']:[]),'-czf',archive,'-C','release/server','.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});execFileSync('scp',[...options,archive,target.ssh+':'+remote+'/candidate.tgz'],{timeout:120000});
 const output=execFileSync('ssh',[...options,target.ssh,'bash -s'],{input:'set -euo pipefail\ncd '+remote+'\ntar -xzf candidate.tgz\n/opt/agent-hub-node/bin/node proof.mjs\n',encoding:'utf8',timeout:120000});
 const result=JSON.parse(output.trim().split('\n').at(-1));await fs.writeFile('docs/evidence/mcp-connectors-20261108/linux-vps.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{execFileSync('ssh',[...options,target.ssh,'rm -rf -- '+remote],{timeout:30000});await fs.rm(directory,{recursive:true,force:true});await fs.rm('release/server/proof.mjs',{force:true});await fs.rm('release/server/mcp-stdio.mjs',{force:true});}
