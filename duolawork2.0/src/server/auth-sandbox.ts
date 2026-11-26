import { randomBytes } from 'node:crypto';
import type { DuolaWorkDatabase } from './db.js';
import type { ScopedTurnClaims, ToolPolicy } from '../shared/types.js';

export class SandboxForbiddenError extends Error {
  public readonly statusCode = 403;
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SandboxForbiddenError';
    this.code = code;
  }
}

const DUOLABASE_READONLY_META_TOOLS = new Set([
  'system_info',
  'vault_usage_guide',
  'vault_list',
  'connector_list',
  'connector_discover',
  'connector_check',
  'memory_usage_guide',
  'memory_recall',
  'experience_suggest',
  'experience_read',
  'skill_list',
  'skill_read'
]);

const DUOLABASE_FORBIDDEN_SECRET_TOOLS = new Set([
  'vault_reveal',
  'vault_save',
  'vault_lifecycle',
  'connector_save',
  'connector_import',
  'memory_forget'
]);

const READONLY_CONNECTOR_TOOLS = new Set([
  'feishu_tenant_check',
  'feishu_doc_read',
  'feishu_chat_list',
  'gmail_profile',
  'gmail_list_messages',
  'gmail_get_message',
  'wechat_token_status',
  'wechat_draft_list',
  'wechat_material_list',
  'notion-search',
  'notion-memory-search',
  'notion-fetch',
  'notion-get-tool-access',
  'search_cloudflare_documentation',
  'migrate_pages_to_workers_guide',
  'docs',
  'search',
  'whoami',
  'get_me',
  'get_file_contents',
  'get_commit',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'issue_read'
]);

export class AuthSandbox {
  constructor(private readonly db: DuolaWorkDatabase) {}

  public issueScopedToken(input: {
    principalKind: ScopedTurnClaims['principalKind'];
    memberId: string;
    attemptId: string;
    threadId: string;
    taskId?: string | null;
    runId?: string | null;
    stepId?: string | null;
    allowedArtifactIds?: string[];
    toolPolicy: ToolPolicy;
    ttlMs?: number;
  }): ScopedTurnClaims {
    const token = 'dw2_tok_' + randomBytes(24).toString('hex');
    const expiresAt = Date.now() + (input.ttlMs ?? 30 * 60 * 1000);
    const claims: ScopedTurnClaims = {
      token,
      principalKind: input.principalKind,
      memberId: input.memberId,
      attemptId: input.attemptId,
      threadId: input.threadId,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      allowedArtifactIds: input.allowedArtifactIds ?? [],
      toolPolicy: input.toolPolicy,
      expiresAt
    };

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_scoped_tokens (
          token, principal_kind, member_id, attempt_id, thread_id,
          task_id, run_id, step_id, allowed_artifact_ids_json,
          tool_policy, expires_at, revoked, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        claims.token,
        claims.principalKind,
        claims.memberId,
        claims.attemptId,
        claims.threadId,
        claims.taskId,
        claims.runId,
        claims.stepId,
        JSON.stringify(claims.allowedArtifactIds),
        claims.toolPolicy,
        claims.expiresAt,
        new Date().toISOString()
      );

    return claims;
  }

  public verifyToken(token: string | undefined | null): ScopedTurnClaims {
    if (!token || !token.startsWith('dw2_tok_')) {
      throw new SandboxForbiddenError('invalid_scoped_token', '缺少有效的受管会话执行令牌');
    }
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_scoped_tokens WHERE token = ?`)
      .get(token) as Record<string, unknown> | undefined;
    if (!row || Number(row.revoked) !== 0) {
      throw new SandboxForbiddenError('revoked_scoped_token', '执行令牌不存在或已失效');
    }
    if (Number(row.expires_at) < Date.now()) {
      throw new SandboxForbiddenError('expired_scoped_token', '执行令牌已过期');
    }
    return {
      token: String(row.token),
      principalKind: row.principal_kind as ScopedTurnClaims['principalKind'],
      memberId: String(row.member_id),
      attemptId: String(row.attempt_id),
      threadId: String(row.thread_id),
      taskId: row.task_id ? String(row.task_id) : null,
      runId: row.run_id ? String(row.run_id) : null,
      stepId: row.step_id ? String(row.step_id) : null,
      allowedArtifactIds: JSON.parse(String(row.allowed_artifact_ids_json)) as string[],
      toolPolicy: row.tool_policy as ToolPolicy,
      expiresAt: Number(row.expires_at)
    };
  }

  public revokeToken(token: string): void {
    this.db.sqlite.prepare(`UPDATE v2_scoped_tokens SET revoked = 1 WHERE token = ?`).run(token);
  }

  public assertLeadPermission(
    claims: ScopedTurnClaims,
    expectedTaskId?: string,
    expectedRunId?: string
  ): void {
    if (claims.principalKind === 'task_worker') {
      throw new SandboxForbiddenError(
        'worker_cannot_act_as_lead',
        '任务执行人无权调用建单、派单、验收或结单接口'
      );
    }
    if (expectedTaskId && claims.principalKind === 'task_lead' && claims.taskId !== expectedTaskId) {
      throw new SandboxForbiddenError(
        'cross_task_lead_forbidden',
        '当前负责人令牌仅绑定指定任务，禁止跨任务操作'
      );
    }
    if (expectedRunId && claims.principalKind === 'task_lead' && claims.runId && claims.runId !== expectedRunId) {
      throw new SandboxForbiddenError(
        'cross_run_lead_forbidden',
        '当前负责人令牌仅绑定当期运行实例，禁止跨期次操作'
      );
    }
  }

  public assertWorkerStepPermission(claims: ScopedTurnClaims, runId: string, stepId: string): void {
    if (claims.principalKind !== 'task_worker') {
      throw new SandboxForbiddenError('not_task_worker', '仅当前步骤受派执行人可提交步骤成果');
    }
    if (claims.runId !== runId || claims.stepId !== stepId) {
      throw new SandboxForbiddenError(
        'cross_step_access_forbidden',
        '执行人禁止读取或提交其他任务步骤的内容'
      );
    }
  }

  public assertArtifactPermission(
    claims: ScopedTurnClaims,
    artifact: { id: string; sourceThreadId: string; taskId: string | null },
    mode: 'read' | 'write'
  ): void {
    if (claims.allowedArtifactIds.includes(artifact.id)) {
      return;
    }
    if (claims.principalKind === 'thread_owner' && artifact.sourceThreadId === claims.threadId) {
      return;
    }
    if (claims.principalKind === 'task_lead' && (artifact.taskId === claims.taskId || artifact.sourceThreadId === claims.threadId)) {
      return;
    }
    throw new SandboxForbiddenError(
      mode === 'write' ? 'cross_task_artifact_write_forbidden' : 'cross_task_artifact_read_forbidden',
      `当前会话无权${mode === 'write' ? '修改' : '读取'}未授权的其他任务或对话文稿 (${artifact.id})`
    );
  }

  /**
   * Enforces server-side DuolaBase MCP access policy per ExecutionPrincipal & global switch.
   */
  public assertExternalToolAllowed(
    claims: ScopedTurnClaims,
    mcpToolName: string,
    args: Record<string, unknown> = {}
  ): void {
    const duolabaseSetting = this.db.getSetting<{ enabled: boolean; endpoint: string }>('duolabase', {
      enabled: true,
      endpoint: 'https://duolabase.manyaitool.com/mcp'
    });
    if (!duolabaseSetting.enabled) {
      throw new SandboxForbiddenError(
        'external_connectors_disabled',
        '外部连接器开关已关闭，本轮仅允许使用工作台本地能力'
      );
    }
    if (claims.toolPolicy === 'none') {
      throw new SandboxForbiddenError('tool_policy_none', '当前步骤未开放外部连接器访问权限');
    }
    if (DUOLABASE_FORBIDDEN_SECRET_TOOLS.has(mcpToolName)) {
      throw new SandboxForbiddenError(
        'secret_reveal_or_mutation_forbidden',
        `受管执行会话禁止调用高危密钥或资产管理接口: ${mcpToolName}`
      );
    }

    if (claims.toolPolicy === 'duolabase_readonly') {
      if (DUOLABASE_READONLY_META_TOOLS.has(mcpToolName)) {
        return;
      }
      if (mcpToolName === 'connector_call') {
        const innerTool = String(args.toolName ?? args.tool ?? '');
        if (READONLY_CONNECTOR_TOOLS.has(innerTool)) {
          return;
        }
        throw new SandboxForbiddenError(
          'external_write_forbidden',
          `当前执行人处于只读连接器策略，禁止调用外部写操作或未授权工具: ${innerTool || 'unknown'}`
        );
      }
      if (mcpToolName === 'vault_http_proxy') {
        const method = String(args.method ?? 'GET').trim().toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
          return;
        }
        throw new SandboxForbiddenError(
          'external_write_forbidden',
          `当前执行人处于只读连接器策略，禁止通过凭证代理发送 ${method} 写请求`
        );
      }
      throw new SandboxForbiddenError(
        'external_write_forbidden',
        `当前执行人处于只读策略，禁止调用非只读 MCP 工具: ${mcpToolName}`
      );
    }
  }
}
