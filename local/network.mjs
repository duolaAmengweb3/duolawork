const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const transientStatus = new Set([408, 502, 503, 504]);
export function isNetworkError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    transientCodes.has(error?.cause?.code || error?.code) ||
    (error instanceof TypeError && /fetch|network|terminated/i.test(error.message));
}
export function networkError(error, method = 'GET') {
  const timeout = error?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(error?.cause?.code || error?.code || '');
  const read = ['GET', 'HEAD'].includes(method.toUpperCase());
  const result = new Error((timeout ? '连接云端超时。' : '暂时无法连接云端。') +
    (read ? '正在自动重连，已显示的内容和草稿会保留。' : '本次操作是否保存尚未确认，请先查看最新记录；消息草稿已保留，不会自动重复发送。'));
  result.name = 'HubNetworkError';
  result.code = timeout ? 'network_timeout' : 'network_unavailable';
  result.status = timeout ? 504 : 502;
  result.uncertain = !read;
  return result;
}

// Retry reads only, within one total deadline. Never replay a possibly committed write.
export function createNetworkRequest({ fetchImpl, dispatcher, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  signal = ms => AbortSignal.timeout(ms), observe = () => {} }) {
  return async function request(url, { timeout = 25000, method = 'GET', signal: callerSignal, ...options } = {}, consume = response => response) {
    method = method.toUpperCase();
    const read = ['GET', 'HEAD'].includes(method), started = now();
    let failure;
    for (let attempt = 0; attempt < (read ? 2 : 1); attempt++) {
      const remaining = Math.max(1, timeout - (now() - started));
      try {
        callerSignal?.throwIfAborted();
        const deadline = signal(read && attempt === 0 ? Math.min(12000, remaining) : remaining);
        const response = await fetchImpl(url, {
          ...options, method, dispatcher: dispatcher({ refresh: attempt > 0 }),
          redirect: 'error', signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
        });
        if (read && attempt === 0 && transientStatus.has(response.status)) {
          await response.body?.cancel();
          failure = { code: 'upstream_' + response.status };
        } else {
          const result = await consume(response);
          observe({ kind: transientStatus.has(response.status) ? 'failure' : attempt ? 'recovered' : 'success',
            method, attempts: attempt + 1, durationMs: now() - started,
            ...(transientStatus.has(response.status) ? { code: 'upstream_' + response.status } : {}) });
          return result;
        }
      } catch (error) {
        if (callerSignal?.aborted) throw error;
        if (!isNetworkError(error)) throw error;
        failure = error;
        if (!read || attempt > 0 || now() - started >= timeout) break;
      }
      await sleep(Math.min(300, Math.max(0, timeout - (now() - started))));
    }
    const error = networkError(failure, method);
    observe({ kind: 'failure', method, code: error.code, durationMs: now() - started });
    throw error;
  };
}
