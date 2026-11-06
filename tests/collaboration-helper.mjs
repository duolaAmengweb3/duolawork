import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { Repository } from "../cloud/collaboration/repository.mjs";
import { command } from "../cloud/collaboration/engine.mjs";

export function database() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001.sql", "0002_collaboration.sql", "0003_human_read.sql"])
    db.exec(
      fs.readFileSync(
        new URL("../cloud/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  const statement = (sql, params = []) => ({
    bind(...args) {
      return statement(sql, args);
    },
    async first() {
      return db.prepare(sql).get(...params) || null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    async run() {
      return { meta: db.prepare(sql).run(...params) };
    },
    sql,
    params,
  });
  return {
    prepare: statement,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => ({
          meta: db.prepare(s.sql).run(...s.params),
        }));
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}
export async function fixture(t) {
  const db = database();
  t.after(() => db.close());
  const repo = new Repository(db, "test");
  const identity = {
    members: ["grok", "check", "write"].map((id) => ({
      id,
      accountId: id,
      status: "ready",
      platformId: "custom",
      paused: false,
    })),
    accounts: ["grok", "check", "write"].map((id) => ({
      id,
      status: "connected",
    })),
  };
  await repo.transact("seed", {}, async (tx) => {
    for (const member of identity.members)
      tx.put("connection", {
        id: member.id,
        status: "verified",
        transport: "muse-poll",
        resourceKey: member.id,
        capabilities: ["research", "writing"],
        configVersion: 1,
      });
    return {};
  });
  let n = 0;
  const send = (type, args = {}, actor = { owner: true }, now) =>
    command(
      repo,
      identity,
      actor,
      { type, requestId: `request_${++n}`, ...args },
      now,
    );
  const project = await send("project.create", {
    recipeId: "daily-x-content",
    name: "测试项目",
    topic: "真实实操案例",
    slots: { discover: "grok", verify: "check", write: "write" },
  });
  return { db, repo, identity, send, project };
}
export const items = (
  n,
  body = "完整的研究结果正文，包含具体观察、参考来源和明确的事实限制。",
) =>
  Array.from({ length: n }, (_, i) => ({
    title: `成果 ${i + 1}`,
    body,
    sources: ["https://example.com/primary"],
  }));
export async function completeNext(f, runId, count) {
  const step = (await f.repo.list("step", { parent: runId })).find(
    (s) => s.status === "ready",
  );
  const actor = { memberId: step.memberId },
    claim = await f.send("step.claim", { stepId: step.id }, actor);
  return f.send(
    "step.submit",
    { attemptId: claim.attemptId, lease: claim.lease, items: items(count) },
    actor,
  );
}
