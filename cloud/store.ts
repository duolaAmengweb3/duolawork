import { initialState, reduce, HubError } from '../shared/domain.mjs';

export async function load(env: Env) {
  const row = await env.DB.prepare('SELECT revision, body FROM hub_workspace WHERE id = ?').bind(env.WORKSPACE_ID).first<{ revision: number; body: string }>();
  return row ? { state: JSON.parse(row.body), revision: row.revision } : { state: initialState(), revision: -1 };
}

const memberBusySQL = "SELECT 1 FROM hub_v2_records WHERE workspace_id=? AND ((kind='channel_turn' AND parent_id=? AND status='active') OR (kind IN ('step','resource') AND json_extract(body,'$.memberId')=? AND status IN ('running','busy')))";

// Called inside the same D1 batch as the workspace CAS. No account/profile,
// message or document is deleted, and every statement is guarded by that CAS.
function disconnectStatements(env: Env, memberId: string, mutationId: string) {
  const now = new Date().toISOString();
  const guard = "EXISTS (SELECT 1 FROM hub_workspace WHERE id=? AND mutation_id=?)";
  const update = (where: string, params: string[], status: string, extra = '') => env.DB.prepare(
    `UPDATE hub_v2_records SET status=?,revision=revision+1,updated_at=?,body=json_set(${extra || 'body'},'$.status',?,'$.revision',revision+1,'$.updatedAt',?) WHERE workspace_id=? AND ${where} AND ${guard}`
  ).bind(status,now,status,now,env.WORKSPACE_ID,...params,env.WORKSPACE_ID,mutationId);
  return [
    update("kind='connection' AND id=?", [memberId], 'disconnected', "json_remove(body,'$.credentials','$.configHash','$.verifiedAt','$.toolSeenAt','$.authSeenAt','$.setup')"),
    update("kind IN ('member_auth','oauth_refresh','oauth_code','pairing','skill_grant') AND (json_extract(body,'$.memberId')=? OR parent_id=?)", [memberId,memberId], 'revoked'),
    update("kind='subscription' AND parent_id=?", [memberId], 'revoked'),
    update("kind='run' AND scope_id=? AND status IN ('running','needs_review')", ['probe_'+memberId], 'canceled'),
    update("kind='step' AND scope_id=? AND status='ready'", ['probe_'+memberId], 'canceled'),
    update("kind='outbox' AND json_extract(body,'$.memberId')=? AND status IN ('pending','retry','waiting_subscription','accepted','sending','coalesced','awaiting_poll')", [memberId], 'canceled'),
    update("kind='channel_turn' AND parent_id=? AND status IN ('ready','stalled','limited','unavailable')", [memberId], 'removed'),
    update("kind='channel_wait' AND parent_id=? AND status='waiting'", [memberId], 'finished'),
    env.DB.prepare(`UPDATE hub_v2_records SET revision=revision+1,updated_at=?,status=CASE WHEN json_extract(body,'$.direct')=1 THEN 'archived' ELSE status END,body=json_set(body,'$.memberIds',json((SELECT json_group_array(value) FROM json_each(body,'$.memberIds') WHERE value<>?)),'$.coordinatorId',CASE WHEN json_extract(body,'$.coordinatorId')=? THEN NULL ELSE json_extract(body,'$.coordinatorId') END,'$.status',CASE WHEN json_extract(body,'$.direct')=1 THEN 'archived' ELSE status END,'$.revision',revision+1,'$.updatedAt',?) WHERE workspace_id=? AND kind='channel' AND EXISTS(SELECT 1 FROM json_each(body,'$.memberIds') WHERE value=?) AND ${guard}`)
      .bind(now,memberId,memberId,now,env.WORKSPACE_ID,memberId,env.WORKSPACE_ID,mutationId),
    // Invalidate the repository's existing query-range clocks as well as rows,
    // so an in-flight read cannot commit a stale member/group snapshot.
    env.DB.prepare(`UPDATE hub_v2_clock SET revision=revision+1,mutation_id=? WHERE (workspace_id=? OR json_extract(CASE WHEN json_valid(workspace_id) THEN workspace_id ELSE '[]' END,'$[0]')=?) AND ${guard}`)
      .bind(mutationId,env.WORKSPACE_ID,env.WORKSPACE_ID,env.WORKSPACE_ID,mutationId),
  ];
}

export async function mutate(env: Env, action: Record<string, unknown>) {
  for (let i = 0; i < 6; i++) {
    const { state: before, revision } = await load(env);
    const next = reduce(before, action);
    const claimAccount = action.type === 'step.claim' ? next.result.accountId : null;
    const disconnectMember = action.type === 'member.disconnect' ? String(action.memberId) : null;
    const delegationGuard = action.delegationVersion ? " AND EXISTS (SELECT 1 FROM hub_v2_records WHERE workspace_id=? AND kind='workspace_secretary' AND id='current' AND status='active' AND json_extract(body,'$.memberId')=? AND json_extract(body,'$.version')=?)" : '';
    const nativeGuard = (claimAccount ? " AND NOT EXISTS (SELECT 1 FROM hub_v2_records WHERE workspace_id=? AND kind='connection' AND json_extract(body,'$.resourceKey')=?)" : '') + (disconnectMember ? ` AND NOT EXISTS (${memberBusySQL})` : '');
    const nativeParams = [...(claimAccount ? [env.WORKSPACE_ID, claimAccount] : []), ...(disconnectMember ? [env.WORKSPACE_ID,disconnectMember,disconnectMember] : [])];
    const serialized = JSON.stringify(next.state);
    if(action.delegationVersion){nativeParams.push(env.WORKSPACE_ID,String(action.actorMemberId),action.delegationVersion);}
    if (new TextEncoder().encode(serialized).length > 1_500_000) throw new HubError('storage_limit', '工作区元数据达到本版容量边界；请导出并归档任务，未删除任何数据', 413);
    const mutationId = crypto.randomUUID();
    const first = revision === -1
      ? env.DB.prepare('INSERT OR IGNORE INTO hub_workspace (id, revision, mutation_id, body, updated_at) VALUES (?, ?, ?, ?, ?)').bind(env.WORKSPACE_ID, 0, mutationId, serialized, new Date().toISOString())
      : env.DB.prepare('UPDATE hub_workspace SET revision = ?, mutation_id = ?, body = ?, updated_at = ? WHERE id = ? AND revision = ?' + nativeGuard + delegationGuard).bind(revision + 1, mutationId, serialized, new Date().toISOString(), env.WORKSPACE_ID, revision, ...nativeParams);
    const statements = [first,
      ...next.events.map((event: { id: string; at: string }) => env.DB.prepare('INSERT OR IGNORE INTO hub_events (id, workspace_id, at, body) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM hub_workspace WHERE id = ? AND mutation_id = ?)').bind(event.id, env.WORKSPACE_ID, event.at, JSON.stringify(event), env.WORKSPACE_ID, mutationId)),
      ...next.blobs.map((blob: { id: string; body: string }) => env.DB.prepare('INSERT OR IGNORE INTO hub_artifacts (id, workspace_id, body, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM hub_workspace WHERE id = ? AND mutation_id = ?)').bind(blob.id, env.WORKSPACE_ID, blob.body, new Date().toISOString(), env.WORKSPACE_ID, mutationId)),
      ...(disconnectMember ? disconnectStatements(env, disconnectMember, mutationId) : []),
    ];
    const results = await env.DB.batch(statements);
    if (results[0].meta.changes === 1) return next;
    if (disconnectMember && await env.DB.prepare(memberBusySQL).bind(env.WORKSPACE_ID,disconnectMember,disconnectMember).first()) throw new HubError('member_busy', '此成员正在回复，请等它完成后再解除连接', 409);
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
