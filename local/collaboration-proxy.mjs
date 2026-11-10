import { requestNetwork } from "./transport.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Same-origin gateway: admin credentials never go to renderer JS or URLs.
export async function proxyCollaboration(req, res, config, { request = requestNetwork } = {}) {
  if (!config.endpoint || !config.adminKey)
    throw new Error("工作区服务尚未配置");
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  req.once('aborted', cancel);
  res.once('close', cancel);
  try {
  const incoming = new URL(req.url, "http://127.0.0.1");
  const target = new URL(
    incoming.pathname.replace(/^\/api/, "") + incoming.search,
    config.endpoint,
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      const e = new Error("请求超过 8 MB");
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  const headers = { Authorization: `Bearer ${config.adminKey}` };
  for (const key of ["content-type", "x-hub-file"])
    if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
  const {response, bytes} = await request(target, {
    method: req.method,
    timeout: incoming.pathname==='/api/v2/connectors'&&req.method==='POST'?60000:30000,
    signal: controller.signal,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  }, async response => ({
    response,
    // Keep body consumption inside the read retry boundary. A partial JSON
    // response must never be committed to the renderer. Writes still get one
    // attempt only; their result may be uncertain if the response was lost.
    bytes: response.headers.get('content-type')?.includes('application/json')
      ? Buffer.from(await response.arrayBuffer()) : null,
  }));
  const out = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  for (const key of ["content-type", "content-disposition"])
    if (response.headers.has(key)) out[key] = response.headers.get(key);
  // fetch decodes compressed bodies while retaining the upstream length.
  // That length is invalid for decoded bytes; calculate it or stream chunked.
  if(bytes)out['content-length']=String(bytes.length);
  else if(!response.headers.has('content-encoding')&&response.headers.has('content-length'))out['content-length']=response.headers.get('content-length');
  res.writeHead(response.status, out);
  if(bytes){res.end(bytes);return;}
  if (response.body) {
    const source = Readable.fromWeb(response.body);
    // A client may close before the Web stream observes its deadline/cancel.
    // Keep an error listener for that late emission, after pipeline cleans up.
    source.on('error', () => {});
    try {
      await pipeline(source, res);
    } catch (e) {
      controller.abort();
      res.destroy();
    }
  } else res.end();
  } finally {
    req.off('aborted', cancel);
    res.off('close', cancel);
  }
}
