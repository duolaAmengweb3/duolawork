import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import { oauthFetch, startPairing } from "../cloud/collaboration/pairing.mjs";
import { digest } from "../cloud/collaboration/repository.mjs";

test("Grok Bot cloud callbacks register and pair with PKCE without changing an existing Grok connection", async t => {
  const f = await fixture(t), origin = "https://hub.example.com";
  const redirects = [
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://www.cursor.com/bot/mcp/oauth/callback",
    "http://localhost:8787/callback",
  ];
  const before = await f.repo.get("connection", "grok");
  const request = (path, body) => oauthFetch(new Request(origin + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.repo, f.identity, origin);
  const registered = await request("/v2/oauth/register", {
    client_name: "Grok Bot", redirect_uris: redirects, token_endpoint_auth_method: "none",
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const verifier = "g".repeat(64), challenge = Buffer.from(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const pair = await startPairing(f.repo, f.identity, "check", origin);
  const params = { client_id: client.client_id, redirect_uri: redirects[1],
    response_type: "code", state: "isolated-grok-bot-state", code_challenge_method: "S256", code_challenge: challenge };
  const page = await oauthFetch(new Request(origin + "/v2/oauth/authorize?" + new URLSearchParams(params)), f.repo, f.identity, origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /12 位配对码/);
  const authorized = await oauthFetch(new Request(origin + "/v2/oauth/authorize", {
    method: "POST", body: new URLSearchParams({ ...params, pair_code: pair.code }),
  }), f.repo, f.identity, origin);
  const callback = new URL(authorized.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, redirects[1]);
  const args = { grant_type: "authorization_code", client_id: client.client_id,
    redirect_uri: redirects[1], code: callback.searchParams.get("code"), code_verifier: verifier };
  await assert.rejects(() => request("/v2/oauth/token", { ...args, redirect_uri: redirects[0] }), e => e.code === "invalid_grant");
  const tokens = await (await request("/v2/oauth/token", args)).json();
  assert.equal((await f.repo.get("member_auth", await digest(tokens.access_token))).memberId, "check");
  assert.deepEqual(await f.repo.get("connection", "grok"), before);
});

test("Grok Bot callback compatibility does not allow arbitrary Cursor URLs, lookalikes or local redirects", async t => {
  const f = await fixture(t), origin = "https://hub.example.com";
  for (const redirect of [
    "https://www.cursor.com.attacker.example/bot/mcp/oauth/callback",
    "https://www.cursor.com/anything-else",
    "https://evil.cursor.com/bot/mcp/oauth/callback",
    "https://www.cursor.com/bot/mcp/oauth/callback?next=https://attacker.example",
    "http://www.cursor.com/bot/mcp/oauth/callback",
    "http://localhost:8788/callback",
    "http://localhost:8787/anything-else",
    "http://127.0.0.1:8787/callback",
    "http://localhost.attacker.example:8787/callback",
    "https://www.cursor.com/bot/mcp/oauth/callback#fragment",
  ]) {
    await assert.rejects(() => oauthFetch(new Request(origin + "/v2/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    }), f.repo, f.identity, origin), e => e.code === "invalid_redirect");
  }
  assert.equal((await f.repo.list("oauth_client")).length, 0);
});

test("native pairing: one-use owner code, PKCE bound to client/redirect; persistent refresh rotates without user login", async (t) => {
  const f = await fixture(t),
    origin = "https://hub.example.com";
  const send = (path, body) =>
    oauthFetch(
      new Request(origin + path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      f.repo,
      f.identity,
      origin,
    );
  const client = await (
    await send("/v2/oauth/register", {
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://chatgpt.com/oauth/callback"],
      client_name: "Dot",
    })
  ).json();
  const pair = await startPairing(f.repo, f.identity, "grok", origin);
  assert.equal(pair.code.length, 12);
  assert(!pair.instructions.includes(pair.code));
  const verifier = "a".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const params = {
    client_id: client.client_id,
    redirect_uri: "https://chatgpt.com/oauth/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "safe-state",
    pair_code: pair.code,
  };
  const result = await oauthFetch(
    new Request(origin + "/v2/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams(params),
    }),
    f.repo,
    f.identity,
    origin,
  );
  assert.equal(result.status, 302);
  const dest = new URL(result.headers.get("location"));
  assert.equal(dest.searchParams.get("state"), "safe-state");
  await assert.rejects(
    () =>
      oauthFetch(
        new Request(origin + "/v2/oauth/authorize", {
          method: "POST",
          body: new URLSearchParams(params),
        }),
        f.repo,
        f.identity,
        origin,
      ),
    (e) => e.code === "pair_expired",
  );
  const args = {
    client_id: client.client_id,
    redirect_uri: params.redirect_uri,
    grant_type: "authorization_code",
    code: dest.searchParams.get("code"),
    code_verifier: verifier,
  };
  await assert.rejects(
    () => send("/v2/oauth/token", { ...args, code_verifier: "b".repeat(64) }),
    (e) => e.code === "invalid_grant",
  );
  const tokens = await (await send("/v2/oauth/token", args)).json();
  const record = await f.repo.get(
    "member_auth",
    await digest(tokens.access_token),
  );
  assert.equal(record.memberId, "grok");
  assert(!JSON.stringify(record).includes(tokens.access_token));
  await assert.rejects(
    () => send("/v2/oauth/token", args),
    (e) => e.code === "invalid_grant",
  );
  const refreshed = await (
    await send("/v2/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    })
  ).json();
  assert(refreshed.access_token !== tokens.access_token);
  await assert.rejects(
    () =>
      send("/v2/oauth/token", {
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
    (e) => e.code === "invalid_grant",
  );
});
test("native pairing rejects non-platform callbacks and expired codes without exposing any credential", async (t) => {
  const f = await fixture(t),
    origin = "https://hub.example.com";
  await assert.rejects(
    () =>
      oauthFetch(
        new Request(origin + "/v2/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://chatgpt.com.attacker.example/cb"],
          }),
        }),
        f.repo,
        f.identity,
        origin,
      ),
    (e) => e.code === "invalid_redirect",
  );
  const response = await oauthFetch(
    new Request(origin + "/.well-known/oauth-protected-resource/v2/mcp"),
    f.repo,
    f.identity,
    origin,
  );
  assert.deepEqual((await response.json()).scopes_supported, ["hub:member"]);
});

test("native pairing: throttled public requests cannot allocate clients or consume pairing codes", async (t) => {
  const f = await fixture(t);
  const response = await oauthFetch(
    new Request("https://hub.example.com/v2/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://grok.com/callback"] }),
    }),
    f.repo,
    f.identity,
    "https://hub.example.com",
    { OAUTH_RATE_LIMIT: { limit: async () => ({ success: false }) } },
  );
  assert.equal(response.status, 429);
  assert.equal((await f.repo.list("oauth_client")).length, 0);
});

test("native pairing: confidential clients require their secret; Basic and form token exchange remain PKCE-bound", async (t) => {
  const f = await fixture(t),
    origin = "https://hub.example.com";
  const request = async (route, data, authorization) =>
    oauthFetch(
      new Request(origin + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(data),
      }),
      f.repo,
      f.identity,
      origin,
    );
  const client = await (
    await request("/v2/oauth/register", {
      redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
      token_endpoint_auth_method: "client_secret_post",
    })
  ).json();
  assert(client.client_secret);
  assert(!(await f.repo.get("oauth_client", client.client_id)).client_secret);
  const pair = await startPairing(f.repo, f.identity, "grok", origin),
    verifier = "r".repeat(64),
    hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    ),
    challenge = Buffer.from(hash).toString("base64url");
  const auth = await oauthFetch(
    new Request(origin + "/v2/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: challenge,
        pair_code: pair.code,
      }),
    }),
    f.repo,
    f.identity,
    origin,
  );
  const args = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    grant_type: "authorization_code",
    code: new URL(auth.headers.get("location")).searchParams.get("code"),
    code_verifier: verifier,
  };
  await assert.rejects(
    () => request("/v2/oauth/token", args),
    (e) => e.code === "invalid_client",
  );
  const token = await (
    await request("/v2/oauth/token", {
      ...args,
      client_secret: client.client_secret,
    })
  ).json();
  assert(token.access_token);
  const refreshed = await (
    await request(
      "/v2/oauth/token",
      { grant_type: "refresh_token", refresh_token: token.refresh_token },
      "Basic " +
        Buffer.from(client.client_id + ":" + client.client_secret).toString(
          "base64",
        ),
    )
  ).json();
  assert(refreshed.access_token);
});
