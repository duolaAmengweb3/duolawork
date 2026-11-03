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
  const response = await request(target, {
    method: req.method,
    timeout: 30000,
    signal: controller.signal,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
  const out = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  for (const key of ["content-type", "content-disposition", "content-length"])
    if (response.headers.has(key)) out[key] = response.headers.get(key);
  res.writeHead(response.status, out);
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
