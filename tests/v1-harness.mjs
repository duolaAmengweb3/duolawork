import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
export async function startHarness({outboundService} = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hub-v1-integration-"),
  );
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
    { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const key = "isolated-v1-acceptance-only";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "hub-v1-integration",
      scriptPath: path.join(directory, "worker.js"),
      modulesRoot: directory,
      modules: true,
      compatibilityDate: "2026-10-26",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ADMIN_KEY: key, WORKSPACE_ID: "v1-test", FILE_STORAGE: "d1" },
      d1Databases: { DB: "v1-test" },
      r2Buckets: { FILES: "v1-files" },
      ...(outboundService ? {outboundService} : {}),
    }),
  );
  const base = String(await mf.ready).replace(/\/$/, "");
  const db = await mf.getD1Database("DB");
  for (const name of ["0001.sql", "0002_collaboration.sql"])
    for (const sql of (await fs.readFile("cloud/migrations/" + name, "utf8"))
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  async function request(route, body, token = key) {
    const r = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(route + ": " + JSON.stringify(d));
    return d;
  }
  const command = (type, args = {}) =>
    request("/v2/commands", {
      type,
      requestId: crypto.randomUUID(),
      ...args,
    }).then((r) => r.result);
  async function member(platformId, name) {
    const account = (
      await request("/admin/action", {
        type: "account.create",
        payload: { platformId, label: name },
      })
    ).result;
    const m = (
      await request("/admin/action", {
        type: "member.create",
        payload: { accountId: account.id, name, mode: "connector" },
      })
    ).result;
    const { token } = await request("/admin/member-credential", {
      memberId: m.id,
    });
    // This is a protocol test peer, not a commercial platform. Poll transport avoids any external call.
    const row = {
      id: m.id,
      kind: "connection",
      revision: 1,
      resourceKey: account.id,
      transport: "muse-poll",
      capabilities: ["research", "writing", "files"],
      configVersion: 1,
      status: "configured",
    };
    await db
      .prepare(
        "INSERT INTO hub_v2_records(workspace_id,kind,id,revision,updated_at,body) VALUES('v1-test','connection',?,1,?,?)",
      )
      .bind(m.id, new Date().toISOString(), JSON.stringify(row))
      .run();
    const call = async (name, args = {}) => {
      const r = await request(
        "/v2/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        token,
      );
      if (r.result.isError) throw new Error(JSON.stringify(r.result));
      return JSON.parse(r.result.content[0].text);
    };
    const probe = await command("connection.probe", { memberId: m.id });
    const work = (await call("list_work")).work.find(
      (w) => w.runId === probe.runId,
    );
    const claim = await call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: work.stepId,
    });
    await call("submit_work", {
      requestId: crypto.randomUUID(),
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: [
        {
          title: "协议验证",
          body: claim.input.instruction.match(/proof_[a-z0-9]+/)[0],
        },
      ],
    });
    return { ...m, token, call };
  }
  return {
    base,
    key,
    db,
    directory,
    mf,
    request,
    command,
    member,
    async stop() {
      await mf.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
