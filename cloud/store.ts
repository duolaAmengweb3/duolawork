import { initialState, reduce, HubError } from '../shared/domain.mjs';

export async function load(env: Env) {
  const row = await env.DB.prepare('SELECT revision, body FROM hub_workspace WHERE id = ?').bind(env.WORKSPACE_ID).first<{ revision: number; body: string }>();
  return row ? { state: JSON.parse(row.body), revision: row.revision } : { state: initialState(), revision: -1 };
}

export async function mutate(env: Env, action: Record<string, unknown>) {
  for (let i = 0; i < 6; i++) {
    const { state: before, revision } = await load(env);
    const next = reduce(before, action);
    const claimAccount = action.type === 'step.claim' ? next.result.accountId : null;
    const nativeGuard = claimAccount ? " AND NOT EXISTS (SELECT 1 FROM hub_v2_records WHERE workspace_id=? AND kind='connection' AND json_extract(body,'$.resourceKey')=?)" : '';
    const nativeParams = claimAccount ? [env.WORKSPACE_ID, claimAccount] : [];
    const serialized = JSON.stringify(next.state);
    if (new TextEncoder().encode(serialized).length > 1_500_000) throw new HubError('storage_limit', '工作区元数据达到本版容量边界；请导出并归档任务，未删除任何数据', 413);
    const mutationId = crypto.randomUUID();
    const first = revision === -1
      ? env.DB.prepare('INSERT OR IGNORE INTO hub_workspace (id, revision, mutation_id, body, updated_at) VALUES (?, ?, ?, ?, ?)').bind(env.WORKSPACE_ID, 0, mutationId, serialized, new Date().toISOString())
      : env.DB.prepare('UPDATE hub_workspace SET revision = ?, mutation_id = ?, body = ?, updated_at = ? WHERE id = ? AND revision = ?' + nativeGuard).bind(revision + 1, mutationId, serialized, new Date().toISOString(), env.WORKSPACE_ID, revision, ...nativeParams);
    const statements = [first,
      ...next.events.map((event: { id: string; at: string }) => env.DB.prepare('INSERT OR IGNORE INTO hub_events (id, workspace_id, at, body) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM hub_workspace WHERE id = ? AND mutation_id = ?)').bind(event.id, env.WORKSPACE_ID, event.at, JSON.stringify(event), env.WORKSPACE_ID, mutationId)),
      ...next.blobs.map((blob: { id: string; body: string }) => env.DB.prepare('INSERT OR IGNORE INTO hub_artifacts (id, workspace_id, body, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM hub_workspace WHERE id = ? AND mutation_id = ?)').bind(blob.id, env.WORKSPACE_ID, blob.body, new Date().toISOString(), env.WORKSPACE_ID, mutationId)),
    ];
    const results = await env.DB.batch(statements);
    if (results[0].meta.changes === 1) return next;
    if (claimAccount && await env.DB.prepare("SELECT 1 AS found FROM hub_v2_records WHERE workspace_id=? AND kind='connection' AND json_extract(body,'$.resourceKey')=?").bind(env.WORKSPACE_ID, claimAccount).first()) throw new HubError('native_channel_active', '账号已启用项目协作通道，不再通过旧版浏览器派发', 409);
  }
  throw new HubError('conflict', '有其他成员正在更新，请重试此操作', 409);
}

export async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export async function sameSecret(a: string, b: string) {
  const left = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a)));
  const right = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b)));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function artifactBody(env: Env, id: string) {
  const record = await env.DB.prepare('SELECT body FROM hub_artifacts WHERE workspace_id = ? AND id = ?').bind(env.WORKSPACE_ID, id).first<{ body: string }>();
  if (!record) throw new HubError('not_found', '成果不存在', 404);
  return record.body;
}
