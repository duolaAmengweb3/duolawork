// Optional once-per-workspace service provisioning, after build-server and
// isolated memory-service acceptance. Credentials are passed on stdin only.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
const directory=path.join(os.homedir(),'.config/agent-hub/server-deploy');
const target=JSON.parse(await fs.readFile(path.join(directory,'target.json'),'utf8'));
const embedding=JSON.parse(await fs.readFile(path.join(directory,'memory-embedding.json'),'utf8'));
const options=[...(target.identityFile?['-i',target.identityFile]:[]),...(target.directSSH?['-o','ProxyCommand=none']:[]),'-o','BatchMode=yes','-o','ServerAliveInterval=15'];
const run=(name,args,input)=>new Promise((resolve,reject)=>{const p=spawn(name,args,{stdio:[input===undefined?'inherit':'pipe','inherit','inherit']});if(input!==undefined)p.stdin.end(input);p.on('error',reject);p.on('exit',code=>code?reject(Error(name+' failed '+code)):resolve());});
await run('ssh',[...options,target.ssh,'bash -s'],`set -euo pipefail
install -d -m 755 /opt/duolawork-qdrant
if ! test -x /opt/duolawork-qdrant/qdrant; then
 curl --fail --location --max-time 180 -o /tmp/duolawork-qdrant.tar.gz https://github.com/qdrant/qdrant/releases/download/v1.18.3/qdrant-x86_64-unknown-linux-musl.tar.gz
 echo 'b4faedcdf8c9577bf1c8f2ab9b454636b87e056c116c99d49bd4f9fb2e634285  /tmp/duolawork-qdrant.tar.gz' | sha256sum -c -
 tar -xzf /tmp/duolawork-qdrant.tar.gz -C /opt/duolawork-qdrant
 rm /tmp/duolawork-qdrant.tar.gz
fi
install -d -o agenthub -g agenthub -m 700 /var/lib/agent-hub/qdrant
install -d -m 755 /opt/agent-hub-server/memory-runtime
`);
for(const file of ['main.mjs','package.json','package-lock.json','repository.mjs'])await run('scp',[...options,'release/server/memory-runtime/'+file,target.ssh+':/opt/agent-hub-server/memory-runtime/'+file]);
await run('scp',[...options,'release/server/memory-ledger.mjs',target.ssh+':/opt/agent-hub-server/memory-ledger.mjs']);
// Private configuration changes preserve every existing field, key and identity.
await run('ssh',[...options,target.ssh,"python3 -c \"import sys,json,os,shutil; p='/var/lib/agent-hub/server.json'; d=json.load(open(p)); shutil.copy2(p,p+'.before-memory'); d['memory']={'embedding':json.load(sys.stdin),'qdrant':{'url':'http://127.0.0.1:6333'},'dimension':1024,'port':8791}; open(p+'.tmp','w').write(json.dumps(d)); os.chmod(p+'.tmp',0o600); s=os.stat(p); os.chown(p+'.tmp',s.st_uid,s.st_gid); os.replace(p+'.tmp',p)\""],JSON.stringify(embedding));
await run('ssh',[...options,target.ssh,'bash -s'],`set -euo pipefail
cd /opt/agent-hub-server/memory-runtime
PATH=/opt/agent-hub-node/bin:$PATH /opt/agent-hub-node/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
cat > /etc/systemd/system/duolawork-qdrant.service <<'UNIT'
[Unit]
Description=DuolaWork shared memory vectors
After=network.target
[Service]
User=agenthub
Group=agenthub
WorkingDirectory=/var/lib/agent-hub/qdrant
Environment=QDRANT__SERVICE__HOST=127.0.0.1
Environment=QDRANT__SERVICE__HTTP_PORT=6333
Environment=QDRANT__SERVICE__GRPC_PORT=6334
Environment=QDRANT__STORAGE__STORAGE_PATH=/var/lib/agent-hub/qdrant/storage
Environment=QDRANT__STORAGE__PERFORMANCE__MAX_SEARCH_THREADS=1
Environment=QDRANT__TELEMETRY_DISABLED=true
ExecStart=/opt/duolawork-qdrant/qdrant
Restart=on-failure
RestartSec=5
MemoryHigh=128M
MemoryMax=192M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/agent-hub/qdrant
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/duolawork-memory.service <<'UNIT'
[Unit]
Description=DuolaWork shared memory indexing and retrieval
After=network-online.target duolawork-qdrant.service
Requires=duolawork-qdrant.service
[Service]
User=agenthub
Group=agenthub
Environment=HUB_SERVER_CONFIG=/var/lib/agent-hub/server.json
Environment=MEM0_TELEMETRY=false
ExecStart=/opt/agent-hub-node/bin/node --max-old-space-size=128 /opt/agent-hub-server/memory-runtime/main.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=25
MemoryHigh=192M
MemoryMax=256M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/agent-hub
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now duolawork-qdrant duolawork-memory
systemctl is-active duolawork-qdrant duolawork-memory
`);
console.log('Memory services provisioned; inspect status and real retrieval before release acceptance.');
