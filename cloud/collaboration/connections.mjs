import { fail, required, id, digest } from "./repository.mjs";
import { platformURL, seal, publicConnection } from "./security.mjs";

export const PLATFORMS = [
  {
    id: "grok-bot",
    name: "Grok Bot",
    transport: "grok-webhook",
    auth: "原 Bot 授权 Hub MCP，并提供专用 Routine webhook",
    reference: "https://docs.x.ai/grok-bot/skills-routines-and-automations",
  },
  {
    id: "muse",
    name: "Muse",
    transport: "muse-poll",
    auth: "原 Muse 创建 REST connector 与轻量 signal hook / 定时任务",
    reference:
      "https://github.com/sabotage-dev/botline/blob/main/docs/recipes/muse.md",
  },
  {
    id: "dots",
    name: "ChatGPT Dots",
    transport: "dots-events",
    auth: "原 Dot 连接 Hub MCP 插件，并订阅 work.ready 事件",
    reference: "https://developers.openai.com/plugins/build/mcp-events",
  },
  {
    id: "perplexity-computer",
    name: "Perplexity Computer",
    transport: "computer-mcp",
    auth: "通过官方 OAuth 授权 Computer MCP",
    reference:
      "https://docs.perplexity.ai/docs/getting-started/integrations/computer-mcp-server",
  },
];
export async function configureConnection(repo, identity, input, secret) {
  required(input.requestId, "请求编号", 120);
  const platform = PLATFORMS.find((x) => x.id === input.platform);
  const member = identity.members.find(
    (x) => x.id === input.memberId && x.status !== "disabled",
  );
  if (
    !platform ||
    !member ||
    !identity.accounts.some(
      (x) => x.id === member.accountId && x.status !== "disabled",
    )
  )
    fail("invalid_connection", "平台或成员不可用");
  if (
    identity.tasks?.some((t) =>
      t.steps.some(
        (s) => s.accountId === member.accountId && s.status === "running",
      ),
    )
  )
    fail("resource_busy", "旧版任务仍在运行，请先结束后启用原生协作", 409);
  const config = {};
  if (platform.id === "grok-bot") {
    config.url = platformURL(input.url, "grok");
    config.token = required(input.token, "Routine 密钥", 4000);
  }
  const configHash = await digest(
      JSON.stringify({ platform: platform.id, config }),
    ),
    sealed = await seal(config, secret);
  return repo.transact(
    `connection:${input.requestId}`,
    { ...input, token: input.token ? await digest(input.token) : undefined },
    async (tx) => {
      tx.guardLegacyIdle(member.accountId);
      const old = await tx.get("connection", member.id, false);
      const resource = await tx.get("resource", member.accountId, false);
      if (resource?.status === "busy")
        fail("resource_busy", "此账号有未结束的原生执行，不能切换通道", 409);
      const changed = !old || old.configHash !== configHash;
      const c = tx.put("connection", {
        ...old,
        id: member.id,
        platform: platform.id,
        transport: platform.transport,
        resourceKey: member.accountId,
        capabilities: [
          ...new Set(
            (input.capabilities || ["research", "writing"]).filter((x) =>
              ["research", "writing", "files"].includes(x),
            ),
          ),
        ],
        credentials: changed ? sealed : old.credentials,
        configHash,
        configVersion: changed
          ? (old?.configVersion || 0) + 1
          : old.configVersion,
        status: changed ? "configured" : old.status,
        verifiedAt: changed ? null : old.verifiedAt,
        deliveryEvidence: changed ? null : old.deliveryEvidence,
        needsAuthorization:
          platform.id === "perplexity-computer" && (!old || changed),
        pollSeconds:
          platform.id === "muse"
            ? Math.max(60, Number(input.pollSeconds) || 300)
            : null,
      });
      return publicConnection(c);
    },
  );
}
export function setupInstructions(connection, memberId, origin) {
  const common = `你仍使用自己的原模型、工具和授权。Hub 只提供共享任务与资料。用专用成员凭证访问 ${origin}/v2/mcp 或 ${origin}/v2/tools/{工具名}，凭证通过平台安全输入保管，不写入聊天、稿件或日志。先 list_work，再 claim_work；领取结果含本轮 lease、材料与交付标准。读取前序成果后执行，长任务 report_progress，最后 submit_work 提交完整正文及原始来源，每次写入使用稳定 requestId。重复通知先查看现有任务，不重复执行。不发布、不付款，遇到授权需求交回用户。`;
  if (connection.transport === "muse-poll")
    return `${common}\n连接 OpenAPI：${origin}/v2/openapi.json。定时或轻量 hook 先 GET ${origin}/v2/signal，只在 hasWork=true 时执行；不把轮询结果当成已领取。建议间隔 ${connection.pollSeconds} 秒，实际取决于原平台支持，不承诺即时。`;
  if (connection.transport === "grok-webhook")
    return `${common}\n为该原 Bot 建一个专用 Routine，收到 webhook 时只处理本成员工作。把官方 POST URL 和 key 填入 Hub 接入设置。通知只是门铃，完整任务从 Hub 工具读取。`;
  if (connection.transport === "dots-events")
    return `${common}\n在原 Dot 连接插件并订阅 work.ready，arguments.member_id=${memberId}。有事件时读取自己待办，按领取和交付协议执行。`;
  return "使用官方 Perplexity OAuth 入口完成授权；Hub 调用原 Computer MCP，保留其线程、工具与额度。任务发送与状态读取分开，超时不自动另发一条任务。";
}
