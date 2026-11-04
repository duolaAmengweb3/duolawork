import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { requestJson } from '../local/transport.mjs';

const privateDir = path.join(os.homedir(), '.config/agent-hub');
const config = JSON.parse(await fs.readFile(path.join(privateDir, 'config.json'), 'utf8'));
const target = JSON.parse(await fs.readFile(path.join(privateDir, 'server-deploy/target.json'), 'utf8'));
if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target.ssh)) throw Error('Invalid SSH deployment target');
const active = await requestJson(target.origin + '/v2/active-work', { token: config.adminKey });
if (active.active) throw Error('已有成员正在工作，保留当前服务，等任务结束后再发布。');
const run = (binary, args, input) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (input !== undefined) child.stdin.end(input);
  child.on('error', reject); child.on('exit', code => code ? reject(Error(`${binary} failed (${code})`)) : resolve());
});
await run(process.execPath, ['scripts/build-server.mjs']);
await run(process.execPath, ['tests/server-http.mjs']);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-server-release-'));
const archive = path.join(directory, 'release.tar.gz');
const control = process.env.HUB_SSH_CONTROL ? ['-o', 'ControlPath=' + process.env.HUB_SSH_CONTROL] : [];
try {
  await run('tar', ['-czf', archive, '-C', 'release/server', '.']);
  await run('scp', [...control, archive, target.ssh + ':/var/lib/agent-hub/release-upload.tar.gz']);
  await run('ssh', [...control, target.ssh, 'bash -s'], `set -euo pipefail
tar -tzf /var/lib/agent-hub/release-upload.tar.gz >/dev/null
tar -czf /var/backups/agent-hub-repurpose/previous-server-release.tar.gz -C /opt/agent-hub-server .
systemctl stop agent-hub
tar -xzf /var/lib/agent-hub/release-upload.tar.gz -C /opt/agent-hub-server
chown -R root:root /opt/agent-hub-server
systemctl start agent-hub
sleep 2
systemctl is-active --quiet agent-hub
curl -fsS http://127.0.0.1:8787/health
`);
  const health = await requestJson(target.origin + '/health');
  const state = await requestJson(target.origin + '/admin/state', { token: config.adminKey });
  if (!health.ok || !Array.isArray(state.members)) throw Error('Deployed server verification failed');
  console.log('VPS backend deployed and authenticated read verified; existing configuration and database retained.');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
