import { fail, required, id, digest } from "./repository.mjs";
import { platformURL, seal, publicConnection, signWebhook } from "./security.mjs";

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
  // Existing Dot members retain their account/profile IDs from the early UI.
  let platform = PLATFORMS.find((x) => x.id === (input.platform === "chatgpt-agent" ? "dots" : input.platform));
  const member = identity.members.find(
    (x) => x.id === input.memberId && x.status !== "disabled",
  );
  // Pull is a member-authenticated protocol, not a Muse-only capability.
  // It cannot cause a server-side request to an arbitrary callback endpoint.
  if (member && input.transport === "muse-poll")
    platform = { id: member.platformId, transport: "muse-poll" };
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
  if (platform.transport === "grok-webhook") {
    config.url = platformURL(input.url, "grok");
    config.token = required(input.token, "Routine 密钥", 4000);
    if (new URL(config.url).pathname.startsWith("/webhook/automation/") || config.token.startsWith("whsec_")) {
      // Validate the exact key before persisting it. Clipboard text and a masked
      // preview are not credentials; never echo the submitted value in errors.
      await signWebhook(config.token, "validation", "0", "{}");
    } else if (!/^[\x21-\x7e]+$/.test(config.token)) {
      fail("invalid_signature_key", "密钥内容不正确，请复制平台提供的完整密钥");
    }
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
        setup: changed ? { stage: "configuring", message: "接收方式已配置，等待原 Agent 真实回应验证。", at: tx.now } : old.setup,
        needsAuthorization:
          platform.id === "perplexity-computer" && (!old || changed),
        pollSeconds:
          platform.transport === "muse-poll"
            ? Math.max(15, Number(input.pollSeconds) || 60)
            : null,
      });
      return publicConnection(c);
    },
  );
}
export function setupInstructions(connection, memberId, origin) {
  const common = `你仍使用自己的原模型、工具和授权。Hub 提供群聊和共享工具，不替你编排协作。用专用成员凭证访问 ${origin}/v2/mcp 或 ${origin}/v2/tools/{工具名}，凭证通过平台安全输入保管，不写入聊天、稿件或日志。群消息优先调用 receive_messages 一次接收并取得上下文；工具尚未显示时调用既有 claim_work，stepId=inbox，同样一次接收。领取结果已有 messages 时不重复 read_channel，需要更早消息才分页。kind=conversation 直接 post_message 回复，需对方行动时用 mentions @ 群内成员，无新内容 stay_silent。负责人由用户指定且随时可更换，不是唯一发言入口。需要时才 create_doc/edit_doc/ask_user/deliver/remember，不把普通聊天变成任务或文档。旧项目工作仍按领取上下文完成，长任务 report_progress。回应后可按 input.continuation 在同一次运行等待后续消息一次，最多45秒；empty/busy 后停止，不反复空跑。每次写入使用稳定 requestId。重复通知先查看现有任务，不重复执行。不发布、不付款，遇到授权需求交回用户。`;
  if (connection.transport === "muse-poll")
    return `${common}\n连接 OpenAPI：${origin}/v2/openapi.json。定时或轻量 hook 先 GET ${origin}/v2/signal，只在 hasWork=true 时执行；不把轮询结果当成已领取。建议间隔 ${connection.pollSeconds} 秒，实际取决于原平台支持，不承诺即时。`;
  if (connection.transport === "grok-webhook")
    return `${common}\n为该原 Bot 建一个专用 Routine，收到 webhook 时只处理本成员工作。把官方 POST URL 和 key 填入 Hub 接入设置。通知只是门铃，完整任务从 Hub 工具读取。`;
  if (connection.transport === "dots-events")
    return `${common}\n在原 Dot 连接插件并订阅 work.ready，arguments.member_id=${memberId}。有事件时读取自己待办，按领取和交付协议执行。`;
  return "使用官方 Perplexity OAuth 入口完成授权；Hub 调用原 Computer MCP，保留其线程、工具与额度。任务发送与状态读取分开，超时不自动另发一条任务。";
}
