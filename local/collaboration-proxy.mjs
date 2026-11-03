import { fetch } from "undici";
import { networkDispatcher } from "./transport.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Same-origin gateway: admin credentials never go to renderer JS or URLs.
export async function proxyCollaboration(req, res, config) {
  if (!config.endpoint || !config.adminKey)
    throw new Error("工作区服务尚未配置");
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
  const response = await fetch(target, {
    method: req.method,
    dispatcher: networkDispatcher(),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
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
    try {
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (e) {
      res.destroy(e);
    }
  } else res.end();
}
