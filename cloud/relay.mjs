// Preserve old connector URLs after an explicit backend cutover. Never fall
// back to the former database: that would create two writable workspaces.
export async function relayRequest(request, env, fetcher = fetch) {
  if (env.HUB_MAINTENANCE === '1') return Response.json({ error: 'maintenance', message: '协作服务正在切换，消息和登录保留，请稍后重试' }, { status: 503, headers: { 'Retry-After': '3', 'Cache-Control': 'no-store' } });
  if (!env.HUB_RELAY_ORIGIN) return null;
  try {
    const source = new URL(request.url), target = new URL(env.HUB_RELAY_ORIGIN);
    if (!env.HUB_RELAY_SECRET || target.protocol !== 'https:' || target.origin === source.origin || target.username || target.password || target.pathname !== '/') throw Error('Invalid relay configuration');
    target.pathname = source.pathname; target.search = source.search;
    const headers = new Headers(request.headers);
    for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'x-hub-public-origin', 'x-hub-gateway-secret', 'x-hub-client-ip']) headers.delete(key);
    headers.set('X-Hub-Public-Origin', source.origin);
    headers.set('X-Hub-Gateway-Secret', env.HUB_RELAY_SECRET);
    headers.set('X-Hub-Client-IP', request.headers.get('CF-Connecting-IP') || 'unknown');
    const response = await fetcher(target, { method: request.method, headers, ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}), redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(95000)]) });
    const out = new Headers(response.headers); out.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers: out });
  } catch {
    return Response.json({ error: 'relay_unavailable', message: '协作服务暂时不可用，原数据保留，请重试' }, { status: 503, headers: { 'Retry-After': '3', 'Cache-Control': 'no-store' } });
  }
}
