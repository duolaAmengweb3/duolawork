import { HubError } from "../../shared/domain.mjs";
import {changeDescriptor,publishChanges} from './change-feed.mjs';

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

// Commit guards validate records and queried ranges. Unrelated projects do not
// invalidate one another; a global sequence is only used for the activity feed.
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
  async list(
    kind,
    {
      scope,
      parent,
      status,
      after = "",
      limit = 100,
      order = "id",
      cursor,
      excludeHidden = false,
      replyTo,
      questionIds,
    } = {},
  ) {
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
    if (excludeHidden)
      sql += " AND COALESCE(json_extract(body,'$.hidden'),0)=0";
    if (replyTo?.length) {
      const roots = replyTo.slice(0,100);
      const placeholders = roots.map(()=>'?').join(',');
      sql += ` AND (json_extract(body,'$.replyTo') IN (${placeholders}) OR json_extract(body,'$.rootId') IN (${placeholders}))`;
      params.push(...roots,...roots);
    }
    if (questionIds?.length) {
      const ids=questionIds.slice(0,500);
      sql += ` AND json_extract(body,'$.questionId') IN (${ids.map(()=>'?').join(',')}) AND json_extract(body,'$.type')='question'`;
      params.push(...ids);
    }
    if (order === "recent") {
      if (cursor) {
        sql += " AND (updated_at<? OR (updated_at=? AND id<?))";
        params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      }
      sql += " ORDER BY updated_at DESC,id DESC LIMIT ?";
    } else {
      sql += " AND id>? ORDER BY id LIMIT ?";
      params.push(after);
    }
    params.push(Math.max(1, Math.min(501, limit)));
    const rows = await this.db
      .prepare(sql)
      .bind(...params)
      .all();
    return rows.results.map((row) => JSON.parse(row.body));
  }
  async transact(requestId, input, callback, now = new Date().toISOString()) {
    required(requestId, "幂等请求编号", 180);
    const fingerprint = await digest(JSON.stringify(input));
    for (let retry = 0; retry < 24; retry++) {
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
      for (const record of tx.writes.values())
        if (!tx.reads.has(`${record.kind}:${record.id}`)) {
          const current = await this.get(record.kind, record.id, false);
          tx.reads.set(`${record.kind}:${record.id}`, {
            kind: record.kind,
            id: record.id,
            revision: current?.revision ?? -1,
          });
          record.revision = (current?.revision || 0) + 1;
        }
      const mutation = crypto.randomUUID();
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
      const validation = `NOT EXISTS (SELECT 1 FROM json_each(?) c LEFT JOIN hub_v2_records r ON r.workspace_id=? AND r.kind=json_extract(c.value,'$.kind') AND r.id=json_extract(c.value,'$.id') WHERE COALESCE(r.revision,-1)<>json_extract(c.value,'$.revision')) AND NOT EXISTS (SELECT 1 FROM json_each(?) c LEFT JOIN hub_v2_clock r ON r.workspace_id=json_extract(c.value,'$.key') WHERE COALESCE(r.revision,-1)<>json_extract(c.value,'$.revision')) AND NOT EXISTS (SELECT 1 FROM hub_v2_receipts WHERE workspace_id=? AND request_id=?) AND ${idleSql}`;
      const validationParams = [
        JSON.stringify([...tx.reads.values()]),
        this.workspaceId,
        JSON.stringify([...tx.ranges.values()]),
        this.workspaceId,
        requestId,
        ...idleParams,
      ];
      const statements = [
        this.db
          .prepare(
            `INSERT INTO hub_v2_clock(workspace_id,revision,mutation_id) SELECT ?,0,? WHERE ${validation} ON CONFLICT(workspace_id) DO UPDATE SET revision=hub_v2_clock.revision+1,mutation_id=excluded.mutation_id WHERE ${validation}`,
          )
          .bind(
            this.workspaceId,
            mutation,
            ...validationParams,
            ...validationParams,
          ),
      ];
      const guard =
        "EXISTS (SELECT 1 FROM hub_v2_clock WHERE workspace_id=? AND mutation_id=?)";
      for (const record of tx.writes.values()) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO hub_v2_records(workspace_id,kind,id,scope_id,parent_id,status,revision,sequence,updated_at,body) SELECT ?,?,?,?,?,?,?,(SELECT revision FROM hub_v2_clock WHERE workspace_id=?),?,? WHERE ${guard} ON CONFLICT(workspace_id,kind,id) DO UPDATE SET scope_id=excluded.scope_id,parent_id=excluded.parent_id,status=excluded.status,revision=excluded.revision,sequence=excluded.sequence,updated_at=excluded.updated_at,body=excluded.body`,
            )
            .bind(
              this.workspaceId,
              record.kind,
              record.id,
              record.scopeId || "",
              record.parentId || "",
              record.status || "",
              record.revision,
              this.workspaceId,
              now,
              JSON.stringify(record),
              this.workspaceId,
              mutation,
            ),
        );
      }
      const rangeKeys = [
        ...new Set(
          [...tx.writes.values()].flatMap((r) => [
            rangeKey(this.workspaceId, r.kind),
            rangeKey(this.workspaceId, r.kind, { scope: r.scopeId || "" }),
            rangeKey(this.workspaceId, r.kind, { parent: r.parentId || "" }),
          ]),
        ),
      ];
      const changes=[...tx.writes.values()].map(changeDescriptor).filter(Boolean);
      if(changes.length){
        statements.push(this.db.prepare(`INSERT INTO hub_v2_records(workspace_id,kind,id,scope_id,parent_id,status,revision,sequence,updated_at,body) SELECT ?,'change_event',?,'','','',1,(SELECT revision FROM hub_v2_clock WHERE workspace_id=?),?,? WHERE ${guard}`)
          .bind(this.workspaceId,mutation,this.workspaceId,now,JSON.stringify({changes}),this.workspaceId,mutation));
        statements.push(this.db.prepare(`DELETE FROM hub_v2_records WHERE workspace_id=? AND kind='change_event' AND sequence<(SELECT revision-10000 FROM hub_v2_clock WHERE workspace_id=?) AND ${guard}`)
          .bind(this.workspaceId,this.workspaceId,this.workspaceId,mutation));
      }
      if (rangeKeys.length)
        statements.push(
          this.db
            .prepare(
              `INSERT INTO hub_v2_clock(workspace_id,revision,mutation_id) SELECT value,0,? FROM json_each(?) WHERE ${guard} ON CONFLICT(workspace_id) DO UPDATE SET revision=hub_v2_clock.revision+1,mutation_id=excluded.mutation_id`,
            )
            .bind(
              mutation,
              JSON.stringify(rangeKeys),
              this.workspaceId,
              mutation,
            ),
        );
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
      if (committed[0].meta.changes === 1) {if(changes.length)publishChanges(this.db,this.workspaceId);return result;}
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
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(200, 4 * 2 ** Math.min(retry, 5)) +
            Math.floor(Math.random() * 12),
        ),
      );
    }
    fail("conflict", "并发更新，请用相同请求编号重试", 409);
  }
}

const rangeKey = (workspace, kind, { scope, parent } = {}) =>
  JSON.stringify([
    workspace,
    "range",
    kind,
    scope !== undefined
      ? ["scope", scope]
      : parent !== undefined
        ? ["parent", parent]
        : ["all"],
  ]);

class Transaction {
  constructor(repo, now) {
    this.repo = repo;
    this.now = now;
    this.writes = new Map();
    this.reads = new Map();
    this.snapshots = new Map();
    this.ranges = new Map();
    this.legacyAccounts = [];
  }
  guardLegacyIdle(accountId) {
    this.legacyAccounts.push(accountId);
  }
  async get(kind, key, necessary = true) {
    const cached = this.writes.get(`${kind}:${key}`);
    if (cached) return structuredClone(cached);
    if (this.snapshots.has(`${kind}:${key}`))
      return structuredClone(this.snapshots.get(`${kind}:${key}`));
    const record = await this.repo.get(kind, key, necessary);
    this.snapshots.set(`${kind}:${key}`, record);
    this.reads.set(`${kind}:${key}`, {
      kind,
      id: key,
      revision: record?.revision ?? -1,
    });
    return structuredClone(record);
  }
  async list(kind, options = {}) {
    const key = rangeKey(this.repo.workspaceId, kind, options);
    if (!this.ranges.has(key)) {
      const clock = await this.repo.db
        .prepare("SELECT revision FROM hub_v2_clock WHERE workspace_id=?")
        .bind(key)
        .first();
      this.ranges.set(key, { key, revision: clock?.revision ?? -1 });
    }
    // A recent window is intentionally bounded (e.g. the last 200 messages
    // for loop detection). It must not become an all-history mutation scan.
    // Keep the range clock guard so concurrent arrivals still retry this read.
    const recent = options.order === 'recent';
    const pageLimit = options.page || recent ? Math.max(1, Math.min(500, options.limit || 100)) : 501;
    const rows = await this.repo.list(kind, { ...options, limit: pageLimit });
    if (!options.page && !recent && rows.length >= 501)
      fail("query_limit", "本操作涉及记录过多，请缩小范围", 413);
    const combined = new Map(rows.map((x) => [x.id, x]));
    for (const row of this.writes.values())
      if (row.kind === kind) combined.set(row.id, structuredClone(row));
    const result = [...combined.values()].filter(
      (row) =>
        (options.scope === undefined || row.scopeId === options.scope) &&
        (options.parent === undefined || row.parentId === options.parent) &&
        (options.status === undefined || row.status === options.status) &&
        (!options.page || recent || row.id > (options.after || "")) &&
        (!recent || !options.cursor || row.updatedAt < options.cursor.updatedAt || row.updatedAt === options.cursor.updatedAt && row.id < options.cursor.id),
    );
    if(recent)return result.sort((a,b)=>a.updatedAt===b.updatedAt?(a.id===b.id?0:a.id>b.id?-1:1):a.updatedAt>b.updatedAt?-1:1).slice(0,pageLimit);
    return options.page ? result.sort((a,b)=>a.id.localeCompare(b.id)).slice(0,pageLimit) : result;
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
