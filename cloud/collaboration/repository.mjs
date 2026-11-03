import { HubError } from "../../shared/domain.mjs";

/** @returns {never} */
export const fail = (code, message, status = 400) => {
  throw new HubError(code, message, status);
};
export const id = (prefix) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export const required = (value, label, max = 8000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("invalid_input", `${label}不能为空，最多 ${max} 字符`);
  return value.trim();
};
export const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");

// One lightweight CAS clock serializes transactions; entities are separate rows,
// not an ever-growing workspace JSON. Every write is guarded by the same mutation.
export class Repository {
  constructor(db, workspaceId) {
    this.db = db;
    this.workspaceId = workspaceId;
  }
  async get(kind, key, necessary = true) {
    const row = await this.db
      .prepare(
        "SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind=? AND id=?",
      )
      .bind(this.workspaceId, kind, key)
      .first();
    if (!row && necessary) fail("not_found", "记录不存在", 404);
    return row ? JSON.parse(row.body) : null;
  }
  async list(kind, { scope, parent, status, after = "", limit = 100 } = {}) {
    let sql = "SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind=?";
    const params = [this.workspaceId, kind];
    for (const [field, value] of [
      ["scope_id", scope],
      ["parent_id", parent],
      ["status", status],
    ])
      if (value !== undefined) {
        sql += ` AND ${field}=?`;
        params.push(value);
      }
    sql += " AND id>? ORDER BY id LIMIT ?";
    params.push(after, Math.max(1, Math.min(501, limit)));
    const rows = await this.db
      .prepare(sql)
      .bind(...params)
      .all();
    return rows.results.map((row) => JSON.parse(row.body));
  }
  async transact(requestId, input, callback, now = new Date().toISOString()) {
    required(requestId, "幂等请求编号", 180);
    const fingerprint = await digest(JSON.stringify(input));
    for (let retry = 0; retry < 8; retry++) {
      const clock = await this.db
        .prepare("SELECT revision FROM hub_v2_clock WHERE workspace_id=?")
        .bind(this.workspaceId)
        .first();
      const previous = await this.db
        .prepare(
          "SELECT fingerprint,result FROM hub_v2_receipts WHERE workspace_id=? AND request_id=?",
        )
        .bind(this.workspaceId, requestId)
        .first();
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail("idempotency_conflict", "同一请求编号不能用于不同操作", 409);
        return JSON.parse(previous.result);
      }
      const tx = new Transaction(this, now),
        result = await callback(tx);
      const mutation = crypto.randomUUID(),
        revision = clock?.revision ?? -1;
      const idleSql =
        tx.legacyAccounts
          .map(
            () =>
              "NOT EXISTS (SELECT 1 FROM hub_workspace w,json_each(w.body,'$.tasks') t,json_each(t.value,'$.steps') s WHERE w.id=? AND json_extract(s.value,'$.accountId')=? AND json_extract(s.value,'$.status')='running')",
          )
          .join(" AND ") || "1";
      const idleParams = tx.legacyAccounts.flatMap((a) => [
        this.workspaceId,
        a,
      ]);
      const statements = [
        revision < 0
          ? this.db
              .prepare(
                `INSERT OR IGNORE INTO hub_v2_clock(workspace_id,revision,mutation_id) SELECT ?,0,? WHERE ${idleSql}`,
              )
              .bind(this.workspaceId, mutation, ...idleParams)
          : this.db
              .prepare(
                `UPDATE hub_v2_clock SET revision=revision+1,mutation_id=? WHERE workspace_id=? AND revision=? AND ${idleSql}`,
              )
              .bind(mutation, this.workspaceId, revision, ...idleParams),
      ];
      const guard =
        "EXISTS (SELECT 1 FROM hub_v2_clock WHERE workspace_id=? AND mutation_id=?)";
      for (const record of tx.writes.values()) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO hub_v2_records(workspace_id,kind,id,scope_id,parent_id,status,revision,sequence,updated_at,body) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(workspace_id,kind,id) DO UPDATE SET scope_id=excluded.scope_id,parent_id=excluded.parent_id,status=excluded.status,revision=excluded.revision,sequence=excluded.sequence,updated_at=excluded.updated_at,body=excluded.body`,
            )
            .bind(
              this.workspaceId,
              record.kind,
              record.id,
              record.scopeId || "",
              record.parentId || "",
              record.status || "",
              record.revision,
              revision + 1,
              now,
              JSON.stringify(record),
              this.workspaceId,
              mutation,
            ),
        );
      }
      statements.push(
        this.db
          .prepare(
            `INSERT INTO hub_v2_receipts(workspace_id,request_id,fingerprint,result,created_at) SELECT ?,?,?,?,? WHERE ${guard}`,
          )
          .bind(
            this.workspaceId,
            requestId,
            fingerprint,
            JSON.stringify(result ?? null),
            now,
            this.workspaceId,
            mutation,
          ),
      );
      const committed = await this.db.batch(statements);
      if (committed[0].meta.changes === 1) return result;
      if (
        idleParams.length &&
        !(
          await this.db
            .prepare(`SELECT (${idleSql}) AS idle`)
            .bind(...idleParams)
            .first()
        ).idle
      )
        fail("resource_busy", "旧版任务仍占用此账号", 409);
    }
    fail("conflict", "并发更新，请用相同请求编号重试", 409);
  }
}

class Transaction {
  constructor(repo, now) {
    this.repo = repo;
    this.now = now;
    this.writes = new Map();
    this.legacyAccounts = [];
  }
  guardLegacyIdle(accountId) {
    this.legacyAccounts.push(accountId);
  }
  async get(kind, key, necessary = true) {
    return structuredClone(
      this.writes.get(`${kind}:${key}`) ||
        (await this.repo.get(kind, key, necessary)),
    );
  }
  async list(kind, options = {}) {
    const rows = await this.repo.list(kind, { ...options, limit: 501 });
    if (rows.length >= 501)
      fail("query_limit", "本操作涉及记录过多，请缩小范围", 413);
    const combined = new Map(rows.map((x) => [x.id, x]));
    for (const row of this.writes.values())
      if (row.kind === kind) combined.set(row.id, structuredClone(row));
    return [...combined.values()].filter(
      (row) =>
        (options.scope === undefined || row.scopeId === options.scope) &&
        (options.parent === undefined || row.parentId === options.parent) &&
        (options.status === undefined || row.status === options.status),
    );
  }
  put(kind, record) {
    const next = {
      ...structuredClone(record),
      kind,
      revision: (record.revision || 0) + 1,
      updatedAt: this.now,
    };
    if (new TextEncoder().encode(JSON.stringify(next)).length > 180000)
      fail("record_limit", "单条记录过大，请使用文件附件", 413);
    this.writes.set(`${kind}:${next.id}`, next);
    return next;
  }
  message(projectId, type, body, refs = {}) {
    return this.put("message", {
      id: id("message"),
      scopeId: projectId,
      type,
      body,
      author: "system",
      createdAt: this.now,
      ...refs,
    });
  }
}
