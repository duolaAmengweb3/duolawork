import { signedHeaders } from "./security.mjs";
import { fail, id } from "./repository.mjs";
import { platformURL, unseal } from "./security.mjs";
import { deliverEvents } from "./events.mjs";
import { command } from "./engine.mjs";
import { startComputer, pollComputer } from "./computer.mjs";
import { conversationMaintenance } from "./conversation.mjs";

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
      const row = await tx.get("outbox", rowId);
      const turn = row.conversation ? await tx.get("channel_turn", row.stepId) : null;
      const channel = row.conversation ? await tx.get("channel", row.scopeId) : null;
      const step = turn ? {...turn,generation:1} : await tx.get("step",row.stepId);
      const run = channel ? {status:channel.status==="active"?"running":"canceled"} : await tx.get("run",row.parentId);
      const project = channel || await tx.get("project",row.scopeId);
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
        !["running", "needs_review"].includes(run.status) ||
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
      if(channel){
        const cursorId=`${channel.id}:${row.memberId}`,cursor=await tx.get("channel_cursor",cursorId,false);
        const earliest=Date.parse(cursor?.lastNotifiedAt||"1970-01-01")+channel.wakeIntervalSeconds*1000;
        if(earliest>Date.parse(now)){tx.put("outbox",{...row,dueAt:new Date(earliest).toISOString()});return null;}
        tx.put("channel_cursor",{...cursor,id:cursorId,scopeId:channel.id,parentId:row.memberId,lastNotifiedAt:now});
        // One platform wake can read all queued messages for this group. Keep
        // every turn ready until the native Agent actually claims them.
        for(const pending of (await Promise.all(["pending","retry","waiting_subscription"].map(status=>tx.list("outbox",{scope:channel.id,status})))).flat())if(pending.id!==row.id&&pending.memberId===row.memberId&&pending.conversation)tx.put("outbox",{...pending,status:"coalesced",coalescedInto:row.id});
      }
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
  let outcome, failureStage = "prepare";
  try {
    const c = await repo.get("connection", row.memberId);
    if (row.transport === "grok-webhook") {
      const credentials = await unseal(c.credentials, env.ADMIN_KEY);
      const body = JSON.stringify({
        delivery_id: row.id,
        member_id: row.memberId,
        step_id: row.stepId,
        run_id: row.parentId,
        generation: row.generation,
      });
      const headers = credentials.token.startsWith("whsec_")
        ? await signedHeaders(
            credentials.token,
            row.id,
            body,
            row.id,
            Date.parse(now),
          )
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credentials.token}`,
          };
      failureStage = "platform_fetch";
      const response = await fetcher(platformURL(credentials.url, "grok"), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers,
        body,
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      const signedAutomation = credentials.token.startsWith("whsec_");
      outcome = (signedAutomation ? response.status === 202 : response.ok)
        ? { status: "accepted", httpStatus: response.status }
        : response.status === 400 && !credentials.token.startsWith("whsec_")
          ? {
              status: "busy",
              retry: true,
              fixedDelay: true,
              delay: [90000, 180000, 360000][Math.min(2, row.attempts - 1)],
              httpStatus: 400,
              reason: "原 Bot 正忙，按固定间隔重试门铃",
            }
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
              reason: response.ok && signedAutomation ? "平台未返回自动化受理码 202，不能当成送达" : null,
            };
    } else if (row.transport === "dots-events")
      outcome = await deliverEvents(repo, row, env.ADMIN_KEY, fetcher, now);
    else if (row.transport === "computer-mcp")
      outcome = await startComputer(repo, identity, row, env, fetcher);
    else outcome = { status: "needs_review", reason: "无此原生传输适配器" };
  } catch (e) {
    outcome =
      row.transport === "grok-webhook" &&
      (e.name === "TimeoutError" || e.name === "AbortError")
        ? {
            status: "busy",
            retry: true,
            fixedDelay: true,
            delay: [90000, 180000, 360000][Math.min(2, row.attempts - 1)],
            reason: "原 Bot 响应超时，保留同一投递编号重试",
          }
        : {
            status: "unknown",
            reason: "发送结果不明；先核对原任务，不自动重发",
            failureStage,
            errorName: ["TypeError", "Error", "SyntaxError"].includes(e.name) ? e.name : "TransportError",
            errorCode: /^[a-z_]{1,40}$/.test(e.code || "") ? e.code : null,
            errorDetail: String(e.message || "").replace(/https?:\/\/\S+/g, "[endpoint]").replace(/[A-Za-z0-9_+/=.-]{16,}/g, "[redacted]").slice(0, 180),
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
          (outcome.delay || 60000) *
            (outcome.fixedDelay ? 1 : Math.max(1, current.attempts)),
      ).toISOString();
      current.reason = outcome.reason || null;
      current.failureStage = outcome.failureStage || null;
      current.errorName = outcome.errorName || null;
      current.errorCode = outcome.errorCode || null;
      current.errorDetail = outcome.errorDetail || null;
      current.httpStatus = outcome.httpStatus || null;
      current.completedAt = now;
      tx.put("outbox", current);
      if(!current.conversation) tx.message(
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
  await conversationMaintenance(repo,identity,now);
  // A deliberately paused/unavailable member is a known condition, not an
  // unexplained fifteen-minute timeout. Preserve any running lease untouched.
  for (const pending of await repo.list("step", {status:"ready",limit:500})) {
    const m=identity.members.find(m=>m.id===pending.memberId && m.status!=="disabled" && !m.paused);
    if (m && identity.accounts.some(a=>a.id===m.accountId && a.status!=="disabled")) continue;
    await repo.transact(`unavailable:${pending.id}:${pending.generation}`, {memberId:pending.memberId}, async tx=>{
      const step=await tx.get("step",pending.id),run=await tx.get("run",step.parentId);
      if(step.status!=="ready" || run.status!=="running") return {};
      step.status="needs_review";step.issues=["成员已暂停或不可用，尚未领取"];
      run.status="needs_review";tx.put("step",step);tx.put("run",run);
      tx.message(step.scopeId,"member.unavailable","成员不可用；保留已有交付，等待重试、部分成稿或终止",{runId:run.id,stepId:step.id,memberId:step.memberId});
      return {};
    },now);
  }
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
        Date.parse(row.completedAt) +
          (row.transport === "dots-events" ? 60 : 15) * 60000 >
          Date.parse(now)
      )
        continue;
      await repo.transact(
        `notice-stalled:${row.id}`,
        { id: row.id },
        async (tx) => {
          if(row.conversation){
            const turn=await tx.get("channel_turn",row.stepId);
            if(turn.status==="ready")tx.put("channel_turn",{...turn,status:"stalled",reason:"平台已接收通知，但尚无真实回应；消息保留，可继续"});
            return {};
          }
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
  for (const signal of await repo.list("distill_signal", {
    status: "pending",
    limit: 20,
  }))
    if (signal.dueAt <= now) {
      try {
        const result = await command(
          repo,
          identity,
          { system: true },
          {
            type: "document.learn",
            requestId: "learn:" + signal.id + ":" + signal.dueAt,
            documentId: signal.id,
          },
          now,
        );
        await repo.transact(
          id("learn-signal"),
          { id: signal.id },
          async (tx) => {
            const current = await tx.get("distill_signal", signal.id);
            if (current.dueAt === signal.dueAt)
              tx.put("distill_signal", { ...current, status: "dispatched" });
            return {};
          },
          now,
        );
      } catch (e) {
        if (!["project_busy", "learn_busy"].includes(e.code))
          summary.errors.push({
            kind: "learn",
            id: signal.id,
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
