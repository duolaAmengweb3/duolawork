import { randomBytes, randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { CloudAuthManager } from './auth.js';
import { sha256Hex } from './auth.js';
import type { DuolaWorkDatabase } from './db.js';
import { emptyUnobservableUsage, redactSecrets, type EnsuredSession, type ReconcileResult, type SessionBindingInput, type TurnDispatchInput, type TurnExecutionResult, type TurnStreamEvent } from './drivers/types.js';
import {
  isExcludedClaudeVps,
  turnPhases,
  type ExecutionNodeRecord,
  type MemberCapabilities,
  type MemberRecord,
  type ProviderUsageMetrics,
  type WorkspaceFileEntry
} from '../shared/types.js';

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveNodeTurn {
  nodeId: string;
  attemptId: string;
  onEvent?: (ev: TurnStreamEvent) => void;
  disconnected?: boolean;
  toolReceipts: Map<string, Promise<Record<string, unknown>>>;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  resolve: (res: TurnExecutionResult) => void;
  reject: (err: Error) => void;
}

interface LiveNodeSocket {
  resumesToolCalls?: boolean;
  nodeId: string;
  ws: WebSocket;
  lastPongAt: number;
}

export interface NodeHelloMember {
  id: string;
  name: string;
  platformId: string;
  localDriverKind: 'codex-app-server' | 'claude-cli' | 'acp-stdio' | 'mock';
  capabilities?: Partial<MemberCapabilities>;
  status?: MemberRecord['status'];
  statusMessage?: string;
  config?: Record<string, unknown>;
}

export class ExecutionNodeHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
  private readonly liveSockets = new Map<string, LiveNodeSocket>();
  private readonly pendingRpcs = new Map<string, PendingRpc>();
  private readonly activeTurns = new Map<string, ActiveNodeTurn>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public onNodesChanged?: (nodes: ExecutionNodeRecord[]) => void;
  public onMembersChanged?: () => void;
  public onReplayedAttemptResult?: (payload: {
    attemptId: string;
    ok: boolean;
    text?: string;
    nativeSessionId?: string | null;
    nativeTurnId?: string | null;
    providerUsage?: ProviderUsageMetrics;
    errorMessage?: string;
  }) => void;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly auth: CloudAuthManager
  ) {}

  public attachToServer(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/v2/nodes/ws') return;
      this.handleUpgrade(req, socket, head);
    });

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const [nodeId, live] of this.liveSockets.entries()) {
          if (now - live.lastPongAt > 45_000) {
            try {
              live.ws.terminate();
            } catch {
              // ignore
            }
            this.handleDisconnect(nodeId, live.ws);
            continue;
          }
          if (live.ws.readyState === WebSocket.OPEN) {
            this.sendFrame(live.ws, { type: 'node.ping', ts: now });
          }
        }
      }, 15_000);
      this.heartbeatTimer.unref?.();
    }
  }

  public close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(new Error('NODE_HUB_CLOSED'));
    }
    this.pendingRpcs.clear();
    for (const [, turn] of this.activeTurns) {
      turn.reject(new Error('SHUTDOWN'));
    }
    this.activeTurns.clear();
    for (const [, live] of this.liveSockets) {
      try {
        live.ws.close();
      } catch {
        // ignore
      }
    }
    this.liveSockets.clear();
    this.wss.close();
  }

  public createPairingCode(input?: { name?: string; kind?: 'cloud' | 'local' }): {
    code: string;
    expiresAt: string;
  } {
    return this.auth.createMagicCode('node_pair', {
      suggestedName: input?.name?.trim() || undefined,
      kind: input?.kind === 'cloud' ? 'cloud' : 'local'
    });
  }

  public pairNode(input: {
    code: string;
    ip?: string;
    name?: string;
    kind?: 'cloud' | 'local';
    platform?: string;
    appVersion?: string;
    capabilities?: ExecutionNodeRecord['capabilities'];
  }): { node: ExecutionNodeRecord; nodeToken: string } {
    const payload = this.auth.consumeMagicCode('node_pair', input.code, input.ip || 'unknown');
    if (!payload) {
      const err = new Error('节点配对码无效或已过期');
      (err as any).statusCode = 401;
      throw err;
    }

    const kind: 'cloud' | 'local' =
      input.kind === 'cloud' || payload.kind === 'cloud' ? 'cloud' : 'local';
    const nodeId = `node_${kind}_${randomUUID().slice(0, 10)}`;
    const rawToken = `dwn_${randomBytes(32).toString('base64url')}`;
    const tokenHash = sha256Hex(rawToken);
    const now = new Date().toISOString();
    const name =
      String(input.name || payload.suggestedName || (kind === 'cloud' ? '云端执行节点' : '本地执行节点')).trim();
    const caps: ExecutionNodeRecord['capabilities'] = {
      drivers: Array.isArray(input.capabilities?.drivers) ? input.capabilities!.drivers : [],
      allowWorkspaceBrowse: Boolean(input.capabilities?.allowWorkspaceBrowse),
      allowedWorkspaceRoots: Array.isArray(input.capabilities?.allowedWorkspaceRoots)
        ? input.capabilities!.allowedWorkspaceRoots
        : []
    };

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_nodes (
          id, name, kind, platform, token_hash, status, capabilities_json,
          last_heartbeat_at, app_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'offline', ?, NULL, ?, ?, ?)`
      )
      .run(
        nodeId,
        name,
        kind,
        String(input.platform || 'unknown'),
        tokenHash,
        JSON.stringify(caps),
        input.appVersion ? String(input.appVersion) : null,
        now,
        now
      );

    const node = this.getNode(nodeId)!;
    this.onNodesChanged?.(this.listNodes());
    return { node, nodeToken: rawToken };
  }

  public getNode(nodeId: string): ExecutionNodeRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_nodes WHERE id = ?`)
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapNodeRow(row);
  }

  public listNodes(): ExecutionNodeRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_nodes ORDER BY kind ASC, created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapNodeRow(r));
  }

  public isNodeOnline(nodeId: string | null | undefined): boolean {
    if (!nodeId) return false;
    const live = this.liveSockets.get(nodeId);
    return Boolean(live && live.ws.readyState === WebSocket.OPEN);
  }

  public revokeNode(nodeId: string): boolean {
    for (const [id, turn] of this.activeTurns) {
      if (turn.nodeId !== nodeId) continue;
      this.activeTurns.delete(id);
      turn.reject(new Error('执行节点已移除'));
    }
    const live = this.liveSockets.get(nodeId);
    if (live) {
      try {
        live.ws.close(4001, 'Node revoked');
      } catch {
        // ignore
      }
      this.liveSockets.delete(nodeId);
    }
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(
        `UPDATE v2_members
         SET status = 'offline', status_message = '所属执行节点已移除', updated_at = ?
         WHERE node_id = ?`
      )
      .run(now, nodeId);
    const res = this.db.sqlite.prepare(`DELETE FROM v2_nodes WHERE id = ?`).run(nodeId);
    this.onNodesChanged?.(this.listNodes());
    this.onMembersChanged?.();
    return Number(res.changes || 0) > 0;
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const authHeader = String(req.headers.authorization || '').trim();
    const rawToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : url.searchParams.get('token')?.trim() || '';

    if (!rawToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const tokenHash = sha256Hex(rawToken);
    const row = this.db.sqlite
      .prepare(`SELECT id FROM v2_nodes WHERE token_hash = ?`)
      .get(tokenHash) as { id: string } | undefined;

    if (!row) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const nodeId = String(row.id);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.registerConnection(nodeId, ws);
    });
  }

  private registerConnection(nodeId: string, ws: WebSocket): void {
    const prev = this.liveSockets.get(nodeId);
    if (prev && prev.ws !== ws) {
      try {
        prev.ws.close(4000, 'Replaced by newer connection');
      } catch {
        // ignore
      }
    }

    const nowIso = new Date().toISOString();
    this.liveSockets.set(nodeId, { nodeId, ws, lastPongAt: Date.now() });
    this.db.sqlite
      .prepare(`UPDATE v2_nodes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso, nowIso, nodeId);

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      void this.handleNodeFrame(nodeId, ws, msg).catch(() => {});
    });

    ws.on('close', () => {
      this.handleDisconnect(nodeId, ws);
    });

    ws.on('error', () => {
      this.handleDisconnect(nodeId, ws);
    });

    this.onNodesChanged?.(this.listNodes());
  }

  private handleDisconnect(nodeId: string, ws: WebSocket): void {
    const current = this.liveSockets.get(nodeId);
    if (!current || current.ws !== ws) return;
    this.liveSockets.delete(nodeId);

    const nowIso = new Date().toISOString();
    try {
      this.db.sqlite
        .prepare(`UPDATE v2_nodes SET status = 'offline', updated_at = ? WHERE id = ?`)
        .run(nowIso, nodeId);
      this.db.sqlite
        .prepare(
          `UPDATE v2_members
           SET status = 'offline', status_message = '所属执行节点离线', updated_at = ?
           WHERE node_id = ? AND driver_kind = 'remote-node' AND status != 'auth_required'`
        )
        .run(nowIso, nodeId);
    } catch {
      // ignore if DB already closed during shutdown
    }

    for (const turn of this.activeTurns.values()) {
      if (turn.nodeId === nodeId) {
        turn.disconnected = true;
        turn.onEvent?.({ kind: 'activity', phase: 'reconnecting' });
      }
    }

    this.onNodesChanged?.(this.listNodes());
    this.onMembersChanged?.();
  }

  private async handleNodeFrame(nodeId: string, ws: WebSocket, msg: any): Promise<void> {
    const type = String(msg?.type || '');
    const live = this.liveSockets.get(nodeId);
    if (live?.ws !== ws) return;
    live.lastPongAt = Date.now();

    if (type === 'node.ping') {
      this.db.sqlite
        .prepare(`UPDATE v2_nodes SET last_heartbeat_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), nodeId);
      this.sendFrame(ws, { type: 'node.pong', ts: msg.ts ?? Date.now() });
      return;
    }

    if (type === 'node.pong') {
      this.db.sqlite
        .prepare(`UPDATE v2_nodes SET last_heartbeat_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), nodeId);
      return;
    }

    if (type === 'node.hello') {
      const now = new Date().toISOString();
      const node = this.getNode(nodeId);
      const nextCaps = {
        drivers: Array.isArray(msg.drivers) ? msg.drivers.map(String) : node?.capabilities.drivers ?? [],
        allowWorkspaceBrowse: Boolean(msg.allowWorkspaceBrowse ?? node?.capabilities.allowWorkspaceBrowse),
        allowedWorkspaceRoots: Array.isArray(msg.allowedWorkspaceRoots)
          ? msg.allowedWorkspaceRoots.map(String)
          : node?.capabilities.allowedWorkspaceRoots ?? []
      };
      this.db.sqlite
        .prepare(
          `UPDATE v2_nodes
           SET name = COALESCE(?, name),
               platform = COALESCE(?, platform),
               app_version = COALESCE(?, app_version),
               capabilities_json = ?,
               status = 'online',
               last_heartbeat_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : null,
          typeof msg.platform === 'string' && msg.platform.trim() ? msg.platform.trim() : null,
          typeof msg.version === 'string' && msg.version.trim() ? msg.version.trim() : null,
          JSON.stringify(nextCaps),
          now,
          now,
          nodeId
        );

      const members = Array.isArray(msg.members) ? (msg.members as NodeHelloMember[]) : [];
      const nodeKind = node?.kind === 'cloud' ? 'cloud-node' : 'local-node';
      for (const m of members) {
        if (!m?.id || !m?.name) continue;
        if (isExcludedClaudeVps({ id: m.id, name: m.name, platformId: m.platformId, driverKind: 'remote-node', location: nodeKind })) {
          continue;
        }
        const existing = this.db.getMember(m.id);
        // A hello advertises configured members. Only a checked login or a new
        // successful turn clears a credential failure for the same node.
        const keepAuthFailure = existing?.nodeId === nodeId && existing.status === 'auth_required';
        this.db.upsertMember({
          id: m.id,
          name: m.name,
          platformId: m.platformId || 'custom',
          driverKind: 'remote-node',
          location: nodeKind,
          nodeId,
          capabilities: {
            supportsIsolatedSessions: m.capabilities?.supportsIsolatedSessions ?? true,
            supportsSessionResume: m.capabilities?.supportsSessionResume ?? true,
            supportsCancel: m.capabilities?.supportsCancel ?? true,
            maxConcurrentRuns: m.capabilities?.maxConcurrentRuns ?? 2
          },
          status: keepAuthFailure ? 'auth_required' : m.status ?? 'ready',
          statusMessage: keepAuthFailure ? existing.statusMessage : m.statusMessage || `在线 (${node?.name || nodeId})`,
          config: {
            ...(existing?.config ?? {}),
            ...(m.config ?? {}),
            localDriverKind: m.localDriverKind || 'acp-stdio'
          }
        });
      }

      live.resumesToolCalls = msg.resumesToolCalls === true;
      this.sendFrame(ws, { type: 'node.welcome', nodeId, serverTime: now, resumesToolCalls: true });
      for (const turn of this.activeTurns.values()) {
        if (turn.nodeId !== nodeId || !turn.disconnected) continue;
        turn.disconnected = false;
        // A restarted runner may have lost the native process. A live one resumes its original callbacks.
        void this.reconcileAttempt(nodeId, turn.attemptId).then(receipt => {
          if (this.activeTurns.get(turn.attemptId) !== turn || this.liveSockets.get(nodeId)?.ws !== ws) return;
          if (receipt.state === 'not_found' || receipt.state === 'failed') {
            this.activeTurns.delete(turn.attemptId);
            turn.reject(new Error(receipt.errorMessage || '执行节点重启，本轮处理已中断'));
          } else if (receipt.state === 'still_running') {
            turn.onEvent?.({ kind: 'activity', phase: 'processing' });
          }
          // Completed receipts also arrive through the runner's durable outbox.
        }).catch(() => {});
      }
      if (Array.isArray(msg.activeAttempts)) {
        for (const id of msg.activeAttempts) {
          const stopped = this.db.sqlite.prepare(
            `SELECT 1 FROM v2_dispatch_attempts a JOIN v2_members m ON m.id=a.member_id
             WHERE a.id=? AND m.node_id=? AND a.status IN ('failed','timed_out','late_ignored')
             AND (a.target_kind <> 'thread_message' OR EXISTS (SELECT 1 FROM v2_thread_messages msg
               WHERE msg.id=a.target_id AND msg.turn_status='canceled'))`
          ).get(String(id), nodeId);
          if (stopped) this.sendFrame(ws, { type: 'turn.abort', attemptId: id });
        }
      }
      this.onNodesChanged?.(this.listNodes());
      this.onMembersChanged?.();
      return;
    }

    if (type === 'rpc.result') {
      const reqId = String(msg.reqId || '');
      const pending = this.pendingRpcs.get(reqId);
      if (!pending) return;
      this.pendingRpcs.delete(reqId);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(redactSecrets(String(msg.error || '节点调用失败'))));
      }
      return;
    }

    if (type === 'turn.started') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId !== nodeId) return;
      turn.onEvent?.({
        kind: 'dispatched_meta',
        nativeTurnId: msg.nativeTurnId ? String(msg.nativeTurnId) : undefined
      });
      turn?.onEvent?.({ kind: 'started' });
      return;
    }

    if (type === 'turn.progress') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId === nodeId) turn.onEvent?.({ kind: 'progress' });
      return;
    }
    if (type === 'turn.activity') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId === nodeId && turnPhases.includes(msg.phase)) {
        turn.onEvent?.({ kind: 'activity', phase: msg.phase });
      }
      return;
    }

    if (type === 'turn.delta') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId === nodeId && typeof msg.text === 'string' && msg.text) {
        turn.onEvent?.({ kind: 'delta', text: msg.text });
      }
      return;
    }

    if (type === 'turn.tool_trace') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId === nodeId && msg.name) {
        turn.onEvent?.({
          kind: 'tool',
          toolId: msg.toolId ? String(msg.toolId) : undefined,
          toolName: String(msg.name),
          toolSummary: msg.summary ? String(msg.summary) : undefined,
          toolStatus: msg.status === 'done' || msg.status === 'error' ? msg.status : 'running'
        });
      }
      return;
    }

    if (type === 'turn.tool_ack') {
      const turn = this.activeTurns.get(String(msg.attemptId || ''));
      if (turn?.nodeId === nodeId) turn.toolReceipts.delete(String(msg.callId));
      return;
    }
    if (type === 'turn.tool_call') {
      const callId = String(msg.callId || '');
      const attemptId = String(msg.attemptId || '');
      const turn = this.activeTurns.get(attemptId);
      if (!callId || !turn?.onToolCall || turn.nodeId !== nodeId) {
        this.sendFrame(ws, { type: 'turn.tool_result', callId, ok: false, error: '原执行连接已结束，请先核对已保存的进度' });
        return;
      }
      let receipt = turn.toolReceipts.get(callId);
      if (!receipt) {
        receipt = turn.onToolCall(String(msg.toolName || ''), msg.args ?? {})
          .then(result => ({ ok: true, result }), err => ({ ok: false, error: redactSecrets(err.message || '工具执行被拒绝') }));
        if (live.resumesToolCalls) turn.toolReceipts.set(callId, receipt);
      }
      const result = await receipt;
      if (this.liveSockets.get(nodeId)?.ws === ws) this.sendFrame(ws, { type: 'turn.tool_result', callId, ...result });
      return;
    }

    if (type === 'turn.completed' || type === 'turn.failed') {
      const attemptId = String(msg.attemptId || '');
      const turn = this.activeTurns.get(attemptId);
      if (turn && turn.nodeId !== nodeId) return;
      if (!turn && !this.db.sqlite.prepare(
        `SELECT 1 FROM v2_dispatch_attempts a JOIN v2_members m ON m.id=a.member_id
         WHERE a.id=? AND COALESCE(m.node_id, json_extract(m.config_json, '$.nodeId'))=?`
      ).get(attemptId, nodeId)) return;
    }

    if (type === 'turn.completed') {
      const attemptId = String(msg.attemptId || '');
      const turn = this.activeTurns.get(attemptId);
      const usage: ProviderUsageMetrics = msg.providerUsage ?? emptyUnobservableUsage();
      if (turn) {
        const recovered = this.db.sqlite.prepare(
          `UPDATE v2_members SET status = 'ready', status_message = '成员已实际回传结果', updated_at = ?
           WHERE node_id = ? AND status = 'auth_required' AND EXISTS (
             SELECT 1 FROM v2_dispatch_attempts a WHERE a.id = ? AND a.member_id = v2_members.id
             AND a.dispatched_at >= v2_members.updated_at
           )`
        ).run(new Date().toISOString(), nodeId, attemptId);
        if (recovered.changes) this.onMembersChanged?.();
        this.activeTurns.delete(attemptId);
        turn.resolve({
          text: String(msg.text ?? ''),
          nativeSessionId: String(msg.nativeSessionId || ''),
          nativeTurnId: msg.nativeTurnId ? String(msg.nativeTurnId) : null,
          sessionReset: Boolean(msg.sessionReset),
          providerUsage: usage
        });
      } else if (attemptId) {
        // Replayed completion after reconnect / cloud restart!
        this.onReplayedAttemptResult?.({
          attemptId,
          ok: true,
          text: String(msg.text ?? ''),
          nativeSessionId: msg.nativeSessionId ? String(msg.nativeSessionId) : null,
          nativeTurnId: msg.nativeTurnId ? String(msg.nativeTurnId) : null,
          providerUsage: usage
        });
      }
      if (attemptId) {
        this.sendFrame(ws, { type: 'turn.ack', attemptId });
      }
      return;
    }

    if (type === 'turn.failed') {
      const attemptId = String(msg.attemptId || '');
      const errText = redactSecrets(String(msg.errorMessage || '节点执行失败'));
      if (/OAuth token revoked|Failed to authenticate|Please log in again/i.test(errText) && attemptId) {
        try {
          const attRow = this.db.sqlite
            .prepare(`SELECT member_id FROM v2_dispatch_attempts WHERE id = ?`)
            .get(attemptId) as { member_id?: string } | undefined;
          if (attRow?.member_id) {
            this.db.sqlite
              .prepare(
                `UPDATE v2_members
                 SET status = 'auth_required', status_message = '登录凭证已失效，请在所在节点重新登录授权', updated_at = ?
                 WHERE id = ?`
              )
              .run(new Date().toISOString(), attRow.member_id);
            this.onMembersChanged?.();
          }
        } catch {
          // ignore
        }
      }
      const turn = this.activeTurns.get(attemptId);
      if (turn) {
        this.activeTurns.delete(attemptId);
        turn.reject(new Error(errText));
      } else if (attemptId) {
        this.onReplayedAttemptResult?.({
          attemptId,
          ok: false,
          errorMessage: errText
        });
      }
      if (attemptId) {
        this.sendFrame(ws, { type: 'turn.ack', attemptId });
      }
      return;
    }
  }

  private sendRpc<T = any>(nodeId: string, type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const live = this.liveSockets.get(nodeId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) {
      const node = this.getNode(nodeId);
      const label = node?.name || nodeId;
      return Promise.reject(new Error(`NODE_OFFLINE: 执行节点「${label}」当前离线，请上线后重试或切换其他成员`));
    }
    const reqId = `rpc_${randomUUID().slice(0, 12)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(reqId);
        reject(new Error(`节点响应超时 (${type})`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpcs.set(reqId, { resolve, reject, timer });
      this.sendFrame(live.ws, { type, reqId, ...payload });
    });
  }

  public async ensureSession(nodeId: string, input: SessionBindingInput): Promise<EnsuredSession> {
    return this.sendRpc<EnsuredSession>(
      nodeId,
      'session.ensure',
      {
        member: {
          id: input.member.id,
          name: input.member.name,
          platformId: input.member.platformId,
          driverKind: input.member.config.localDriverKind || 'acp-stdio',
          location: 'local',
          capabilities: input.member.capabilities,
          status: input.member.status,
          statusMessage: input.member.statusMessage,
          config: input.member.config
        },
        scopeKey: input.scopeKey,
        cwd: input.cwd,
        existingNativeSessionId: input.existingNativeSessionId ?? null,
        existingBridgeMeta: input.existingBridgeMeta ?? null,
        dynamicTools: input.dynamicTools ?? [],
        mcpServers: input.mcpServers ?? []
      },
      45_000
    );
  }

  public runTurn(
    nodeId: string,
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    const live = this.liveSockets.get(nodeId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) {
      const node = this.getNode(nodeId);
      return Promise.reject(
        new Error(`NODE_OFFLINE: 执行节点「${node?.name || nodeId}」当前离线，请上线后重试或切换其他成员`)
      );
    }

    return new Promise<TurnExecutionResult>((resolve, reject) => {
      this.activeTurns.set(input.attemptId, {
        nodeId,
        attemptId: input.attemptId,
        toolReceipts: new Map(),
        onEvent,
        onToolCall: input.onToolCall,
        resolve,
        reject
      });

      this.sendFrame(live.ws, {
        type: 'turn.dispatch',
        attemptId: input.attemptId,
        member: {
          id: input.member.id,
          name: input.member.name,
          platformId: input.member.platformId,
          driverKind: input.member.config.localDriverKind || 'acp-stdio',
          location: 'local',
          capabilities: input.member.capabilities,
          status: input.member.status,
          statusMessage: input.member.statusMessage,
          config: input.member.config
        },
        scopeKey: input.scopeKey,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        bridgeMeta: input.bridgeMeta ?? null,
        prompt: input.prompt,
        fallbackFullPrompt: input.fallbackFullPrompt ?? null,
        timeoutMs: input.timeoutMs ?? 900_000,
        dynamicTools: input.dynamicTools ?? [],
        mcpServers: input.mcpServers ?? [],
        ...(input.images && input.images.length > 0 ? { images: input.images } : {})
      });
    });
  }

  public async abortTurn(nodeId: string, attemptId: string): Promise<boolean> {
    const active = this.activeTurns.get(attemptId);
    if (active?.nodeId === nodeId) {
      this.activeTurns.delete(attemptId);
      active.reject(new Error('ATTEMPT_CANCELED'));
    }
    const live = this.liveSockets.get(nodeId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) return false;
    this.sendFrame(live.ws, { type: 'turn.abort', attemptId });
    return true;
  }

  public async reconcileAttempt(nodeId: string, attemptId: string): Promise<ReconcileResult> {
    if (!this.isNodeOnline(nodeId)) {
      return { state: 'still_running', errorMessage: '执行节点暂未重连，等待恢复对账' };
    }
    try {
      return await this.sendRpc<ReconcileResult>(nodeId, 'turn.reconcile', { attemptId }, 15_000);
    } catch {
      return { state: 'still_running' };
    }
  }

  public async listNodeDirectory(
    nodeId: string,
    targetPath: string
  ): Promise<{ root: string; entries: WorkspaceFileEntry[] }> {
    return this.sendRpc(nodeId, 'fs.list_dir', { targetPath }, 15_000);
  }

  public async checkMemberHealth(
    nodeId: string,
    member: MemberRecord
  ): Promise<{ status: MemberRecord['status']; message: string }> {
    const node = this.getNode(nodeId);
    if (!node || !this.isNodeOnline(nodeId)) {
      return { status: 'offline', message: `执行节点「${node?.name || nodeId}」当前离线` };
    }
    try {
      const res = await this.sendRpc<{ status: MemberRecord['status']; message: string }>(
        nodeId,
        'member.check_health',
        {
          member: {
            id: member.id,
            name: member.name,
            platformId: member.platformId,
            driverKind: member.config.localDriverKind || 'acp-stdio',
            location: 'local',
            capabilities: member.capabilities,
            status: member.status,
            statusMessage: member.statusMessage,
            config: member.config
          }
        },
        20_000
      );
      if (res && (res.status === 'ready' || res.status === 'busy' || res.status === 'auth_required' || res.status === 'offline')) {
        return {
          status: res.status,
          message: res.message ? `${res.message} (${node.name})` : `在线 (${node.name})`
        };
      }
      return { status: 'offline', message: `节点已连接，未取得成员健康状态 (${node.name})` };
    } catch {
      return { status: 'offline', message: `成员健康探测超时 (${node.name})` };
    }
  }

  private sendFrame(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private mapNodeRow(row: Record<string, unknown>): ExecutionNodeRecord {
    const id = String(row.id);
    const liveOnline = this.isNodeOnline(id);
    let caps: ExecutionNodeRecord['capabilities'] = { drivers: [] };
    try {
      caps = JSON.parse(String(row.capabilities_json || '{}')) as ExecutionNodeRecord['capabilities'];
    } catch {
      caps = { drivers: [] };
    }
    return {
      id,
      name: String(row.name),
      kind: row.kind === 'cloud' ? 'cloud' : 'local',
      platform: String(row.platform || 'unknown'),
      status: liveOnline ? 'online' : 'offline',
      capabilities: {
        drivers: Array.isArray(caps.drivers) ? caps.drivers : [],
        allowWorkspaceBrowse: Boolean(caps.allowWorkspaceBrowse),
        allowedWorkspaceRoots: Array.isArray(caps.allowedWorkspaceRoots) ? caps.allowedWorkspaceRoots : []
      },
      lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
      appVersion: row.app_version ? String(row.app_version) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
