import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import { issueAgentSkill, redeemAgentSkill, selfConnection, selfCheck, selfStatus, reportSetup, publicOnboarding, onboardingManifest } from "../cloud/collaboration/onboarding.mjs";
import { startPairing } from "../cloud/collaboration/pairing.mjs";
import { resolveActor, callTool } from "../cloud/collaboration/api.mjs";
import { unseal, publicConnection } from "../cloud/collaboration/security.mjs";
import { digest } from "../cloud/collaboration/repository.mjs";

const origin = "https://hub.example.com", secret = "isolated-onboarding-fixture-secret";
async function skillFor(f, memberId = "grok") {
  const issued = await issueAgentSkill(f.repo, f.identity, memberId, origin);
  const code = issued.skill.match(/配对码：([A-F0-9]{12})/)[1];
  return { ...issued, code };
}

test("一段接入Skill包含一次性成员码；重试不重复授权，长期凭证仅加密保存在回执", async t => {
  const f = await fixture(t), s = await skillFor(f);
  assert.match(s.skill, /自动完成配对/);
  const args = { code: s.code, attemptId: "retained-client-attempt" };
  const token = await redeemAgentSkill(f.repo, f.identity, args, secret, origin);
  const again = await redeemAgentSkill(f.repo, f.identity, args, secret, origin);
  assert.equal(token.access_token, again.access_token);
  const actor = await resolveActor(new Request(origin + "/v2/mcp", { headers: { Authorization: "Bearer " + token.access_token } }), { DB: f.db, WORKSPACE_ID: "test", ADMIN_KEY: secret }, f.identity);
  assert.deepEqual(actor, { memberId: "grok" });
  assert(!actor.owner);
  assert.equal((await f.repo.get("member_auth", await digest(token.access_token))).memberId, "grok");
  const rows = await f.db.prepare("SELECT body FROM hub_v2_records").all();
  const receipts = await f.db.prepare("SELECT result FROM hub_v2_receipts").all();
  const stored = JSON.stringify([rows.results, receipts.results]);
  assert(!stored.includes(token.access_token)); assert(!stored.includes(token.refresh_token));
  await assert.rejects(() => redeemAgentSkill(f.repo, f.identity, { ...args, attemptId: "different-client" }, secret, origin), e => e.code === "pair_expired");
  assert.equal((await f.repo.list("member_auth")).length, 1);
  assert.equal((await f.repo.get("connection", "grok")).setup.stage, "configuring");
  f.identity.accounts.find(a => a.id === f.identity.members.find(m => m.id === "grok").accountId).status = "disabled";
  await assert.rejects(() => redeemAgentSkill(f.repo, f.identity, args, secret, origin), e => e.code === "member_missing");
});

test("配对并发只授权一个请求，旧OAuth码不能误用，过期/停用不发凭证", async t => {
  const f = await fixture(t), s = await skillFor(f);
  const results = await Promise.allSettled(["client-a", "client-b"].map(attemptId => redeemAgentSkill(f.repo, f.identity, { code: s.code, attemptId }, secret, origin)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const old = await startPairing(f.repo, f.identity, "check", origin);
  await assert.rejects(() => redeemAgentSkill(f.repo, f.identity, { code: old.code, attemptId: "old-flow" }, secret, origin), e => e.code === "pair_expired");
  const exp = await skillFor(f, "check");
  await assert.rejects(() => redeemAgentSkill(f.repo, f.identity, { code: exp.code, attemptId: "expired" }, secret, origin, new Date(Date.parse(exp.expiresAt) + 1).toISOString()), e => e.code === "pair_expired");
  const paused = await skillFor(f, "write"); f.identity.members.find(m => m.id === "write").paused = true;
  await assert.rejects(() => redeemAgentSkill(f.repo, f.identity, { code: paused.code, attemptId: "paused" }, secret, origin), e => e.code === "member_missing");
});

test("自配置只操作本成员，保留原生Webhook密钥加密和其他成员状态", async t => {
  const f = await fixture(t); f.identity.members[0].platformId = "grok-bot";
  const other = await f.repo.get("connection", "check"), actor = { memberId: "grok" };
  await reportSetup(f.repo, actor, { stage: "waiting_platform", message: "之前未找到平台入口" });
  await assert.rejects(() => selfConnection(f.repo, f.identity, actor, { memberId: "check", requestId: "foreign", transport: "pull" }, secret), e => e.code === "forbidden");
  const result = await selfConnection(f.repo, f.identity, actor, { requestId: "native-receiver", transport: "webhook", url: "https://grok.com/native-hook/fixture", token: "isolated-native-webhook-key" }, secret);
  assert.equal(result.status, "configured"); assert(!JSON.stringify(result).includes("isolated-native-webhook-key"));
  assert.equal(result.setup.stage, "configuring");
  const saved = await f.repo.get("connection", "grok");
  assert.equal((await unseal(saved.credentials, secret)).token, "isolated-native-webhook-key");
  assert.deepEqual(await f.repo.get("connection", "check"), other);
  await assert.rejects(() => selfCheck(f.repo, f.identity, actor, { memberId: "check", requestId: "foreign-check" }), e => e.code === "forbidden");
  f.identity.members[0].paused = true;
  await assert.rejects(() => selfConnection(f.repo, f.identity, actor, { requestId: "paused-config", transport: "pull" }, secret), e => e.code === "member_missing");
});

test("原有Dot账号别名可自行接入事件，不改账号或其他成员", async t => {
  const f = await fixture(t), member = f.identity.members[0];
  member.platformId = "chatgpt-agent";
  const before = structuredClone(f.identity);
  const c = await selfConnection(f.repo, f.identity, { memberId: member.id }, { requestId: "existing-dot", transport: "events" }, secret);
  assert.equal(c.transport, "dots-events"); assert.equal(c.platform, "dots");
  assert.deepEqual(f.identity, before);
});

test("相同通用契约接Coding与Personal成员，配对或自配置不能把成员标成已接通", async t => {
  const f = await fixture(t), actor = { memberId: "grok" };
  f.identity.members[0].platformId = "codex";
  f.identity.members[1].platformId = "qwen-code";
  for (const memberId of ["grok", "check"]) {
    const result = await selfConnection(f.repo, f.identity, { memberId }, { requestId: "pull-" + memberId, transport: "pull", pollSeconds: 15 }, secret);
    assert.equal(result.transport, "muse-poll"); assert.equal(result.pollSeconds, 15);
    assert.equal((await selfStatus(f.repo, { memberId }, origin)).complete, false);
  }
  const probe = await selfCheck(f.repo, f.identity, actor, { requestId: "roundtrip" });
  const work = await callTool(f.repo, f.identity, actor, "list_work", {}, {});
  const pending = work.work.find(w => w.runId === probe.runId);
  assert(pending);
  const claim = await callTool(f.repo, f.identity, actor, "claim_work", { requestId: "claim-probe", stepId: pending.stepId }, {});
  const run = await f.repo.get("run", probe.runId);
  await callTool(f.repo, f.identity, actor, "submit_work", { requestId: "submit-probe", attemptId: claim.attemptId, lease: claim.lease,
    items: [{ title: "连接验证", body: run.probeNonce, sources: [] }] }, {});
  const verified = await selfStatus(f.repo, actor, origin);
  assert.equal(verified.complete, true);
  assert.equal(verified.connection.setup.stage, "verified");
  assert.equal((await f.repo.get("connection", "grok")).setup.stage, "verified");
  const legacy = { ...await f.repo.get("connection", "grok"), setup: { stage: "waiting_platform", message: "过时卡点" } };
  assert.equal(publicConnection(legacy).setup.stage, "verified");
  const laterBlock = { ...legacy, setup: { stage: "blocked", message: "后续新卡点", at: new Date(Date.parse(legacy.verifiedAt) + 1000).toISOString() } };
  assert.equal(publicConnection(laterBlock).setup.stage, "blocked");
  assert.equal((await selfStatus(f.repo, { memberId: "check" }, origin)).complete, false);
});

test("接入进度可报告具体阻塞，不允许自称verified，也不把凭证回显给用户", async t => {
  const f = await fixture(t), actor = { memberId: "grok" };
  await reportSetup(f.repo, actor, { stage: "blocked", message: "平台需要授权 https://example.com/path?code=private Bearer ahv1_private_value_1234567890" });
  const status = await selfStatus(f.repo, actor, origin);
  assert.equal(status.connection.setup.stage, "blocked");
  assert(!JSON.stringify(status.connection.setup).includes("private"));
  await assert.rejects(() => reportSetup(f.repo, actor, { stage: "verified", message: "pretend" }), e => e.code === "invalid_stage");
});

test("公开发现不授予权限，兑换限流不生成凭证；候选清单不冒充已实现", async t => {
  const f = await fixture(t);
  const manifest = onboardingManifest(origin);
  assert.equal(manifest.targetsAreImplementedClaims, false);
  for (const name of ["Codex", "Claude Code", "Qwen Code", "Kimi Code CLI", "Grok Bot", "WorkBuddy"])
    assert(manifest.targets.some(a => a.name === name));
  const result = await publicOnboarding(new Request(origin + "/v2/connect/redeem", { method: "POST", body: "{}" }), f.repo, f.identity,
    { ADMIN_KEY: secret, OAUTH_RATE_LIMIT: { limit: async () => ({ success: false }) } }, origin);
  assert.equal(result.status, 429);
  assert.equal((await f.repo.list("member_auth")).length, 0);
});
