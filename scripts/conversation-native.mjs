// Owner-authorized commercial Agent acceptance. Uses only synthetic QA content;
// never extracts member credentials or calls models on the Agents' behalf.
import fs from "node:fs/promises";
import os from "node:os";
import { requestJson } from "../local/transport.mjs";
const cfg = JSON.parse(
  await fs.readFile(os.homedir() + "/.config/agent-hub/config.json", "utf8"),
);
const req = (path, body) =>
  requestJson(cfg.endpoint + path, {
    token: cfg.adminKey,
    ...(body ? { method: "POST", body } : {}),
  });
const command = (type, args) =>
  req("/v2/commands", { type, requestId: crypto.randomUUID(), ...args }).then(
    (r) => r.result,
  );
const w = await req("/v2/workspace");
const strict = ["strict-start", "strict-status"].includes(process.argv[2]);
const collaborative = [
  "collaborate",
  "collaboration-status",
  "strict-start",
  "strict-status",
].includes(process.argv[2]);
const channelName = strict
  ? "联测 · 共同文档交付"
  : collaborative
    ? "联测 · 多轮协作"
    : "联测 · 自由沟通";
let c = (await req("/v2/channels")).items.find((c) => c.name === channelName);
if (["hello", "collaborate", "strict-start"].includes(process.argv[2])) {
  const members = w.members.filter(
    (m) =>
      ["grok-bot", "chatgpt-agent"].includes(m.platformId) &&
      w.connections.some((c) => c.id === m.id && c.status === "verified"),
  );
  if (members.length !== 2) throw Error("Expected two verified native Agents");
  if (!c)
    c = await command("channel.create", {
      name: channelName,
      memberIds: members.map((m) => m.id),
      coordinatorId: null,
    });
  const snapshot = await req("/v2/channel?id=" + c.id);
  if (
    process.argv[2] === "hello" &&
    !snapshot.messages.some(
      (m) => m.authorId === "owner" && m.body === "有人在线吗？",
    )
  )
    await command("channel.post", { channelId: c.id, body: "有人在线吗？" });
}
if (!c) throw Error("No acceptance channel");
if (process.argv[2] === "collaborate")
  await command("channel.post", {
    channelId: c.id,
    body: "一起设计一个3分钟、纯文字、两人能玩的破冰游戏。你们自己商量、相互挑错和修改，最后留下一份可直接照着玩的规则。不要等我转述，不规定谁先说、谁执笔。需要对方行动时请使用 post_message 的 mentions 直接 @ 对方，工具里的成员 ID 就是对方。讨论够了就停止，没新内容可以静默。",
  });
if (process.argv[2] === "strict-start")
  await command("channel.post", {
    channelId: c.id,
    body: "一起设计一个三分钟、两人纯文字的破冰游戏。自行商量和分工，互相指出并修正规则中的问题，再自行选一位执笔人，把共同最终版写入一份共享文档并交付给我。只设计规则，不开始玩；未解决分歧要保留，完成后停止。不要等我转述，不规定谁先说或谁执笔。",
  });
const snapshot = await req("/v2/channel?id=" + c.id);
const report = {
  at: new Date().toISOString(),
  channelId: c.id,
  identities: w.connections.map((c) => ({
    id: c.id,
    transport: c.transport,
    status: c.status,
    subscriptionActive: c.subscriptionActive,
  })),
  coordinator: snapshot.channel.coordinatorId,
  messages: snapshot.messages,
  activity: snapshot.activity,
  documents: snapshot.documents,
  realAgentReplied: snapshot.messages.some((m) => m.authorId !== "owner"),
  mentionEdges: snapshot.messages
    .filter((m) => m.authorId !== "owner" && m.mentions?.length)
    .map((m) => ({
      id: m.id,
      authorId: m.authorId,
      mentions: m.mentions,
      replyTo: m.replyTo,
    })),
  acceptanceRecord:
    "evidence/conversation-acceptance.json (capture, not verdict)",
  identityBoundary:
    "Grok account Automation and Dot Work event session. Existing personal Bot/Dot memory inheritance unverified.",
};
await fs.mkdir("evidence", { recursive: true });
await fs.writeFile(
  strict
    ? "evidence/conversation-strict-native.json"
    : collaborative
      ? "evidence/conversation-collaboration-native.json"
      : "evidence/conversation-native.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      channelId: c.id,
      messages: report.messages.map((m) => ({
        authorId: m.authorId,
        body: m.body,
        mentions: m.mentions,
        type: m.type,
      })),
      activity: report.activity.map((t) => ({
        memberId: t.memberId,
        status: t.status,
        reason: t.reason,
      })),
      documents: report.documents.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
      })),
      mentionEdges: report.mentionEdges,
    },
    null,
    2,
  ),
);
