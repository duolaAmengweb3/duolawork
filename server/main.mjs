import http from 'node:http';
import {memoryClient} from './memory-client.mjs';
import {forgottenLedger,scrubMemoryReceipts} from './memory-ledger.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from './worker.mjs';
import { openDatabase } from './sqlite.mjs';
import { diskObjects } from './object-store.mjs';
import { cleanUploads } from './object-maintenance.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.HUB_SERVER_CONFIG;
if (!configPath) throw new Error('HUB_SERVER_CONFIG is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.adminKey || !config.publicOrigin || !config.workspaceId) throw new Error('Missing private server configuration');
const origins = new Set([config.publicOrigin, ...(config.compatibleOrigins || [])]);
for (const origin of origins) if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Expected HTTPS public origin');
const DB = openDatabase(config.database, path.join(directory, 'migrations'));
for(const entry of await forgottenLedger(DB,config.workspaceId,config.database,{restore:true}))await scrubMemoryReceipts(DB,config.workspaceId,entry.id);
const limits = new Map();
const env = {
  PERSIST_MEMORY_FORGET:async id=>{await forgottenLedger(DB,config.workspaceId,config.database);await scrubMemoryReceipts(DB,config.workspaceId,id);},
  MEMORY:config.memory?memoryClient('http://127.0.0.1:'+(config.memory.port||8791)):undefined,
  DB, ADMIN_KEY: config.adminKey, WORKSPACE_ID: config.workspaceId, FILE_STORAGE: 'd1',
  SHARED_FILE_STORAGE: 'disk', SHARED_FILES: diskObjects(config.objectDirectory || path.join(path.dirname(config.database),'objects')),
  SHARED_FILE_LIMIT: config.fileLimit || 128*1024*1024, SHARED_SPACE_QUOTA: config.spaceQuota || 2*1024*1024*1024,
  OAUTH_RATE_LIMIT: { async limit({ key }) {
    const now = Date.now(); let row = limits.get(key);
    if (!row || row.until < now) { row = { count: 0, until: now + 60000 }; limits.set(key, row); }
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    if (limits.size > 10000) return { success: false };
    return { success: ++row.count <= 45 };
  } },
};
let active = 0, watchers=0, scheduled = false, closing = false, lastObjectCleanup = 0;
const pending = new Set();
const ctx = { waitUntil(promise) { const p = Promise.resolve(promise).catch(() => console.error('background_operation_failed')).finally(() => pending.delete(p)); pending.add(p); } };
const equal = (a, b) => !!a && !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const server = http.createServer(async (req, res) => {
  const watching=req.method==='GET'&&req.url?.split('?')[0]==='/v2/changes';
  if (closing || (watching?watchers >= (config.maxWatchers||64):active >= (config.maxRequests || 128))) { res.writeHead(503, { 'Retry-After': '3' }); res.end('Service busy'); return; }
  if(watching)watchers++;else active++;
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    let origin = config.publicOrigin;
    const forwarded = req.headers['x-hub-public-origin'];
    if (forwarded) {
      if (!origins.has(forwarded) || !equal(req.headers['x-hub-gateway-secret'], config.gatewaySecret)) {
        res.writeHead(403); res.end('Invalid gateway'); return;
      }
      origin = forwarded;
    }
    const headers = new Headers();
    for (const [key, v] of Object.entries(req.headers)) if (v !== undefined && !['host', 'connection', 'transfer-encoding', 'x-hub-gateway-secret', 'x-hub-public-origin', 'cf-connecting-ip'].includes(key)) headers.set(key, Array.isArray(v) ? v.join(', ') : v);
    headers.set('CF-Connecting-IP', (forwarded ? req.headers['x-hub-client-ip'] : null) || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (Number(req.headers['content-length'] || 0) > 12 * 1024 * 1024) { res.writeHead(413); res.end('Request too large'); return; }
      body = Readable.toWeb(req);
    }
    const url = new URL(req.url, origin);
    if (url.origin !== origin) { res.writeHead(400); res.end('Invalid request target'); return; }
    const request = new Request(url, { method: req.method, headers, body, ...(body ? { duplex: 'half' } : {}), signal: abort.signal });
    const response = await worker.fetch(request, env, ctx);
    res.statusCode = response.status;
    for (const [key, v] of response.headers) if (!['transfer-encoding', 'connection'].includes(key)) res.setHeader(key, v);
    if (typeof response.headers.getSetCookie === 'function' && response.headers.getSetCookie().length) res.setHeader('set-cookie', response.headers.getSetCookie());
    res.setHeader('X-Hub-Backend', 'vps');
    if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '3' }); res.end(JSON.stringify({ error: 'temporarily_unavailable', message: '服务暂时不可用，请重试；原消息和登录保留' })); }
    else res.destroy();
    if (!abort.signal.aborted) console.error('request_failed', error?.name || 'Error');
  } finally { if(watching)watchers--;else active--; }
});
server.headersTimeout = 15000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 65000;
server.maxConnections = config.maxConnections || 256;
server.listen(config.port || 8787, '127.0.0.1', () => console.log('Agent Hub server listening on loopback'));
async function maintenance() {
  if (scheduled || closing || !config.enableScheduled) return;
  scheduled = true;
  try { await worker.scheduled({}, env, ctx); if(Date.now()-lastObjectCleanup>3600000){await cleanUploads(DB,config.workspaceId,env.SHARED_FILES);lastObjectCleanup=Date.now();} } catch { console.error('maintenance_failed'); } finally { scheduled = false; }
}
const timer = setInterval(maintenance, 60000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (closing) return;
  closing = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 110000).unref();
  server.close(async () => { await Promise.allSettled([...pending]); clearTimeout(deadline); DB.close(); process.exit(0); });
  server.closeIdleConnections();
});
