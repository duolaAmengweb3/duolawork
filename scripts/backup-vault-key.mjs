import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

// Operator recovery material: never printed, committed, or included in app/DB archives.
const privateDirectory=path.join(os.homedir(),'.config/agent-hub/server-deploy');
const target=JSON.parse(await fs.readFile(path.join(privateDirectory,'target.json'),'utf8'));
if(!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target.ssh))throw Error('Invalid SSH target');
const options=[...(process.env.HUB_SSH_CONTROL?['-o','ControlPath='+process.env.HUB_SSH_CONTROL]:[]),...(target.identityFile?['-i',target.identityFile]:[]),...(target.directSSH?['-o','ProxyCommand=none']:[])];
const command=`python3 - <<'PY'
import json,pathlib
c=json.loads(pathlib.Path('/var/lib/agent-hub/server.json').read_text())
key=c.get('vaultEncryptionKey')
if key is None:
 p=pathlib.Path(c.get('vaultKeyDirectory',pathlib.Path(c['database']).parent / '.vault-keys')) / 'recovery.key'
 key=p.read_text().strip()
print(json.dumps({'key':key,'workspace':c['workspaceId']}))
PY`;
const {stdout}=await promisify(execFile)('ssh',[...options,target.ssh,command],{maxBuffer:8192});const data=JSON.parse(stdout);
if(typeof data.key!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(data.key)||Buffer.from(data.key,'base64').length!==32)throw Error('Vault recovery material unavailable');
const hash=value=>createHash('sha256').update(value).digest('hex');const keyId=hash(data.key).slice(0,16),directory=path.join(privateDirectory,'vault-recovery',hash(data.workspace).slice(0,16));
await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(path.dirname(directory),0o700);await fs.chmod(directory,0o700);const file=path.join(directory,keyId+'.key');
try{const out=await fs.open(file,'wx',0o600);try{await out.writeFile(data.key+'\n');await out.sync();}finally{await out.close();}}catch(e){if(e.code!=='EEXIST')throw e;if((await fs.readFile(file,'utf8')).trim()!==data.key)throw Error('Existing Vault recovery copy mismatch');}
await fs.chmod(file,0o600);if(hash((await fs.readFile(file,'utf8')).trim()).slice(0,16)!==keyId)throw Error('Vault recovery verification failed');delete data.key;
console.log(JSON.stringify({vaultRecovery:'saved outside server and source tree',keyId,mode:'0600'}));
