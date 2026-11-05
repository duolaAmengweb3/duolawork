import { digest, fail, id, required } from "./repository.mjs";
import { grant, startPairing } from "./pairing.mjs";
import { readJSON, seal, unseal, publicConnection, platformURL } from "./security.mjs";
import { configureConnection, setupInstructions } from "./connections.mjs";
import { command } from "./engine.mjs";
import { claudeResumeAction } from '../../shared/claude-onboarding.mjs';

export const AGENT_TARGETS = [
  ["codex", "Codex", "coding"], ["claude-code", "Claude Code", "coding"],
  ["gemini-cli", "Gemini CLI（旧入口）", "coding"], ["antigravity", "Gemini · Antigravity", "coding"], ["cursor-cli", "Cursor CLI", "coding"],
  ["opencode", "OpenCode", "coding"], ["copilot-cli", "GitHub Copilot CLI", "coding"],
  ["kimi-code", "Kimi Code CLI", "coding"], ["qwen-code", "Qwen Code", "coding"],
  ["codebuddy-code", "CodeBuddy Code", "coding"], ["qoder-cli", "Qoder CLI", "coding"],
  ["grok-bot", "Grok Bot", "personal"], ["dots", "ChatGPT Dot", "personal"],
  ["muse", "Muse", "personal"], ["perplexity-computer", "Perplexity Computer", "personal"],
  ["openclaw", "OpenClaw", "personal"], ["hermes", "Hermes", "personal"],
  ["workbuddy", "WorkBuddy", "personal"], ["qwenwork", "QwenWork", "personal"],
].map(([id, name, kind]) => ({ id, name, kind, status: "acceptance_target" }));

const json = (data, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const setupText = value => value.replace(/https?:\/\/\S+/g, "[地址]")
  .replace(/(?:Bearer\s+|ahv1_|ahr_|whsec_|crsr_|sk-)[A-Za-z0-9_+/=.-]+/g, "[凭证已隐藏]");

export async function issueAgentSkill(repo, identity, memberId, origin) {
  const pair = await startPairing(repo, identity, memberId, origin, "agent-skill");
  const member = identity.members.find(m => m.id === memberId);
  return {
    expiresAt: pair.expiresAt,
    pairingCode: pair.code,
    skill: `把你自己接入我的 DuolaWork，成员备注「${member.name || memberId}」。配对码：${pair.code}（15分钟内一次使用）。先读取 ${origin}/v2/connect/manifest ，然后按其中的协议自动完成配对、配置你自己的消息接收方式、回填配置并运行真实往返自检。由你执行配置，不让我逐项填写 MCP、Webhook、密钥或命令。你仍是原来的 Agent，保留自己的模型、订阅、工具与记忆，不换成模型API。短时配对码可用于这次接入；长期令牌、刷新凭证和平台密钥只放你的私有凭证存储，不回显在聊天或日志。正常聊天与相互@是基础，文档、事项、会议等按需调用，不预设分工。不能完成的步骤通过状态接口报告具体原因；配对或创建文件不等于接入成功，必须实际收到 Hub 验证、由你自己调用工具回传后才算完成。不要退出原账号、改全局模型设置、修改其他成员或清除会话。`,
  };
}

export function onboardingManifest(origin) {
  return {
    protocol: "agent-hub-connect/1",
    targets: AGENT_TARGETS,
    targetsAreImplementedClaims: false,
    redeem: { url: origin + "/v2/connect/redeem", method: "POST",
      body: { code: "user supplied 12-character code", attemptId: "generate a stable random id and retain for retries" } },
    credentialStorage: "Save returned credentials in your native secret store or a private 0600 file, namespaced by this endpoint and the returned memberId. Multiple Bots may share a filesystem: never use one global token file or overwrite another member. Never print or paste credentials into chat. On expiry use refresh_token with client_id at /v2/oauth/token.",
    grokBotFirstSetup: "Create or reuse ONE webhook-only Routine named 'Agent Hub 成员 <memberName> 接收器' in this exact native Bot; use the member-private credentials and conversation instructions. Give the owner its in-app 'Webhook URL' navigation link. If URL/key are owner-only, POST self.status with stage=waiting_owner, action=grok_routine, routineName=<exact name>, message='接收器已准备好，请回到 Hub 完成一次确认。' and stop this setup turn so the receiver is free to wake. Hub now presents the secure URL/key form in the DEFAULT connection screen and starts the real check automatically after the owner saves; do not send them through chat or direct the owner into advanced configuration. The official Grok Bot desktop app exposes these fields while the website may omit them. The official receiver is https://api2.cursor.sh/automations/webhook/<id> with a Bearer sender key. Never invent values, infer inability from the website, create account Automations as a substitute, or enable recurring model polling. If all values are available through your tools, configure yourself and run self.check without asking the owner.",
    selfManagement: {
      headers: "Authorization: Bearer <your access_token>; Content-Type: application/json",
      configure: { method: "POST", path: "/v2/self/connection", body: { requestId: "stable random id", transport: "webhook | events | pull", url: "webhook only: official receiver URL", token: "webhook only: private key", pollSeconds: 15 } },
      check: { method: "POST", path: "/v2/self/check", body: { requestId: "stable random id" } },
      readStatus: { method: "GET", path: "/v2/self/status" },
      reportProgress: { method: "POST", path: "/v2/self/status", body: { stage: "configuring | waiting_owner | waiting_platform | blocked", message: "short concrete progress or blocker; no secrets", action: "optional: grok_routine", routineName: "exact existing Routine name when action=grok_routine" } },
      mcpProgressTool: "report_setup_status",
    },
    next: [
      "Redeem the code once. Retrying the same code + attemptId for three minutes returns the same encrypted-at-rest grant; another attempt cannot reuse it.",
      "Use Authorization: Bearer <access_token> for the MCP or REST tools returned by redeem. No workspace administrator credential is granted.",
      "REST tools are first-class and share the same semantics as MCP. If your platform cannot automatically add an authenticated MCP connection, use its native terminal/HTTP tool with these REST endpoints; do not stall setup on an unnecessary second OAuth flow. Keep credentials in native secret storage/private files and preserve provider settings and existing approvals.",
      "Create or reuse a dedicated native receiver for this member. Grok Bot: a webhook Routine owned by this exact Bot. Dot: native work.ready subscription. CLI/SDK agents: a local receiver using the existing CLI/session and credentials, checking signal without model calls while idle, waking the original agent only on work. Do not replace the agent with a model completion endpoint.",
      "POST your receiver configuration to self.connection. You may only configure yourself. If your platform is pull-based use transport=pull; keep an actual scheduled/native receiver running, not just a written plan.",
      "POST self.check, finish this setup turn so the receiver can run, and let the next native invocation read and claim its own work then submit the exact verification output. Do not simulate an agent response or mark yourself verified.",
      "Regular invocations use receive_messages (or claim_work stepId=inbox) for group chat. If a formal verification step is waiting, list_work + claim_work returns its exact instructions. Tool results include continuation for bounded follow-ups. Use post_message/mentions to converse; shared documents and other tools are optional.",
    ],
    receiverConfiguration: {
      webhook: { transport: "webhook", url: "native platform's official POST URL", token: "native platform's private key" },
      events: { transport: "events", instruction: "Use the native MCP events/subscribe flow for work.ready; the platform supplies its callback and signing secret." },
      pull: { transport: "pull", pollSeconds: 15, instruction: "Read your authenticated /v2/signal without invoking a model. On work, invoke the original agent with its bound session; fetch and execute the member's real instructions. Do not claim work in the idle checker." },
    },
    limitations: "One protocol does not prove every target already works. Report platform-mandated user consent or unsupported wake capability explicitly; do not report complete support before a real native round-trip.",
  };
}

export async function redeemAgentSkill(repo, identity, args, secret, origin, now = new Date().toISOString()) {
  const code = required(args.code, "配对码", 12).toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(code)) fail("invalid_pairing", "配对码格式不正确");
  const attemptId = required(args.attemptId, "接入请求编号", 100);
  const key = await digest(code), attemptHash = await digest(attemptId);
  const receiptId = key + ":" + attemptHash;
  await repo.transact("skill:" + receiptId, { key, attemptHash }, async tx => {
    const pair = await tx.get("pairing", key, false);
    if (!pair || pair.purpose !== "agent-skill" || pair.status !== "pending" || pair.expiresAt <= tx.now)
      fail("pair_expired", "配对码已使用或过期，请在 Hub 复制新的接入 Skill");
    const member = identity.members.find(m => m.id === pair.memberId && m.status !== "disabled");
    if (!member || member.paused || !identity.accounts.some(a => a.id === member.accountId && a.status !== "disabled"))
      fail("member_missing", "成员当前不可接入", 403);
    const clientId = "hub_skill_" + member.id;
    if (!await tx.get("oauth_client", clientId, false)) tx.put("oauth_client", {
      id: clientId, redirects: [], authMethod: "none", name: "Hub member Skill",
    });
    const tokens = await grant(tx, member.id, clientId, tx.now);
    const connection = await tx.get("connection", member.id);
    tx.put("connection", { ...connection, setup: { stage: "configuring", message: "Agent 已配对，正在配置自己的消息接收。", at: tx.now } });
    tx.put("pairing", { ...pair, status: "used" });
    tx.put("skill_grant", { id: receiptId, parentId: member.id, status: "issued",
      credentials: await seal({ ...tokens, client_id: clientId }, secret),
      expiresAt: new Date(Date.parse(tx.now) + 180000).toISOString() });
    return { receiptId };
  }, now);
  const receipt = await repo.get("skill_grant", receiptId);
  if (receipt.expiresAt <= now) fail("pair_expired", "接入回执已过期，请复制新的接入 Skill");
  const member = identity.members.find(m => m.id === receipt.parentId && m.status !== "disabled");
  if (!member || member.paused || !identity.accounts.some(a => a.id === member.accountId && a.status !== "disabled")) fail("member_missing", "成员当前不可接入", 403);
  return {
    ...await unseal(receipt.credentials, secret), memberId: member.id, memberName: member.name || member.id,
    endpoint: origin, mcpUrl: origin + "/v2/mcp", openapiUrl: origin + "/v2/openapi.json",
    self: { connection: origin + "/v2/self/connection", check: origin + "/v2/self/check", status: origin + "/v2/self/status", signal: origin + "/v2/signal" },
    tools: origin + "/v2/tools/{tool_name}",
    runtime: "Use your own native tools. Read list_work; claim the ready work with a new requestId. Conversation input is ordinary group chat; verification input tells you exactly what to submit. Perform the receiver configuration yourself. If the provider exposes a first-time sender key only in its owner-facing panel, give that exact native panel link for one secure handoff; do not ask for a key in chat or pretend full automatic setup succeeded.",
  };
}

export async function publicOnboarding(request, repo, identity, env, origin) {
  const path = new URL(request.url).pathname;
  if (path === "/v2/connect/manifest" && request.method === "GET") return json(onboardingManifest(origin));
  if (path !== "/v2/connect/redeem" || request.method !== "POST") return null;
  if (env.OAUTH_RATE_LIMIT && !(await env.OAUTH_RATE_LIMIT.limit({ key: "hub-skill:" + (request.headers.get("CF-Connecting-IP") || "unknown") })).success)
    return json({ error: "rate_limited", message: "接入请求过于频繁，请稍后重试" }, 429);
  return json(await redeemAgentSkill(repo, identity, await readJSON(request, 4000), env.ADMIN_KEY, origin));
}

export async function selfConnection(repo, identity, actor, input, secret) {
  if (!actor.memberId) fail("member_required", "需要成员身份", 403);
  if (input.memberId && input.memberId !== actor.memberId) fail("forbidden", "只能配置自己", 403);
  const member = identity.members.find(m => m.id === actor.memberId && m.status !== "disabled");
  if (!member || member.paused) fail("member_missing", "成员当前不可接入", 403);
  const transport = { webhook: "grok-webhook", events: "dots-events", pull: "muse-poll" }[input.transport];
  if (!transport) fail("unsupported_transport", "接收方式应为 webhook、events 或 pull");
  if (transport === "grok-webhook" && member.platformId !== "grok-bot") fail("unsupported_transport", "这个平台的主动推送适配尚未验收，请采用其原生拉取或事件方式");
  if (transport === "dots-events" && !["dots", "chatgpt-agent"].includes(member.platformId)) fail("unsupported_transport", "此事件适配仅用于 Dot 原生事件");
  return configureConnection(repo, identity, { ...input, memberId: member.id, platform: member.platformId, transport }, secret);
}

export async function selfCheck(repo, identity, actor, input) {
  if (!actor.memberId || (input.memberId && input.memberId !== actor.memberId)) fail("forbidden", "只能验证自己", 403);
  return command(repo, identity, { owner: true }, { type: "connection.probe", memberId: actor.memberId,
    requestId: "self-check:" + actor.memberId + ":" + required(input.requestId, "请求编号", 80) });
}

export async function selfStatus(repo, actor, origin) {
  if (!actor.memberId) fail("member_required", "需要成员身份", 403);
  const c = await repo.get("connection", actor.memberId);
  return { connection: publicConnection(c), complete: c.status === "verified", instructions: setupInstructions(c, actor.memberId, origin) };
}

export async function reportSetup(repo, actor, input) {
  if (!actor.memberId) fail("member_required", "需要成员身份", 403);
  if (!["configuring", "waiting_owner", "waiting_platform", "blocked"].includes(input.stage)) fail("invalid_stage", "无效接入进度");
  let ownerAction;
  if (input.action) {
    const c = await repo.get("connection", actor.memberId);
    if (input.stage !== "waiting_owner") fail("invalid_action", "此接入确认不适用于该成员");
    if(input.action==='claude_resume'&&c.platform==='claude-code'){
      try { ownerAction=claudeResumeAction(input.resume||{}); } catch { fail('invalid_action','原对话恢复信息无效'); }
    } else if(input.action==='grok_routine'&&c.platform==='grok-bot') {
      ownerAction = { type: "grok_routine", routineName: setupText(required(input.routineName, "接收器名称", 120)) };
    } else fail("invalid_action", "此接入确认不适用于该成员");
  }
  const message = setupText(required(input.message, "进度说明", 500));
  return repo.transact(id("setup-status"), { memberId: actor.memberId, stage: input.stage, message, ownerAction }, async tx => {
    const c = await tx.get("connection", actor.memberId);
    tx.put("connection", { ...c, setup: { stage: input.stage, message, ...(ownerAction ? { ownerAction } : {}), at: tx.now } });
    return { recorded: true };
  });
}

// This is the owner's one-time provider handoff, not a second pairing flow.
// Both writes are idempotent. A retry after a lost response reuses the same
// encrypted configuration and the same nonce-only check.
export async function completeGuidedConnection(repo, identity, input, secret) {
  required(input.requestId, "请求编号", 80);
  const member = identity.members.find(m => m.id === input.memberId && m.status !== "disabled" && !m.paused);
  if (!member || member.platformId !== "grok-bot") fail("unsupported_handoff", "此确认仅适用于已配对的 Grok Bot");
  const auth = await repo.db.prepare("SELECT COUNT(*) AS total FROM hub_v2_records WHERE workspace_id=? AND kind='member_auth' AND status='active' AND json_extract(body,'$.memberId')=? AND json_extract(body,'$.expiresAt')>?")
    .bind(repo.workspaceId, member.id, new Date().toISOString()).first();
  if (!auth?.total) fail("pairing_required", "请先把接入 Skill 发给这个 Agent，等它完成配对后再确认。", 409);
  const url = platformURL(input.url, "grok");
  if (new URL(url).hostname !== "api2.cursor.sh") fail("wrong_receiver", "请复制 Grok Bot 桌面例程里的 Webhook URL，不是聊天页或账号自动化地址。");
  const connection = await configureConnection(repo, identity, { requestId: "guided:" + input.requestId, memberId: member.id, platform: "grok-bot", url, token: input.token }, secret);
  const probe = await command(repo, identity, { owner: true }, { type: "connection.probe", memberId: member.id, requestId: "guided-check:" + input.requestId });
  return { connection, probe, message: "已保存，正在等待原 Agent 实际回复；你可以关闭此页，结果会保留。" };
}
