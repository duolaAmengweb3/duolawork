import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNetworkRequest } from '../local/network.mjs';
import { createApi } from '../ui/v1/api.mjs';
import { startPolling } from '../ui/v1/polling.mjs';
import { proxyCollaboration } from '../local/collaboration-proxy.mjs';
import { requestNetwork } from '../local/transport.mjs';

const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', secret: 'never-log-this' } });
test('读取瞬断和临时 503 自动恢复，写入已到远端后断开不重发', async () => {
  const routes = [], events = [];
  let calls = 0;
  const request = createNetworkRequest({
    fetchImpl: async () => { if (++calls === 1) throw reset(); return new Response('saved'); },
    dispatcher: options => { routes.push(options.refresh); }, sleep: async () => {}, observe: event => events.push(event),
  });
  assert.equal(await request('https://fixture.invalid/?token=never-log-this', {}, r => r.text()), 'saved');
  assert.deepEqual(routes, [false, true]);
  assert.equal(events[0].kind, 'recovered');
  assert(!JSON.stringify(events).includes('never-log-this'));
  calls = 0;
  const transient = createNetworkRequest({ fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response('ok'), dispatcher: () => {}, sleep: async () => {} });
  assert.equal(await transient('https://fixture.invalid', {}, r => r.text()), 'ok');
  let saves = 0;
  const write = createNetworkRequest({ fetchImpl: async () => { saves++; throw reset(); }, dispatcher: () => {}, sleep: async () => {} });
  await assert.rejects(write('https://fixture.invalid', { method: 'POST', body: 'important' }), e => e.code === 'network_unavailable' && e.uncertain && e.status === 502);
  assert.equal(saves, 1);
});

test('超时总预算有限，业务错误不重试', async () => {
  let clock = 0, calls = 0;
  const budgets = [];
  const request = createNetworkRequest({
    now: () => clock, sleep: async ms => { clock += ms; }, dispatcher: () => {},
    signal: ms => { budgets.push(ms); return ms; },
    fetchImpl: async (_url, options) => { calls++; clock += options.signal; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
  });
  await assert.rejects(request('https://fixture.invalid', { timeout: 25000 }), e => e.code === 'network_timeout');
  assert.equal(calls, 2); assert.deepEqual(budgets, [12000, 12700]); assert.equal(clock, 25000);
  let businessCalls = 0;
  const business = createNetworkRequest({ fetchImpl: async () => { businessCalls++; return new Response('{}', { status: 401 }); }, dispatcher: () => {} });
  assert.equal((await business('https://fixture.invalid')).status, 401); assert.equal(businessCalls, 1);
});

test('前端读取重连，发送失败保留不确定状态且不重发', async () => {
  let count = 0;
  const api = createApi({ fetchImpl: async () => { if (++count === 1) throw new TypeError('Failed to fetch'); return Response.json({ items: [] }); }, sleep: async () => {} });
  assert.deepEqual(await api('/v2/channels'), { items: [] }); assert.equal(count, 2);
  count = 0;
  const failed = createApi({ fetchImpl: async () => { count++; throw new TypeError('Failed to fetch'); }, sleep: async () => {} });
  await assert.rejects(failed('/v2/commands', { type: 'channel.post' }), e => e.uncertain && !e.message.includes('fetch failed'));
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(failed('/v2/workspace'), e => e.code === 'local_connection_unavailable' && !e.uncertain);
  assert.equal(count, 2);
  count = 0;
  const brokenBody = createApi({ fetchImpl: async () => ++count === 1 ? { json: async () => { throw new TypeError('terminated'); } } : Response.json({ items: [] }), sleep: async () => {} });
  assert.deepEqual(await brokenBody('/v2/channel'), { items: [] }); assert.equal(count, 2);
});

test('慢刷新不叠加；失败后继续轮询、恢复后清提示、关闭后不再调度', async () => {
  let release, count = 0, cleared = 0, errors = 0, canceled;
  const scheduled = [];
  const stop = startPolling({
    run: async () => { count++; if (count === 1) await new Promise(resolve => { release = resolve; }); if (count === 2) throw reset(); },
    schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: id => { canceled = id; },
    onSuccess: () => { cleared++; }, onError: () => { errors++; },
  });
  assert.equal(count, 1); assert.equal(scheduled.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleared, 1); assert.equal(scheduled.length, 1);
  await scheduled[0](); assert.equal(errors, 1); assert.equal(scheduled.length, 2);
  await scheduled[1](); assert.equal(cleared, 2);
  stop(); assert.equal(canceled, 3);
  let later, schedules = 0;
  const stopEarly = startPolling({ run: () => new Promise(resolve => { later = resolve; }), schedule: () => { schedules++; }, onSuccess: () => assert.fail('unmounted callback') });
  stopEarly(); later(); await new Promise(resolve => setImmediate(resolve)); assert.equal(schedules, 0);
});

test('真实 HTTP 代理：读请求断流恢复，写入响应丢失只落一次', async t => {
  let reads = 0, writes = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume before committing */ }
    if (req.method === 'GET' && ++reads > 1) { res.setHeader('Content-Type', 'application/json'); res.end('{"items":[]}'); }
    else { if (req.method === 'POST') writes++; req.socket.destroy(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = http.createServer((req, res) => proxyCollaboration(req, res, { endpoint: `http://127.0.0.1:${upstream.address().port}`, adminKey: 'isolated-fixture' }).catch(e => {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: e.message, error: e.code, uncertain: e.uncertain }));
  }));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  assert.deepEqual(await (await fetch(base + '/api/v2/channels')).json(), { items: [] }); assert.equal(reads, 2);
  const response = await fetch(base + '/api/v2/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"channel.post"}' });
  assert.equal(response.status, 502); assert.equal((await response.json()).uncertain, true); assert.equal(writes, 1);
});

test('客户端取消和上游慢流超时不会抛未处理异常，后续请求仍可用', async t => {
  let upstreamCanceled = 0, reads = 0;
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/slow')) {
      res.write('{"partial":');
      res.once('close', () => { upstreamCanceled++; });
    } else { reads++; res.end('{"ok":true}'); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = http.createServer((req, res) => proxyCollaboration(req, res,
    { endpoint: `http://127.0.0.1:${upstream.address().port}`, adminKey: 'isolated-fixture' },
    { request: (url, options, consume) => requestNetwork(url, { ...options, timeout: 80 }, consume) },
  ).catch(() => res.destroy()));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const controller = new AbortController();
  const canceled = fetch(base + '/api/v2/slow', { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(canceled);
  // JSON headers are now withheld until the body is complete, so timeout
  // rejects the request itself instead of exposing a partial response.
  await assert.rejects(fetch(base + '/api/v2/slow'));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert(upstreamCanceled >= 2);
  assert.deepEqual(await (await fetch(base + '/api/v2/ok')).json(), { ok: true });
  assert.equal(reads, 1);
});
