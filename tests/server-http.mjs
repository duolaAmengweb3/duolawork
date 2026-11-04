import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-server-http-'));
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(r => listener.close(r));
const key = crypto.randomUUID(), gatewaySecret = crypto.randomUUID();
const configPath = path.join(directory, 'config.json');
await fs.writeFile(configPath, JSON.stringify({ adminKey: key, gatewaySecret, workspaceId: 'isolated-server', publicOrigin: 'https://hub.example.com', compatibleOrigins: ['https://legacy.example.com'], database: path.join(directory, 'data.sqlite'), port, enableScheduled: false }), { mode: 0o600 });
let child, client;
const base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, ['release/server/main.mjs'], { env: { ...process.env, HUB_SERVER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', b => { error += b; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(error); }), new Promise((_, reject) => { const t = setTimeout(() => reject(Error('start timeout')), 10000); t.unref(); })]);
}
async function stop() { if (!child || child.exitCode !== null) return; const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
async function call(route, body, expected = 200) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
try {
  await start();
  assert.equal((await fetch(base + '/v2/channels')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { 'x-hub-public-origin': 'https://legacy.example.com', 'x-hub-gateway-secret': 'wrong' } })).status, 403);
  const discovery = await fetch(base + '/.well-known/oauth-protected-resource', { headers: { 'x-hub-public-origin': 'https://legacy.example.com', 'x-hub-gateway-secret': gatewaySecret } });
  assert.equal(discovery.status, 200); assert.match(await discovery.text(), /https:\/\/legacy.example.com/);
  const account = (await call('/admin/action', { type: 'account.create', payload: { platformId: 'muse', label: 'Isolated' } })).result;
  const member = (await call('/admin/action', { type: 'member.create', payload: { accountId: account.id, name: 'Isolated member', mode: 'connector' } })).result;
  const credential = await call('/admin/member-credential', { memberId: member.id });
  client = new Client({ name: 'standalone-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/v2/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + credential.token } } }));
  assert((await client.listTools()).tools.some(t => t.name === 'post_message'));
  const command = async (type, args = {}, expected = 200) => call('/v2/commands', { type, requestId: crypto.randomUUID(), ...args }, expected);
  const created = await command('channel.create', { name: 'Standalone server check', memberIds: [member.id] });
  const channel = created.result || created;
  const docResult = await command('channel.doc.create', { channelId: channel.id, title: 'Shared document', body: 'Version one' });
  const doc = docResult.result || docResult;
  await command('channel.doc.edit', { channelId: channel.id, documentId: doc.id, expectedVersion: 1, body: 'Version two', reason: 'test' });
  await command('channel.doc.edit', { channelId: channel.id, documentId: doc.id, expectedVersion: 1, body: 'Wrong overwrite', reason: 'conflict' }, 409);
  await Promise.all(Array.from({ length: 20 }, (_, i) => command('channel.post', { channelId: channel.id, body: 'Persisted message ' + i })));
  await client.close(); client = null;
  await stop(); await start();
  const view = await call('/v2/channel?id=' + channel.id);
  const savedDoc = await call('/v2/channel-doc?id=' + doc.id);
  assert(JSON.stringify(savedDoc).includes('Version two'));
  assert(JSON.stringify(view).includes('Persisted message 19'));
  assert(!JSON.stringify(view).includes('Wrong overwrite'));
  console.log('PASS: authorization, original-origin discovery, MCP, concurrent writes, conflict rejection, and process-restart persistence');
} finally { if (client) await client.close(); await stop(); await fs.rm(directory, { recursive: true, force: true }); }
