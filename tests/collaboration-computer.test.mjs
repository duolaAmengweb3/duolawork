import test from "node:test";
import assert from "node:assert/strict";
import { fixture, items } from "./collaboration-helper.mjs";
import { seal } from "../cloud/collaboration/security.mjs";
import {
  startComputer,
  pollComputer,
  respondComputer,
  readRpcReply,
} from "../cloud/collaboration/computer.mjs";

const SECRET = "isolated-computer-test";
async function computer(t) {
  const f = await fixture(t);
  await f.repo.transact("computer-fixture", {}, async (tx) => {
    const c = await tx.get("connection", "grok");
    tx.put("connection", { ...c, transport: "computer-mcp" });
    tx.put("oauth", {
      id: "grok",
      status: "authorized",
      redirectUrl: "https://example.com/v2/oauth/callback",
      credentials: await seal(
        {
          tokens: { access_token: "fixture-only" },
          tokenExpiresAt: Date.now() + 3600000,
        },
        SECRET,
      ),
    });
    return {};
  });
  const run = await f.send("run.start", { projectId: f.project.id });
  return {
    ...f,
    run,
    row: (await f.repo.list("outbox", { parent: run.id }))[0],
    env: { ADMIN_KEY: SECRET },
  };
}
const reply = (request, result) =>
  Response.json({ jsonrpc: "2.0", id: request.id, result });
test("Computer creates once, persists opaque task id, polls same task then delivers full output", async (t) => {
  const f = await computer(t),
    requests = [];
  const fetcher = async (_, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    assert(request.params._meta["io.modelcontextprotocol/clientCapabilities"]);
    if (request.method === "tools/call")
      return reply(request, {
        resultType: "task",
        taskId: "opaque.id.123",
        status: "working",
      });
    assert.equal(request.method, "tasks/get");
    assert.equal(request.params.taskId, "opaque.id.123");
    return reply(request, {
      resultType: "complete",
      taskId: "opaque.id.123",
      status: "completed",
      result: {
        structuredContent: {
          task_status: "completed",
          thread_id: "thread1",
          text: JSON.stringify({ items: items(5) }),
        },
      },
    });
  };
  await startComputer(f.repo, f.identity, f.row, f.env, fetcher);
  const job = (await f.repo.list("remote_job"))[0];
  assert.equal(job.taskId, "opaque.id.123");
  await pollComputer(f.repo, f.identity, job, f.env, fetcher);
  assert.equal(requests.filter((x) => x.method === "tools/call").length, 1);
  assert.equal((await f.repo.get("remote_job", job.id)).status, "completed");
  assert.equal((await f.repo.get("step", job.stepId)).documentIds.length, 5);
});
test("Computer ambiguity never creates a second task; user responses use documented inputResponses exactly once", async (t) => {
  const f = await computer(t);
  let sends = 0;
  await startComputer(f.repo, f.identity, f.row, f.env, async () => {
    sends++;
    throw new Error("network");
  });
  const unknown = (await f.repo.list("remote_job"))[0];
  assert.equal(unknown.status, "unknown");
  // Same claim request resolves to the persisted attempt; no second external call.
  await startComputer(f.repo, f.identity, f.row, f.env, async () => {
    sends++;
  });
  assert.equal(sends, 1);
  await f.repo.transact("question-fixture", {}, async (tx) => {
    const j = await tx.get("remote_job", unknown.id);
    tx.put("remote_job", {
      ...j,
      status: "waiting_user",
      taskId: "opaque-q",
      interactions: { "answer:q1": { params: { mode: "form" } } },
    });
    return {};
  });
  const answer = {
    requestId: "answer1",
    attemptId: unknown.id,
    inputResponses: {
      "answer:q1": { action: "accept", content: { q1: "PDF" } },
    },
  };
  let answers = 0;
  const fetcher = async (_, options) => {
    const r = JSON.parse(options.body);
    assert.equal(r.method, "tasks/update");
    assert.deepEqual(r.params.inputResponses, answer.inputResponses);
    assert.equal(r.params.responses, undefined);
    answers++;
    return reply(r, {});
  };
  const settled = await Promise.allSettled([
    respondComputer(f.repo, f.identity, answer, f.env, fetcher),
    respondComputer(f.repo, f.identity, answer, f.env, fetcher),
  ]);
  assert.equal(answers, 1);
  assert(settled.some((x) => x.status === "fulfilled"));
  assert.equal((await f.repo.get("remote_job", unknown.id)).status, "working");
});
test("SSE parser ignores notifications and finishes on matching response without waiting for stream close", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0","id":"test","result":{"ok":true}}\r\n\r\n',
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  assert.deepEqual((await readRpcReply(response, "test")).result, { ok: true });
  assert(canceled);
});

test("Computer sends approved project attachment bytes through the official upload envelope", async (t) => {
  const f = await computer(t);
  const bytes = new TextEncoder().encode("真实项目参考资料");
  f.env.FILES = {
    async get() {
      return { body: new Response(bytes).body };
    },
  };
  await f.repo.transact("attachment-fixture", {}, async (tx) => {
    tx.put("file", {
      id: "file-fixture",
      scopeId: f.project.id,
      name: "素材.txt",
      mime: "text/plain",
      size: bytes.length,
      storage: "r2",
      objectKey: "isolated-key",
      status: "stored",
    });
    const run = await tx.get("run", f.run.id);
    run.knowledge.push({ id: "knowledge-file", fileIds: ["file-fixture"] });
    tx.put("run", run);
    return {};
  });
  const called = [];
  const fetcher = async (url, options) => {
    if (url === "https://fixture.s3.amazonaws.com/") {
      assert.deepEqual(
        new Uint8Array(await options.body.get("file").arrayBuffer()),
        bytes,
      );
      called.push("uploaded");
      return new Response(null, { status: 204 });
    }
    const r = JSON.parse(options.body);
    called.push(r.params.name);
    if (r.params.name === "create_attachment_upload")
      return reply(r, {
        structuredContent: {
          upload_url: "https://fixture.s3.amazonaws.com/",
          attachment_url: "https://fixture.s3.amazonaws.com/data/file",
          upload_fields: { key: "data/file", policy: "fixture" },
        },
      });
    assert.deepEqual(r.params.arguments.attachment_urls, [
      "https://fixture.s3.amazonaws.com/data/file",
    ]);
    return reply(r, {
      resultType: "task",
      taskId: "file-task",
      status: "working",
    });
  };
  await startComputer(f.repo, f.identity, f.row, f.env, fetcher);
  assert.deepEqual(called, [
    "create_attachment_upload",
    "uploaded",
    "call_perplexity_computer",
  ]);
});
