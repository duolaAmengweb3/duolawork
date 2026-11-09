import {secretaryMaintenance} from './secretary.mjs';
import {executionResource} from './execution-bindings.mjs';
import { signedHeaders } from "./security.mjs";
import { fail, id } from "./repository.mjs";
import { platformURL, unseal } from "./security.mjs";
import { deliverEvents,eventReceiptCurrent } from "./events.mjs";
import { command } from "./engine.mjs";
import { startComputer, pollComputer } from "./computer.mjs";
import { conversationMaintenance } from "./conversation.mjs";
import { meetingTurnAllowed, chargeMeetingRetry } from './meetings.mjs';
import {reconcileTaskNotification} from './task-deliverables.mjs';
import {wakeExpired,wakeId,resolveReceptionBlock} from './receiver-wakes.mjs';
import {receptionIssues} from '../../shared/receiver-reception.mjs';
const sameDeliveryScope=(a,b)=>(a.deliveryReview||null)===(b.deliveryReview||null)&&(a.meetingId||null)===(b.meetingId||null)&&(!a.meetingId||(a.meetingVersion===b.meetingVersion&&a.meetingRound===b.meetingRound&&a.meetingPurpose===b.meetingPurpose));
const maxUnclaimedWakes = 3;

// Only retry the doorbell before an execution lease exists. A platform HTTP
// receipt says nothing about whether its Agent actually called receive_messages.
async function recoverUnclaimedWakes(repo, now) {
  let after='';
  for (;;) {
   const page=await repo.list('outbox', { status: 'accepted', after, limit: 100 });
   for (const row of page) {
    if (!row.conversation || !wakeExpired(row,now)) continue;
    await repo.transact(`unclaimed-wake:${row.id}:${row.revision}:${now}`, { id: row.id, revision: row.revision }, async tx => {
      const current = await tx.get('outbox', row.id);
      if (current.status !== 'accepted' || current.revision !== row.revision) return {};
      const turn = await tx.get('channel_turn', row.stepId);
      // Already-stalled historical work is not silently restarted on upgrade.
      if (turn.status !== 'ready' || turn.claimedAt || turn.lease) return {};
      if((await reconcileTaskNotification(tx,turn)).state!=='current')return {};
      const channel = await tx.get('channel', row.scopeId);
      const connection = await tx.get('connection', row.memberId);
      if (channel.status !== 'active' || !channel.memberIds.includes(row.memberId) ||
          connection.status !== 'verified' || connection.configVersion !== row.configVersion) return {};
      const resource = await tx.get('resource', await executionResource(tx, connection, channel.id), false);
      if (resource?.status === 'busy') return {};
      if ((current.unclaimedRecoveries??current.wakeGeneration??0) < maxUnclaimedWakes-1) {
        tx.put('outbox', { ...current, status: 'retry', dueAt: now,
          wakeGeneration:(current.wakeGeneration||0)+1,
          wakeCreatedAt:now,
          unclaimedRecoveries:(current.unclaimedRecoveries??current.wakeGeneration??0)+1,
          unclaimedRetry: true, reason: '平台已受理，但成员尚未接收；正在重新通知' });
      } else {
        await stallUnclaimedBatch(tx, current, '已多次通知原平台，但成员仍未接收；消息已保留，可重试或查看原 Agent。');
      }
      return {};
    }, now);
   }
   if(page.length<100)break;
   after=page.at(-1).id;
  }
}

async function stallUnclaimedBatch(tx, notice, reason) {
  const connection=await tx.get('connection',notice.memberId,false);
  if(connection&&(await tx.get('resource',await executionResource(tx,connection,notice.scopeId),false))?.status==='busy')return;
  const turns = await tx.list('channel_turn', { scope: notice.scopeId, parent: notice.memberId, status: 'ready' });
  let stalled=0;
  for (const turn of turns) {
    if (turn.claimedAt || turn.lease) continue;
    const child = await tx.get('outbox', `notice_${turn.id}`, false);
    if (child?.id !== notice.id && child?.coalescedInto !== notice.id) continue;
    tx.put('channel_turn', { ...turn, status: 'stalled', reason });
    tx.put('outbox', { ...child, status: 'unclaimed', reason });
    stalled++;
  }
  if(stalled&&connection?.status==='verified'&&connection.configVersion===notice.configVersion){
    const issue={stage:'blocked',channelId:notice.scopeId,code:'delivery_unclaimed',message:reason,at:tx.now};
    tx.put('connection',{...connection,receptionIssues:{...receptionIssues(connection),[notice.scopeId]:issue},setup:issue});
  }
  // Drain historical accepted rows too, so they cannot starve newer receipts.
  const current = await tx.get('outbox', notice.id);
  if (['accepted','unknown','needs_review'].includes(current.status))
    tx.put('outbox', { ...current, status: 'unclaimed', reason });
}

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
      if(turn&&(await reconcileTaskNotification(tx,turn)).state!=='current')return null;
      const member = identity.members.find(
        (x) => x.id === row.memberId && x.status !== "disabled" && !x.paused,
      );
      const account = identity.accounts.find(
        (x) => x.id === member?.accountId && x.status !== "disabled",
      );
      const c = await tx.get("connection", row.memberId);
      if (turn && !await meetingTurnAllowed(tx, turn)) { tx.put('outbox',{...row,status:'canceled',reason:'会议已结束或阶段变化'}); return null; }
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
      const resource = await tx.get("resource", channel?await executionResource(tx,c,channel.id):c.resourceKey, false);
      if (resource?.status === "busy") return null;
      if(channel){
        const waiter=await tx.get("channel_wait",`${channel.id}:${row.memberId}`,false);
        if(waiter?.status==="waiting"&&waiter.expiresAt>now&&waiter.configVersion===c.configVersion)return null;
        // A delivered wake that has not been claimed will read the new input
        // too. Preserve the turn, without launching another platform run.
        const outstanding=(await Promise.all(["accepted","sending"].map(status=>tx.list("outbox",{scope:channel.id,status})))).flat();
        for(const notice of outstanding){
          if(notice.id===row.id||notice.memberId!==row.memberId||!notice.conversation||notice.configVersion!==row.configVersion||!sameDeliveryScope(notice,row))continue;
          if(notice.status==='accepted'&&(wakeExpired(notice,now)||row.transport==='dots-events'&&!await eventReceiptCurrent(tx,notice,now)))continue;
          const notifiedTurn=await tx.get("channel_turn",notice.stepId,false);
          if(notifiedTurn?.status!=="ready"||notifiedTurn.claimedAt||notifiedTurn.lease)continue;
          if((await reconcileTaskNotification(tx,notifiedTurn)).state!=='current')continue;
          tx.put("outbox",{...row,status:"coalesced",coalescedInto:notice.id});
          return null;
        }
        // Trust stored message authorship, never caller-supplied priority.
        // Older queued turns do not have wakeSource yet.
        const userInput=turn.wakeSource==="user"||(turn.wakeSource===undefined&&(await tx.get("channel_message",turn.messageId)).authorId==="owner");
        const cursorId=`${channel.id}:${row.memberId}`,cursor=await tx.get("channel_cursor",cursorId,false);
        const earliest=Date.parse(cursor?.lastNotifiedAt||"1970-01-01")+channel.wakeIntervalSeconds*1000;
        if(!turn.meetingId&&!userInput&&earliest>Date.parse(now)){tx.put("outbox",{...row,dueAt:new Date(earliest).toISOString()});return null;}
        tx.put("channel_cursor",{...cursor,id:cursorId,scopeId:channel.id,parentId:row.memberId,lastNotifiedAt:now});
        // One platform wake can read all queued messages for this group. Keep
        // every turn ready until the native Agent actually claims them.
        for(const pending of (await Promise.all(["pending","retry","waiting_subscription"].map(status=>tx.list("outbox",{scope:channel.id,status})))).flat())if(pending.id!==row.id&&pending.memberId===row.memberId&&pending.conversation&&sameDeliveryScope(pending,row)){
          const other=await tx.get('channel_turn',pending.stepId);if((await reconcileTaskNotification(tx,other)).state==='current')tx.put("outbox",{...pending,status:"coalesced",coalescedInto:row.id});
        }
        // A fresh message may replace an expired invitation, but never launch
        // a second recovery behind it. Repoint its supplements to the new wake.
        for(const notice of outstanding){
          if(notice.status!=='accepted'||!wakeExpired(notice,now)||notice.id===row.id||notice.memberId!==row.memberId||notice.configVersion!==row.configVersion||!sameDeliveryScope(notice,row))continue;
          const old=await tx.get('channel_turn',notice.stepId,false);
          if(old?.status!=='ready'||old.claimedAt||old.lease)continue;
          tx.put('outbox',{...notice,status:'coalesced',coalescedInto:row.id});
          for(const child of await tx.list('outbox',{scope:channel.id,status:'coalesced'}))
            if(child.coalescedInto===notice.id)tx.put('outbox',{...child,coalescedInto:row.id});
        }
      }
      if(turn&&!await chargeMeetingRetry(tx,turn,row.attempts)){tx.put('outbox',{...row,status:'canceled',reason:'达到本场自动重试预算'});return null;}
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
  const dispatchStartedAt = Date.now();
  let outcome, receiverKind, failureStage = "prepare";
  try {
    const c = await repo.get("connection", row.memberId);
    if (row.transport === "grok-webhook") {
      const credentials = await unseal(c.credentials, env.ADMIN_KEY);
      receiverKind=credentials.token.startsWith('whsec_')?'platform-automation':'bot-routine';
      const deliveryId = wakeId(row);
      const body = JSON.stringify({
        delivery_id: deliveryId,
        member_id: row.memberId,
        step_id: row.stepId,
        run_id: row.parentId,
        generation: row.generation,
        ...(row.conversation ? {
          kind: 'conversation',
          channel_id: row.scopeId,
          receive: { tool: 'receive_messages', arguments: { requestId: deliveryId + ':receive', channelId: row.scopeId, expectedMemberId: row.memberId, notificationTurnId:row.stepId } },
          instruction: 'Use the private credential bound to member_id, not a shared MCP login belonging to another Bot. GET /v2/self/status must return connection.id=member_id. Then call receive.tool with all receive.arguments via authenticated REST /v2/tools/{tool}. Each wake uses current membership: users may remove and re-add you. A previous left-group/forbidden result is not current authorization. Do not reuse a channel, requestId or afterTurnId from earlier invocations. Reply to the returned channelId and turnId in Hub. If busy, empty or obsolete, end only this invocation; keep the receiver enabled for future wakes and other groups. A removed group must never disable the whole receiver. If receiver_identity_mismatch, use your own saved credential; do not reconfigure shared MCP or claim another member work.',
        } : { kind: 'work', claim: { tool: 'claim_work', arguments: { requestId: row.id + ':claim', stepId: row.stepId, expectedMemberId: row.memberId } }, instruction: 'Use the private credential bound to member_id. GET /v2/self/status must return connection.id=member_id. Call claim.tool with claim.arguments through authenticated REST, then follow the returned verification instructions and submit real results. Never use another Bot shared MCP login.' }),
      });
      const headers = credentials.token.startsWith("whsec_")
        ? await signedHeaders(
            credentials.token,
            deliveryId,
            body,
            deliveryId,
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
      outcome = (signedAutomation ? response.status === 202 : response.status === 200)
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
  const attemptFinishedAt = new Date().toISOString();
  const timing = {
    ...(receiverKind?{receiverKind}:{}),
    attemptFinishedAt,
    dispatchElapsedMs: Date.now() - dispatchStartedAt,
    platformRespondedAt: outcome.platformRespondedAt || (outcome.httpStatus ? attemptFinishedAt : null),
  };
  return repo.transact(
    id("dispatch-result"),
    { rowId, lock, outcome },
    async (tx) => {
      const current = await tx.get("outbox", rowId);
      if(current.conversation){const notice=await reconcileTaskNotification(tx,await tx.get('channel_turn',current.stepId));if(notice.state==='obsolete')return {status:notice.turn.status==='removed'?'canceled':current.status};}
      // A real claim can race with the webhook response; never downgrade its state.
      if (current.dispatchId !== lock)
        return { status: current.status };
      Object.assign(current, timing);
      if (current.status !== "sending") {
        tx.put("outbox", current);
        return { status: current.status };
      }
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
      // A rejected nonce-only self-check must not leave the setup screen
      // waiting forever. Preserve its history and leave business work alone.
      if (!current.conversation && ["rejected", "needs_review", "unknown"].includes(current.status)) {
        const probe = await tx.get("run", current.parentId);
        const step = await tx.get("step", current.stepId);
        if (probe.probe && probe.status === "running" && step.status === "ready") {
          const issue = current.httpStatus
            ? `原平台返回 HTTP ${current.httpStatus}，自检未收到确认；核对接收配置后可重试。`
            : "接入自检的发送结果尚未确认；核对原平台记录后可重试。";
          tx.put("step", { ...step, status: "needs_review", issues: [issue] });
          tx.put("run", { ...probe, status: "needs_review", probeError: issue });
        }
      }
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

// Independent native receivers need not wait behind a slow platform request.
// Keep bounded concurrency and one wake per resource in this maintenance pass;
// dispatchOne still owns all identity, deadline, coalescing and lease checks.
export async function dispatchPending(repo,identity,env,fetcher=fetch,now=new Date().toISOString()){
  const beganAt=Date.now(),seen=new Set(),result={notifications:0,errors:[]};
  const rows=(await Promise.all(['pending','retry','waiting_subscription'].map(status=>repo.list('outbox',{status,limit:60})))).flat().filter(r=>r.dueAt<=now).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
  const candidates=await Promise.all(rows.map(async row=>({row,connection:await repo.get('connection',row.memberId,false)})));
  const queue=candidates.filter(({row,connection})=>{
    const key=connection?.resourceKey||row.memberId;
    if(seen.has(key))return false;seen.add(key);return true;
  });
  for(let i=0;i<queue.length&&result.notifications<12&&Date.now()-beganAt<18000;i+=4){
    const batch=queue.slice(i,i+Math.min(4,12-result.notifications));
    const outcomes=await Promise.allSettled(batch.map(({row})=>dispatchOne(repo,identity,row.id,env,fetcher,now)));
    outcomes.forEach((outcome,index)=>{
      if(outcome.status==='fulfilled'){if(!outcome.value.skipped)result.notifications++;}
      else result.errors.push({kind:'notification',id:batch[index].row.id,code:outcome.reason?.code||'failure'});
    });
  }
  return result;
}

export async function maintenance(
  repo,
  identity,
  env,
  fetcher = fetch,
  now = new Date().toISOString(),
) {
  await conversationMaintenance(repo,identity,now);
  await secretaryMaintenance(repo,identity,now);
  await recoverUnclaimedWakes(repo, now);
  // Reconcile old blockers against actual member receipts that predate this
  // release. Never heal from a saved configuration or a platform HTTP receipt.
  let afterConnection='';
  for(;;){
    const page=await repo.list('connection',{status:'verified',after:afterConnection,limit:100});
    for(const c of page)if(Object.keys(receptionIssues(c)).length)await repo.transact(`reception-reconcile:${c.id}:${c.revision}:${now}`,{},async tx=>{
      for(const issue of Object.values(receptionIssues(await tx.get('connection',c.id)))){
        const turns=(await Promise.all(['done','silent'].map(status=>tx.list('channel_turn',{parent:c.id,...(issue.channelId?{scope:issue.channelId}:{}),status,order:'recent',limit:1})))).flat();
        for(const turn of turns)await resolveReceptionBlock(tx,turn);
      }
      return{};
    },now);
    if(page.length<100)break;afterConnection=page.at(-1).id;
  }
  const beganAt = Date.now();
  // Deliver current conversation work before schedule scans and recovery work.
  const summary = { ...(await dispatchPending(repo,identity,env,fetcher,now)), schedules:0,recovered:0 };
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
        `notice-stalled:${row.id}:${row.revision}`,
        { id: row.id, revision: row.revision },
        async (tx) => {
          if(row.conversation){
            const current=await tx.get('outbox',row.id);
            if(current.status!==row.status||current.revision!==row.revision)return {};
            await stallUnclaimedBatch(tx,current,'尚未确认成员接收；消息已保留，可重试或查看原 Agent。');
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
