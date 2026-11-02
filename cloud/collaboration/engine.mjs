import { fail, id, required, digest } from "./repository.mjs";
import { recipeById, nextDaily } from "../../shared/recipes.mjs";
import { ruleScope, memberSetKey } from "../../shared/policies.mjs";
import { applicableKnowledge, indexKnowledge } from "./knowledge.mjs";
import {
  flowCommand,
  prepareSubmission,
  finishFlowStep,
  dependencySteps,
} from "./flow.mjs";

const ACTIVE = ["ready", "running", "needs_review", "needs_approval"];
const memberOf = (identity, key) => {
  const m = identity.members.find(
    (x) => x.id === key && x.status !== "disabled",
  );
  const account = identity.accounts.find(
    (x) => x.id === m?.accountId && x.status !== "disabled",
  );
  if (!m || !account || m.paused)
    fail("member_unavailable", "成员已停用、暂停或不存在", 409);
  return m;
};
const expect = (record, revision) => {
  if (record.revision !== revision)
    fail("revision_conflict", "内容已更新，请读取最新版本后再保存", 409);
};
const owned = (actor, memberId) => {
  if (!actor.memberId || actor.memberId !== memberId)
    fail("forbidden", "此工作没有指派给你", 403);
};
const owner = (actor) => {
  if (!actor.owner) fail("forbidden", "此操作需要用户确认", 403);
};
const system = (actor) => {
  if (!actor.system) fail("forbidden", "内部操作", 403);
};
const deadline = (value) => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 1440)
    fail("invalid_deadline", "截止时间需为 1–1440 分钟或留空");
  return value;
};
const stepOrder = (steps) => steps.sort((a, b) => a.position - b.position);
async function activeRuns(tx, projectId) {
  return (
    await Promise.all(
      [...ACTIVE, "paused"].map((status) =>
        tx.list("run", { scope: projectId, status }),
      ),
    )
  ).flat();
}

async function connectionFor(
  tx,
  identity,
  memberId,
  capability,
  probe = false,
) {
  const member = memberOf(identity, memberId),
    c = await tx.get("connection", memberId);
  if (!["configured", "verified"].includes(c.status))
    fail("connection_unavailable", "原生接入未配置或已暂停", 409);
  if (!probe && c.status !== "verified")
    fail("connection_unverified", "请先完成该原生通道的真实往返验证", 409);
  if (capability && !c.capabilities.includes(capability))
    fail("capability_missing", `成员未配置 ${capability} 能力`, 409);
  return { member, connection: c };
}
async function ready(tx, step) {
  step.status = "ready";
  tx.put("step", step);
  const c = await tx.get("connection", step.memberId);
  tx.put("outbox", {
    id: `${step.id}_${step.generation}`,
    scopeId: step.scopeId,
    parentId: step.parentId,
    stepId: step.id,
    memberId: step.memberId,
    configVersion: c.configVersion,
    transport: c.transport,
    generation: step.generation,
    status: c.transport === "muse-poll" ? "polling" : "pending",
    attempts: 0,
    dueAt: tx.now,
    createdAt: tx.now,
  });
  tx.message(step.scopeId, "handoff", `${step.title}等待成员领取`, {
    runId: step.parentId,
    stepId: step.id,
    memberId: step.memberId,
  });
}
async function advance(tx, run, identity) {
  if (run.status === "canceled") return;
  const paused = run.status === "paused";
  const steps = stepOrder(await tx.list("step", { parent: run.id }));
  if (steps.every((s) => ["completed", "skipped"].includes(s.status))) {
    const docs = run.arrangement
      ? await tx.list("document", { parent: run.id })
      : [];
    run.status =
      run.arrangement &&
      (run.partial ||
        docs.some((d) => d.deliverable && d.qualityIssues?.length))
        ? "partially_met"
        : "completed";
    run.completedAt = tx.now;
    tx.message(run.scopeId, "run.completed", "本轮成果已交付，等待你审核", {
      runId: run.id,
    });
  } else if (steps.some((s) => s.status === "needs_review"))
    run.status = "needs_review";
  else if (steps.some((s) => s.status === "needs_approval"))
    run.status = "needs_approval";
  else if (run.status !== "paused") {
    run.status = "running";
    const project = await tx.get("project", run.scopeId);
    const next = steps.find(
      (s, i) =>
        s.status === "waiting" &&
        (s.dependsOn
          ? s.dependsOn.every((id) =>
              steps.some((x) => x.id === id && ["completed", "skipped"].includes(x.status)),
            )
          : steps.slice(0, i).every((x) => x.status === "completed")),
    );
    if (project.status === "active")
      for (const next of steps.filter(
        (s, i) =>
          s.status === "waiting" &&
          (s.dependsOn
            ? s.dependsOn.every((id) =>
                steps.some((x) => x.id === id && ["completed", "skipped"].includes(x.status)),
              )
            : steps.slice(0, i).every((x) => x.status === "completed")),
      ))
        await ready(tx, next);
  }
  if (paused && !["completed","partially_met"].includes(run.status)) run.status = "paused";
  tx.put("run", run);
  if (
    identity &&
    run.arrangement &&
    ["completed", "partially_met"].includes(run.status)
  ) {
    const project = await tx.get("project", run.scopeId);
    if (run.purpose === "goal") {
      const finalDocs = (await tx.list("document", { parent: run.id })).filter(
          (d) => d.deliverable,
        ),
        decisions = await tx.list("decision", { parent: run.id });
      const extra =
        finalDocs.some(
          (d) =>
            d.record?.unique || d.record?.independent || d.record?.corrections,
        ) || decisions.length;
      project.zeroContributionStreak = extra
        ? 0
        : (project.zeroContributionStreak || 0) + 1;
      tx.put("project", project);
    }
    const queued = (
      await tx.list("followup", { scope: run.scopeId, status: "queued" })
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (queued && project.status === "active") {
      queued.status = "started";
      tx.put("followup", queued);
      await startRun(tx, project, identity, {
        topicOverride: queued.body,
        ...(queued.memberId
          ? { instruction: queued.body, targetMember: queued.memberId }
          : {}),
      });
    }
  }
}
async function startRun(
  tx,
  project,
  identity,
  {
    probe = false,
    instruction,
    targetDocument,
    targetMember,
    topicOverride,
    purpose,
  } = {},
) {
  const prior = await activeRuns(tx, project.id);
  if (prior.some((x) => ACTIVE.includes(x.status) || x.status === "paused"))
    fail("project_busy", "项目还有未结束运行，补充要求请发到原运行", 409);
  if (project.status !== "active") fail("paused", "项目已暂停", 409);
  if (project.pendingArrangement && !probe) {
    Object.assign(project, project.pendingArrangement);
    delete project.pendingArrangement;
    tx.put("project", project);
  }
  const specs = probe
    ? [
        {
          slot: "probe",
          title: "验证原生往返",
          minimum: 1,
          instruction,
          requireSources: false,
        },
      ]
    : instruction
      ? [
          {
            slot: "revision",
            title: purpose === "learn" ? "归纳改稿偏好" : purpose === "recheck" ? "复查当前稿件" : purpose === "plan" ? "拟工作安排" : "修改指定成果",
            minimum: 1,
            instruction,
            requireSources: false,
          },
        ]
      : project.recipe.steps;
  const trial = !probe && !instruction ? (await applicableKnowledge(tx,project,"trial")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,1) : [];
  const knowledge = [
    ...(await applicableKnowledge(tx,project,"approved")),...trial,
  ].map((k) => ({
    id: k.id,
    revision: k.revision,
    title: k.title,
    body: k.body,
    kind: k.category,
    fileIds: k.fileIds || [],
  }));
  if (!probe && !instruction)
    for (const k of trial) {
      const used=tx.put("knowledge", {
        ...k,
        status: "trial_used",
        trialConsumedAt: tx.now,
      });
      await indexKnowledge(tx,used);
    }
  const run = tx.put("run", {
    id: id("run"),
    scopeId: project.id,
    status: "running",
    projectRevision: project.revision,
    projectType: project.projectType || null,
    memberSetKey: memberSetKey(project.arrangement?.members),
    recipeVersion: project.recipe.version,
    topic: topicOverride || project.topic,
    arrangement: project.arrangement
      ? structuredClone(project.arrangement)
      : null,
    purpose: purpose || (instruction ? "revise" : "goal"),
    materials: project.materials || [],
    knowledge,
    probe,
    createdAt: tx.now,
    deadlineAt: project.deadlineMinutes
      ? new Date(
          Date.parse(tx.now) + project.deadlineMinutes * 60000,
        ).toISOString()
      : null,
  });
  const stepIds = Object.fromEntries(specs.map((s, i) => [s.slot, id("step")]));
  for (const [position, spec] of specs.entries()) {
    const memberId = targetMember || project.slots[spec.slot];
    const { member, connection } = await connectionFor(
      tx,
      identity,
      memberId,
      spec.capability,
      probe,
    );
    const step = tx.put("step", {
      id: stepIds[spec.slot],
      phase: purpose || spec.kind || spec.slot,
      dependsOn: project.arrangement
        ? (spec.dependencies || []).map((key) => stepIds[key])
        : undefined,
      scopeId: project.id,
      parentId: run.id,
      memberId,
      accountId: member.accountId,
      resourceKey: connection.resourceKey,
      position,
      deliverable:
        !probe &&
        !["plan", "learn", "recheck"].includes(purpose) &&
        (Boolean(instruction) ||
          (project.arrangement ? spec.final : position === specs.length - 1)),
      generation: 1,
      status: "waiting",
      title: spec.title,
      instruction: spec.instruction,
      minimum: spec.minimum,
      requireSources: spec.requireSources,
      requiresApproval: project.approvals?.includes(spec.slot) || false,
      documentIds: [],
      targetDocument: targetDocument || null,
      createdAt: tx.now,
    });
    if (project.arrangement ? !spec.dependencies?.length : position === 0)
      await ready(tx, step);
  }
  tx.message(
    project.id,
    "run.started",
    probe ? "原生通道验证开始；尚未接通" : purpose === "learn" ? "正在从改稿中整理偏好，需确认后生效" : purpose === "recheck" ? "正在复查当前工作稿" : purpose === "plan" ? "正在拟工作安排" : instruction || project.topic,
    { runId: run.id, author: purpose ? "system" : "owner" },
  );
  return run;
}
export async function attemptFor(tx, actor, args) {
  const attempt = await tx.get("attempt", args.attemptId),
    step = await tx.get("step", attempt.parentId),
    run = await tx.get("run", step.parentId);
  owned(actor, step.memberId);
  if (
    attempt.leaseHash !==
      (await digest(required(args.lease, "领取凭证", 180))) ||
    step.activeAttemptId !== attempt.id ||
    attempt.generation !== step.generation ||
    run.status === "canceled" ||
    !["claimed", "running", "needs_review"].includes(attempt.status)
  )
    fail("stale_attempt", "领取凭证已失效，不能提交旧结果", 409);
  return { attempt, step, run };
}
async function release(tx, step, attempt) {
  const resource = await tx.get("resource", step.resourceKey, false);
  if (resource?.attemptId === attempt.id)
    tx.put("resource", { ...resource, status: "free", attemptId: null });
}
function outputItems(items, step, run) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 12)
    fail("invalid_delivery", "需要 1–12 个独立成果");
  const clean = items.map((v) => ({
    title: required(v.title, "成果标题", 160),
    body: required(v.body, "完整成果正文", 50000),
    format: ["text", "markdown", "html"].includes(v.format)
      ? v.format
      : "markdown",
    fileIds: Array.isArray(v.fileIds) ? v.fileIds.slice(0, 10) : [],
    sources: (Array.isArray(v.sources) ? v.sources : [])
      .slice(0, 40)
      .map((s) => {
        let url;
        try {
          url = new URL(
            required(typeof s === "string" ? s : s.url, "来源地址", 2000),
          );
        } catch {
          fail("invalid_source", "出处地址无效");
        }
        if (url.protocol !== "https:" || url.username || url.password)
          fail("invalid_source", "出处必须是 HTTPS 原文链接");
        return {
          url: url.href,
          title:
            typeof s === "string" ? "" : String(s.title || "").slice(0, 300),
          publishedAt: typeof s === "string" ? null : s.publishedAt || null,
        };
      }),
  }));
  const issues = [];
  if (clean.length < step.minimum)
    issues.push(`要求 ${step.minimum} 条，实际 ${clean.length} 条`);
  if (!run.probe && clean.some((x) => x.body.length < 20))
    issues.push("存在只有状态说明、缺少完整正文的成果");
  if (step.requireSources && clean.some((x) => !x.sources.length))
    issues.push("部分成果缺少原始出处");
  if (run.probe && (clean.length !== 1 || clean[0].body !== run.probeNonce))
    issues.push("验证结果不匹配");
  return { clean, issues };
}

export async function command(
  repo,
  identity,
  actor,
  input,
  now = new Date().toISOString(),
) {
  const { type, requestId, ...p } = input;
  required(requestId, "幂等请求编号", 120);
  if (actor.memberId) memberOf(identity, actor.memberId);
  return repo.transact(
    `${actor.memberId || (actor.system ? "system" : "owner")}:${requestId}`,
    {
      actor: actor.memberId || (actor.system ? "system" : "owner"),
      type,
      ...p,
    },
    async (tx) => {
      const flow = await flowCommand(
        tx,
        identity,
        actor,
        { type, ...p },
        { startRun, advance: (tx, run) => advance(tx, run, identity) },
      );
      if (flow.handled) return flow.result;
      switch (type) {
        case "project.create": {
          owner(actor);
          const recipe = recipeById(p.recipeId, p.recipeVersion || 1);
          if (!recipe) fail("recipe_not_found", "此配方版本不可用", 404);
          const slots = {};
          for (const spec of recipe.steps) {
            memberOf(identity, p.slots?.[spec.slot]);
            slots[spec.slot] = p.slots[spec.slot];
          }
          const project = tx.put("project", {
            id: id("project"),
            name: required(p.name, "项目名称", 160),
            topic: required(p.topic, "关注方向", 6000),
            recipe: structuredClone(recipe),
            slots,
            deadlineMinutes: deadline(p.deadlineMinutes),
            approvals: recipe.steps
              .filter((s) => p.approvals?.includes(s.slot))
              .map((s) => s.slot),
            status: "active",
            createdAt: tx.now,
          });
          tx.put("knowledge", {
            id: id("knowledge"),
            scopeId: project.id,
            title: "初始工作规则",
            body: recipe.knowledge,
            category: "rule",
            status: "approved",
            author: "owner",
            createdAt: tx.now,
          });
          tx.message(
            project.id,
            "project.created",
            "项目群已创建，尚未自动运行",
          );
          return project;
        }
        case "project.update": {
          owner(actor);
          const project = await tx.get("project", p.projectId);
          expect(project, p.revision);
          if (p.deadlineMinutes !== undefined)
            project.deadlineMinutes = deadline(p.deadlineMinutes);
          if (p.name !== undefined)
            project.name = required(p.name, "项目名称", 160);
          if (p.topic !== undefined)
            project.topic = required(p.topic, "关注方向", 6000);
          if (p.slots)
            for (const spec of project.recipe.steps) {
              memberOf(identity, p.slots[spec.slot]);
              project.slots[spec.slot] = p.slots[spec.slot];
            }
          if (p.approvals)
            project.approvals = project.recipe.steps
              .filter((s) => p.approvals.includes(s.slot))
              .map((s) => s.slot);
          tx.message(
            project.id,
            "project.updated",
            "项目设置已更新，运行中的分工与资料版本保持不变",
          );
          return tx.put("project", project);
        }
        case "project.control": {
          owner(actor);
          const project = await tx.get("project", p.projectId);
          if (!["pause", "resume"].includes(p.control))
            fail("invalid_input", "无效控制");
          project.status = p.control === "pause" ? "paused" : "active";
          tx.put("project", project);
          if (p.control === "resume")
            for (const run of await activeRuns(tx, project.id))
              if (ACTIVE.includes(run.status)) await advance(tx, run, identity);
          tx.message(
            project.id,
            "project.control",
            p.control === "pause"
              ? "暂停后续派发；远端正在执行的工作可能继续"
              : "项目恢复",
          );
          return project;
        }
        case "run.start": {
          owner(actor);
          return startRun(tx, await tx.get("project", p.projectId), identity);
        }
        case "run.control": {
          owner(actor);
          const run = await tx.get("run", p.runId);
          if (["completed", "canceled"].includes(run.status))
            fail("ended", "运行已经结束", 409);
          if (!["pause", "resume", "cancel"].includes(p.control))
            fail("invalid_input", "无效控制");
          run.status =
            p.control === "pause"
              ? "paused"
              : p.control === "cancel"
                ? "canceled"
                : "running";
          if (p.control === "cancel")
            for (const step of await tx.list("step", { parent: run.id })) {
              if (step.status === "completed") continue;
              step.status = "canceled";
              step.generation++;
              tx.put("step", step);
              if (step.activeAttemptId) {
                const attempt = await tx.get("attempt", step.activeAttemptId);
                attempt.status = "canceled";
                attempt.remoteStop = "not_confirmed";
                tx.put("attempt", attempt);
              }
            }
          tx.put("run", run);
          if (p.control === "resume") await advance(tx, run, identity);
          tx.message(
            run.scopeId,
            "run.control",
            `运行${p.control}；取消不等于已停止原平台任务`,
            { runId: run.id },
          );
          return run;
        }
        case "message.send": {
          owner(actor);
          const project = await tx.get("project", p.projectId),
            body = required(p.body, "消息", 8000);
          const message = tx.message(project.id, "user", body, {
            author: "owner",
            memberId: p.memberId || null,
          });
          if (p.memberId) {
            const c = await connectionFor(tx, identity, p.memberId);
            const runs = await activeRuns(tx, project.id);
            const run = runs.find(
              (x) => ACTIVE.includes(x.status) || x.status === "paused",
            );
            if (run) {
              if (run.status === "needs_review")
                fail("needs_review", "先核对当前运行，再追加任务", 409);
              const steps = await tx.list("step", { parent: run.id });
              if (steps.length >= 30) fail("capacity", "本轮步骤已达上限");
              tx.put("step", {
                id: id("step"),
                scopeId: project.id,
                parentId: run.id,
                memberId: p.memberId,
                accountId: c.member.accountId,
                resourceKey: c.connection.resourceKey,
                position: steps.length,
                deliverable: true,
                generation: 1,
                status: "waiting",
                title: "定向补充",
                instruction: body,
                minimum: 1,
                requireSources: false,
                requiresApproval: false,
                documentIds: [],
                createdAt: tx.now,
              });
              await advance(tx, run, identity);
              message.runId = run.id;
            } else
              message.runId = (
                await startRun(tx, project, identity, {
                  instruction: body,
                  targetMember: p.memberId,
                })
              ).id;
            tx.put("message", message);
          }
          return message;
        }
        case "step.claim": {
          const step = await tx.get("step", p.stepId);
          owned(actor, step.memberId);
          const run = await tx.get("run", step.parentId),
            project = await tx.get("project", step.scopeId);
          await connectionFor(tx, identity, step.memberId, null, run.probe);
          if (
            step.status !== "ready" ||
            !["running", "needs_review"].includes(run.status) ||
            project.status !== "active"
          )
            fail("not_ready", "步骤尚未就绪或已经领取", 409);
          tx.guardLegacyIdle(step.accountId);
          const resource = await tx.get("resource", step.resourceKey, false);
          if (
            identity.tasks?.some((t) =>
              t.steps.some(
                (s) => s.accountId === step.accountId && s.status === "running",
              ),
            )
          )
            fail("resource_busy", "该账号仍有旧版任务在运行", 409);
          if (resource?.status === "busy")
            fail(
              "resource_busy",
              "同账号资源仍被占用；超时不会自动重复执行",
              409,
            );
          const lease = id("lease"),
            attempt = tx.put("attempt", {
              id: id("attempt"),
              scopeId: step.scopeId,
              parentId: step.id,
              runId: run.id,
              memberId: step.memberId,
              generation: step.generation,
              leaseHash: await digest(lease),
              status: "claimed",
              claimedAt: tx.now,
              expiresAt: new Date(
                Date.parse(tx.now) + 15 * 60000,
              ).toISOString(),
              platformRunId: String(p.platformRunId || "").slice(0, 300),
            });
          tx.put("resource", {
            id: step.resourceKey,
            status: "busy",
            attemptId: attempt.id,
            memberId: step.memberId,
          });
          step.status = "running";
          step.activeAttemptId = attempt.id;
          tx.put("step", step);
          const c = await tx.get("connection", step.memberId);
          c.toolSeenAt = tx.now;
          tx.put("connection", c);
          const wake = await tx.get(
            "outbox",
            `${step.id}_${step.generation}`,
            false,
          );
          if (wake)
            tx.put("outbox", {
              ...wake,
              status: "claimed",
              attemptId: attempt.id,
            });
          tx.message(step.scopeId, "step.claimed", "成员实际领取了工作", {
            runId: run.id,
            stepId: step.id,
            memberId: step.memberId,
          });
          const preceding = run.arrangement
            ? (await dependencySteps(tx, step)).filter(
                (s) => s.status === "completed",
              )
            : stepOrder(await tx.list("step", { parent: run.id })).filter(
                (s) => s.position < step.position && s.status === "completed",
              );
          return {
            attemptId: attempt.id,
            lease,
            stepId: step.id,
            runId: run.id,
            generation: step.generation,
            expiresAt: attempt.expiresAt,
            input: {
              topic:
                run.arrangement && step.phase === "verify"
                  ? "定向事实核查"
                  : run.topic,
              kind: step.phase,
              criteria: run.arrangement?.criteria,
              important: !!run.arrangement?.important,
              availableMembers: identity.members.filter(m=>m.status!=="disabled"&&!m.paused).map(m=>({id:m.id,name:m.name,platform:m.platformId,sourcePermissions:"未单独核验；不要仅凭平台名称当作账号已授权"})),
              materials:
                run.arrangement && step.phase === "verify"
                  ? []
                  : run.materials || [],
              submissionContract: run.arrangement
                ? "items[].claims=[{id,text,sourceUrls,risk,important}]; 汇总/修订需 dispositions=[{claimId,action:adopt|refute|not_applicable|uncertain|duplicate|irrelevant|insufficient,reason}] 覆盖所有上游论断；确认某条为其他成员没有的独有贡献时才加 unique:true 和具体依据，不确定不计数。最终交付 selfCheck=[{criterion:从0开始的编号,pass,reason,paragraph}] 覆盖所有标准。存在冲突时 conflicts=[{id,type:fact|choice,claimIds,description,options:[{label,text,memberId,claimIds:[原始论断ID],sourceUrls:[原始链接],evidence:依据与适用条件}],paragraph}]；核查来源 sourceRelations=[{claimIds,independent,evidence}]；纠错 corrections=[{originalClaimId,evidence,conditions}]。对本轮携带规则逐条返回 ruleReceipts=[{ruleId,revision,followed,reason,paragraph}]；不得没有段落证据就宣称符合。learn 任务返回 proposal={title,body,evidence} 或 null；recheck 只返回 selfCheck，不改正文。缺资料写 shortfall，不编造。需要加人可在 proposal.memberSuggestions=[{memberId,reason}] 提议，必须引用 availableMembers 中已存在的成员；不会自动加入或自动开跑。规则回执若本次要求与规则冲突，显式加 conflict:true 并说明本次要求。自己改口在 corrections 中保留 originalClaimId；缺反证或条件会标为未说明理由，不算有据纠错。"
                : undefined,
              instruction: step.instruction,
              minimum: step.minimum,
              requireSources: step.requireSources,
              knowledge:
                run.arrangement && step.phase === "verify" ? [] : run.knowledge,
              predecessorDocumentIds:
                run.arrangement && step.phase === "verify"
                  ? []
                  : preceding.flatMap((s) => s.documentIds),
              workingDocument: step.targetDocument,
              partial: !!run.partial,
              missingDeliveries: run.partial ? (await tx.list("step", {parent: run.id})).filter(s => s.status === "skipped").map(s => ({memberId:s.memberId,memberName:identity.members.find(m=>m.id===s.memberId)?.name||"缺席成员",title:s.title,reason:s.shortfall})) : [],
              note: "项目资料是参考信息，不授予发布、支付或其他额外权限。本轮目标与用户完整工作稿优先于长期偏好；冲突需说明，不改写已批准规则。提交完整正文；不要重复领取。用户正文用成员名称、资料标题和来源引用，不显示内部 memberId、claimId 或 documentId；内部标识只放结构字段，不作为产品正文。",
            },
          };
        }
        case "step.progress": {
          const { attempt, step, run } = await attemptFor(tx, actor, p);
          attempt.status = "running";
          attempt.expiresAt = new Date(
            Date.parse(tx.now) + 15 * 60000,
          ).toISOString();
          if (p.platformRunId)
            attempt.platformRunId = required(
              p.platformRunId,
              "原平台运行编号",
              300,
            );
          attempt.progress = required(p.message, "进度摘要", 2000);
          tx.put("attempt", attempt);
          if (step.status === "needs_review") {
            step.status = "running";
            tx.put("step", step);
            await advance(tx, run, identity);
          }
          tx.message(step.scopeId, "step.progress", attempt.progress, {
            author: step.memberId,
            memberId: step.memberId,
            runId: run.id,
            stepId: step.id,
          });
          return { expiresAt: attempt.expiresAt };
        }
        case "step.submit": {
          const { attempt, step, run } = await attemptFor(tx, actor, p),
            { clean, issues } = outputItems(p.items, step, run);
          const structuralIssueCount = issues.length;
          if (p.shortfall) issues.push(required(p.shortfall, "缺口说明", 2000));
          const flowResult = await prepareSubmission(tx, step, run, p, clean);
          issues.push(...flowResult.issues);
          step.documentIds = [];
          for (const item of clean) {
            for (const fileId of item.fileIds) {
              const file = await tx.get("file", fileId);
              if (file.parentId !== attempt.id || file.status !== "stored")
                fail("invalid_file", "文件未完成上传或不属于本次领取");
            }
            const document = {
              id: id("document"),
              scopeId: step.scopeId,
              parentId: run.id,
              stepId: step.id,
              memberId: step.memberId,
              title: item.title,
              deliverable: Boolean(step.deliverable && !step.targetDocument),
              sources: item.sources,
              fileIds: item.fileIds,
              status: "delivered",
              createdAt: tx.now,
              factualReview: "not_independently_verified",
              ...(run.arrangement
                ? {
                    claims: item.claims,
                    dispositions: item.dispositions,
                    sourceRelations: item.sourceRelations,
                    corrections: item.corrections,
                  }
                : {}),
            };
            const version = tx.put("document_version", {
              id: id("version"),
              scopeId: step.scopeId,
              parentId: document.id,
              body: item.body,
              format: item.format,
              author: step.memberId,
              type: "agent",
              createdAt: tx.now,
            });
            document.originalVersionId = version.id;
            document.workingVersionId = version.id;
            tx.put("document", document);
            step.documentIds.push(document.id);
            if (step.targetDocument) {
              const target = await tx.get("document", step.targetDocument.id);
              if (!run.arrangement) {
                if (
                  clean.length === 1 &&
                  target.revision === step.targetDocument.revision
                ) {
                  const revised = tx.put("document_version", {
                    ...version,
                    id: id("version"),
                    parentId: target.id,
                    derivedFrom: document.id,
                  });
                  target.workingVersionId = revised.id;
                  target.latestAgentVersionId = revised.id;
                  tx.put("document", target);
                } else
                  issues.push(
                    "人工稿已更新或修订数量不符；新稿独立保存，未覆盖当前工作稿",
                  );
              } else if (!["learn","recheck"].includes(run.purpose)) {
                const revised = tx.put("document_version", {
                  ...version,
                  id: id("version"),
                  parentId: target.id,
                  derivedFrom: document.id,
                  previousId: step.targetDocument.versionId || step.targetDocument.workingVersionId || null,
                  type: "candidate",
                });
                target.candidateVersionId = revised.id;
                target.candidateBaseRevision = step.targetDocument.revision;
                tx.put("document", target);
              }
            }
          }
          step.issues = issues;
          step.status = run.arrangement
            ? "completed"
            : issues.length
              ? "needs_review"
              : step.requiresApproval
                ? "needs_approval"
                : "completed";
          attempt.status = "delivered";
          attempt.deliveredAt = tx.now;
          tx.put("attempt", attempt);
          tx.put("step", step);
          await release(tx, step, attempt);
          await finishFlowStep(tx, step, run, clean, issues, { identity, repairable: structuralIssueCount > 0 || flowResult.issues.length > 0 });
          if (run.probe && !issues.length) {
            const c = await tx.get("connection", step.memberId);
            c.status = "verified";
            c.verifiedAt = tx.now;
            c.setup = { stage: "verified", message: "原 Agent 已完成真实往返验证。", at: tx.now };
            c.deliveryEvidence = {
              runId: run.id,
              attemptId: attempt.id,
              documentIds: step.documentIds,
            };
            tx.put("connection", c);
          }
          tx.message(
            step.scopeId,
            "step.delivered",
            issues.length
              ? `已收成果，需处理：${issues.join("；")}`
              : "完整成果已存储；格式检查不代表事实已独立核验",
            {
              author: step.memberId,
              memberId: step.memberId,
              runId: run.id,
              stepId: step.id,
              documentIds: step.documentIds,
            },
          );
          await advance(tx, run, identity);
          return { status: step.status, documentIds: step.documentIds, issues };
        }
        case "step.approve": {
          owner(actor);
          const step = await tx.get("step", p.stepId),
            run = await tx.get("run", step.parentId);
          if (step.status !== "needs_approval" || run.status === "canceled")
            fail("invalid_state", "当前步骤不可批准", 409);
          step.status = "completed";
          step.approvedAt = tx.now;
          tx.put("step", step);
          await advance(tx, run, identity);
          return step;
        }
        case "step.retry": {
          owner(actor);
          const step = await tx.get("step", p.stepId),
            run = await tx.get("run", step.parentId);
          if (run.status === "canceled" || run.status === "completed")
            fail("ended", "请创建新运行", 409);
          if (!["needs_review", "needs_approval"].includes(step.status))
            fail("invalid_state", "只有需处理的步骤可重做", 409);
          const notification = await tx.get(
            "outbox",
            `${step.id}_${step.generation}`,
            false,
          );
          if (
            !step.activeAttemptId &&
            ["unknown", "accepted", "needs_review"].includes(
              notification?.status,
            ) &&
            !p.confirmRemoteStopped
          )
            fail("remote_unknown", "需核对原平台没有继续执行，再重做", 409);
          if (step.activeAttemptId) {
            const attempt = await tx.get("attempt", step.activeAttemptId);
            if (attempt.status !== "delivered" && !p.confirmRemoteStopped)
              fail(
                "remote_unknown",
                "需先确认远端任务已停止，避免重复执行",
                409,
              );
            attempt.status = "superseded";
            tx.put("attempt", attempt);
            await release(tx, step, attempt);
          }
          step.generation++;
          step.instruction += `\n用户重做要求：${required(p.reason, "重做要求", 4000)}`;
          step.activeAttemptId = null;
          step.documentIds = [];
          await ready(tx, step);
          run.status = "running";
          tx.put("run", run);
          return step;
        }
        case "resource.release": {
          owner(actor);
          if (!p.confirmRemoteStopped)
            fail("remote_unknown", "请核对原平台任务确已停止", 409);
          const resource = await tx.get("resource", p.resourceKey);
          if (resource.attemptId !== p.attemptId)
            fail("conflict", "占用者已变化", 409);
          const attempt = await tx.get("attempt", resource.attemptId);
          if (
            !["canceled", "needs_review", "superseded"].includes(attempt.status)
          )
            fail("active_attempt", "不能释放仍在执行的任务", 409);
          attempt.status = "superseded";
          tx.put("attempt", attempt);
          return tx.put("resource", {
            ...resource,
            status: "free",
            attemptId: null,
          });
        }
        case "document.edit": {
          owner(actor);
          const document = await tx.get("document", p.documentId);
          expect(document, p.revision);
          const original = await tx.get(
            "document_version",
            document.workingVersionId,
          );
          const version = tx.put("document_version", {
            id: id("version"),
            scopeId: document.scopeId,
            parentId: document.id,
            body: required(p.body, "正文", 50000),
            format: ["text", "markdown", "html"].includes(p.format)
              ? p.format
              : original.format,
            author: "owner",
            type: "human",
            previousId: original.id,
            createdAt: tx.now,
          });
          document.workingVersionId = version.id;
          const editEvent = tx.put("edit_event", {
            id: id("edit"),
            scopeId: document.scopeId,
            parentId: document.id,
            fromVersionId: original.id,
            toVersionId: version.id,
            emojiOnlyRemoval:
              /\p{Extended_Pictographic}/u.test(original.body) &&
              !/\p{Extended_Pictographic}/u.test(version.body) &&
              original.body.replace(
                /[\p{Extended_Pictographic}\uFE0F\u200D]/gu,
                "",
              ) === version.body,
            createdAt: tx.now,
          });
          tx.message(document.scopeId, "document.edited", "工作稿有新修改", {
            documentId: document.id,
          });
          document.editOrigin = "human";
          const documentProject = await tx.get("project", document.scopeId);
          if (documentProject.arrangement) {
            tx.put("distill_signal", {
              id: document.id,
              scopeId: document.scopeId,
              status: "pending",
              dueAt: new Date(Date.parse(tx.now) + 10 * 60000).toISOString(),
            });
            return tx.put("document", document);
          }
          const suggestionId = `emoji-rule:${document.scopeId}`;
          if (editEvent.emojiOnlyRemoval)
            tx.put("style_signal", { ...editEvent, id: document.id });
          if (
            editEvent.emojiOnlyRemoval &&
            !(await tx.get("knowledge", suggestionId, false))
          ) {
            const evidence = await tx.list("style_signal", {
              scope: document.scopeId,
            });
            if (evidence.length >= 3) {
              tx.put("knowledge", {
                id: suggestionId,
                scopeId: document.scopeId,
                title: "候选文风：不使用 emoji",
                body: "成稿不使用 emoji。此建议仅依据三份不同稿件中的纯 emoji 删除操作，是否作为长期规则由你决定。",
                category: "rule",
                status: "pending",
                author: "system",
                versionIds: evidence
                  .slice(-3)
                  .flatMap((e) => [e.fromVersionId, e.toVersionId]),
                createdAt: tx.now,
              });
              tx.message(
                document.scopeId,
                "knowledge.proposed",
                "三份稿件都只删除了 emoji，已生成候选规则，批准后才生效",
              );
            }
          }
          return tx.put("document", document);
        }
        case "document.revise": {
          owner(actor);
          const document = await tx.get("document", p.documentId);
          expect(document, p.revision);
          const version = await tx.get(
            "document_version",
            document.workingVersionId,
          );
          return startRun(
            tx,
            await tx.get("project", document.scopeId),
            identity,
            {
              instruction: required(p.instruction, "修改要求", 8000),
              targetMember: p.memberId || document.memberId,
              targetDocument: {
                id: document.id,
                revision: document.revision,
                versionId: version.id,
                body: version.body,
                format: version.format,
                sources: document.sources,
              },
            },
          );
        }
        case "feedback.set": {
          owner(actor);
          const document = await tx.get("document", p.documentId);
          if (!["adopted", "discarded", "pending"].includes(p.value))
            fail("invalid_input", "无效反馈");
          if (!document.deliverable)
            fail(
              "not_deliverable",
              "采用反馈只统计最终交付稿，研究过程材料不计入",
            );
          tx.put("feedback_event", {
            id: id("feedback"),
            scopeId: document.scopeId,
            parentId: document.id,
            value: p.value,
            evaluatedVersionId: document.workingVersionId,
            author: "owner",
            createdAt: tx.now,
          });
          document.feedback = p.value;
          document.evaluatedVersionId = document.workingVersionId;
          tx.put("document", document);
          return tx.put("feedback", {
            ...(await tx.get("feedback", document.id, false)),
            id: document.id,
            scopeId: document.scopeId,
            parentId: document.parentId,
            memberId: document.memberId,
            value: p.value,
            evaluatedVersionId: document.workingVersionId,
            originalVersionId: document.originalVersionId,
            author: "owner",
          });
        }
        case "knowledge.write": {
          const scopeId = required(p.projectId, "资料范围", 180);
          if (actor.memberId) {
            if (scopeId === "global")
              fail("forbidden", "成员不能写全局规则", 403);
            await requireProjectAccess(tx, scopeId, actor.memberId);
          } else owner(actor);
          const sourceProject = scopeId !== "global" ? await tx.get("project", scopeId) : null;
          const old = p.knowledgeId
            ? await tx.get("knowledge", p.knowledgeId)
            : null;
          const scopeTargetId=actor.memberId?scopeId:p.appliesToProjectId || old?.appliesToProjectId;
          const scopeTarget=scopeTargetId&&scopeTargetId!=="global"?await tx.get("project",scopeTargetId):sourceProject;
          if (old) {
            expect(old, p.revision);
            if (old.scopeId !== scopeId || actor.memberId)
              fail("forbidden", "不能覆盖已有批准知识", 403);
          }
          const files = [];
          for (const fileId of (p.fileIds || []).slice(0, 10)) {
            const file = await tx.get("file", fileId);
            if (file.scopeId !== scopeId || file.status !== "stored")
              fail("invalid_file", "资料文件不属于当前项目");
            files.push(file.id);
          }
          const evidence = [];
          for (const key of (p.versionIds || []).slice(0, 20)) {
            const v = await tx.get("document_version", key);
            if (v.scopeId !== scopeId)
              fail("forbidden", "依据不属于当前项目", 403);
            evidence.push(key);
          }
          if (old)
            tx.put("knowledge_version", {
              ...old,
              id: `${old.id}:${old.revision}`,
              parentId: old.id,
            });
          const newStatus = actor.memberId
            ? "pending"
            : p.approved === true
              ? "approved"
              : "pending";
          if (
            newStatus === "pending" &&
            (!old || old.status !== "pending") &&
            (await tx.list("knowledge", { scope: scopeId, status: "pending" }))
              .length >= 3
          )
            fail("knowledge_capacity", "每个项目最多保留 3 条待确认规则", 409);
          const item=tx.put("knowledge", {
            ...old,
            id: old?.id || id("knowledge"),
            scopeId,
            title: required(p.title, "知识标题", 160),
            body: required(p.body, "知识正文", 12000),
            category: p.category === "material" ? "material" : "rule",
            ...ruleScope({...old,...p,...(actor.memberId?{scopeMode:"project"}:{})}, scopeTarget),
            sourcePublishedAt: p.sourcePublishedAt || old?.sourcePublishedAt || null,
            collectedAt: old?.collectedAt || tx.now,
            status: actor.memberId
              ? "pending"
              : p.approved === true
                ? "approved"
                : "pending",
            author: actor.memberId || "owner",
            versionIds: evidence,
            fileIds: files,
            createdAt: old?.createdAt || tx.now,
          });
          await indexKnowledge(tx,item);
          return item;
        }
        case "knowledge.review": {
          owner(actor);
          const item = await tx.get("knowledge", p.knowledgeId);
          expect(item, p.revision);
          const previousKnowledge=structuredClone(item);
          if (p.scopeMode !== undefined) {const target=p.appliesToProjectId || item.appliesToProjectId || item.scopeId;Object.assign(item,ruleScope(p,target==="global"?null:await tx.get("project",target)));}
          if (!["approved", "trial", "rejected", "revoked"].includes(p.status))
            fail("invalid_input", "无效审批结果");
          if (
            p.status === "trial" &&
            item.status !== "trial" &&
            (
              await tx.list("knowledge", {
                scope: item.scopeId,
                status: "trial",
              })
            ).length >= 1
          )
            fail("knowledge_capacity", "每个项目最多保留 1 条试行规则", 409);
          tx.put("knowledge_version", {
            ...previousKnowledge,
            id: `${item.id}:${item.revision}`,
            parentId: item.id,
          });
          item.status = p.status;
          const updated=tx.put("knowledge", item);
          await indexKnowledge(tx,updated);
          return updated;
        }
        case "schedule.set": {
          owner(actor);
          await tx.get("project", p.projectId);
          const old = await tx.get("schedule", p.projectId, false);
          if (old) expect(old, p.revision);
          const timezone = required(p.timeZone, "时区", 80);
          let nextAt;
          try {
            nextAt = nextDaily(tx.now, timezone, p.hour, p.minute);
          } catch {
            fail("invalid_schedule", "请填写有效时区和时间");
          }
          return tx.put("schedule", {
            ...old,
            id: p.projectId,
            scopeId: p.projectId,
            status: p.enabled === true ? "enabled" : "disabled",
            timeZone: timezone,
            hour: p.hour,
            minute: p.minute,
            nextAt,
          });
        }
        case "schedule.fire": {
          system(actor);
          const schedule = await tx.get("schedule", p.projectId);
          if (
            schedule.status !== "enabled" ||
            schedule.nextAt !== p.expectedAt ||
            schedule.nextAt > tx.now
          )
            return { skipped: true };
          const project = await tx.get("project", schedule.scopeId);
          let result;
          const runs = await activeRuns(tx, project.id);
          if (
            project.status !== "active" ||
            runs.some((r) => ACTIVE.includes(r.status) || r.status === "paused")
          )
            result = { skipped: true, reason: "项目暂停或仍有未结束运行" };
          else {
            try {
              for (const spec of project.recipe.steps)
                await connectionFor(
                  tx,
                  identity,
                  project.slots[spec.slot],
                  spec.capability,
                );
            } catch (e) {
              if (!e.code) throw e;
              result = { skipped: true, reason: e.message };
            }
            if (!result) result = await startRun(tx, project, identity);
          }
          schedule.lastAt = schedule.nextAt;
          schedule.nextAt = schedule.times
            ? schedule.times
                .map((t) => {
                  const [h, m] = t.split(":").map(Number);
                  return nextDaily(tx.now, schedule.timeZone, h, m);
                })
                .sort()[0]
            : nextDaily(
                tx.now,
                schedule.timeZone,
                schedule.hour,
                schedule.minute,
              );
          tx.put("schedule", schedule);
          if (result.skipped)
            tx.message(project.id, "schedule.skipped", result.reason);
          return result;
        }
        case "attempt.expire": {
          system(actor);
          const attempt = await tx.get("attempt", p.attemptId);
          if (
            !["claimed", "running"].includes(attempt.status) ||
            attempt.expiresAt > tx.now
          )
            return { skipped: true };
          const step = await tx.get("step", attempt.parentId),
            run = await tx.get("run", step.parentId);
          if (step.activeAttemptId !== attempt.id || run.status === "canceled")
            return { skipped: true };
          attempt.status = "needs_review";
          step.status = "needs_review";
          tx.put("attempt", attempt);
          tx.put("step", step);
          await advance(tx, run, identity);
          tx.message(
            step.scopeId,
            "attempt.stalled",
            "未收到新进度，保留原领取与成果；请核对原平台运行，不自动重复派发",
            { runId: run.id, stepId: step.id },
          );
          return { status: "needs_review" };
        }
        case "connection.probe": {
          owner(actor);
          const c = await connectionFor(tx, identity, p.memberId, null, true),
            nonce = id("proof");
          let project = await tx.get("project", `probe_${p.memberId}`, false);
          project ||= tx.put("project", {
            id: `probe_${p.memberId}`,
            name: "接入验证",
            topic: "真实原生工具往返",
            hidden: true,
            status: "active",
            slots: { probe: p.memberId },
            recipe: { version: 1, steps: [] },
            createdAt: tx.now,
          });
          // Retrying this nonce-only probe cannot perform external work. Keep
          // its history, invalidate old leases, and never release business work.
          for (const previous of await activeRuns(tx, project.id)) {
            if (!previous.probe) fail("project_busy", "存在非验证任务，不能重试", 409);
            previous.status = "canceled";
            previous.cancelReason = "superseded_probe";
            tx.put("run", previous);
            for (const step of await tx.list("step", { parent: previous.id })) {
              step.status = "canceled";
              step.generation++;
              tx.put("step", step);
              if (step.activeAttemptId) {
                const attempt = await tx.get("attempt", step.activeAttemptId);
                attempt.status = "superseded";
                tx.put("attempt", attempt);
                await release(tx, step, attempt);
              }
            }
            tx.message(project.id, "probe.superseded", "重新验证原生往返；保留上次失败记录", { runId: previous.id });
          }
          const run = await startRun(tx, project, identity, {
            probe: true,
            instruction: `这是接入验证，不做外部操作。用一个成果提交：title 为 连接验证，body 严格等于 ${nonce}，sources 为空。`,
            targetMember: c.member.id,
          });
          run.probeNonce = nonce;
          tx.put("run", run);
          return { runId: run.id, status: "waiting_for_real_agent" };
        }
        default:
          fail("unknown_command", "未知协作操作", 404);
      }
    },
    now,
  );
}

export async function requireProjectAccess(tx, projectId, memberId) {
  const project = await tx.get("project", projectId);
  if (Object.values(project.slots).includes(memberId)) return project;
  const repository = tx.repo || tx;
  const access = await repository.db
    .prepare(
      "SELECT 1 AS permitted FROM hub_v2_records WHERE workspace_id=? AND kind='step' AND scope_id=? AND json_extract(body,'$.memberId')=? LIMIT 1",
    )
    .bind(repository.workspaceId, projectId, memberId)
    .first();
  if (!access) fail("forbidden", "未授权访问这个项目", 403);
  return project;
}

export async function workForMember(repo, identity, memberId) {
  memberOf(identity, memberId);
  const all = [
    ...(await repo.list("step", { status: "ready", limit: 500 })),
    ...(await repo.list("step", { status: "running", limit: 500 })),
    ...(await repo.list("step", { status: "needs_review", limit: 500 })),
  ];
  const work = [];
  for (const step of all.filter((s) => s.memberId === memberId)) {
    const run = await repo.get("run", step.parentId),
      project = await repo.get("project", step.scopeId);
    if (
      run.status === "canceled" ||
      (step.status === "ready" &&
        (!["running", "needs_review"].includes(run.status) || project.status !== "active"))
    )
      continue;
    work.push({
      stepId: step.id,
      runId: run.id,
      projectId: project.id,
      title: step.title,
      status: step.status,
      generation: step.generation,
      attemptId: step.activeAttemptId || null,
    });
  }
  return work;
}
