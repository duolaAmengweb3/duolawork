import { fail, required } from "./repository.mjs";
const enc = new TextEncoder();
export const base64 = (bytes) => {let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw);};
export const unbase64 = (value) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
async function key(secret) {
  if (!secret) fail("missing_secret", "服务端加密密钥尚未配置", 503);
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(`agent-hub-v2:${secret}`)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(secret),
    enc.encode(JSON.stringify(value)),
  );
  return { iv: base64(iv), data: base64(new Uint8Array(ciphertext)) };
}
export async function unseal(value, secret) {
  try {
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: unbase64(value.iv) },
          await key(secret),
          unbase64(value.data),
        ),
      ),
    );
  } catch {
    fail("credential_locked", "原生连接凭证无法解密，未覆盖或重建", 503);
  }
}
export async function readBounded(response, limit = 180000) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        fail("too_large", "响应或请求超过允许大小", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function readJSON(request, limit = 180000) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await readBounded(request, limit)),
    );
  } catch (e) {
    if (e.code) throw e;
    fail("invalid_json", "无效 JSON");
  }
}
// Only product-owned HTTPS hosts; no arbitrary customer callback URLs, IPs or redirects.
// Avoids DNS-rebinding to user-controlled hosts while running in Workers fetch.
export function platformURL(raw, product) {
  let url;
  try {
    url = new URL(required(raw, "平台地址", 4000));
  } catch {
    fail("invalid_url", "无效平台地址");
  }
  const domains =
    {
      grok: ["grok.com", "x.ai"],
      dots: ["openai.com", "chatgpt.com"],
      computer: ["perplexity.ai"],
      asset: ["perplexity.ai", "amazonaws.com"],
    }[product] || [];
  // Grok Bot routines use Cursor's backend, unlike grok.com account
  // Automations. This is the exact receiver family used in botline's
  // native Bot implementation; it does not allow other Cursor endpoints.
  const nativeGrok = product === "grok" && url.hostname === "api2.cursor.sh"
    && /^\/automations\/webhook\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    && !url.search && !url.hash;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(nativeGrok || domains.some((d) => url.hostname === d || url.hostname.endsWith("." + d)))
  )
    fail("untrusted_endpoint", "地址不是该平台允许的官方 HTTPS 域名", 400);
  return url.href;
}
export async function signWebhook(secret, eventId, timestamp, body) {
  if (!secret.startsWith("whsec_"))
    fail("invalid_signature_key", "签名密钥格式不正确");
  let bytes;
  try {
    bytes = unbase64(secret.slice(6));
  } catch {
    fail("invalid_signature_key", "签名密钥编码不正确");
  }
  if (bytes.length < 24 || bytes.length > 64)
    fail("invalid_signature_key", "签名密钥长度不正确");
  const k = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return (
    "v1," +
    base64(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          k,
          enc.encode(`${eventId}.${timestamp}.${body}`),
        ),
      ),
    )
  );
}
export async function signedHeaders(
  secret,
  eventId,
  body,
  subscriptionId,
  now = Date.now(),
  previousSecret,
) {
  const timestamp = String(Math.floor(now / 1000));
  const signatures = [await signWebhook(secret, eventId, timestamp, body)];
  if (previousSecret)
    signatures.push(
      await signWebhook(previousSecret, eventId, timestamp, body),
    );
  return {
    "Content-Type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}
import {receptionIssue} from '../../shared/receiver-reception.mjs';
export const publicConnection = (c) =>
  c && {
    id: c.id,
    platform: c.platform,
    transport: c.transport,
    status: c.status,
    capabilities: c.capabilities,
    resourceKey: c.resourceKey,
    revision: c.revision,
    toolSeenAt: c.toolSeenAt || null,
    verifiedAt: c.verifiedAt || null,
    deliveryEvidence: c.deliveryEvidence || null,
    pollSeconds: c.pollSeconds || null,
    needsAuthorization: c.needsAuthorization || false,
    receptionIssues: c.receptionIssues || {},
    // Old records can retain an earlier setup blocker after a real probe
    // succeeds. Only the server-owned verification state resolves it.
    setup: receptionIssue(c) || (c.status === "verified" && c.verifiedAt && (!c.setup?.at || c.setup.at <= c.verifiedAt)
      ? { stage: "verified", message: "原 Agent 已完成真实往返验证。", at: c.verifiedAt || null }
      : c.setup || null),
  };
