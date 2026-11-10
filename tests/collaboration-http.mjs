import { fetch as networkFetch } from "undici";
import { networkDispatcher } from "../local/transport.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const remoteBase = process.env.HUB_COLLAB_TEST_URL;
if (
  remoteBase &&
  !/^https:\/\/agent-hub-acceptance\.duola-ai-project-radar\.workers\.dev$/.test(
    remoteBase,
  )
)
  throw new Error("Only the isolated acceptance worker may be mutated");
const fetch = (url, options = {}) =>
  remoteBase
    ? networkFetch(url, { ...options, dispatcher: networkDispatcher() })
    : globalThis.fetch(url, options);
const ownerToken = remoteBase
  ? process.env.HUB_COLLAB_TEST_KEY
  : "test-http-admin-only";
if (!ownerToken) throw new Error("Missing isolated acceptance key");
const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-v2-http-")),
);
let mf;
const clients = [];
const checks = [];
try {
  if (!remoteBase) {
    execFileSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--dry-run",
        "--outdir",
        directory,
        "--config",
        "cloud/wrangler.jsonc",
      ],
      {
        stdio: "pipe",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    const bundle = path.join(directory, "worker.js");
    mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "hub-test",
        scriptPath: bundle,
        modulesRoot: directory,
        modules: true,
        compatibilityDate: "2026-10-26",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ADMIN_KEY: ownerToken,
          FILE_STORAGE: "d1",
          WORKSPACE_ID: "v2-http-isolated",
        },
        d1Databases: { DB: "test-v2" },
        r2Buckets: { FILES: "test-v2-files" },
      }),
    );
    const db = await mf.getD1Database("DB");
    for (const name of ["0001.sql", "0002_collaboration.sql", "0003_human_read.sql"]) {
      const sql = await fs.readFile(`cloud/migrations/${name}`, "utf8");
      for (const statement of sql.split(";").filter((s) => s.trim()))
        await db.prepare(statement).run();
    }
  }
  const base = String(remoteBase || (await mf.ready)).replace(/\/$/, "");
  async function request(route, body, token = ownerToken, method) {
    const r = await fetch(base + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    return result;
  }
  assert.equal((await fetch(base + "/v2/catalog")).status, 401);
  const catalog = await request("/v2/catalog");
  assert.equal(catalog.platforms.length, 4);
  assert.equal(catalog.recipes.length, 1);
  const members = [];
  for (let i = 0; i < 3; i++) {
    const a = (
      await request("/admin/action", {
        type: "account.create",
        payload: { platformId: "muse", label: "隔离协议测试" },
      })
    ).result;
    const m = (
      await request("/admin/action", {
        type: "member.create",
        payload: { accountId: a.id, name: "测试成员" + i, mode: "connector" },
      })
    ).result;
    const credential = await request("/admin/member-credential", {
      memberId: m.id,
    });
    members.push({ ...m, token: credential.token });
    await request("/v2/connections", {
      requestId: "setup" + i,
      memberId: m.id,
      platform: "muse",
      capabilities: ["research", "writing"],
    });
    const client = new Client({
      name: "isolated-v2-fixture",
      version: "1.0.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/v2/mcp"), {
        fetch,
        requestInit: {
          headers: { Authorization: "Bearer " + credential.token },
        },
      }),
    );
    clients.push(client);
    assert.equal((await client.listTools()).tools.length, 8);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    m.call = call;
    members[i].call = call;
    const probe = (
      await request("/v2/commands", {
        type: "connection.probe",
        requestId: "probe" + i,
        memberId: m.id,
      })
    ).result;
    const work = (await call("list_work")).work.find(
      (w) => w.runId === probe.runId,
    );
    const claim = await call("claim_work", {
      requestId: "probe-claim",
      stepId: work.stepId,
    });
    const nonce = claim.input.instruction.match(/proof_[a-z0-9]+/)[0];
    await call("submit_work", {
      requestId: "probe-submit",
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: [{ title: "连接验证", body: nonce }],
    });
  }
  checks.push(
    "Worker + D1 + 真 HTTP/MCP 三个独立测试身份，nonce 往返后才 verified",
  );
  const project = (
    await request("/v2/commands", {
      type: "project.create",
      requestId: "create-project",
      recipeId: "daily-x-content",
      name: "协议测试项目",
      topic: "测试输入",
      slots: {
        discover: members[0].id,
        verify: members[1].id,
        write: members[2].id,
      },
    })
  ).result;
  const binary = new Uint8Array(1100000).map((_, i) => i % 251);
  const uploadResponse = await fetch(base + "/v2/files", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ownerToken,
      "Content-Type": "application/octet-stream",
      "X-Hub-File": encodeURIComponent(
        JSON.stringify({
          requestId: "large-attachment",
          projectId: project.id,
          name: "多块资料.bin",
        }),
      ),
    },
    body: binary,
  });
  assert.equal(uploadResponse.status, 200);
  const largeFile = await uploadResponse.json();
  const downloaded = new Uint8Array(
    await (
      await fetch(base + "/v2/files/" + largeFile.id, {
        headers: { Authorization: "Bearer " + ownerToken },
      })
    ).arrayBuffer(),
  );
  assert.deepEqual(downloaded, binary);
  checks.push("1100000字节附件经真实HTTP与D1分块持久化后逐字节一致");
  const run = (
    await request("/v2/commands", {
      type: "run.start",
      requestId: "run-start",
      projectId: project.id,
    })
  ).result;
  let docId;
  for (let i = 0; i < 3; i++) {
    const m = members[i],
      work = (await m.call("list_work")).work.find((w) => w.runId === run.id);
    const claim = await m.call("claim_work", {
      requestId: "main-claim",
      stepId: work.stepId,
    });
    if (i > 0) assert(claim.input.predecessorDocumentIds.length >= 5);
    if (i === 0) {
      const wrong = await clients[1].callTool({
        name: "submit_work",
        arguments: {
          requestId: "stolen-lease",
          attemptId: claim.attemptId,
          lease: claim.lease,
          items: [{ title: "伪造", body: "不应该通过" }],
        },
      });
      assert.equal(wrong.isError, true);
    }
    const uploaded = await m.call("upload_file", {
      requestId: "file-" + i,
      attemptId: claim.attemptId,
      lease: claim.lease,
      name: "资料.txt",
      base64: Buffer.from("HTTP 真实文件字节").toString("base64"),
    });
    const items = Array.from({ length: i === 0 ? 5 : 3 }, (_, n) => ({
      title: "独立成果" + n,
      body: "这是隔离协议测试客户端提交的完整成果，不能冒充真实商业 Agent 的任务质量。",
      sources: [{ url: "https://example.com/primary" }],
      fileIds: n === 0 ? [uploaded.id] : [],
    }));
    const submitted = await m.call("submit_work", {
      requestId: "main-submit",
      attemptId: claim.attemptId,
      lease: claim.lease,
      items,
    });
    docId = submitted.documentIds[0];
    const response = await fetch(base + "/v2/files/" + uploaded.id, {
      headers: { Authorization: "Bearer " + m.token },
    });
    assert.equal(await response.text(), "HTTP 真实文件字节");
  }
  const view = await request("/v2/project?id=" + project.id);
  assert.equal(view.runs[0].status, "completed");
  const doc = await request("/v2/document?id=" + docId);
  await request("/v2/commands", {
    type: "document.edit",
    requestId: "edit1",
    documentId: docId,
    revision: doc.revision,
    body: "人的完整工作稿，刷新后仍可读取。",
  });
  assert.equal(
    (await request("/v2/document?id=" + docId)).working.body,
    "人的完整工作稿，刷新后仍可读取。",
  );
  await request("/v2/commands", {
    type: "feedback.set",
    requestId: "adopt",
    documentId: docId,
    value: "adopted",
  });
  assert.equal(
    (await request("/v2/metrics?projectId=" + project.id)).adopted,
    1,
  );
  checks.push(
    "配方三步接力、前序材料、跨成员拒绝、附件真实字节、文稿版本与反馈均经HTTP验收",
  );
  let activity = await request("/v2/activity?projectId=" + project.id);
  const cursor = activity.cursor;
  await request("/v2/commands", {
    type: "message.send",
    requestId: "message-after-cursor",
    projectId: project.id,
    body: "新增消息必须出现在增量游标以后",
  });
  activity = await request(
    "/v2/activity?projectId=" +
      project.id +
      "&cursor=" +
      encodeURIComponent(cursor),
  );
  assert.equal(activity.events.length, 1);
  assert.match(activity.events[0].body, /增量游标/);
  const discover = await request(
    "/v2/mcp",
    { jsonrpc: "2.0", id: 7, method: "server/discover" },
    members[0].token,
  );
  assert(discover.result.capabilities.events);
  checks.push("增量消息游标不丢新增事件，MCP 2.0 discovery 对外可用");
  await fs.mkdir("evidence", { recursive: true });
  const report = {
    at: new Date().toISOString(),
    environment: remoteBase
      ? "isolated Cloudflare Worker + D1 attachments"
      : "isolated local workerd + D1 attachments",
    passed: checks,
    realCommercialAgentTested: false,
    productionDataTouched: false,
  };
  await fs.writeFile(
    remoteBase
      ? "evidence/collaboration-cloud.json"
      : "evidence/collaboration-http.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const c of clients) await c.close();
  await mf?.dispose();
  await fs.rm(directory, { recursive: true, force: true });
}
