import { digest, fail, id, required } from "./repository.mjs";
import { readJSON, readBounded } from "./security.mjs";
const esc = (s) =>
  String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const response = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const random = (prefix) =>
  prefix +
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const allowedRedirect = (raw) => {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail("invalid_redirect", "回调地址无效");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !["openai.com", "chatgpt.com", "grok.com", "x.ai"].some(
      (d) => u.hostname === d || u.hostname.endsWith("." + d),
    )
  )
    fail("invalid_redirect", "只接受原平台官方授权回调");
  return u.href;
};
async function grant(tx, memberId, clientId, now) {
  const access = random("ahv1_"),
    refresh = random("ahr_");
  tx.put("member_auth", {
    id: await digest(access),
    memberId,
    clientId,
    status: "active",
    expiresAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(),
  });
  tx.put("oauth_refresh", {
    id: await digest(refresh),
    memberId,
    clientId,
    status: "active",
    expiresAt: new Date(Date.parse(now) + 90 * 86400000).toISOString(),
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 30 * 86400,
    refresh_token: refresh,
    scope: "hub:member",
  };
}
export async function startPairing(repo, identity, memberId, origin) {
  const member = identity.members.find(
    (m) => m.id === memberId && m.status !== "disabled",
  );
  if (!member) fail("member_missing", "成员不存在", 404);
  const old = await repo.get("connection", memberId, false);
  if (!old)
    await repo.transact(id("connection-draft"), { memberId }, (tx) =>
      tx.put("connection", {
        id: memberId,
        platform: member.platformId,
        transport:
          member.platformId === "grok-bot" ? "grok-webhook" : "dots-events",
        resourceKey: member.accountId,
        capabilities: ["research", "writing", "files"],
        configVersion: 1,
        status:
          member.platformId === "grok-bot" ? "awaiting_trigger" : "configured",
      }),
    );
  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) =>
    n.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  const key = await digest(code);
  const result = await repo.transact(id("pair"), { memberId }, (tx) =>
    tx.put("pairing", {
      id: key,
      memberId,
      status: "pending",
      expiresAt: new Date(Date.parse(tx.now) + 15 * 60000).toISOString(),
    }),
  );
  return {
    code,
    expiresAt: result.expiresAt,
    mcpUrl: origin + "/v2/mcp",
    instructions:
      "请添加我的私有 Agent Hub MCP 连接：" +
      origin +
      "/v2/mcp，并在打开的官方授权流程中让我本人完成配对。配对码不发到聊天。" +
      (member.platformId === "grok-bot"
        ? ""
        : " 连接成功后，请订阅 work.ready 事件，arguments.member_id=" +
          memberId +
          "，收到通知后用 list_work、claim_work 领取并执行，再 submit_work 交付；重复门铃不能重复执行。"),
  };
}
export async function oauthFetch(request, repo, identity, origin, env = {}) {
  const u = new URL(request.url);
  const path = u.pathname;
  if (
    request.method === "POST" &&
    path.startsWith("/v2/oauth/") &&
    env.OAUTH_RATE_LIMIT
  ) {
    const { success } = await env.OAUTH_RATE_LIMIT.limit({
      key:
        "agent-hub-oauth:" +
        (request.headers.get("CF-Connecting-IP") || "unknown") +
        ":" +
        path,
    });
    if (!success)
      return response(
        { error: "rate_limited", message: "授权请求过于频繁，请稍后重试" },
        429,
      );
  }
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return response({
      resource: origin + "/v2/mcp",
      authorization_servers: [origin],
      scopes_supported: ["hub:member"],
      bearer_methods_supported: ["header"],
    });
  if (path === "/.well-known/oauth-authorization-server")
    return response({
      issuer: origin,
      authorization_endpoint: origin + "/v2/oauth/authorize",
      token_endpoint: origin + "/v2/oauth/token",
      registration_endpoint: origin + "/v2/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["hub:member"],
    });
  if (path === "/v2/oauth/register" && request.method === "POST") {
    const data = await readJSON(request);
    const redirects = (data.redirect_uris || []).map(allowedRedirect);
    if (!redirects.length || redirects.length > 5)
      fail("invalid_client", "需要官方回调地址");
    const authMethod = data.token_endpoint_auth_method || "client_secret_basic";
    if (
      !["none", "client_secret_basic", "client_secret_post"].includes(
        authMethod,
      )
    )
      fail("invalid_client_metadata", "不支持此客户端认证方式");
    const clientSecret = authMethod === "none" ? null : random("ahc_");
    const secretHash = clientSecret ? await digest(clientSecret) : null;
    const clientId = id("client");
    await repo.transact(id("register"), { clientId }, (tx) =>
      tx.put("oauth_client", {
        id: clientId,
        redirects,
        authMethod,
        secretHash,
        requestedAuthMethod: data.token_endpoint_auth_method || null,
        name: String(data.client_name || "个人 Agent").slice(0, 80),
      }),
    );
    return response(
      {
        client_id: clientId,
        redirect_uris: redirects,
        token_endpoint_auth_method: authMethod,
        ...(clientSecret
          ? { client_secret: clientSecret, client_secret_expires_at: 0 }
          : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }
  if (path === "/v2/oauth/authorize") {
    const p =
      request.method === "POST"
        ? new URLSearchParams(
            new TextDecoder().decode(await readBounded(request, 10000)),
          )
        : u.searchParams;
    const client = await repo.get("oauth_client", p.get("client_id"));
    const redirect = allowedRedirect(p.get("redirect_uri"));
    if (
      !client.redirects.includes(redirect) ||
      p.get("response_type") !== "code" ||
      p.get("code_challenge_method") !== "S256" ||
      !p.get("code_challenge")
    )
      fail("invalid_request", "授权参数或回调不匹配");
    if (request.method === "GET") {
      const fields = [
        "client_id",
        "redirect_uri",
        "response_type",
        "state",
        "code_challenge",
        "code_challenge_method",
      ];
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 Agent Hub</title><style>body{font:16px system-ui;background:#f5f6f8;color:#18243a;margin:0;display:grid;min-height:100vh;place-items:center}main{background:white;padding:40px;border:1px solid #e3e6ec;border-radius:16px;max-width:420px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin-top:16px}button{background:#245bdb;color:white;border:0;border-radius:8px}small{color:#65738a;line-height:1.7}</style><main><h2>连接你的 ${esc(client.name)}</h2><p>输入 Agent Hub 成员页显示的一次性配对码。</p><small>仅允许这个成员领取自己的任务、读取获授权的项目材料并交付成果。不授予工作区管理、支付或发布权限。</small><form method="post">${fields.map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k))}">`).join("")}<input name="pair_code" required autocomplete="off" placeholder="12 位配对码" maxlength="12"><button>授权这个成员</button></form></main></html>`,
        {
          headers: {
            "Content-Type": "text/html;charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(redirect).origin}; base-uri 'none'; frame-ancestors 'none'`,
            "X-Frame-Options": "DENY",
          },
        },
      );
    }
    const key = await digest(
        String(p.get("pair_code") || "")
          .trim()
          .toUpperCase(),
      ),
      code = random("auth_");
    await repo.transact(
      id("authorize"),
      { key, clientId: client.id },
      async (tx) => {
        const pair = await tx.get("pairing", key, false);
        if (!pair || pair.status !== "pending" || pair.expiresAt <= tx.now)
          fail("pair_expired", "配对码不存在、已使用或已过期", 400);
        if (
          !identity.members.some(
            (m) => m.id === pair.memberId && m.status !== "disabled",
          )
        )
          fail("member_missing", "成员已停用", 403);
        tx.put("pairing", { ...pair, status: "used" });
        tx.put("oauth_code", {
          id: await digest(code),
          memberId: pair.memberId,
          clientId: client.id,
          redirect,
          challenge: p.get("code_challenge"),
          status: "pending",
          expiresAt: new Date(Date.parse(tx.now) + 5 * 60000).toISOString(),
        });
        return {};
      },
    );
    const dest = new URL(redirect);
    dest.searchParams.set("code", code);
    if (p.get("state")) dest.searchParams.set("state", p.get("state"));
    return new Response(null, {
      status: 302,
      headers: { Location: dest.href, "Cache-Control": "no-store" },
    });
  }
  if (path === "/v2/oauth/token" && request.method === "POST") {
    const p = request.headers.get("content-type")?.includes("application/json")
      ? await readJSON(request)
      : Object.fromEntries(
          new URLSearchParams(
            new TextDecoder().decode(await readBounded(request, 10000)),
          ),
        );
    let suppliedSecret = p.client_secret;
    const basic = request.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      let decoded;
      try {
        decoded = atob(basic.slice(6));
      } catch {
        fail("invalid_client", "客户端认证格式无效", 401);
      }
      const split = decoded.indexOf(":");
      if (split < 0) fail("invalid_client", "客户端认证格式无效", 401);
      const clientId = decodeURIComponent(decoded.slice(0, split));
      if (p.client_id && p.client_id !== clientId)
        fail("invalid_client", "客户端编号不匹配", 401);
      p.client_id = clientId;
      suppliedSecret = decodeURIComponent(decoded.slice(split + 1));
    }
    const client = await repo.get("oauth_client", p.client_id, false);
    if (
      !client ||
      (client.secretHash &&
        (!suppliedSecret ||
          (await digest(suppliedSecret)) !== client.secretHash))
    )
      fail("invalid_client", "客户端认证失败", 401);
    const diagnostic = {
      fields: Object.keys(p).sort(),
      grantType: p.grant_type || null,
      clientIdPresent: !!p.client_id,
      basicAuth:
        request.headers.get("authorization")?.startsWith("Basic ") || false,
    };
    if (p.code) {
      const record = await repo.get(
        "oauth_code",
        await digest(String(p.code)),
        false,
      );
      diagnostic.codeFound = !!record;
      diagnostic.clientMatches = record?.clientId === p.client_id;
      diagnostic.redirectMatches = record?.redirect === p.redirect_uri;
      if (p.code_verifier) {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(p.code_verifier),
        );
        diagnostic.pkceMatches =
          record?.challenge ===
          btoa(String.fromCharCode(...new Uint8Array(bytes)))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
      }
    }
    await repo.transact(id("oauth-audit"), diagnostic, (tx) =>
      tx.put("oauth_audit", {
        id: id("oauth"),
        ...diagnostic,
        createdAt: tx.now,
      }),
    );
    if (p.grant_type === "refresh_token") {
      const key = await digest(required(p.refresh_token, "刷新凭证", 500));
      return response(
        await repo.transact(id("refresh"), { key }, async (tx) => {
          const old = await tx.get("oauth_refresh", key, false);
          if (
            !old ||
            old.status !== "active" ||
            old.expiresAt <= tx.now ||
            old.clientId !== p.client_id ||
            !identity.members.some(
              (m) => m.id === old.memberId && m.status !== "disabled",
            )
          )
            fail("invalid_grant", "刷新凭证无效", 400);
          tx.put("oauth_refresh", { ...old, status: "rotated" });
          return grant(tx, old.memberId, old.clientId, tx.now);
        }),
      );
    }
    if (p.grant_type !== "authorization_code")
      fail("unsupported_grant", "不支持此授权方式", 400);
    const key = await digest(required(p.code, "授权码", 500)),
      verifier = required(p.code_verifier, "PKCE 验证", 200);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    return response(
      await repo.transact(id("token"), { key }, async (tx) => {
        const code = await tx.get("oauth_code", key, false);
        if (
          !code ||
          code.status !== "pending" ||
          code.expiresAt <= tx.now ||
          code.clientId !== p.client_id ||
          code.redirect !== p.redirect_uri ||
          code.challenge !== challenge
        )
          fail("invalid_grant", "授权码无效或验证不匹配", 400);
        tx.put("oauth_code", { ...code, status: "used" });
        return grant(tx, code.memberId, code.clientId, tx.now);
      }),
    );
  }
  return null;
}
