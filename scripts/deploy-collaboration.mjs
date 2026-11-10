// Deploy only the backend. Never rewrites local account/config/profile material.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestJson } from "../local/transport.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operator = JSON.parse(
  await fs.readFile(
    path.join(os.homedir(), ".config/cloudflare/rikhuan93-operator.json"),
    "utf8",
  ),
);
const local = JSON.parse(
  await fs.readFile(
    path.join(os.homedir(), ".config/agent-hub/config.json"),
    "utf8",
  ),
);
if (operator.account_id !== "d9d2d3d737a0e4f3f99bee632ed94f45")
  throw new Error("Wrong Cloudflare account");
const mode = process.argv[2];
if (!["acceptance", "production"].includes(mode))
  throw new Error("Choose acceptance or production");
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: operator.account_id,
  CLOUDFLARE_API_TOKEN: operator.api_token,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};
async function run(args, input, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...env, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    child.stdin.end(input || "");
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        process.stderr.write(
          output.replaceAll(operator.api_token, "[REDACTED]"),
        );
        reject(new Error("Command failed: " + args.slice(0, 3).join(" ")));
      } else resolve(output);
    });
  });
}
const wrangler = ["node_modules/wrangler/bin/wrangler.js"];
const api = (suffix, options = {}) =>
  requestJson(
    "https://api.cloudflare.com/client/v4/accounts/" +
      operator.account_id +
      suffix,
    { ...options, token: operator.api_token, timeout: 60000 },
  );
const cfg = JSON.parse(
  await fs.readFile(path.join(root, "cloud/wrangler.jsonc"), "utf8"),
);
if (mode === "production" && cfg.vars?.HUB_RELAY_ORIGIN) {
  console.log(await run(["scripts/deploy-server.mjs"]));
  process.exit(0);
}
if (cfg.d1_databases[0].database_id !== "890d1e07-1ad5-42fb-a982-b99215b2ff99")
  throw new Error("Wrong D1");
const before = await requestJson(local.endpoint + "/admin/state", {
  token: local.adminKey,
});
if (before.tasks.some((t) => t.steps.some((s) => s.status === "running")))
  throw new Error("Existing task running; deployment deferred");
console.log(
  "Target verified; existing accounts retained. Applying additive migrations.",
);
console.log(
  await run([
    ...wrangler,
    "d1",
    "migrations",
    "apply",
    "agent-hub-local",
    "--remote",
    "--config",
    "cloud/wrangler.jsonc",
  ]),
);
if (mode === "production") {
  console.log(
    await run([...wrangler, "deploy", "--config", "cloud/wrangler.jsonc"]),
  );
  const catalog = await requestJson(local.endpoint + "/v2/catalog", {
    token: local.adminKey,
  });
  const after = await requestJson(local.endpoint + "/admin/state", {
    token: local.adminKey,
  });
  if (
    JSON.stringify(before.accounts) !== JSON.stringify(after.accounts) ||
    JSON.stringify(before.members) !== JSON.stringify(after.members)
  )
    throw new Error("Unexpected account/member change");
  const connections = await requestJson(local.endpoint + "/v2/connections", {
    token: local.adminKey,
  });
  const report = {
    at: new Date().toISOString(),
    endpoint: local.endpoint,
    accountId: operator.account_id,
    backendVersion: catalog.version,
    platformAdapters: catalog.platforms.length,
    nativeConnections: connections.connections.map((c) => ({
      id: c.id,
      status: c.status,
    })),
    legacyAccountsPreserved: true,
    uiChanged: false,
    realCommercialAgentTested: false,
    attachmentStorage: "D1 chunks; 8 MiB per file",
  };
  await fs.writeFile(
    path.join(root, "evidence/collaboration-deployment.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} else {
  const dir = await fs.mkdtemp(path.join(root, ".local-acceptance-"));
  const workspace = "acceptance_" + crypto.randomUUID().replaceAll("-", "");
  const key = crypto.randomUUID() + crypto.randomUUID();
  const stage = {
    ...cfg,
    name: "agent-hub-acceptance",
    main: path.join(root, "cloud/worker.ts"),
    vars: { ...cfg.vars, WORKSPACE_ID: workspace, HUB_RELAY_ORIGIN: "", HUB_MAINTENANCE: "0" },
    triggers: { crons: [] },
    d1_databases: cfg.d1_databases.map((x) => ({
      ...x,
      migrations_dir: path.join(root, "cloud/migrations"),
    })),
  };
  const configFile = path.join(dir, "wrangler.json");
  await fs.writeFile(configFile, JSON.stringify(stage));
  const secretFile = path.join(dir, "secrets.json");
  await fs.writeFile(secretFile, JSON.stringify({ ADMIN_KEY: key }), {
    mode: 0o600,
  });
  try {
    console.log(
      await run([
        ...wrangler,
        "deploy",
        "--config",
        configFile,
        "--secrets-file",
        secretFile,
      ]),
    );
    console.log(
      await run(["tests/collaboration-http.mjs"], null, {
        HUB_COLLAB_TEST_URL:
          "https://agent-hub-acceptance.duola-ai-project-radar.workers.dev",
        HUB_COLLAB_TEST_KEY: key,
      }),
    );
  } finally {
    const cleanup = [
      "hub_v2_records",
      "hub_v2_receipts",
      "hub_v2_clock",
      "hub_events",
      "hub_artifacts",
    ].map((table) => ({
      sql: `DELETE FROM ${table} WHERE workspace_id=?`,
      params: [workspace],
    }));
    cleanup.push(
      { sql: "DELETE FROM hub_workspace WHERE id=?", params: [workspace] },
      {
        sql: "DELETE FROM hub_v2_file_chunks WHERE object_key LIKE ?",
        params: [workspace + "/%"],
      },
    );
    for (const q of cleanup) {
      const r = await api(
        "/d1/database/" + cfg.d1_databases[0].database_id + "/query",
        { method: "POST", body: q },
      );
      if (!r.success) throw new Error("Acceptance cleanup failed");
    }
    await api("/workers/scripts/agent-hub-acceptance", { method: "DELETE" });
    await fs.rm(dir, { recursive: true, force: true });
  }
}
