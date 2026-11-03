import { digest, fail, id } from "./repository.mjs";
import {
  platformURL,
  readJSON,
  seal,
  unseal,
  signedHeaders,
  signWebhook,
} from "./security.mjs";

export const EVENT = {
  name: "work.ready",
  description: "本成员有待领取的项目工作。仅包含标识，完整资料从工具读取。",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { member_id: { type: "string" } },
    required: ["member_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      member_id: { type: "string" },
      step_id: { type: "string" },
      run_id: { type: "string" },
      generation: { type: "integer" },
    },
    required: ["member_id", "step_id", "run_id", "generation"],
    additionalProperties: false,
  },
};

export async function eventMethod(
  repo,
  memberId,
  method,
  params,
  secret,
  fetcher = fetch,
  now = new Date().toISOString(),
) {
  const c = await repo.get("connection", memberId);
  if (
    c.transport !== "dots-events" ||
    !["configured", "verified"].includes(c.status)
  )
    fail("wrong_transport", "此成员没有启用 Dots 事件通道", 409);
  if (method === "events/list") return { events: [EVENT] };
  if (
    params.name !== EVENT.name ||
    params.arguments?.member_id !== memberId ||
    Object.keys(params.arguments).length !== 1 ||
    params.delivery?.mode !== "webhook"
  )
    fail("forbidden", "订阅只允许当前成员的待办事件", 403);
  const url = platformURL(params.delivery.url, "dots");
  const subscriptionId =
    "sub_" +
    (await digest(
      JSON.stringify([memberId, url, EVENT.name, { member_id: memberId }]),
    ));
  if (method === "events/unsubscribe") {
    await repo.transact(
      id("unsubscribe"),
      { memberId, subscriptionId },
      async (tx) => {
        const old = await tx.get("subscription", subscriptionId, false);
        if (old) tx.put("subscription", { ...old, status: "revoked" });
        return {};
      },
      now,
    );
    return {};
  }
  if (method !== "events/subscribe")
    fail("unknown_method", "未知事件方法", 404);
  const signingSecret = params.delivery.secret;
  await signWebhook(signingSecret || "", "validate", "0", "{}");
  const previous = await repo.get("subscription", subscriptionId, false);
  const data = previous ? await unseal(previous.credentials, secret) : null;
  // Rotation uses a verified new secret; retain prior signature for a short overlap.
  if (
    !previous ||
    previous.verifiedUntil <= now ||
    data.secret !== signingSecret ||
    previous.status !== "active"
  ) {
    const challenge = id("challenge"),
      body = JSON.stringify({ type: "verification", challenge });
    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: await signedHeaders(
          signingSecret,
          id("verify"),
          body,
          subscriptionId,
        ),
        body,
      });
    } catch {
      fail("callback_timeout", "事件回调验证超时，未启用订阅", 502);
    }
    if (!response.ok) fail("callback_rejected", "事件回调验证被拒绝", 502);
    const reply = await readJSON(response, 4000);
    if ((await digest(String(reply.challenge))) !== (await digest(challenge)))
      fail("challenge_failed", "事件回调未返回正确挑战值", 502);
  }
  const ttl =
    params.ttlMs === undefined || params.ttlMs === null
      ? 86400000
      : params.ttlMs;
  if (!Number.isFinite(ttl) || ttl < 60000)
    fail("invalid_ttl", "订阅有效期至少一分钟");
  const refreshBefore = new Date(
    Date.parse(now) + Math.min(86400000, ttl),
  ).toISOString();
  const credentials = await seal(
    {
      url,
      secret: signingSecret,
      previousSecret:
        data?.secret !== signingSecret ? data?.secret : data?.previousSecret,
      rotateUntil:
        data?.secret !== signingSecret
          ? new Date(Date.parse(now) + 300000).toISOString()
          : data?.rotateUntil,
    },
    secret,
  );
  await repo.transact(
    id("subscribe"),
    { subscriptionId, refreshBefore },
    async (tx) => {
      tx.put("subscription", {
        ...previous,
        id: subscriptionId,
        parentId: memberId,
        status: "active",
        credentials,
        expiresAt: refreshBefore,
        verifiedUntil: new Date(Date.parse(now) + 300000).toISOString(),
      });
      return {};
    },
    now,
  );
  return { id: subscriptionId, refreshBefore, cursor: null, truncated: false };
}

export async function deliverEvents(repo, row, secret, fetcher, now) {
  const subscriptions = (
    await repo.list("subscription", {
      parent: row.memberId,
      status: "active",
      limit: 100,
    })
  ).filter((s) => s.expiresAt > now);
  if (!subscriptions.length)
    return { status: "waiting_subscription", retry: true, delay: 60000 };
  let allAccepted = true;
  for (const sub of subscriptions) {
    const deliveryId = `${row.id}:${sub.id}`,
      prior = await repo.get("event_delivery", deliveryId, false);
    if (prior?.status === "accepted") continue;
    if (prior?.status === "stopped") {
      allAccepted = false;
      continue;
    }
    const c = await unseal(sub.credentials, secret),
      url = platformURL(c.url, "dots");
    const event = {
      eventId: deliveryId,
      name: EVENT.name,
      timestamp: row.createdAt,
      data: {
        member_id: row.memberId,
        step_id: row.stepId,
        run_id: row.parentId,
        generation: row.generation,
      },
      cursor: null,
    };
    const body = JSON.stringify(event);
    let status = "retry",
      httpStatus = null;
    try {
      const r = await fetcher(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: await signedHeaders(
          c.secret,
          deliveryId,
          body,
          sub.id,
          Date.parse(now),
          c.rotateUntil > now ? c.previousSecret : undefined,
        ),
        body,
      });
      httpStatus = r.status;
      await r.body?.cancel();
      status = r.ok
        ? "accepted"
        : [410, 413].includes(r.status)
          ? "stopped"
          : "retry";
    } catch {
      /* Same event ID is safe to redeliver under MCP Events semantics. */
    }
    await repo.transact(
      id("event_receipt"),
      { deliveryId, status },
      async (tx) => {
        tx.put("event_delivery", {
          ...prior,
          id: deliveryId,
          parentId: row.id,
          status,
          httpStatus,
        });
        if (httpStatus === 410)
          tx.put("subscription", { ...sub, status: "revoked" });
        return {};
      },
      now,
    );
    if (status !== "accepted") allAccepted = false;
  }
  return {
    status: allAccepted ? "accepted" : "event_retry",
    retry: !allAccepted,
    delay: 60000,
  };
}
