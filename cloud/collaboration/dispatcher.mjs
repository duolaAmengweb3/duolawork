import { fail, id } from "./repository.mjs";
import { platformURL, unseal } from "./security.mjs";
import { deliverEvents } from "./events.mjs";
import { command } from "./engine.mjs";
import { startComputer, pollComputer } from "./computer.mjs";

export async function dispatchOne(
  repo,
  identity,
  rowId,
  env,
  fetcher = fetch,
  now = new Date().toISOString(),
) {
  const lock = id("dispatch");
  const row = await repo.transact(
    lock,
    { rowId },
    async (tx) => {
      const row = await tx.get("outbox", rowId),
        step = await tx.get("step", row.stepId),
        run = await tx.get("run", row.parentId),
        project = await tx.get("project", row.scopeId);
      if (
        !["pending", "retry", "waiting_subscription"].includes(row.status) ||
        row.dueAt > now
      )
        return null;
      const member = identity.members.find(
        (x) => x.id === row.memberId && x.status !== "disabled" && !x.paused,
      );
      const account = identity.accounts.find(
        (x) => x.id === member?.accountId && x.status !== "disabled",
      );
      const c = await tx.get("connection", row.memberId);
      if (
        step.status !== "ready" ||
        step.generation !== row.generation ||
        run.status === "canceled"
      ) {
        tx.put("outbox", { ...row, status: "superseded" });
        return null;
      }
      if (
        project.status !== "active" ||
        run.status !== "running" ||
        !member ||
        !account ||
        !["configured", "verified"].includes(c.status)
      )
        return null;
      if (
        c.transport !== row.transport ||
        c.configVersion !== row.configVersion
      ) {
        tx.put("outbox", {
          ...row,
          status: "needs_review",
          reason: "通道已变化，需要确认新派发",
        });
        return null;
      }
      const resource = await tx.get("resource", c.resourceKey, false);
      if (resource?.status === "busy") return null;
      row.status = "sending";
      row.dispatchId = lock;
      row.sendingAt = now;
      row.attempts++;
      tx.put("outbox", row);
      return row;
    },
    now,
  );
  if (!row) return { skipped: true };
  let outcome;
  try {
    const c = await repo.get("connection", row.memberId);
    if (row.transport === "grok-webhook") {
      const credentials = await unseal(c.credentials, env.ADMIN_KEY);
      const response = await fetcher(platformURL(credentials.url, "grok"), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify({
          delivery_id: row.id,
          member_id: row.memberId,
          step_id: row.stepId,
          run_id: row.parentId,
          generation: row.generation,
        }),
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      outcome =
        response.status === 200
          ? { status: "accepted" }
          : {
              status: "rejected",
              retry: response.status === 429 || response.status >= 500,
              delay: Math.min(
                3600000,
                Math.max(
                  60000,
                  Number.isFinite(retryAfter) ? retryAfter * 1000 : 60000,
                ),
              ),
              httpStatus: response.status,
            };
    } else if (row.transport === "dots-events")
      outcome = await deliverEvents(repo, row, env.ADMIN_KEY, fetcher, now);
    else if (row.transport === "computer-mcp")
      outcome = await startComputer(repo, identity, row, env, fetcher);
    else outcome = { status: "needs_review", reason: "无此原生传输适配器" };
  } catch {
    outcome = {
      status: "unknown",
      reason: "发送结果不明；先核对原任务，不自动重发",
    };
  }
  return repo.transact(
    id("dispatch-result"),
    { rowId, lock, outcome },
    async (tx) => {
      const current = await tx.get("outbox", rowId);
      // A real claim can race with the webhook response; never downgrade its state.
      if (current.dispatchId !== lock || current.status !== "sending")
        return { status: current.status };
      current.status =
        outcome.retry && current.attempts < 4
          ? outcome.status === "waiting_subscription"
            ? "waiting_subscription"
            : "retry"
          : outcome.status;
      if (outcome.retry && current.attempts >= 4)
        current.status = "needs_review";
      current.dueAt = new Date(
        Date.parse(now) +
          (outcome.delay || 60000) * Math.max(1, current.attempts),
      ).toISOString();
      current.reason = outcome.reason || null;
      current.httpStatus = outcome.httpStatus || null;
      current.completedAt = now;
      tx.put("outbox", current);
      tx.message(
        current.scopeId,
        "notification",
        current.status === "accepted"
          ? "通知被原平台受理，等待成员领取；尚未交付"
          : `通知状态：${current.status}`,
        {
          runId: current.parentId,
          stepId: current.stepId,
          memberId: current.memberId,
        },
      );
      return { status: current.status };
    },
    now,
  );
}

export async function maintenance(
  repo,
  identity,
  env,
  fetcher = fetch,
  now = new Date().toISOString(),
) {
  const beganAt = Date.now();
  const summary = { notifications: 0, schedules: 0, recovered: 0, errors: [] };
  for (const row of await repo.list("outbox", {
    status: "sending",
    limit: 100,
  }))
    if (Date.parse(row.sendingAt) + 60000 <= Date.parse(now)) {
      await repo.transact(
        id("sending-expired"),
        { id: row.id },
        async (tx) => {
          const current = await tx.get("outbox", row.id);
          if (
            current.status === "sending" &&
            current.dispatchId === row.dispatchId
          )
            tx.put("outbox", {
              ...current,
              status: "unknown",
              reason: "通知进程中断，是否送达未知，未重发",
            });
          return {};
        },
        now,
      );
      summary.recovered++;
    }
  for (const status of ["accepted", "unknown", "needs_review"])
    for (const row of await repo.list("outbox", { status, limit: 100 })) {
      if (
        status === "accepted" &&
        Date.parse(row.completedAt) + 15 * 60000 > Date.parse(now)
      )
        continue;
      await repo.transact(
        `notice-stalled:${row.id}`,
        { id: row.id },
        async (tx) => {
          const step = await tx.get("step", row.stepId),
            run = await tx.get("run", row.parentId);
          if (
            step.status !== "ready" ||
            step.generation !== row.generation ||
            run.status === "canceled"
          )
            return {};
          step.status = "needs_review";
          run.status = "needs_review";
          tx.put("step", step);
          tx.put("run", run);
          tx.message(
            row.scopeId,
            "notification.stalled",
            "通知后没有可确认的领取，需核对原平台；不会自动重发",
            { stepId: step.id, runId: run.id },
          );
          return {};
        },
        now,
      );
    }
  for (const schedule of await repo.list("schedule", {
    status: "enabled",
    limit: 100,
  }))
    if (schedule.nextAt <= now) {
      try {
        await command(
          repo,
          identity,
          { system: true },
          {
            type: "schedule.fire",
            requestId: `schedule:${schedule.id}:${schedule.nextAt}`,
            projectId: schedule.id,
            expectedAt: schedule.nextAt,
          },
          now,
        );
        summary.schedules++;
      } catch (e) {
        summary.errors.push({
          kind: "schedule",
          id: schedule.id,
          code: e.code || "failure",
        });
      }
    }
  for (const status of ["pending", "retry", "waiting_subscription"])
    for (const row of await repo.list("outbox", { status, limit: 20 })) {
      if (
        row.dueAt <= now &&
        summary.notifications < 2 &&
        Date.now() - beganAt < 18000
      ) {
        await dispatchOne(repo, identity, row.id, env, fetcher, now);
        summary.notifications++;
      }
    }
  for (const status of ["working", "checkpoint", "waiting_user"])
    for (const job of await repo.list("remote_job", { status, limit: 8 }))
      if (job.pollAt <= now && Date.now() - beganAt < 18000) {
        try {
          await pollComputer(repo, identity, job, env, fetcher);
        } catch (e) {
          summary.errors.push({
            kind: "computer",
            id: job.id,
            code: e.code || "failure",
          });
        }
      }
  for (const status of ["claimed", "running"])
    for (const a of await repo.list("attempt", { status, limit: 100 }))
      if (a.expiresAt <= now)
        await command(
          repo,
          identity,
          { system: true },
          {
            type: "attempt.expire",
            requestId: `expire:${a.id}:${a.expiresAt}`,
            attemptId: a.id,
          },
          now,
        );
  return summary;
}
