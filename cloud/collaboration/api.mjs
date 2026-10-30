import { oauthFetch, startPairing } from "./pairing.mjs";
import { fileStore } from "./file-store.mjs";
import { Repository, fail, digest, required, id } from "./repository.mjs";
import { command, workForMember, requireProjectAccess } from "./engine.mjs";
import { canRead } from "./flow.mjs";
import { RECIPES } from "../../shared/recipes.mjs";
import {
  PLATFORMS,
  configureConnection,
  setupInstructions,
} from "./connections.mjs";
import {
  readJSON,
  readBounded,
  publicConnection,
  unbase64,
  base64,
} from "./security.mjs";
import { EVENT, eventMethod } from "./events.mjs";
import { resultPage, projectPage, pairingFacts, allPairingFacts, ruleUsage } from "./views.mjs";
import { projectType } from "../../shared/policies.mjs";
import { applicableKnowledge } from "./knowledge.mjs";
import { maintenance } from "./dispatcher.mjs";
import {
  beginComputerAuth,
  finishComputerAuth,
  respondComputer,
} from "./computer.mjs";
import { uploadFile, downloadFile } from "./files.mjs";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
function encodeCursor(row) {
  return btoa(JSON.stringify({ updatedAt: row.updatedAt, id: row.id }));
}
function decodeCursor(raw) {
  try {
    const c = JSON.parse(atob(raw));
    if (typeof c.updatedAt !== "string" || typeof c.id !== "string")
      throw new Error();
    return c;
  } catch {
    fail("invalid_cursor", "分页游标无效");
  }
}
const string = { type: "string" };
const schema = (properties, requiredKeys = Object.keys(properties)) => ({
  type: "object",
  properties,
  required: requiredKeys,
  additionalProperties: false,
});
export const TOOLS = [
  {
    name: "read_file",
    description: "读取本项目附件的真实字节，按64KB分页，不截断伪装完整文件。",
    inputSchema: schema(
      { fileId: string, offset: { type: "integer", minimum: 0 } },
      ["fileId"],
    ),
  },
  {
    name: "list_work",
    description: "读取自己的待办和已领取工作，读取不会消费或领取任务。",
    inputSchema: schema({}),
  },
  {
    name: "claim_work",
    description:
      "领取指派给自己的步骤，获得唯一 attemptId、lease 和完整任务上下文。",
    inputSchema: schema({ requestId: string, stepId: string }),
  },
  {
    name: "report_progress",
    description: "报告可见工作进度并延续原领取，不能自称完成。",
    inputSchema: schema(
      {
        requestId: string,
        attemptId: string,
        lease: string,
        message: string,
        platformRunId: string,
      },
      ["requestId", "attemptId", "lease", "message"],
    ),
  },
  {
    name: "submit_work",
    description: "提交独立成果的完整正文与出处，不以完成说明或临时链接代替。",
    inputSchema: schema(
      {
        requestId: string,
        attemptId: string,
        lease: string,
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: schema(
            {
              title: string,
              body: string,
              format: { type: "string", enum: ["text", "markdown", "html"] },
              sources: {
                type: "array",
                items: schema(
                  { url: string, title: string, publishedAt: string },
                  ["url"],
                ),
              },
              fileIds: { type: "array", items: string },
              ...Object.fromEntries(
                [
                  "claims",
                  "dispositions",
                  "selfCheck",
                  "conflicts",
                  "sourceRelations",
                  "corrections",
                  "critiques",
                  "ruleReceipts",
                ].map((k) => [
                  k,
                  {
                    type: "array",
                    maxItems: 300,
                    items: { type: "object", additionalProperties: true },
                  },
                ]),
              ),
              proposal: {
                anyOf: [
                  { type: "object", additionalProperties: true },
                  { type: "null" },
                ],
              },
              shortfall: string,
            },
            ["title", "body"],
          ),
        },
        shortfall: string,
      },
      ["requestId", "attemptId", "lease", "items"],
    ),
  },
  {
    name: "read_document",
    description: "读取获授权项目的完整成果、原稿和版本。",
    inputSchema: schema({ documentId: string }),
  },
  {
    name: "propose_knowledge",
    description: "建议项目规则，始终待用户批准，不覆盖全局知识。",
    inputSchema: schema(
      {
        requestId: string,
        projectId: string,
        title: string,
        body: string,
        versionIds: { type: "array", items: string },
      },
      ["requestId", "projectId", "title", "body"],
    ),
  },
  {
    name: "upload_file",
    description:
      "上传真实小文件字节，返回已存储文件ID。大于100KB用REST二进制上传。",
    inputSchema: schema(
      {
        requestId: string,
        attemptId: string,
        lease: string,
        name: string,
        mime: string,
        base64: string,
      },
      ["requestId", "attemptId", "lease", "name", "base64"],
    ),
  },
];
const commands = {
  claim_work: "step.claim",
  report_progress: "step.progress",
  submit_work: "step.submit",
  propose_knowledge: "knowledge.write",
};
const exposedKinds = new Set([
  "project",
  "run",
  "step",
  "message",
  "document",
  "document_version",
  "knowledge",
  "knowledge_version",
  "edit_event",
  "feedback",
  "feedback_event",
  "schedule",
  "file",
  "decision",
  "disagreement",
  "followup",
  "rule_notice",
  "member_suggestion",
]);

export async function resolveActor(request, env, identity) {
  const token =
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token) fail("unauthorized", "需要授权", 401);
  const hashed = await digest(token);
  if (env.ADMIN_KEY && hashed === (await digest(env.ADMIN_KEY)))
    return { owner: true };
  const access = await new Repository(env.DB, env.WORKSPACE_ID).get(
    "member_auth",
    hashed,
    false,
  );
  const member = identity.members.find(
    (m) =>
      (m.tokenHash === hashed ||
        (access?.status === "active" &&
          access.expiresAt > new Date().toISOString() &&
          access.memberId === m.id)) &&
      m.status !== "disabled",
  );
  if (
    !member ||
    !identity.accounts.some(
      (a) => a.id === member.accountId && a.status !== "disabled",
    )
  )
    fail("unauthorized", "成员凭证失效或已暂停", 401);
  return { memberId: member.id };
}
async function readDocument(repo, actor, documentId) {
  const document = await repo.get("document", documentId);
  if (actor.memberId) {
    await requireProjectAccess(repo, document.scopeId, actor.memberId);
    if (!(await canRead(repo, actor.memberId, document)))
      fail("not_found", "记录不存在", 404);
    await repo.transact(
      id("read"),
      { documentId, memberId: actor.memberId },
      (tx) =>
        tx.put("read_event", {
          id: id("read"),
          scopeId: document.scopeId,
          parentId: document.parentId,
          memberId: actor.memberId,
          documentId,
          workingVersionId: document.workingVersionId,
          createdAt: tx.now,
        }),
    );
  }
  const original = await repo.get(
      "document_version",
      document.originalVersionId,
    ),
    working = await repo.get("document_version", document.workingVersionId);
  const candidate = document.candidateVersionId
    ? await repo.get("document_version", document.candidateVersionId)
    : null;
  return { ...document, original, working, candidate };
}
export async function callTool(repo, identity, actor, name, args, env) {
  if (!actor.memberId)
    fail(
      "member_required",
      "原生工具必须使用成员身份，不能用管理凭证冒充",
      403,
    );
  if (name === "list_work")
    return { work: await workForMember(repo, identity, actor.memberId) };
  if (name === "read_file") {
    const file = await repo.get("file", args.fileId),
      offset = args.offset || 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= file.size)
      fail("invalid_offset", "文件偏移量无效");
    const response = await downloadFile(
      repo,
      fileStore(env, file.storage || "r2"),
      actor,
      file.id,
    );
    const bytes = await readBounded(response, 8 * 1024 * 1024),
      end = Math.min(offset + 65536, bytes.length);
    return {
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256,
      offset,
      base64: base64(bytes.slice(offset, end)),
      nextOffset: end < bytes.length ? end : null,
    };
  }
  if (name === "read_document")
    return readDocument(repo, actor, args.documentId);
  if (name === "upload_file")
    return uploadFile(repo, fileStore(env), actor, args, unbase64(args.base64));
  if (!commands[name]) fail("unknown_tool", "未知工具", 404);
  return command(repo, identity, actor, { ...args, type: commands[name] });
}
function openapi(origin) {
  return {
    openapi: "3.1.0",
    info: { title: "Agent Hub 项目协作", version: "2.0.0" },
    servers: [{ url: origin }],
    security: [{ memberToken: [] }],
    components: {
      securitySchemes: { memberToken: { type: "http", scheme: "bearer" } },
    },
    paths: Object.fromEntries(
      TOOLS.map((t) => [
        `/v2/tools/${t.name}`,
        {
          post: {
            operationId: t.name,
            summary: t.description,
            requestBody: {
              required: true,
              content: { "application/json": { schema: t.inputSchema } },
            },
            responses: {
              200: { description: "真实结果" },
              409: { description: "版本或领取状态冲突，不能重做副作用" },
            },
          },
        },
      ]),
    ),
  };
}
async function mcp(repo, identity, actor, request, env) {
  if (!actor.memberId) fail("member_required", "插件使用成员授权", 403);
  if (request.method === "GET" || request.method === "DELETE")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const rpc = await readJSON(request);
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string")
    return json(
      {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      },
      400,
    );
  if (rpc.id === undefined && rpc.method.startsWith("notifications/"))
    return new Response(null, { status: 202 });
  let result;
  try {
    if (rpc.method === "initialize")
      result = {
        protocolVersion: [
          "2026-07-28",
          "2025-11-25",
          "2025-06-18",
          "2025-03-26",
        ].includes(rpc.params?.protocolVersion)
          ? rpc.params.protocolVersion
          : "2025-03-26",
        capabilities: { tools: {}, events: {} },
        serverInfo: { name: "Agent Hub", version: "2.0.0" },
      };
    else if (rpc.method === "server/discover")
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, events: {} },
        serverInfo: { name: "Agent Hub", version: "2.0.0" },
      };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/list") {
      await repo.transact(
        id("tool-seen"),
        { memberId: actor.memberId },
        async (tx) => {
          const c = await tx.get("connection", actor.memberId, false);
          if (c) tx.put("connection", { ...c, authSeenAt: tx.now });
          return {};
        },
      );
      result = {
        tools: TOOLS.map((t) => ({
          ...t,
          annotations: {
            readOnlyHint: ["list_work", "read_document"].includes(t.name),
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
      };
    } else if (rpc.method === "tools/call") {
      try {
        const value = await callTool(
          repo,
          identity,
          actor,
          rpc.params?.name,
          rpc.params?.arguments || {},
          env,
        );
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (e) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: e.code || "tool_error",
                message: e.code ? e.message : "工具处理失败，未标记完成",
              }),
            },
          ],
        };
      }
    } else if (rpc.method.startsWith("events/"))
      result = await eventMethod(
        repo,
        actor.memberId,
        rpc.method,
        rpc.params || {},
        env.ADMIN_KEY,
      );
    else
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      });
    return json({ jsonrpc: "2.0", id: rpc.id, result });
  } catch (e) {
    return json({
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code:
          e.code?.startsWith("callback") || e.code === "challenge_failed"
            ? -32015
            : -32602,
        message: e.code ? e.message : "请求未完成",
        data: { reason: e.code || "failure" },
      },
    });
  }
}
export async function v2Fetch(request, env, ctx, identity) {
  const url = new URL(request.url),
    repo = new Repository(env.DB, env.WORKSPACE_ID);
  if (url.pathname === "/v2/openapi.json") return json(openapi(url.origin));
  if (url.pathname === "/v2/oauth/callback")
    return json(
      await finishComputerAuth(
        repo,
        url.searchParams.get("code"),
        url.searchParams.get("state"),
        env.ADMIN_KEY,
        url.origin,
      ),
    );
  const oauth = await oauthFetch(request, repo, identity, url.origin, env);
  if (oauth) return oauth;
  let actor;
  try {
    actor = await resolveActor(request, env, identity);
  } catch (e) {
    if (e.status === 401)
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "需要授权" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/v2/mcp"`,
          },
        },
      );
    throw e;
  }
  const kick = () =>
    ctx.waitUntil(
      maintenance(repo, identity, env).catch((e) =>
        console.error(
          JSON.stringify({
            event: "hub_v2_maintenance_failed",
            code: e.code || "failure",
          }),
        ),
      ),
    );
  if (url.pathname === "/v2/mcp") {
    const result = await mcp(repo, identity, actor, request, env);
    if (request.method === "POST") kick();
    return result;
  }
  if (url.pathname === "/v2/signal" && request.method === "GET") {
    if (!actor.memberId) fail("member_required", "需要成员身份", 403);
    const work = await workForMember(repo, identity, actor.memberId);
    return json({
      hasWork: work.some((x) => x.status === "ready"),
      pending: work.filter((x) => x.status === "ready").length,
      active: work.filter((x) => x.status !== "ready").length,
      note: "读取未领取；有待办再唤醒模型",
    });
  }
  if (url.pathname.startsWith("/v2/tools/") && request.method === "POST") {
    const result = await callTool(
      repo,
      identity,
      actor,
      url.pathname.slice(10),
      await readJSON(request),
      env,
    );
    kick();
    return json(result);
  }
  if (url.pathname === "/v2/files" && request.method === "POST") {
    let metadata;
    try {
      metadata = JSON.parse(
        decodeURIComponent(request.headers.get("X-Hub-File") || ""),
      );
    } catch {
      fail("invalid_metadata", "缺少文件元数据");
    }
    return json(
      await uploadFile(
        repo,
        fileStore(env),
        actor,
        metadata,
        await readBounded(request, 8 * 1024 * 1024),
      ),
    );
  }
  if (url.pathname.startsWith("/v2/files/") && request.method === "GET")
    return downloadFile(
      repo,
      fileStore(
        env,
        (await repo.get("file", url.pathname.slice(10))).storage || "r2",
      ),
      actor,
      url.pathname.slice(10),
    );
  if (!actor.owner) fail("forbidden", "管理操作需要用户身份", 403);
  if (url.pathname === "/v2/pairing" && request.method === "POST")
    return json(
      await startPairing(
        repo,
        identity,
        (await readJSON(request)).memberId,
        url.origin,
      ),
    );
  if (url.pathname === "/v2/workspace" && request.method === "GET")
    return json({
      pendingByProject: Object.fromEntries((await env.DB.prepare("SELECT scope_id,COUNT(*) AS total FROM hub_v2_records WHERE workspace_id=? AND kind IN ('knowledge','rule_notice','member_suggestion') AND status='pending' GROUP BY scope_id").bind(env.WORKSPACE_ID).all()).results.map(r=>[r.scope_id,r.total])),
      members: identity.members
        .filter((m) => m.status !== "disabled")
        .map(({ tokenHash, ...m }) => ({
          ...m,
          ownerId: m.ownerId || env.WORKSPACE_ID,
        })),
      accounts: identity.accounts.map(({ id, name, platformId, status }) => ({
        id,
        name,
        platformId,
        status,
      })),
      connections: await Promise.all(
        (await repo.list("connection")).map(async (c) => ({
          ...publicConnection(c),
          authSeenAt: c.authSeenAt || c.toolSeenAt,
          authorizedAt:
            (
              await env.DB.prepare(
                "SELECT MAX(updated_at) AS at FROM hub_v2_records WHERE workspace_id=? AND kind='member_auth' AND status='active' AND json_extract(body,'$.memberId')=? AND json_extract(body,'$.expiresAt')>?",
              )
                .bind(env.WORKSPACE_ID, c.id, new Date().toISOString())
                .first()
            )?.at || null,
          subscriptionActive: (
            await repo.list("subscription", { parent: c.id, status: "active" })
          ).some((s) => s.expiresAt > new Date().toISOString()),
          lastDeliveryAt:
            (await repo.list("outbox", { status: "accepted", limit: 100 }))
              .filter((o) => o.memberId === c.id)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
              ?.updatedAt || null,
          probe: (await repo.list("run", { scope: `probe_${c.id}` }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 1).map(({ id, status }) => ({ id, status }))[0] || null,
        })),
      ),
    });
  if (url.pathname === "/v2/catalog")
    return json({ recipes: RECIPES, platforms: PLATFORMS, version: 2 });
  if (url.pathname === "/v2/connections" && request.method === "GET")
    return json({
      connections: (await repo.list("connection")).map(publicConnection),
    });
  if (url.pathname === "/v2/connections" && request.method === "POST")
    return json(
      await configureConnection(
        repo,
        identity,
        await readJSON(request),
        env.ADMIN_KEY,
      ),
    );
  if (url.pathname === "/v2/setup" && request.method === "GET") {
    const memberId = url.searchParams.get("memberId"),
      c = await repo.get("connection", memberId);
    return json({
      connection: publicConnection(c),
      instructions: setupInstructions(c, memberId, url.origin),
      mcpUrl: url.origin + "/v2/mcp",
      openapiUrl: url.origin + "/v2/openapi.json",
    });
  }
  if (url.pathname === "/v2/oauth/start" && request.method === "POST")
    return json(
      await beginComputerAuth(
        repo,
        (await readJSON(request)).memberId,
        env.ADMIN_KEY,
        url.origin,
      ),
    );
  if (url.pathname === "/v2/computer/respond" && request.method === "POST")
    return json(
      await respondComputer(repo, identity, await readJSON(request), env),
    );
  if (url.pathname === "/v2/commands" && request.method === "POST") {
    const result = await command(
      repo,
      identity,
      actor,
      await readJSON(request),
    );
    kick();
    return json({ result });
  }
  if (url.pathname === "/v2/maintenance" && request.method === "POST")
    return json(await maintenance(repo, identity, env));
  if (url.pathname === "/v2/results" && request.method === "GET") {
    const rows=await resultPage(repo,url.searchParams,url.searchParams.has("cursor")?decodeCursor(url.searchParams.get("cursor")):null);
    return json({items:rows.slice(0,100),nextCursor:rows.length>100?encodeCursor(rows[99]):null});
  }
  if(url.pathname==="/v2/projects"&&request.method==="GET"){
    const rows=await projectPage(repo,url.searchParams,url.searchParams.has("cursor")?decodeCursor(url.searchParams.get("cursor")):null);
    return json({items:rows.slice(0,100),nextCursor:rows.length>100?encodeCursor(rows[99]):null});
  }
  if (url.pathname === "/v2/pairing-facts" && request.method === "GET") {
    if (!url.searchParams.has("projectId")&&!url.searchParams.has("members")) return json({groups:await allPairingFacts(repo)});
    const p=url.searchParams.get("projectId")?await repo.get("project",url.searchParams.get("projectId")):{id:"",arrangement:{members:[]}};
    if(url.searchParams.has("projectType"))p.projectType=projectType(url.searchParams.get("projectType"));
    if(url.searchParams.has("members")){const members=url.searchParams.get("members").split(",").filter(Boolean);if(members.length>10)fail("invalid_arrangement","成员数量过多");p.arrangement={...p.arrangement,members};}
    return json({facts:await pairingFacts(repo,p)});
  }
  if (url.pathname === "/v2/rule-usage" && request.method === "GET") return json({usage:await ruleUsage(repo)});
  if (url.pathname === "/v2/records" && request.method === "GET") {
    const kind = url.searchParams.get("kind");
    if (!exposedKinds.has(kind)) fail("invalid_kind", "不公开此记录类型");
    const rows = await repo.list(kind, {
      excludeHidden: true,
      ...(url.searchParams.has("projectId")
        ? { scope: url.searchParams.get("projectId") }
        : {}),
      ...(url.searchParams.has("parentId")
        ? { parent: url.searchParams.get("parentId") }
        : {}),
      ...(url.searchParams.has("status")
        ? { status: url.searchParams.get("status") }
        : {}),
      after: url.searchParams.get("after") || "",
      order: url.searchParams.get("order") === "recent" ? "recent" : "id",
      ...(url.searchParams.has("cursor")
        ? { cursor: decodeCursor(url.searchParams.get("cursor")) }
        : {}),
      limit: 101,
    });
    return json({
      items: rows.slice(0, 100).filter((x) => !x.hidden),
      nextCursor:
        rows.length > 100
          ? url.searchParams.get("order") === "recent"
            ? encodeCursor(rows[99])
            : rows[99].id
          : null,
    });
  }
  if (url.pathname === "/v2/project" && request.method === "GET") {
    const project = await repo.get("project", url.searchParams.get("id"));
    const [runs, messages, documents, knowledge, feedback, schedule] =
      await Promise.all([
        repo.list("run", { scope: project.id, order: "recent" }),
        env.DB.prepare(
          "SELECT sequence,id,body FROM hub_v2_records WHERE workspace_id=? AND kind='message' AND scope_id=? ORDER BY sequence DESC,id DESC LIMIT 100",
        )
          .bind(env.WORKSPACE_ID, project.id)
          .all(),
        repo.list("document", {
          scope: project.id,
          order: "recent",
          limit: 101,
        }),
        repo.list("knowledge", { scope: project.id }),
        repo.list("feedback", { scope: project.id }),
        repo.get("schedule", project.id, false),
      ]);
    const last = messages.results[0];
    return json({
      project,
      runs,
      messages: messages.results.reverse().map((x) => JSON.parse(x.body)),
      activityCursor: last ? `${last.sequence}:${last.id}` : "-1:",
      documents: documents.slice(0, 100),
      documentCursor:
        documents.length > 100 ? encodeCursor(documents[99]) : null,
      activeRuns: (
        await Promise.all(
          ["running", "ready", "paused", "needs_review", "needs_approval"].map(
            (status) => repo.list("run", { scope: project.id, status }),
          ),
        )
      ).flat(),
      knowledge: [...new Map([...knowledge,...await applicableKnowledge(repo,project,"approved")].map(k=>[k.id,k])).values()],
      ruleNotices: await repo.list("rule_notice",{scope:project.id,status:"pending"}),
      memberSuggestions: await repo.list("member_suggestion",{scope:project.id,status:"pending"}),
      feedback,
      schedule,
      pagination: "/v2/records",
    });
  }
  if (url.pathname === "/v2/run" && request.method === "GET") {
    const run = await repo.get("run", url.searchParams.get("id"));
    const steps = (await repo.list("step", { parent: run.id })).sort(
      (a, b) => a.position - b.position,
    );
    const attempts = [],
      remoteJobs = [];
    for (const step of steps) {
      for (const attempt of await repo.list("attempt", { parent: step.id })) {
        const { leaseHash, ...safe } = attempt;
        attempts.push(safe);
        const job = await repo.get("remote_job", attempt.id, false);
        if (job) {
          const { credentials, answerDispatchId, ...safeJob } = job;
          remoteJobs.push(safeJob);
        }
      }
    }
    return json({
      run,
      steps,
      attempts,
      notifications: await repo.list("outbox", { parent: run.id }),
      remoteJobs,
    });
  }
  if (url.pathname === "/v2/document")
    return json(await readDocument(repo, actor, url.searchParams.get("id")));
  if (url.pathname === "/v2/metrics") {
    // SQL aggregation covers all history; paging the UI must not change the denominator.
    const scope = url.searchParams.get("projectId");
    const result = await env.DB.prepare(
      "SELECT json_extract(body,'$.value') AS value,COUNT(*) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='feedback' AND scope_id=? GROUP BY value",
    )
      .bind(env.WORKSPACE_ID, scope)
      .all();
    const counts = Object.fromEntries(
      result.results.map((x) => [x.value, x.n]),
    );
    const documentCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='document' AND scope_id=? AND json_extract(body,'$.deliverable')=1",
    )
      .bind(env.WORKSPACE_ID, scope)
      .first();
    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN status='completed' AND json_extract(body,'$.deadlineAt') IS NOT NULL THEN 1 ELSE 0 END) AS timed_completed,SUM(CASE WHEN status='completed' AND json_extract(body,'$.completedAt')<=json_extract(body,'$.deadlineAt') THEN 1 ELSE 0 END) AS on_time,SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) AS needs_review FROM hub_v2_records WHERE workspace_id=? AND kind='run' AND scope_id=? AND json_extract(body,'$.probe')=0",
    )
      .bind(env.WORKSPACE_ID, scope)
      .first();
    const rework = await env.DB.prepare(
      "SELECT COALESCE(SUM(json_extract(body,'$.generation')-1),0) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='step' AND scope_id=? AND status!='canceled'",
    )
      .bind(env.WORKSPACE_ID, scope)
      .first();
    const adopted = counts.adopted || 0,
      discarded = counts.discarded || 0;
    return json({
      adopted,
      discarded,
      evaluated: adopted + discarded,
      pending: documentCount.n - adopted - discarded,
      adoptionRate:
        adopted + discarded ? adopted / (adopted + discarded) : null,
      smallSample: adopted + discarded < 20,
      runs: {
        total: runs.total,
        completed: runs.completed || 0,
        onTime: runs.on_time || 0,
        needsReview: runs.needs_review || 0,
        timedCompleted: runs.timed_completed || 0,
        onTimeRate: runs.timed_completed
          ? runs.on_time / runs.timed_completed
          : null,
      },
      rework: rework.n,
      cost: null,
      costStatus: "platform_not_reported",
      meaning:
        "只统计最终交付稿的人工采用反馈。按时率只统计事前设置截止时间的已完成运行；不代表原稿免修改率、事实准确率或长期收益。",
    });
  }
  if (url.pathname === "/v2/activity") {
    const cursor = url.searchParams.get("cursor") || "-1:",
      split = cursor.indexOf(":"),
      sequence = Number(cursor.slice(0, split)),
      key = cursor.slice(split + 1);
    if (!Number.isInteger(sequence) || sequence < -1 || split < 0)
      fail("invalid_cursor", "无效游标");
    const result = await env.DB.prepare(
      "SELECT sequence,id,body FROM hub_v2_records WHERE workspace_id=? AND kind='message' AND scope_id=? AND (sequence>? OR (sequence=? AND id>?)) ORDER BY sequence,id LIMIT 101",
    )
      .bind(
        env.WORKSPACE_ID,
        url.searchParams.get("projectId"),
        sequence,
        sequence,
        key,
      )
      .all();
    const rows = result.results.slice(0, 100),
      last = rows.at(-1);
    return json({
      events: rows.map((x) => JSON.parse(x.body)),
      cursor: last ? `${last.sequence}:${last.id}` : cursor,
      hasMore: result.results.length > 100,
      refreshAfterMs: 2000,
    });
  }
  return fail("not_found", "接口不存在", 404);
}
