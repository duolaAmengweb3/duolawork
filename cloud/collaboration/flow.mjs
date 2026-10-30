import { fail, id, required } from "./repository.mjs";
import { nextDaily } from "../../shared/recipes.mjs";
import {
  normalizeArrangement,
  compileArrangement,
  normalizeSource,
} from "../../shared/modes.mjs";
const owner = (a) => {
  if (!a.owner) fail("forbidden", "需要用户确认", 403);
};
export async function dependencySteps(tx, step) {
  const steps = await tx.list("step", { parent: step.parentId });
  const byId = new Map(steps.map((s) => [s.id, s])),
    seen = new Set();
  const visit = (s) => {
    for (const key of s.dependsOn ||
      steps.filter((x) => x.position < s.position).map((x) => x.id)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (byId.has(key)) visit(byId.get(key));
    }
  };
  visit(step);
  return steps.filter((s) => seen.has(s.id));
}
export async function canRead(tx, memberId, record) {
  if (
    record.parentId === "owner" ||
    (record.author === "owner" && record.kind === "file")
  )
    return true;
  let sourceStep = record.stepId
    ? await tx.get("step", record.stepId, false)
    : null;
  if (!sourceStep && record.kind === "file") {
    const attempt = await tx.get("attempt", record.parentId, false);
    if (attempt) sourceStep = await tx.get("step", attempt.parentId, false);
  }
  if (!sourceStep) return false;
  if (sourceStep.memberId === memberId) return true;
  const run = await tx.get("run", sourceStep.parentId);
  if (!run.arrangement) return true;
  const mine = (await tx.list("step", { parent: run.id })).filter(
    (s) =>
      s.memberId === memberId &&
      ["ready", "running", "completed", "needs_approval"].includes(s.status),
  );
  for (const step of mine)
    if (
      step.phase !== "verify" &&
      (await dependencySteps(tx, step)).some((s) => s.id === sourceStep.id)
    )
      return true;
  const project = await tx.get("project", record.scopeId);
  return (project.materials || []).some((m) => m.fileId === record.id);
}
export async function flowCommand(tx, identity, actor, input, h) {
  const { type, ...p } = input;
  if (type === "project.keep_mode") {
    owner(actor);
    const project = await tx.get("project", p.projectId);
    project.nextContributionReminder =
      (project.zeroContributionStreak || 0) + 3;
    return { handled: true, result: tx.put("project", project) };
  }
  if (type === "arrangement.suggest") {
    owner(actor);
    const goal = required(p.goal, "目标", 8000),
      members = p.members || [];
    const lead = members.includes(p.lead) ? p.lead : members[0];
    if (!identity.members.some((m) => m.id === lead && !m.paused))
      fail("member_unavailable", "先选一位已连接成员", 409);
    const arrangement = normalizeArrangement(
        {
          mode: "solo",
          members: [lead],
          lead,
          criteria: ["只给工作安排建议，不执行业务任务"],
          internalRevisions: 0,
        },
        goal,
      ),
      compiled = compileArrangement(arrangement);
    const project = tx.put("project", {
      id: id("advice-project"),
      name: "工作安排草案",
      topic: goal,
      arrangement,
      ...compiled,
      status: "active",
      hidden: true,
      createdAt: tx.now,
    });
    const run = await h.startRun(tx, project, identity, {
      purpose: "plan",
      instruction:
        "只拟一份工作安排草案，不执行目标。items[0].proposal 返回 {mode:parallel|review|solo,delivery:final|compare,members:从给定成员选择,lead,criteria:合格标准数组}。不得新增其他成员。可用成员：" +
        JSON.stringify(members),
    });
    run.adviceMembers = members;
    tx.put("run", run);
    return { handled: true, result: run };
  }
  if (type === "project.create" && (p.arrangement || p.goal)) {
    owner(actor);
    const arrangement = normalizeArrangement(
        p.arrangement || p,
        p.goal || p.topic,
      ),
      compiled = compileArrangement(arrangement);
    for (const m of arrangement.members)
      if (
        !identity.members.some(
          (x) => x.id === m && !x.paused && x.status !== "disabled",
        )
      )
        fail("member_unavailable", "所选成员不可用", 409);
    const project = tx.put("project", {
      id: id("project"),
      name: required(p.name || p.goal?.slice(0, 30), "项目名", 160),
      topic: required(p.goal || p.topic, "目标", 8000),
      arrangement,
      ...compiled,
      status: "active",
      materials: (p.materials || []).slice(0, 30),
      createdAt: tx.now,
      planVersion: 1,
    });
    if (p.adviceRunId) {
      const advice = await tx.get("run", p.adviceRunId);
      if (advice.purpose !== "plan") fail("invalid_advice", "不是工作安排建议");
      if (advice.planSuggestion) project.planSuggestion = advice.planSuggestion;
      tx.put("project", project);
      tx.put("advice_target", { id: p.adviceRunId, scopeId: project.id });
    }
    tx.message(project.id, "project.created", "项目已创建，工作安排已保存");
    return { handled: true, result: project };
  }
  if (type === "project.update" && p.arrangement) {
    owner(actor);
    const project = await tx.get("project", p.projectId);
    if (project.revision !== p.revision)
      fail("revision_conflict", "安排已更新，请重新读取", 409);
    const arrangement = normalizeArrangement(
      p.arrangement,
      p.goal || project.topic,
    );
    for (const m of arrangement.members)
      if (!identity.members.some((x) => x.id === m && !x.paused))
        fail("member_unavailable", "成员不可用", 409);
    const active = (await tx.list("run", { scope: project.id })).some((r) =>
      ["running", "paused", "needs_review"].includes(r.status),
    );
    const next = {
      arrangement,
      ...compileArrangement(arrangement),
      topic: p.goal || project.topic,
    };
    if (active) project.pendingArrangement = next;
    else Object.assign(project, next);
    project.planVersion = (project.planVersion || 1) + 1;
    return { handled: true, result: tx.put("project", project) };
  }
  if (type === "project.material") {
    owner(actor);
    const project = await tx.get("project", p.projectId),
      material = {
        ...p.material,
        title: required(p.material?.title, "资料名称", 300),
      };
    if (material.sourceDocument) {
      const source = await tx.get("document", material.sourceDocument);
      if (!p.material.version) material.version = source.workingVersionId;
      const version = await tx.get("document_version", material.version);
      if (version.parentId !== source.id)
        fail("invalid_reference", "引用版本不属于该成果");
      material.body = version.body;
      material.sourceProject = source.scopeId;
    }
    project.materials = [...(project.materials || []), material];
    if (project.materials.length > 50)
      fail("capacity", "本项目资料过多，请整理后再添加", 409);
    return { handled: true, result: tx.put("project", project) };
  }
  if (type === "comparison.adopt") {
    owner(actor);
    const project = await tx.get("project", p.projectId),
      source = await tx.get("document", p.sourceDocumentId);
    if (source.scopeId !== project.id)
      fail("forbidden", "只能采用本项目并排成果", 403);
    const version = await tx.get("document_version", source.workingVersionId),
      parts = version.body.split(/\n\s*\n/).filter(Boolean);
    if (!Number.isInteger(p.sectionIndex) || !parts[p.sectionIndex])
      fail("invalid_section", "原文段落不存在");
    const adoptionKey = version.id + ":" + p.sectionIndex;
    let draft = project.comparisonDraftId
      ? await tx.get("document", project.comparisonDraftId)
      : null;
    if (draft?.adoptions?.some((a) => a.key === adoptionKey))
      return { handled: true, result: draft };
    if (!draft)
      draft = {
        id: id("document"),
        scopeId: project.id,
        parentId: source.parentId,
        memberId: "owner",
        title: "我的工作稿",
        status: "working",
        deliverable: false,
        adoptions: [],
        sources: [],
        createdAt: tx.now,
      };
    const previous = draft.workingVersionId
      ? await tx.get("document_version", draft.workingVersionId)
      : null;
    const name =
      identity.members.find((m) => m.id === source.memberId)?.name || "成员";
    const body =
      (previous?.body || "") +
      "\n\n" +
      parts[p.sectionIndex] +
      `\n\n[${name} · 原文段落 ${p.sectionIndex + 1}]`;
    if (body.length > 50000) fail("capacity", "工作稿已达正文上限");
    const next = tx.put("document_version", {
      id: id("version"),
      scopeId: project.id,
      parentId: draft.id,
      body,
      format: "markdown",
      author: "owner",
      type: "human",
      previousId: previous?.id || null,
      createdAt: tx.now,
    });
    draft.originalVersionId ||= next.id;
    draft.workingVersionId = next.id;
    draft.adoptions.push({
      key: adoptionKey,
      sourceDocumentId: source.id,
      versionId: version.id,
      section: p.sectionIndex,
    });
    project.comparisonDraftId = draft.id;
    tx.put("project", project);
    return { handled: true, result: tx.put("document", draft) };
  }
  if (type === "schedule.set" && Array.isArray(p.times)) {
    owner(actor);
    await tx.get("project", p.projectId);
    if (
      (p.enabled && !p.times.length) ||
      p.times.length > 12 ||
      p.times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    )
      fail("invalid_schedule", "请输入有效时间");
    const old = await tx.get("schedule", p.projectId, false);
    const times = [
      ...new Set(p.times.length ? p.times : old?.times || ["06:00"]),
    ].sort();
    let nextAt;
    try {
      nextAt = times
        .map((t) => {
          const [h, m] = t.split(":").map(Number);
          return nextDaily(tx.now, p.timeZone, h, m);
        })
        .sort()[0];
    } catch {
      fail("invalid_schedule", "时区无效");
    }
    return {
      handled: true,
      result: tx.put("schedule", {
        ...old,
        id: p.projectId,
        scopeId: p.projectId,
        status: p.enabled ? "enabled" : "disabled",
        times,
        timeZone: p.timeZone,
        nextAt,
      }),
    };
  }
  if (type === "message.send") {
    const project = await tx.get("project", p.projectId);
    if (!project.arrangement) return { handled: false };
    owner(actor);
    const body = required(p.body, "消息", 8000);
    const message = tx.message(project.id, "user", body, {
      author: "owner",
      memberId: p.memberId || null,
    });
    const active = (await tx.list("run", { scope: project.id })).find((r) =>
      ["running", "paused", "needs_review", "needs_approval"].includes(
        r.status,
      ),
    );
    if (active) {
      tx.put("followup", {
        id: message.id,
        scopeId: project.id,
        parentId: active.id,
        status: "queued",
        body,
        memberId: p.memberId || null,
        createdAt: tx.now,
      });
      return { handled: true, result: { ...message, queued: true } };
    }
    if (project.pendingArrangement) {
      Object.assign(project, project.pendingArrangement);
      delete project.pendingArrangement;
      tx.put("project", project);
    }
    const run = await h.startRun(tx, project, identity, {
      topicOverride: body,
      ...(p.memberId ? { instruction: body, targetMember: p.memberId } : {}),
    });
    return { handled: true, result: { ...message, runId: run.id } };
  }
  if (type === "decision.choose") {
    owner(actor);
    const decision = await tx.get("decision", p.decisionId),
      doc = await tx.get("document", decision.documentId);
    if (doc.revision !== p.revision)
      fail("revision_conflict", "稿件有更新，读取后再决定", 409);
    const choice = p.undo
      ? null
      : required(
          p.text || decision.options?.[p.option]?.text,
          "决定正文",
          10000,
        );
    decision.status = p.undo ? "pending" : "resolved";
    decision.choice = choice;
    decision.chosenAt = tx.now;
    const working = await tx.get("document_version", doc.workingVersionId);
    const escape = (text) =>
      String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
    const node = `<hub-decision data-id="${escape(decision.id)}"${choice ? ` data-selected="${escape(choice)}" data-choice="用户选择"` : ""}><p>${escape(choice || "待你决定")}</p></hub-decision>`;
    const escaped = decision.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      '<hub-decision[^>]*data-id="' +
        escaped +
        '"[^>]*>[\\s\\S]*?</hub-decision>',
      "g",
    );
    const body = pattern.test(working.body)
      ? working.body.replace(pattern, node)
      : working.body + "\n\n" + node;
    const version = tx.put("document_version", {
      id: id("version"),
      scopeId: doc.scopeId,
      parentId: doc.id,
      body,
      format: working.format,
      author: "owner",
      type: "human",
      previousId: working.id,
      createdAt: tx.now,
    });
    doc.workingVersionId = version.id;
    doc.editOrigin = "human";
    tx.put("document", doc);
    tx.put("decision", decision);
    tx.message(
      decision.scopeId,
      "decision.chosen",
      p.undo ? "已撤回决定" : "已保留你的选择",
      { decisionId: decision.id, documentId: doc.id },
    );
    return { handled: true, result: decision };
  }
  if (type === "document.apply_candidate") {
    owner(actor);
    const doc = await tx.get("document", p.documentId);
    if (doc.revision !== p.revision)
      fail("revision_conflict", "工作稿已更新，需重新对比", 409);
    if (!doc.candidateVersionId) fail("no_candidate", "没有候选稿", 409);
    const candidate = await tx.get("document_version", doc.candidateVersionId);
    const old = doc.workingVersionId;
    doc.workingVersionId = candidate.id;
    doc.previousWorkingVersionId = old;
    doc.candidateVersionId = null;
    doc.editOrigin = "agent";
    return { handled: true, result: tx.put("document", doc) };
  }
  if (type === "document.recheck") {
    owner(actor);
    const doc = await tx.get("document", p.documentId);
    if (doc.revision !== p.revision)
      fail("revision_conflict", "稿件已更新", 409);
    const project = await tx.get("project", doc.scopeId),
      working = await tx.get("document_version", doc.workingVersionId);
    const run = await h.startRun(tx, project, identity, {
      instruction:
        "仅按合格标准复查这份工作稿，逐条返回 selfCheck。不要改写正文。",
      targetMember:
        doc.memberId === "owner" ? project.arrangement.lead : doc.memberId,
      targetDocument: {
        id: doc.id,
        revision: doc.revision,
        workingVersionId: working.id,
        body: working.body,
      },
      purpose: "recheck",
    });
    return { handled: true, result: run };
  }
  if (type === "document.learn") {
    if (!actor.system) owner(actor);
    const doc = await tx.get("document", p.documentId),
      project = await tx.get("project", doc.scopeId);
    if (!project.arrangement)
      return { handled: true, result: { skipped: true } };
    const pending = await tx.list("knowledge", {
      scope: project.id,
      status: "pending",
    });
    if (pending.length >= 3) fail("learn_busy", "待确认规则已满", 409);
    const running = (await tx.list("run", { scope: project.id })).find(
      (r) => r.purpose === "learn" && r.status === "running",
    );
    if (running) fail("learn_busy", "已有归纳任务", 409);
    const old = await tx.get("document_version", doc.originalVersionId),
      working = await tx.get("document_version", doc.workingVersionId);
    if (old.id === working.id || doc.learnedVersionId === working.id)
      return { handled: true, result: { skipped: true } };
    const run = await h.startRun(tx, project, identity, {
      instruction:
        "根据用户改稿归纳一条可确认的长期写作偏好。只把有改动证据的偏好写入 proposal；没有则 proposal=null，不猜用户意图。",
      targetMember: project.arrangement.lead,
      targetDocument: {
        id: doc.id,
        revision: doc.revision,
        original: old.body,
        body: working.body,
        workingVersionId: working.id,
      },
      purpose: "learn",
    });
    doc.learnedVersionId = working.id;
    tx.put("document", doc);
    return { handled: true, result: run };
  }
  if (type === "run.accept_partial") {
    owner(actor);
    const run = await tx.get("run", p.runId);
    if (!run.arrangement) fail("invalid_run", "不是新协作运行");
    const steps = await tx.list("step", { parent: run.id }),
      delivered = steps.filter(
        (s) => s.status === "completed" && s.documentIds.length,
      );
    if (!delivered.length) fail("no_delivery", "没有可用成果", 409);
    if (steps.some(s => s.status === "running" && s.activeAttemptId) && !p.confirmRemoteStopped)
      fail("remote_unknown", "成员仍在执行，请先确认原平台任务已停止，再使用已有结果", 409);
    run.partial = true;
    run.status = "running";
    for (const step of steps) {
      if (
        ["needs_review", "running", "ready"].includes(step.status) &&
        !step.documentIds.length
      ) {
        step.generation++;
        step.status = "skipped";
        step.shortfall = "用户选择使用已有结果，缺少此成员交付";
        if (step.activeAttemptId) {
          const attempt = await tx.get("attempt", step.activeAttemptId);
          attempt.status = "superseded";
          tx.put("attempt", attempt);
          const resource = await tx.get("resource", step.resourceKey, false);
          if (resource?.attemptId === attempt.id)
            tx.put("resource", {...resource, status:"free", attemptId:null});
        }
        tx.put("step", step);
      }
    }
    const final = steps.find((s) => s.deliverable && s.status === "waiting");
    if (final) {
      const available =
        delivered.find((s) => s.memberId !== final.memberId) || delivered[0];
      final.memberId = available.memberId;
      final.accountId = available.accountId;
      final.resourceKey = available.resourceKey;
      tx.put("step", final);
    }
    tx.put("run", run);
    await h.advance(tx, run);
    return { handled: true, result: run };
  }
  return { handled: false };
}
export async function prepareSubmission(tx, step, run, raw, clean) {
  if (!run.arrangement || run.probe) return { issues: [] };
  const issues = [],
    upstream = await dependencySteps(tx, step),
    claims = [];
  for (const s of upstream)
    for (const key of s.documentIds) {
      const d = await tx.get("document", key);
      claims.push(...(d.claims || []));
    }
  for (let i = 0; i < clean.length; i++) {
    for (const key of [
      "claims",
      "dispositions",
      "selfCheck",
      "conflicts",
      "sourceRelations",
      "corrections",
      "critiques",
      "ruleReceipts",
    ])
      if (raw.items[i][key] !== undefined && !Array.isArray(raw.items[i][key]))
        fail("invalid_delivery", key + " 必须是数组");
    const item = clean[i],
      v = raw.items[i];
    item.claims = (v.claims || []).slice(0, 100).map((c, n) => ({
      id: `${step.id}:${i}:${c.id || n}`,
      localId: String(c.id || n),
      text: required(c.text, "论断", 3000),
      sourceUrls: (Array.isArray(c.sourceUrls) ? c.sourceUrls : [])
        .map(normalizeSource)
        .filter(Boolean),
      risk: c.risk === true,
      important: c.important === true,
      memberId: step.memberId,
    }));
    if (
      !["plan", "learn", "recheck", "review", "verify"].includes(step.phase) &&
      !item.claims.length
    )
      issues.push("未提供结构化论断 claims");
    if (
      item.claims.some((c) => !c.sourceUrls.length) &&
      run.purpose !== "learn" &&
      !v.shortfall &&
      !raw.shortfall
    )
      issues.push("论断缺来源且未说明缺口");
    item.selfCheck = (v.selfCheck || raw.selfCheck || []).slice(0, 20);
    if (
      (step.deliverable || run.purpose === "recheck") &&
      !["plan", "learn"].includes(run.purpose)
    )
      for (let n = 0; n < run.arrangement.criteria.length; n++) {
        const check = item.selfCheck.find(
          (c) => c.criterion === n || c.criterionId === String(n),
        );
        if (
          !check ||
          typeof check.pass !== "boolean" ||
          !check.reason ||
          (check.pass && !check.paragraph)
        )
          issues.push(`合格标准 ${n + 1} 未给出有效自查`);
        else if (!check.pass)
          issues.push(`标准未达标：${run.arrangement.criteria[n]}`);
      }
    item.dispositions = (v.dispositions || []).slice(0, 300);
    item.upstreamClaims = claims;
    if (["integrate", "resolve", "revise"].includes(step.phase))
      for (const c of claims) {
        const d = item.dispositions.find((d) => d.claimId === c.id);
        if (
          !d ||
          ![
            "adopt",
            "refute",
            "not_applicable",
            "uncertain",
            "duplicate",
            "irrelevant",
            "insufficient",
          ].includes(d.action) ||
          !d.reason
        )
          issues.push(`未处理上游论断：${c.id}`);
      }
    item.conflicts = (v.conflicts || []).slice(0, 12);
    item.sourceRelations = (v.sourceRelations || []).slice(0, 100);
    item.corrections = (v.corrections || []).slice(0, 100);
    item.proposal = v.proposal || null;
    item.ruleReceipts = (v.ruleReceipts || [])
      .filter(
        (r) =>
          run.knowledge.some(
            (k) => r.ruleId === k.id && r.revision === k.revision,
          ) &&
          typeof r.followed === "boolean" &&
          r.reason &&
          r.paragraph,
      )
      .map((r) => ({ ...r, checkedBy: step.memberId }));
    if (step.phase === "review") {
      item.critiques = (v.critiques || []).slice(0, 30);
      if (item.critiques.some((c) => !c.evidence))
        issues.push("检查质疑缺少证据");
    }
  }
  return { issues: [...new Set(issues)], upstreamClaims: claims };
}
export async function finishFlowStep(tx, step, run, clean, issues, h) {
  if (!run.arrangement || run.probe) return;
  if (run.purpose === "plan") {
    if (clean[0]?.proposal) {
      const proposal = normalizeArrangement(clean[0].proposal, run.topic);
      if (proposal.members.some((m) => !run.adviceMembers.includes(m)))
        fail("invalid_arrangement", "建议不能增加未选择的成员");
      run.planSuggestion = proposal;
      const target = await tx.get("advice_target", run.id, false);
      if (target) {
        const project = await tx.get("project", target.scopeId);
        project.planSuggestion = proposal;
        tx.put("project", project);
      }
      tx.put("run", run);
    }
    for (const key of step.documentIds) {
      const d = await tx.get("document", key);
      d.deliverable = false;
      d.internal = true;
      tx.put("document", d);
    }
    return;
  }
  if (run.purpose === "learn") {
    const proposal = clean[0]?.proposal;
    if (
      proposal &&
      (await tx.list("knowledge", { scope: run.scopeId, status: "pending" }))
        .length < 3
    )
      tx.put("knowledge", {
        id: id("knowledge"),
        scopeId: run.scopeId,
        status: "pending",
        category: "rule",
        title: String(proposal.title || "来自你的改稿").slice(0, 160),
        body: required(proposal.body, "规则正文", 12000),
        author: step.memberId,
        source: "human_edit",
        documentId: step.targetDocument.id,
        versionIds: [step.targetDocument.workingVersionId],
        evidence: proposal.evidence || "",
        createdAt: tx.now,
      });
  }
  if (run.purpose === "recheck") {
    const target = await tx.get("document", step.targetDocument.id);
    target.selfCheckVersionId = step.targetDocument.workingVersionId;
    target.selfCheck = clean[0].selfCheck;
    target.checkedBy = step.memberId;
    tx.put("document", target);
  }
  const attempts = step.internalRound || 0;
  if (
    issues.length &&
    (step.deliverable || h.repairable) &&
    step.phase !== "learn" &&
    step.phase !== "recheck" &&
    attempts < run.arrangement.internalRevisions
  ) {
    for (const key of step.documentIds) {
      const d = await tx.get("document", key);
      d.deliverable = false;
      d.internal = true;
      tx.put("document", d);
    }
    const next = tx.put("step", {
      ...step,
      id: id("step"),
      position: step.position + 0.1,
      dependsOn: [...new Set([...(step.dependsOn || []), step.id])],
      status: "waiting",
      activeAttemptId: null,
      documentIds: [],
      generation: 1,
      internalRound: attempts + 1,
      instruction:
        step.instruction +
        "\n内部补交/修订（不改用户标准）：" +
        issues.join("；"),
      createdAt: tx.now,
    });
    step.deliverable = false;
    tx.put("step", step);
    for (const dependent of await tx.list("step", { parent: run.id })) {
      if (
        dependent.id !== next.id &&
        dependent.status === "waiting" &&
        dependent.dependsOn?.includes(step.id)
      ) {
        dependent.dependsOn = dependent.dependsOn.map((k) =>
          k === step.id ? next.id : k,
        );
        tx.put("step", dependent);
      }
    }
    return;
  }
  for (let i = 0; i < step.documentIds.length; i++) {
    const d = await tx.get("document", step.documentIds[i]),
      item = clean[i];
    d.qualityIssues = issues;
    d.status = issues.length || run.partial ? "partially_met" : "delivered";
    d.selfCheck = item.selfCheck;
    d.selfCheckVersionId = d.originalVersionId;
    d.checkedBy = step.memberId;
    d.ruleReceipts = item.ruleReceipts;
    if (
      step.deliverable &&
      !["plan", "learn", "recheck"].includes(run.purpose)
    ) {
      const verifyIds = [];
      for (const c of item.conflicts) {
        const key = `${run.id}:${String(
          c.description || c.reason || c.claimIds?.join(":") || c.id,
        )
          .trim()
          .slice(0, 180)}`;
        let disagreement = await tx.get("disagreement", key, false);
        if (!disagreement) {
          disagreement = tx.put("disagreement", {
            id: key,
            scopeId: run.scopeId,
            parentId: run.id,
            type: c.type === "choice" ? "choice" : "fact",
            claimIds: c.claimIds || [],
            body: c.description || c.reason || "待核对",
            status: c.type === "choice" ? "decision" : "unverified",
            checks: 0,
            createdAt: tx.now,
          });
        }
        if (
          disagreement.type === "choice" &&
          !(await tx.get("decision", key, false))
        )
          tx.put("decision", {
            id: key,
            scopeId: run.scopeId,
            parentId: run.id,
            documentId: d.id,
            status: "pending",
            title: c.title || "需要你的取舍",
            description: c.description || c.reason || "",
            paragraph: c.paragraph || "",
            options: c.options || [],
            createdAt: tx.now,
          });
        else if (disagreement.type === "fact" && step.phase === "resolve") {
          d.qualityIssues = [
            ...new Set([
              ...d.qualityIssues,
              "补证后仍有未确认事实：" + disagreement.body,
            ]),
          ];
          d.status = "partially_met";
        } else if (
          disagreement.type === "fact" &&
          disagreement.checks === 0 &&
          step.phase !== "resolve"
        ) {
          const verifyMember =
            run.arrangement.members.find((m) => m !== step.memberId) ||
            run.arrangement.lead;
          const conn = await tx.get("connection", verifyMember);
          const member = h.identity.members.find((m) => m.id === verifyMember);
          const verify = tx.put("step", {
            ...step,
            id: id("step"),
            phase: "verify",
            memberId: verifyMember,
            accountId: member.accountId,
            resourceKey: conn.resourceKey,
            position: step.position + 0.2,
            dependsOn: [step.id],
            status: "waiting",
            documentIds: [],
            activeAttemptId: null,
            generation: 1,
            deliverable: false,
            conflictId: key,
            instruction:
              "仅核对以下中性事实与原始来源，不按多数人或成员身份判断：" +
              JSON.stringify({
                description: disagreement.body,
                claims: item.upstreamClaims
                  .filter((x) => disagreement.claimIds.includes(x.id))
                  .map(({ text, sourceUrls }) => ({ text, sourceUrls })),
              }),
            internalRound: 0,
          });
          verifyIds.push(verify.id);
          d.deliverable = false;
          step.deliverable = false;
          tx.put("step", step);
          disagreement.checks = 1;
          disagreement.status = "checking";
          tx.put("disagreement", disagreement);
        }
      }
      if (verifyIds.length)
        tx.put("step", {
          ...step,
          id: id("step"),
          phase: "resolve",
          position: step.position + 0.3,
          dependsOn: [step.id, ...verifyIds],
          status: "waiting",
          documentIds: [],
          activeAttemptId: null,
          generation: 1,
          deliverable: true,
          internalRound: 0,
          instruction:
            "根据原成果和补证结果修订最终稿。未确认的事实保留缺口，不重复补证。",
        });
      const all = [...(item.upstreamClaims || []), ...item.claims],
        byId = new Map(all.map((c) => [c.id, c]));
      const adopted = item.dispositions
        .filter((x) => x.action === "adopt" && x.unique === true && x.reason)
        .map((x) => byId.get(x.claimId))
        .filter(Boolean);
      const aliases = new Map();
      for (const relation of item.sourceRelations)
        if (
          relation.independent === false &&
          relation.evidence &&
          Array.isArray(relation.claimIds) &&
          relation.claimIds.every((k) => byId.has(k))
        ) {
          const urls = relation.claimIds
              .flatMap((k) => byId.get(k).sourceUrls)
              .map(normalizeSource)
              .filter(Boolean),
            root = normalizeSource(relation.canonicalUrl) || urls[0];
          if (root) for (const url of urls) aliases.set(url, root);
        }
      const canonical = new Map();
      for (const c of all)
        for (const url of c.sourceUrls) {
          const key = aliases.get(normalizeSource(url)) || normalizeSource(url);
          canonical.set(key, [...(canonical.get(key) || []), c]);
        }
      const independent = item.sourceRelations
        .filter(
          (r) =>
            !item.sourceRelations.some(
              (other) =>
                other !== r &&
                other.independent === false &&
                other.claimIds?.some((k) => r.claimIds?.includes(k)),
            ) &&
            !r.canonicalUrl &&
            !r.sharedSource &&
            r.independent === true &&
            r.evidence &&
            r.claimIds?.length > 1 &&
            r.claimIds.every((k) => byId.has(k)) &&
            new Set(r.claimIds.map((k) => byId.get(k).memberId)).size > 1 &&
            new Set(
              r.claimIds
                .flatMap((k) => byId.get(k).sourceUrls)
                .map(
                  (url) =>
                    aliases.get(normalizeSource(url)) || normalizeSource(url),
                ),
            ).size > 1,
        )
        .map((r) => ({ ...r, checkedBy: step.memberId }));
      const corrections = item.corrections
        .filter(
          (c) => byId.has(c.originalClaimId) && c.evidence && c.conditions,
        )
        .map((c) => ({ ...c, checkedBy: step.memberId }));
      d.record = {
        unique: adopted.filter(
          (c) =>
            !all.some(
              (x) =>
                x.memberId !== c.memberId && x.text.trim() === c.text.trim(),
            ),
        ).length,
        independent: independent.length,
        multiple: [...canonical.values()].filter(
          (cs) => new Set(cs.map((c) => c.memberId)).size > 1,
        ).length,
        corrections: corrections.length,
      };
      d.sourceEvidence = {
        independent,
        corrections,
        claims: all,
        dispositions: item.dispositions,
      };
      d.partial = !!run.partial;
    }
    tx.put("document", d);
  }
  if (step.phase === "verify" && step.conflictId) {
    const conflict = await tx.get("disagreement", step.conflictId);
    conflict.status = clean[0]?.corrections?.length
      ? "corrected"
      : "unconfirmed";
    conflict.checkedBy = step.memberId;
    conflict.documentIds = step.documentIds;
    tx.put("disagreement", conflict);
  }
}
