import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from './artifacts.js';
import { CloudAuthManager, hashPassword, type CloudAuthOptions } from './auth.js';
export { hashPassword };
import { AuthSandbox, SandboxForbiddenError } from './auth-sandbox.js';
import { DuolaWorkDatabase } from './db.js';
import { DriverRegistry } from './drivers/registry.js';
import { DuolaBaseClient, encryptSettingSecret } from './duolabase-client.js';
import { HandoffEngine } from './handoff.js';
import { ExecutionNodeHub } from './node-hub.js';
import { TaskScheduler } from './scheduler.js';
import { SpaceStore } from './space.js';
import { TaskEngine } from './tasks-fsm.js';
import { ThreadEngine } from './threads.js';
import { WorktreeManager } from './worktrees.js';
import { redactSecrets } from './drivers/types.js';
import {
  isExcludedClaudeVps,
  type DriverKind,
  type MaterialTaskRole,
  type MemberLocation,
  type MemberUsageSummary,
  type ScopedTurnClaims,
  type SpaceItemKind,
  type ThreeTierUsage
} from '../shared/types.js';

export interface BuildInfoMeta {
  id: string;
  version: string;
  builtAt?: string;
  commit?: string;
}

export interface DuolaWorkAppOptions {
  dbPath?: string;
  filesDir?: string;
  lockFilePath?: string;
  worktreesRoot?: string;
  staticWebDir?: string;
  autoImportAgentHub?: boolean;
  agentHubDir?: string;
  buildInfo?: BuildInfoMeta;
  auth?: CloudAuthOptions;
  chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
  setTheme?: (theme: 'light' | 'dark') => void;
  externalMcpCaller?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export class DuolaWorkApp {
  public readonly db: DuolaWorkDatabase;
  public readonly auth: CloudAuthManager;
  public readonly nodeHub: ExecutionNodeHub;
  public readonly artifacts: ArtifactStore;
  public readonly sandbox: AuthSandbox;
  public readonly handoff: HandoffEngine;
  public readonly registry: DriverRegistry;
  public readonly worktrees: WorktreeManager;
  public readonly threads: ThreadEngine;
  public readonly tasks: TaskEngine;
  public readonly scheduler: TaskScheduler;
  public readonly space: SpaceStore;
  public readonly duolabase: DuolaBaseClient;
  private readonly staticWebDir: string | null;
  private readonly agentHubDir: string;
  private readonly autoImportAgentHub: boolean;
  private readonly buildInfo: BuildInfoMeta;
  private readonly lockFilePath: string | null;
  private lockFd: number | null = null;
  private readonly chooseDirectoryHandler?: (defaultPath?: string) => Promise<string | null>;
  private readonly setThemeHandler?: (theme: 'light' | 'dark') => void;
  private desktopClientView: { ready: boolean; buildId: string | null; updatedAt: string | null } = {
    ready: false,
    buildId: null,
    updatedAt: null
  };
  private legacySyncStarted = false;
  private legacyMembersSyncPromise: Promise<number> | null = null;
  private externalMcpCaller?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  private httpServer: http.Server | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileInProgress = false;
  private readonly bootId = randomUUID().slice(0, 8);
  private eventSeq = 0;
  private readonly eventBuffer: Array<{ id: number; event: Record<string, unknown> }> = [];
  private readonly sseClients = new Set<{
    res: http.ServerResponse;
    sessionId: string | null;
    via: 'disabled' | 'cookie' | 'bearer' | 'none';
  }>();
  private sseKeepaliveTimer: NodeJS.Timeout | null = null;

  constructor(options: DuolaWorkAppOptions = {}) {
    const dbPath =
      options.dbPath ??
      path.join(os.homedir(), '.config', 'agent-hub', 'duolawork-v2.sqlite');
    const worktreesRoot =
      options.worktreesRoot ??
      path.join(os.tmpdir(), 'duolawork-v2-git-worktrees');

    this.db = new DuolaWorkDatabase(dbPath);
    this.auth = new CloudAuthManager(this.db, options.auth);
    this.nodeHub = new ExecutionNodeHub(this.db, this.auth);
    this.artifacts = new ArtifactStore(this.db);
    this.sandbox = new AuthSandbox(this.db);
    this.handoff = new HandoffEngine(this.db);
    this.registry = new DriverRegistry(this.db);
    this.registry.remoteNodeDriver.bindNodeHub(this.nodeHub);
    this.worktrees = new WorktreeManager(worktreesRoot);
    this.threads = new ThreadEngine(
      this.db,
      this.artifacts,
      this.handoff,
      this.sandbox,
      this.registry
    );
    this.tasks = new TaskEngine(
      this.db,
      this.artifacts,
      this.sandbox,
      this.registry,
      this.threads,
      this.worktrees
    );
    this.scheduler = new TaskScheduler(this.db, this.tasks);
    this.space = new SpaceStore(this.db, this.artifacts, options.filesDir);
    this.staticWebDir = options.staticWebDir ?? null;
    this.agentHubDir = options.agentHubDir ?? path.join(os.homedir(), '.config', 'agent-hub');
    this.autoImportAgentHub = options.autoImportAgentHub !== false;
    this.duolabase = new DuolaBaseClient(this.db, this.autoImportAgentHub, options.externalMcpCaller);
    this.buildInfo = options.buildInfo ?? loadBuildInfoFromDisk(this.staticWebDir);
    this.lockFilePath = options.lockFilePath ?? null;
    this.chooseDirectoryHandler = options.chooseDirectory;
    this.setThemeHandler = options.setTheme;
    this.externalMcpCaller = options.externalMcpCaller;

    const storedSeq = Number(this.db.getSetting<number>('sse_event_seq', 0)) || 0;
    this.eventSeq = Math.max(0, storedSeq);

    this.threads.subscribe((ev) => {
      this.eventSeq += 1;
      try {
        this.db.setSetting('sse_event_seq', this.eventSeq);
      } catch {
        // ignore if DB already closed during shutdown
      }
      const entry = { id: this.eventSeq, event: ev as Record<string, unknown> };
      this.eventBuffer.push(entry);
      if (this.eventBuffer.length > 500) {
        this.eventBuffer.splice(0, this.eventBuffer.length - 500);
      }
      const frame = `id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`;
      for (const client of this.sseClients) {
        if (
          client.via === 'cookie' &&
          this.auth.isAuthRequired() &&
          !this.auth.isSessionActive(client.sessionId)
        ) {
          try {
            client.res.end();
          } catch {
            // ignore
          }
          this.sseClients.delete(client);
          continue;
        }
        try {
          client.res.write(frame);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });

    this.nodeHub.onNodesChanged = (nodes) => {
      this.threads.emit({ type: 'nodes.updated', payload: nodes });
    };
    this.nodeHub.onMembersChanged = () => {
      this.threads.emit({ type: 'thread.members_refreshed', payload: this.db.listMembers() });
    };
    this.nodeHub.onReplayedAttemptResult = (payload) => {
      const att = this.registry.getAttempt(payload.attemptId);
      if (!att || !['prepared', 'dispatched', 'running', 'reconciling'].includes(att.status)) {
        return;
      }
      const now = new Date().toISOString();
      if (payload.ok) {
        const usage: ThreeTierUsage = {
          workbenchDispatches: att.usage.workbenchDispatches || 1,
          nativeTurns: 1,
          providerUsage: payload.providerUsage ?? att.usage.providerUsage
        };
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'succeeded', slot_held = 0,
                 native_session_id = COALESCE(?, native_session_id),
                 native_turn_id = COALESCE(?, native_turn_id),
                 response_text = ?, usage_json = ?, error_message = NULL, settled_at = ?
             WHERE id = ?`
          )
          .run(
            payload.nativeSessionId ?? null,
            payload.nativeTurnId ?? null,
            payload.text ?? '',
            JSON.stringify(usage),
            now,
            payload.attemptId
          );
      } else {
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'failed', slot_held = 0, error_message = ?, settled_at = ?
             WHERE id = ?`
          )
          .run(payload.errorMessage || '节点重放回执失败', now, payload.attemptId);
      }
      this.threads.syncReconciledThreadTurns();
      void this.tasks.reconcileInFlightTaskRuns().catch(() => {});
    };

    this.registry.mcpServersProvider = (toolPolicy) => {
      if (toolPolicy === 'none') return [];
      const cfg = this.duolabase.getActiveMcpConfig();
      return cfg ? [cfg] : [];
    };
    this.tasks.space = this.space;
    this.tasks.scopedToolExecutor = (claims, toolName, args) =>
      this.executeScopedAgentTool(claims, toolName, args);

    this.threads.actionHandler = {
      executeTool: (claims, toolName, args) => this.executeScopedAgentTool(claims, toolName, args),
      getActiveTasksSummaryForThread: (threadId) =>
        this.tasks.getActiveTasksSummaryForThread(threadId),
      getSpaceMaterialsSummaryForThread: (threadId, opts) =>
        this.space.getSpaceContextDigestForPrompt(threadId, opts)
    };

    if (this.autoImportAgentHub) {
      this.db.importExistingAgentHubReadOnly(this.agentHubDir);
    }
  }

  public setDesktopReady(buildId: string | null): void {
    this.desktopClientView = {
      ready: Boolean(buildId),
      buildId,
      updatedAt: new Date().toISOString()
    };
  }

  private disconnectSseForSession(sessionId: string): number {
    let closed = 0;
    for (const client of this.sseClients) {
      if (client.sessionId === sessionId) {
        try {
          client.res.write(`data: ${JSON.stringify({ type: 'auth.revoked', sessionId })}\n\n`);
          client.res.end();
          client.res.destroy?.();
        } catch {
          // ignore
        }
        this.sseClients.delete(client);
        closed += 1;
      }
    }
    return closed;
  }

  private loadHubCredentialsReadOnly(): { endpoint: string; adminKey: string } | null {
    try {
      const cfgPath = path.join(this.agentHubDir, 'config.json');
      if (!fs.existsSync(cfgPath)) return null;
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      const endpoint = String(raw.endpoint || '').replace(/\/+$/, '');
      const adminKey = String(raw.adminKey || '');
      if (!endpoint || !adminKey) return null;
      return { endpoint, adminKey };
    } catch {
      return null;
    }
  }

  private async syncLegacyArchivesReadOnly(): Promise<void> {
    if (!this.autoImportAgentHub) return;
    const creds = this.loadHubCredentialsReadOnly();
    if (!creds) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${creds.endpoint}/v2/channels`, {
        headers: { Authorization: `Bearer ${creds.adminKey}` },
        signal: controller.signal
      });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(data.items) ? data.items : [];
      const filtered = items
        .filter((ch) => {
          const name = String(ch.name || '');
          const id = String(ch.id || '');
          return Boolean(id) && !name.startsWith('[v2-isolated]');
        })
        .slice(0, 30);

      const now = new Date().toISOString();
      this.db.inTransaction(() => {
        const stmt = this.db.sqlite.prepare(
          `INSERT INTO v2_legacy_archives (id, name, kind, meta_json, imported_at)
           VALUES (?, ?, 'channel', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             meta_json = excluded.meta_json,
             imported_at = excluded.imported_at`
        );
        for (const ch of filtered) {
          stmt.run(
            String(ch.id),
            String(ch.name || ch.id),
            JSON.stringify({
              updatedAt: ch.updatedAt ?? ch.createdAt ?? null,
              topic: ch.topic ?? null,
              memberIds: Array.isArray(ch.memberIds) ? ch.memberIds : []
            }),
            String(ch.updatedAt || now)
          );
        }
      });
      if (filtered.length > 0) {
        this.threads.emit({ type: 'thread.archives_synced', payload: { count: filtered.length } });
      }
    } catch {
      // ignore offline or optional remote archive failure
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read-only sync of ALL non-ClaudeVPS members from the remote 1.9.6 Hub `/v2/workspace`,
   * preserving local T3-style Coding Agents (`Codex`, `Claude`, `Gemini (本机)`) and `Gemini2VPS` `native-runtime`.
   */
  public async syncLegacyWorkspaceMembersReadOnly(): Promise<number> {
    if (!this.autoImportAgentHub) return 0;
    const creds = this.loadHubCredentialsReadOnly();
    if (!creds) return 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${creds.endpoint}/v2/workspace`, {
        headers: { Authorization: `Bearer ${creds.adminKey}` },
        signal: controller.signal
      });
      if (!res.ok) return 0;
      const ws = (await res.json()) as {
        members?: Array<Record<string, any>>;
        connections?: Array<Record<string, any>>;
        accounts?: Array<Record<string, any>>;
      };
      const remoteMembers = Array.isArray(ws.members) ? ws.members : [];
      if (remoteMembers.length === 0) return 0;

      const connById = new Map<string, Record<string, any>>();
      for (const c of ws.connections ?? []) {
        if (c?.id) connById.set(String(c.id), c);
      }
      const accById = new Map<string, Record<string, any>>();
      for (const a of ws.accounts ?? []) {
        if (a?.id) accById.set(String(a.id), a);
      }

      const localConnByMemberId = new Map<string, Record<string, any>>();
      const acPath = path.join(this.agentHubDir, 'agent-connections.json');
      if (fs.existsSync(acPath)) {
        try {
          const ac = JSON.parse(fs.readFileSync(acPath, 'utf8')) as {
            accounts?: Record<string, Record<string, any>>;
          };
          for (const rec of Object.values(ac.accounts ?? {})) {
            if (rec?.memberId && rec.enabled !== false) {
              localConnByMemberId.set(String(rec.memberId), rec);
            }
          }
        } catch {
          // ignore unreadable optional file
        }
      }

      const cfgPath = path.join(this.agentHubDir, 'config.json');
      let synced = 0;

      this.db.inTransaction(() => {
        for (const rm of remoteMembers) {
          const id = String(rm?.id || '').trim();
          if (!id) continue;
          const name = String(rm.name || id).trim();
          const platformId = String(rm.platformId || rm.platform || '').trim();

          if (
            isExcludedClaudeVps({
              id,
              name,
              platformId,
              driverKind: 'remote-bridge',
              location: 'remote-bridge'
            })
          ) {
            continue;
          }

          const existing = this.db.getMember(id);
          // Preserve pure local T3-style Coding Agents without overwriting their local CLI drivers!
          if (
            existing &&
            existing.location === 'local' &&
            (existing.driverKind === 'codex-app-server' ||
              existing.driverKind === 'acp-stdio' ||
              existing.driverKind === 'claude-cli')
          ) {
            continue;
          }

          // Preserve Gemini2VPS native-runtime bridge mode
          if (id === 'member_ccdf940ba6d3426da01b9f65048909e2') {
            this.db.upsertMember({
              id,
              name: name || 'Gemini2VPS',
              platformId: platformId || 'antigravity',
              driverKind: 'remote-bridge',
              location: 'remote-bridge',
              capabilities: existing?.capabilities ?? {
                supportsIsolatedSessions: true,
                supportsSessionResume: true,
                supportsCancel: false,
                maxConcurrentRuns: 2
              },
              status: existing?.status ?? 'ready',
              statusMessage: existing?.statusMessage ?? '远端 Antigravity 运行端在线桥接',
              config: {
                ...(existing?.config ?? {}),
                agentHubConfigPath: cfgPath,
                remoteMode: 'native-runtime',
                accountId: rm.accountId ?? null
              }
            });
            synced += 1;
            continue;
          }

          const conn = connById.get(id);
          const acc = rm.accountId ? accById.get(String(rm.accountId)) : null;
          const localConn = localConnByMemberId.get(id);
          const transport = String(conn?.transport || rm.mode || acc?.mode || 'connector');
          const status: 'ready' | 'auth_required' | 'offline' =
            conn?.status === 'verified' || rm.status === 'ready' || localConn?.status === 'ready'
              ? 'ready'
              : conn?.status === 'configured'
                ? 'auth_required'
                : 'offline';
          const statusMessage =
            localConn?.status === 'ready'
              ? `专用浏览器已连接 (${transport})`
              : status === 'ready'
                ? `远端工作区成员已连接 (${transport})`
                : status === 'auth_required'
                  ? `已配置 (${transport})，待完成首轮连接验证`
                  : `远端成员暂未在线 (${transport})`;

          this.db.upsertMember({
            id,
            name,
            platformId: platformId || 'remote',
            driverKind: 'remote-bridge',
            location: 'remote-bridge',
            capabilities: {
              supportsIsolatedSessions: false,
              supportsSessionResume: false,
              supportsCancel: false,
              maxConcurrentRuns: 1
            },
            status,
            statusMessage,
            config: {
              agentHubConfigPath: cfgPath,
              remoteMode: 'hub-channel',
              hubTransport: transport,
              accountId: rm.accountId ?? null
            }
          });
          synced += 1;
        }
      });

      if (synced > 0) {
        this.threads.emit({ type: 'thread.members_refreshed', payload: this.db.listMembers() });
      }
      return synced;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }

  public setExternalMcpCaller(
    fn: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.externalMcpCaller = fn;
    this.duolabase.setExternalCaller(fn);
  }

  /**
   * Executes a scoped tool call from a managed Agent turn, enforcing RBAC & DuolaBase policies!
   */
  public async executeScopedAgentTool(
    claims: ScopedTurnClaims,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (toolName === 'artifact_read') {
      const artId = String(args.artifactId || '');
      const art = this.artifacts.getArtifact(artId);
      if (!art) throw new Error(`文稿不存在: ${artId}`);
      this.sandbox.assertArtifactPermission(claims, art, 'read');
      return art;
    }

    if (toolName === 'artifact_write') {
      const artId = String(args.artifactId || '');
      const art = this.artifacts.getArtifact(artId);
      if (!art) throw new Error(`文稿不存在: ${artId}`);
      this.sandbox.assertArtifactPermission(claims, art, 'write');
      const expectedBase =
        args.expectedBaseVersion !== undefined
          ? Number(args.expectedBaseVersion)
          : art.headVersion;
      return this.artifacts.writeArtifact({
        artifactId: artId,
        expectedBaseVersion: expectedBase,
        title: typeof args.title === 'string' ? args.title : undefined,
        content: String(args.content ?? ''),
        writerKind: 'agent',
        writerId: claims.memberId,
        attemptId: claims.attemptId
      });
    }

    if (toolName === 'thread_read_history') {
      if (claims.principalKind === 'task_worker') {
        throw new SandboxForbiddenError(
          'worker_cannot_read_main_chat',
          '任务执行人禁止读取主对话历史记录'
        );
      }
      const fromSeq = Number(args.fromSeq ?? 1);
      const toSeq = Number(args.toSeq ?? fromSeq + 30);
      return {
        items: this.threads.listMessages(claims.threadId, { fromSeq, toSeq })
      };
    }

    if (toolName === 'task_create_or_update') {
      this.sandbox.assertLeadPermission(claims);
      const rawLead = typeof args.leadMemberId === 'string' ? args.leadMemberId.trim() : '';
      const kind = args.kind === 'scheduled' ? 'scheduled' : 'once';
      const startImmediately =
        args.startImmediately !== undefined
          ? Boolean(args.startImmediately)
          : kind !== 'scheduled';
      const created = this.tasks.createOrUpdateTask({
        sourceThreadId: claims.threadId,
        title: String(args.title || '未命名任务'),
        kind,
        cronExpr: typeof args.cronExpr === 'string' ? args.cronExpr : null,
        intervalSeconds: typeof args.intervalSeconds === 'number' ? args.intervalSeconds : null,
        timezone: typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : 'Asia/Shanghai',
        leadMemberId: !rawLead || rawLead === 'self' ? claims.memberId : rawLead,
        spec: {
          goal: String(args.goal || args.title || ''),
          acceptanceCriteria: typeof args.acceptanceCriteria === 'string' ? args.acceptanceCriteria : undefined,
          steps: Array.isArray(args.steps) ? (args.steps as any[]) : []
        },
        startImmediately
      });
      if (created.initialRun) {
        void this.tasks.driveRun(created.initialRun.id).catch(() => {});
      }
      return created;
    }

    if (toolName === 'task_review_step' || toolName === 'task_complete_run') {
      this.sandbox.assertLeadPermission(claims, typeof args.taskId === 'string' ? args.taskId : undefined);
      return { ok: true };
    }

    if (toolName === 'step_read_context') {
      const runId = String(args.runId || claims.runId || '');
      const stepId = String(args.stepId || claims.stepId || '');
      this.sandbox.assertWorkerStepPermission(claims, runId, stepId);
      const step = this.tasks.getStep(stepId);
      if (!step) throw new Error('步骤不存在');
      return {
        stepId: step.id,
        title: step.title,
        brief: step.brief,
        acceptanceCriteria: step.acceptanceCriteria
      };
    }

    if (toolName === 'space_list_materials') {
      const space = this.space.listSpace(claims.threadId);
      return {
        items: space.items.map((it) => ({
          kind: it.kind,
          id: it.id,
          title: it.title,
          version: it.version,
          sizeBytes: it.sizeBytes,
          url: it.url,
          excerpt: it.excerpt
        }))
      };
    }

    if (toolName === 'space_read_material') {
      const kind = String(args.kind || '') as SpaceItemKind;
      const id = String(args.id || '');
      if (!['document', 'file', 'link'].includes(kind) || !id) {
        throw new Error('请指定有效的资料类型 (document/file/link) 与 ID');
      }
      return this.space.readMaterialForAgent(claims.threadId, kind, id);
    }

    // External DuolaBase tool proxy (enforcing read-only vs write vs disabled switch!)
    if (toolName.startsWith('duolabase:')) {
      const mcpTool = toolName.slice('duolabase:'.length);
      this.sandbox.assertExternalToolAllowed(claims, mcpTool, args);
      if (this.externalMcpCaller) {
        return this.externalMcpCaller(mcpTool, args);
      }
      if (this.duolabase.getPublicStatus().hasToken) {
        return this.duolabase.callTool(mcpTool, args);
      }
      return { proxied: true, mcpTool };
    }

    throw new SandboxForbiddenError('unknown_or_forbidden_tool', `未授权或未知工具: ${toolName}`);
  }

  public async listen(port = 8780, host = '127.0.0.1'): Promise<{ port: number; url: string }> {
    if (this.httpServer) {
      const addr = this.httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      return { port: actualPort, url: `http://${host}:${actualPort}` };
    }

    if (this.lockFilePath && this.lockFd === null) {
      fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true, mode: 0o700 });
      try {
        this.lockFd = fs.openSync(this.lockFilePath, 'wx', 0o600);
        fs.writeFileSync(this.lockFd, `${process.pid}\n`);
      } catch (err: any) {
        if (err?.code === 'EEXIST') {
          const existingPid = Number(fs.readFileSync(this.lockFilePath, 'utf8').trim());
          let alive = false;
          if (Number.isFinite(existingPid) && existingPid > 0) {
            try {
              process.kill(existingPid, 0);
              alive = true;
            } catch {
              alive = false;
            }
          }
          if (alive) {
            throw new Error(`另一个 DuolaWork 实例正在运行 (pid=${existingPid}, lock=${this.lockFilePath})`);
          }
          fs.unlinkSync(this.lockFilePath);
          this.lockFd = fs.openSync(this.lockFilePath, 'wx', 0o600);
          fs.writeFileSync(this.lockFd, `${process.pid}\n`);
        } else {
          throw err;
        }
      }
    }

    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.httpServer = server;
    this.nodeHub.attachToServer(server);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });

    if (!this.sseKeepaliveTimer) {
      this.sseKeepaliveTimer = setInterval(() => {
        for (const client of this.sseClients) {
          if (
            client.via === 'cookie' &&
            this.auth.isAuthRequired() &&
            !this.auth.isSessionActive(client.sessionId)
          ) {
            try {
              client.res.write(`data: ${JSON.stringify({ type: 'auth.revoked' })}\n\n`);
              client.res.end();
            } catch {
              // ignore
            }
            this.sseClients.delete(client);
            continue;
          }
          try {
            client.res.write(': ping\n\n');
          } catch {
            this.sseClients.delete(client);
          }
        }
      }, 20_000);
      this.sseKeepaliveTimer.unref?.();
    }

    this.scheduler.start(15_000);
    const runBackgroundReconcile = () => {
      if (this.reconcileInProgress) return;
      const hasRunningMsgs = Boolean(
        this.db.sqlite
          .prepare(`SELECT 1 FROM v2_thread_messages WHERE turn_status = 'running' LIMIT 1`)
          .get()
      );
      const hasRunningTaskRuns = this.tasks.hasReconcilableRuns();
      if (!this.registry.hasPendingReconcileAttempts() && !hasRunningMsgs && !hasRunningTaskRuns) return;
      this.reconcileInProgress = true;
      void this.registry
        .reconcileInFlightAttempts({ waitTimeoutMs: 0 })
        .then(async () => {
          this.threads.syncReconciledThreadTurns();
          await this.tasks.reconcileInFlightTaskRuns();
        })
        .catch(() => {})
        .finally(() => {
          this.reconcileInProgress = false;
        });
    };
    runBackgroundReconcile();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(runBackgroundReconcile, 8_000);
      this.reconcileTimer.unref?.();
    }
    if (this.autoImportAgentHub && !this.legacySyncStarted) {
      this.legacySyncStarted = true;
      this.legacyMembersSyncPromise = this.syncLegacyWorkspaceMembersReadOnly();
      void this.syncLegacyArchivesReadOnly();
    }
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    return { port: actualPort, url: `http://${host}:${actualPort}` };
  }

  public async close(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.sseKeepaliveTimer) {
      clearInterval(this.sseKeepaliveTimer);
      this.sseKeepaliveTimer = null;
    }
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    this.scheduler.stop();
    this.registry.cancelAllActiveAttempts('SHUTDOWN');
    this.nodeHub.close();
    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          srv.closeAllConnections?.();
          resolve();
        }, 500);
        srv.close(() => {
          clearTimeout(timer);
          resolve();
        });
        srv.closeAllConnections?.();
      });
    }
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {
        // ignore
      }
      this.lockFd = null;
      if (this.lockFilePath) {
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          // ignore
        }
      }
    }
    this.db.close();
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      if (pathname === '/api/v2/health' && method === 'GET') {
        sendJson(res, 200, {
          status: 'ok',
          version: this.buildInfo.version || '2.0.0',
          buildId: this.buildInfo.id,
          builtAt: this.buildInfo.builtAt ?? null,
          authRequired: this.auth.isAuthRequired(),
          desktopReady: this.desktopClientView.ready,
          renderedBuildId: this.desktopClientView.buildId,
          desktopUpdatedAt: this.desktopClientView.updatedAt
        });
        return;
      }

      // Public Authentication & Node Pairing Endpoints
      if (pathname === '/api/v2/auth/status' && method === 'GET') {
        const check = this.auth.checkRequest(req);
        sendJson(res, 200, {
          authRequired: this.auth.isAuthRequired(),
          authenticated: check.authenticated,
          hasPassword: this.auth.hasPasswordConfigured(),
          sessionId: check.sessionId ?? null
        });
        return;
      }

      if (pathname === '/api/v2/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const out = this.auth.loginWithPassword({
          password: String(body.password || ''),
          ip: this.auth.getClientIp(req),
          userAgent: String(req.headers['user-agent'] || ''),
          deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
          secureCookie: this.auth.isSecureRequest(req)
        });
        res.setHeader('Set-Cookie', out.setCookie);
        sendJson(res, 200, { ok: true, session: out.session });
        return;
      }

      if (pathname === '/api/v2/auth/magic-login' && method === 'POST') {
        const body = await readJsonBody(req);
        const out = this.auth.redeemLoginMagicCode({
          code: String(body.code || ''),
          ip: this.auth.getClientIp(req),
          userAgent: String(req.headers['user-agent'] || ''),
          deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
          secureCookie: this.auth.isSecureRequest(req)
        });
        res.setHeader('Set-Cookie', out.setCookie);
        sendJson(res, 200, { ok: true, session: out.session });
        return;
      }

      if (pathname === '/api/v2/nodes/pair' && method === 'POST') {
        const body = await readJsonBody(req);
        const paired = this.nodeHub.pairNode({
          code: String(body.code || ''),
          ip: this.auth.getClientIp(req),
          name: typeof body.name === 'string' ? body.name : undefined,
          kind: body.kind === 'cloud' ? 'cloud' : 'local',
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
          capabilities: body.capabilities
        });
        sendJson(res, 201, paired);
        return;
      }

      // Enforce authentication & CSRF for all protected `/api/v2/*` routes
      const isPublicProtectedBypass =
        pathname === '/api/v2/webhooks/callback' || pathname === '/api/v2/agent-tools/call';
      let authCheck = this.auth.checkRequest(req);
      if (pathname.startsWith('/api/v2/') && !isPublicProtectedBypass) {
        if (!authCheck.authenticated) {
          sendJson(res, 401, { error: 'auth_required', message: '请先登录工作台' });
          return;
        }
        if (authCheck.via === 'cookie') {
          this.auth.assertCsrfOrigin(req);
        }
      }

      if (pathname === '/api/v2/auth/logout' && method === 'POST') {
        if (authCheck.sessionId) {
          this.auth.revokeSession(authCheck.sessionId);
          this.disconnectSseForSession(authCheck.sessionId);
        }
        res.setHeader('Set-Cookie', this.auth.clearCookieHeader(this.auth.isSecureRequest(req)));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/v2/auth/magic-code' && method === 'POST') {
        const body = await readJsonBody(req);
        const generated = this.auth.createMagicCode('login', {
          deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined
        });
        sendJson(res, 201, generated);
        return;
      }

      if (pathname === '/api/v2/auth/sessions' && method === 'GET') {
        sendJson(res, 200, { sessions: this.auth.listSessions(authCheck.sessionId) });
        return;
      }

      const sessionDelMatch = pathname.match(/^\/api\/v2\/auth\/sessions\/([^/]+)$/);
      if (sessionDelMatch && method === 'DELETE') {
        const sid = decodeURIComponent(sessionDelMatch[1]);
        const revoked = this.auth.revokeSession(sid);
        if (revoked) {
          this.disconnectSseForSession(sid);
        }
        sendJson(res, 200, { ok: revoked, sessions: this.auth.listSessions(authCheck.sessionId) });
        return;
      }

      // Execution Nodes Management APIs
      if (pathname === '/api/v2/nodes' && method === 'GET') {
        sendJson(res, 200, { nodes: this.nodeHub.listNodes() });
        return;
      }

      if (pathname === '/api/v2/nodes/pair-code' && method === 'POST') {
        const body = await readJsonBody(req);
        const generated = this.nodeHub.createPairingCode({
          name: typeof body.name === 'string' ? body.name : undefined,
          kind: body.kind === 'cloud' ? 'cloud' : 'local'
        });
        sendJson(res, 201, generated);
        return;
      }

      const nodeFsMatch = pathname.match(/^\/api\/v2\/nodes\/([^/]+)\/fs$/);
      if (nodeFsMatch && method === 'GET') {
        const nodeId = decodeURIComponent(nodeFsMatch[1]);
        const targetPath = url.searchParams.get('path') || '';
        const out = await this.nodeHub.listNodeDirectory(nodeId, targetPath);
        sendJson(res, 200, out);
        return;
      }

      const nodeDelMatch = pathname.match(/^\/api\/v2\/nodes\/([^/]+)$/);
      if (nodeDelMatch && method === 'DELETE') {
        const nodeId = decodeURIComponent(nodeDelMatch[1]);
        const ok = this.nodeHub.revokeNode(nodeId);
        sendJson(res, 200, { ok, nodes: this.nodeHub.listNodes() });
        return;
      }

      if (pathname === '/api/v2/desktop-ready' && method === 'POST') {
        const body = await readJsonBody(req);
        this.setDesktopReady(typeof body.buildId === 'string' ? body.buildId : null);
        sendJson(res, 200, { ok: true, desktopClientView: this.desktopClientView });
        return;
      }

      if (pathname === '/api/v2/desktop/choose-directory' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!this.chooseDirectoryHandler) {
          sendJson(res, 200, { canceled: true, path: null, unavailable: true });
          return;
        }
        const selected = await this.chooseDirectoryHandler(
          typeof body.defaultPath === 'string' ? body.defaultPath : undefined
        );
        sendJson(res, 200, { canceled: !selected, path: selected });
        return;
      }

      if (pathname === '/api/v2/desktop/theme' && method === 'POST') {
        const body = await readJsonBody(req);
        const normalized: 'light' | 'dark' = body.theme === 'dark' ? 'dark' : 'light';
        this.db.setSetting('ui_theme', normalized);
        this.setThemeHandler?.(normalized);
        sendJson(res, 200, { ok: true, theme: normalized });
        return;
      }

      if (pathname === '/api/v2/members/sync-protocol-memory' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = this.threads.bumpProtocolVersion(
          typeof body.reason === 'string' ? body.reason : undefined
        );
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/api/v2/members/refresh-health' && method === 'POST') {
        await this.syncLegacyWorkspaceMembersReadOnly();
        const currentMembers = this.db.listMembers();
        for (const m of currentMembers) {
          if (isExcludedClaudeVps(m)) {
            continue;
          }
          try {
            const driver = this.registry.getDriver(m.driverKind);
            const checked = await Promise.race([
              driver.checkHealth(m),
              new Promise<{ status: typeof m.status; message: string }>((resolve) =>
                setTimeout(() => resolve({ status: 'offline', message: '健康检查超时' }), 8000)
              )
            ]);
            this.db.upsertMember({
              ...m,
              status: checked.status,
              statusMessage: checked.message
            });
          } catch (err) {
            this.db.upsertMember({
              ...m,
              status: 'offline',
              statusMessage: redactSecrets((err as Error).message)
            });
          }
        }
        const refreshed = this.db.listMembers();
        this.threads.emit({ type: 'thread.members_refreshed', payload: refreshed });
        sendJson(res, 200, { members: refreshed });
        return;
      }

      // SSE realtime event stream (with Last-Event-ID catch-up & proxy-safe keepalive)
      if (pathname === '/api/v2/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive'
        });
        const rawLastId =
          url.searchParams.get('lastEventId') ??
          (typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null);
        const lastId = rawLastId ? Number(rawLastId) : 0;

        res.write(
          `id: ${this.eventSeq}\ndata: ${JSON.stringify({
            type: 'connected',
            bootId: this.bootId,
            eventSeq: this.eventSeq
          })}\n\n`
        );

        if (Number.isFinite(lastId) && lastId > 0 && lastId !== this.eventSeq) {
          const oldestBuffered = this.eventBuffer[0]?.id;
          if (
            lastId > this.eventSeq ||
            oldestBuffered === undefined ||
            lastId < oldestBuffered - 1
          ) {
            res.write(
              `id: ${this.eventSeq}\ndata: ${JSON.stringify({
                type: 'sync.full_refresh',
                bootId: this.bootId,
                eventSeq: this.eventSeq
              })}\n\n`
            );
          } else {
            for (const entry of this.eventBuffer) {
              if (entry.id > lastId) {
                res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
              }
            }
          }
        }

        const sseEntry = {
          res,
          sessionId: authCheck.sessionId ?? null,
          via: authCheck.via
        };
        this.sseClients.add(sseEntry);
        req.on('close', () => {
          this.sseClients.delete(sseEntry);
        });
        return;
      }

      // Bootstrap state for 3-column workbench
      if (pathname === '/api/v2/bootstrap' && method === 'GET') {
        if (this.legacyMembersSyncPromise) {
          await Promise.race([
            this.legacyMembersSyncPromise,
            new Promise((resolve) => setTimeout(resolve, 2500))
          ]);
        }
        const members = this.db.listMembers();
        let threads = this.threads.listThreads();
        if (threads.length === 0 && members.length > 0) {
          const defaultOwner =
            members.find((m) => m.name === 'Codex') ??
            members.find((m) => m.status === 'ready') ??
            members[0];
          threads = [
            this.threads.createThread({
              title: '新工作对话',
              activeOwnerMemberId: defaultOwner.id,
              projectId: 'default'
            })
          ];
        }
        const tasks = this.tasks.listTasks().map((t) => ({
          ...t,
          latestRun: this.tasks.listRuns(t.id)[0] ?? null
        }));
        const duolabase = this.duolabase.getPublicStatus();
        const archives = this.db.sqlite
          .prepare(`SELECT * FROM v2_legacy_archives ORDER BY imported_at DESC LIMIT 30`)
          .all();

        sendJson(res, 200, {
          members,
          nodes: this.nodeHub.listNodes(),
          threads,
          tasks,
          duolabase,
          archives,
          auth: {
            authRequired: this.auth.isAuthRequired(),
            authenticated: authCheck.authenticated,
            sessionId: authCheck.sessionId ?? null
          },
          protocolVersion: this.threads.getProtocolVersion(),
          buildInfo: this.buildInfo,
          hasDesktopDialog: Boolean(this.chooseDirectoryHandler)
        });
        return;
      }

      const legacyArchiveMatch = pathname.match(/^\/api\/v2\/legacy-archives\/([^/]+)$/);
      if (legacyArchiveMatch && method === 'GET') {
        const channelId = decodeURIComponent(legacyArchiveMatch[1]);
        const creds = this.loadHubCredentialsReadOnly();
        const storedRow = this.db.sqlite
          .prepare(`SELECT * FROM v2_legacy_archives WHERE id = ?`)
          .get(channelId) as { id: string; name: string; meta_json: string; imported_at: string } | undefined;

        if (!creds) {
          sendJson(res, 200, {
            archive: storedRow ?? { id: channelId, name: channelId },
            messages: [],
            readOnly: true,
            note: '未配置远端桥接凭证，当前仅显示本地归档标题'
          });
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const remoteRes = await fetch(
            `${creds.endpoint}/v2/channel?id=${encodeURIComponent(channelId)}`,
            {
              headers: { Authorization: `Bearer ${creds.adminKey}` },
              signal: controller.signal
            }
          );
          if (!remoteRes.ok) {
            throw new Error(`HTTP ${remoteRes.status}`);
          }
          const remoteData = (await remoteRes.json()) as {
            channel?: { id?: string; name?: string; topic?: string };
            messages?: Array<Record<string, unknown>>;
          };
          const msgs = Array.isArray(remoteData.messages)
            ? remoteData.messages.map((m) => ({
                id: String(m.id || Math.random()),
                authorName: String(m.authorName || m.authorId || '成员'),
                authorId: String(m.authorId || ''),
                body: String(m.body || ''),
                createdAt: String(m.createdAt || '')
              }))
            : [];
          sendJson(res, 200, {
            archive: {
              id: channelId,
              name: remoteData.channel?.name || storedRow?.name || channelId,
              topic: remoteData.channel?.topic || null
            },
            messages: msgs,
            readOnly: true
          });
        } catch (err) {
          sendJson(res, 200, {
            archive: storedRow ?? { id: channelId, name: channelId },
            messages: [],
            readOnly: true,
            note: `远端只读拉取失败: ${redactSecrets((err as Error).message)}`
          });
        } finally {
          clearTimeout(timer);
        }
        return;
      }

      if (pathname === '/api/v2/settings/duolabase' && method === 'POST') {
        const body = await readJsonBody(req);
        const current = this.db.getSetting<{ enabled: boolean; endpoint: string; token?: string }>('duolabase', {
          enabled: true,
          endpoint: 'https://duolabase.manyaitool.com/mcp'
        });
        const nextToken =
          body.token === null
            ? undefined
            : typeof body.token === 'string' && body.token.trim()
              ? encryptSettingSecret(body.token.trim())
              : current.token;
        const updated: { enabled: boolean; endpoint: string; token?: string } = {
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
          endpoint: typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : current.endpoint,
          ...(nextToken ? { token: nextToken } : {})
        };
        this.db.setSetting('duolabase', updated);
        sendJson(res, 200, this.duolabase.getPublicStatus());
        return;
      }

      // Unified DuolaBase Connectors & Vault Management Proxy (never exposes plaintext secrets)
      if (pathname === '/api/v2/duolabase/status' && method === 'GET') {
        const status = this.duolabase.getPublicStatus();
        let systemInfo: Record<string, unknown> | null = null;
        if (status.enabled && status.hasToken) {
          try {
            systemInfo = await this.duolabase.callTool('system_info', {}, 6000);
          } catch {
            systemInfo = null;
          }
        }
        sendJson(res, 200, { ...status, systemInfo });
        return;
      }

      if (pathname === '/api/v2/duolabase/connectors' && method === 'GET') {
        const args: Record<string, unknown> = {};
        if (url.searchParams.get('category')) args.category = url.searchParams.get('category');
        if (url.searchParams.get('status')) args.status = url.searchParams.get('status');
        if (url.searchParams.get('query')) args.query = url.searchParams.get('query');
        const result = await this.duolabase.callTool('connector_list', args);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/v2/duolabase/connectors' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.duolabase.callTool('connector_save', {
          ...body,
          autoCheck: body.autoCheck !== false
        });
        sendJson(res, 200, result);
        return;
      }

      const connCheckMatch = pathname.match(/^\/api\/v2\/duolabase\/connectors\/([^/]+)\/check$/);
      if (connCheckMatch && method === 'POST') {
        const connectorId = decodeURIComponent(connCheckMatch[1]);
        const result = await this.duolabase.callTool('connector_check', { connectorId }, 20_000);
        sendJson(res, 200, result);
        return;
      }

      const connToolsMatch = pathname.match(/^\/api\/v2\/duolabase\/connectors\/([^/]+)\/tools$/);
      if (connToolsMatch && method === 'GET') {
        const connectorId = decodeURIComponent(connToolsMatch[1]);
        const result = await this.duolabase.callTool('connector_discover', { connectorId });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/v2/duolabase/vault' && method === 'GET') {
        const args: Record<string, unknown> = {};
        for (const k of ['category', 'type', 'status', 'query', 'project', 'service'] as const) {
          const val = url.searchParams.get(k);
          if (val) args[k] = val;
        }
        const result = await this.duolabase.callTool('vault_list', args);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/v2/duolabase/vault' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.duolabase.callTool('vault_save', body);
        sendJson(res, 200, result);
        return;
      }

      const vaultLifecycleMatch = pathname.match(/^\/api\/v2\/duolabase\/vault\/([^/]+)\/lifecycle$/);
      if (vaultLifecycleMatch && method === 'POST') {
        const credentialId = decodeURIComponent(vaultLifecycleMatch[1]);
        const body = await readJsonBody(req);
        const result = await this.duolabase.callTool('vault_lifecycle', {
          credentialId,
          expectedVersion: Number(body.expectedVersion ?? 1),
          action: String(body.action || 'disable'),
          ...(typeof body.project === 'string' && body.project ? { project: body.project } : {})
        });
        sendJson(res, 200, result);
        return;
      }

      const vaultTagMatch = pathname.match(/^\/api\/v2\/duolabase\/vault\/([^/]+)\/tag-project$/);
      if (vaultTagMatch && method === 'POST') {
        const credentialId = decodeURIComponent(vaultTagMatch[1]);
        const body = await readJsonBody(req);
        const result = await this.duolabase.callTool('vault_tag_project', {
          credentialId,
          project: String(body.project || '').trim()
        });
        sendJson(res, 200, result);
        return;
      }

      // Member Usage & Onboarding Management
      if (pathname === '/api/v2/members/usage' && method === 'GET') {
        const members = this.db.listMembers();
        const attemptRows = this.db.sqlite
          .prepare(
            `SELECT id, member_id, target_kind, thread_id, status, prompt_bytes, handoff_bytes, usage_json, error_message, dispatched_at, settled_at
             FROM v2_dispatch_attempts
             ORDER BY dispatched_at DESC LIMIT 200`
          )
          .all() as Record<string, unknown>[];

        const summaryMap = new Map<string, MemberUsageSummary>();
        for (const m of members) {
          summaryMap.set(m.id, {
            memberId: m.id,
            workbenchDispatches: 0,
            nativeTurns: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            lastActiveAt: null
          });
        }

        const recent = attemptRows.slice(0, 30).map((r) => {
          const usage = JSON.parse(String(r.usage_json || '{}')) as ThreeTierUsage;
          return {
            id: String(r.id),
            memberId: String(r.member_id),
            targetKind: String(r.target_kind),
            status: String(r.status),
            promptBytes: Number(r.prompt_bytes ?? 0),
            usage,
            errorMessage: r.error_message ? String(r.error_message) : null,
            dispatchedAt: String(r.dispatched_at),
            settledAt: r.settled_at ? String(r.settled_at) : null
          };
        });

        for (const r of attemptRows) {
          const mid = String(r.member_id);
          const s = summaryMap.get(mid);
          if (!s) continue;
          const u = JSON.parse(String(r.usage_json || '{}')) as ThreeTierUsage;
          s.workbenchDispatches += Number(u.workbenchDispatches || 0);
          s.nativeTurns += Number(u.nativeTurns || 0);
          if (u.providerUsage?.observable) {
            s.inputTokens += Number(u.providerUsage.inputTokens || 0);
            s.cachedInputTokens += Number(u.providerUsage.cachedInputTokens || 0);
            s.outputTokens += Number(u.providerUsage.outputTokens || 0);
            s.totalTokens += Number(u.providerUsage.totalTokens || 0);
          }
          const dAt = String(r.dispatched_at || '');
          if (dAt && (!s.lastActiveAt || dAt > s.lastActiveAt)) {
            s.lastActiveAt = dAt;
          }
        }

        sendJson(res, 200, {
          summaries: Array.from(summaryMap.values()),
          recent
        });
        return;
      }

      if (pathname === '/api/v2/members' && method === 'POST') {
        const body = await readJsonBody(req);
        const platformId = String(body.platformId || '').trim();
        const id = String(body.id || `member_${Date.now().toString(36)}`).trim();
        const name = String(body.name || '').trim();
        const driverKind = String(body.driverKind || 'codex-app-server') as DriverKind;
        const location = String(body.location || 'local') as MemberLocation;
        if (isExcludedClaudeVps({ id, name, platformId, driverKind, location })) {
          sendJson(res, 403, { error: 'forbidden', message: '禁止接入被排除的 VPS Claude 实例' });
          return;
        }
        if (!name) throw new Error('成员名称不能为空');
        const saved = this.db.upsertMember({
          id,
          name,
          platformId: platformId || driverKind,
          driverKind,
          location,
          capabilities: {
            supportsIsolatedSessions: Boolean(body.supportsIsolatedSessions ?? driverKind !== 'webhook-bot'),
            supportsSessionResume: Boolean(body.supportsSessionResume ?? driverKind !== 'webhook-bot'),
            supportsCancel: driverKind === 'codex-app-server' || driverKind === 'acp-stdio',
            maxConcurrentRuns: Number(body.maxConcurrentRuns ?? (driverKind === 'webhook-bot' ? 1 : 2))
          },
          status: 'ready',
          statusMessage: String(body.statusMessage || '已登记连接'),
          config: (body.config as Record<string, unknown>) ?? {}
        });
        sendJson(res, 201, { member: saved, members: this.db.listMembers() });
        return;
      }

      const memberDelMatch = pathname.match(/^\/api\/v2\/members\/([^/]+)$/);
      if (memberDelMatch && method === 'DELETE') {
        const memberId = decodeURIComponent(memberDelMatch[1]);
        const refThreads = (
          this.db.sqlite
            .prepare(`SELECT COUNT(*) AS cnt FROM v2_threads WHERE active_owner_member_id = ?`)
            .get(memberId) as { cnt: number }
        ).cnt;
        const refTasks = (
          this.db.sqlite
            .prepare(`SELECT COUNT(*) AS cnt FROM v2_tasks WHERE lead_member_id = ?`)
            .get(memberId) as { cnt: number }
        ).cnt;
        if (refThreads > 0 || refTasks > 0) {
          sendJson(res, 400, {
            error: 'member_in_use',
            message: '该成员仍被现有对话或任务使用，请先切换对接人后再移除'
          });
          return;
        }
        this.db.sqlite.prepare(`DELETE FROM v2_members WHERE id = ?`).run(memberId);
        sendJson(res, 200, { ok: true, members: this.db.listMembers() });
        return;
      }

      if (pathname === '/api/v2/threads' && method === 'POST') {
        const body = await readJsonBody(req);
        const members = this.db.listMembers();
        const ownerId =
          typeof body.activeOwnerMemberId === 'string' && body.activeOwnerMemberId
            ? body.activeOwnerMemberId
            : (members[0]?.id ?? '');
        const thread = this.threads.createThread({
          title: String(body.title || '新对话'),
          activeOwnerMemberId: ownerId,
          projectId: typeof body.projectId === 'string' ? body.projectId : 'default',
          workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : null
        });
        const artifact = thread.boundArtifactId
          ? this.artifacts.getArtifact(thread.boundArtifactId)
          : null;
        sendJson(res, 201, { thread, artifact });
        return;
      }

      const threadMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)$/);
      if (threadMatch && method === 'GET') {
        const threadId = decodeURIComponent(threadMatch[1]);
        const thread = this.threads.getThread(threadId);
        if (!thread) return sendJson(res, 404, { error: '对话不存在' });
        const messages = this.threads.listMessages(threadId);
        const artifact = thread.boundArtifactId
          ? this.artifacts.getArtifact(thread.boundArtifactId)
          : null;
        const versions = artifact ? this.artifacts.listVersions(artifact.id) : [];
        sendJson(res, 200, { thread, messages, artifact, versions });
        return;
      }
      if (threadMatch && method === 'PATCH') {
        const threadId = decodeURIComponent(threadMatch[1]);
        const body = await readJsonBody(req);
        const updated = this.threads.updateThread(threadId, {
          title: typeof body.title === 'string' ? body.title : undefined,
          workspacePath:
            body.workspacePath === undefined
              ? undefined
              : body.workspacePath === null
                ? null
                : String(body.workspacePath),
          workspaceNodeId:
            body.workspaceNodeId === undefined
              ? undefined
              : body.workspaceNodeId === null
                ? null
                : String(body.workspaceNodeId),
          status: body.status === 'active' || body.status === 'archived' ? body.status : undefined,
          pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined
        });
        sendJson(res, 200, { thread: updated });
        return;
      }

      const abortMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        const threadId = decodeURIComponent(abortMatch[1]);
        const out = await this.threads.abortActiveTurn(threadId);
        sendJson(res, 200, {
          ...out,
          messages: this.threads.listMessages(threadId)
        });
        return;
      }

      const ownerMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/owner$/);
      if (ownerMatch && method === 'POST') {
        const threadId = decodeURIComponent(ownerMatch[1]);
        const body = await readJsonBody(req);
        const updated = this.threads.switchOwner(threadId, String(body.memberId || ''));
        sendJson(res, 200, { thread: updated, messages: this.threads.listMessages(threadId) });
        return;
      }

      const handoffPreviewMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/handoff-preview$/);
      if (handoffPreviewMatch && method === 'GET') {
        const threadId = decodeURIComponent(handoffPreviewMatch[1]);
        const memberId = url.searchParams.get('memberId') || undefined;
        const preview = this.threads.previewPendingHandoff(threadId, memberId);
        sendJson(res, 200, preview);
        return;
      }

      const msgMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/messages$/);
      if (msgMatch && method === 'POST') {
        const threadId = decodeURIComponent(msgMatch[1]);
        const body = await readJsonBody(req);
        const out = await this.threads.sendUserMessage({
          threadId,
          body: String(body.body || ''),
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined
        });
        const thread = this.threads.getThread(threadId)!;
        const artifact = thread.boundArtifactId
          ? this.artifacts.getArtifact(thread.boundArtifactId)
          : null;
        sendJson(res, 200, {
          ...out,
          messages: this.threads.listMessages(threadId),
          artifact,
          versions: artifact ? this.artifacts.listVersions(artifact.id) : []
        });
        return;
      }

      // Collaboration Space APIs (Documents, Files, Links, Folders, Workspace Browse, Tasks)
      const spaceMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space$/);
      if (spaceMatch && method === 'GET') {
        const threadId = decodeURIComponent(spaceMatch[1]);
        const thread = this.threads.getThread(threadId);
        if (!thread) return sendJson(res, 404, { error: '对话不存在' });
        const space = this.space.listSpace(threadId);
        const tasks = this.tasks
          .listTasks({ sourceThreadId: threadId })
          .map((t) => {
            const latestRun = this.tasks.listRuns(t.id)[0] ?? null;
            const steps = latestRun ? this.tasks.listSteps(latestRun.id) : [];
            return { ...t, latestRun, steps };
          });
        sendJson(res, 200, { ...space, tasks });
        return;
      }

      const spaceFoldersCreateMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/folders$/);
      if (spaceFoldersCreateMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceFoldersCreateMatch[1]);
        const body = await readJsonBody(req);
        const folder = this.space.createFolder({
          threadId,
          title: String(body.title || ''),
          parentFolderId: typeof body.parentFolderId === 'string' ? body.parentFolderId : null
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, { folder });
        return;
      }

      const spaceFolderItemMatch = pathname.match(/^\/api\/v2\/space\/folders\/([^/]+)$/);
      if (spaceFolderItemMatch && method === 'PATCH') {
        const folderId = decodeURIComponent(spaceFolderItemMatch[1]);
        const body = await readJsonBody(req);
        const folder = this.space.renameFolder(folderId, String(body.title || ''));
        this.threads.emit({ type: 'thread.space_updated', threadId: folder.threadId });
        sendJson(res, 200, { folder });
        return;
      }
      if (spaceFolderItemMatch && method === 'DELETE') {
        const folderId = decodeURIComponent(spaceFolderItemMatch[1]);
        const resDel = this.space.deleteFolder(folderId);
        this.threads.emit({ type: 'thread.space_updated', threadId: resDel.threadId });
        sendJson(res, 200, { ok: true, ...resDel });
        return;
      }

      const spaceDocsCreateMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/documents$/);
      if (spaceDocsCreateMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceDocsCreateMatch[1]);
        const body = await readJsonBody(req);
        const artifact = this.space.createDocument({
          threadId,
          title: String(body.title || '新建文档.md'),
          content: typeof body.content === 'string' ? body.content : undefined,
          folderId: typeof body.folderId === 'string' ? body.folderId : null
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, {
          artifact,
          versions: this.artifacts.listVersions(artifact.id)
        });
        return;
      }

      const spaceFilesUploadMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/files\/upload$/);
      if (spaceFilesUploadMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceFilesUploadMatch[1]);
        const contentType = String(req.headers['content-type'] || '');
        const rawBuf = await readRawBody(req, 52 * 1024 * 1024);
        let fileName = 'upload.bin';
        let mimeType: string | undefined;
        let folderId: string | null = null;
        let fileBuffer = rawBuf;

        if (contentType.toLowerCase().includes('multipart/form-data')) {
          const form = await new Response(new Uint8Array(rawBuf), {
            headers: { 'content-type': contentType }
          }).formData();
          const f = form.get('file');
          if (!f || typeof f === 'string') {
            return sendJson(res, 400, { error: 'missing_file', message: '请附带 file 文件字段' });
          }
          fileName = f.name || 'upload.bin';
          mimeType = f.type || undefined;
          fileBuffer = Buffer.from(await f.arrayBuffer());
          const fld = form.get('folderId');
          if (typeof fld === 'string' && fld.trim()) folderId = fld.trim();
        } else {
          fileName = decodeURIComponent(String(req.headers['x-file-name'] || url.searchParams.get('name') || 'upload.bin'));
          mimeType = contentType || undefined;
          folderId = url.searchParams.get('folderId') || null;
        }

        const file = this.space.saveFileBuffer({
          threadId,
          name: fileName,
          mimeType,
          buffer: fileBuffer,
          folderId
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, { file });
        return;
      }

      const spaceFilesCreateMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/files$/);
      if (spaceFilesCreateMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceFilesCreateMatch[1]);
        const body = await readJsonBody(req, 24 * 1024 * 1024);
        const file = this.space.saveFile({
          threadId,
          name: String(body.name || 'file.bin'),
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          dataBase64: String(body.dataBase64 || ''),
          folderId: typeof body.folderId === 'string' ? body.folderId : null
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, { file });
        return;
      }

      const spaceFileDownloadMatch = pathname.match(/^\/api\/v2\/space\/files\/([^/]+)$/);
      if (spaceFileDownloadMatch && method === 'GET') {
        const fileId = decodeURIComponent(spaceFileDownloadMatch[1]);
        const found = this.space.getFileWithPath(fileId);
        if (!found) return sendJson(res, 404, { error: '文件不存在' });
        const download = url.searchParams.get('download') === '1';
        const disp = download ? 'attachment' : 'inline';
        const encodedName = encodeURIComponent(found.file.name);
        res.writeHead(200, {
          'Content-Type': found.file.mimeType || 'application/octet-stream',
          'Content-Length': String(found.file.sizeBytes),
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `${disp}; filename*=UTF-8''${encodedName}`
        });
        fs.createReadStream(found.absPath).pipe(res);
        return;
      }

      const spaceLinksCreateMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/links$/);
      if (spaceLinksCreateMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceLinksCreateMatch[1]);
        const body = await readJsonBody(req);
        const link = this.space.createLink({
          threadId,
          title: String(body.title || ''),
          url: String(body.url || ''),
          note: typeof body.note === 'string' ? body.note : '',
          folderId: typeof body.folderId === 'string' ? body.folderId : null
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, { link });
        return;
      }

      const spaceItemMutateMatch = pathname.match(/^\/api\/v2\/space\/items\/(document|file|link)\/([^/]+)$/);
      if (spaceItemMutateMatch && method === 'PATCH') {
        const kind = spaceItemMutateMatch[1] as SpaceItemKind;
        const id = decodeURIComponent(spaceItemMutateMatch[2]);
        const body = await readJsonBody(req);
        const action = String(body.action || '');
        if (!['pin', 'unpin', 'move', 'rename', 'delete', 'restore'].includes(action)) {
          return sendJson(res, 400, { error: '无效操作类型' });
        }
        const out = this.space.mutateItem({
          kind,
          id,
          action: action as 'pin' | 'unpin' | 'move' | 'rename' | 'delete' | 'restore',
          title: typeof body.title === 'string' ? body.title : undefined,
          folderId:
            body.folderId === undefined
              ? undefined
              : body.folderId === null
                ? null
                : String(body.folderId)
        });
        this.threads.emit({ type: 'thread.space_updated', threadId: out.threadId });
        sendJson(res, 200, { ok: true, threadId: out.threadId });
        return;
      }
      if (spaceItemMutateMatch && method === 'DELETE') {
        const kind = spaceItemMutateMatch[1] as SpaceItemKind;
        const id = decodeURIComponent(spaceItemMutateMatch[2]);
        const out = this.space.purgeItem(kind, id);
        this.threads.emit({ type: 'thread.space_updated', threadId: out.threadId });
        sendJson(res, 200, { ok: true, threadId: out.threadId });
        return;
      }

      const spaceCtxMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/context$/);
      if (spaceCtxMatch && method === 'GET') {
        const threadId = decodeURIComponent(spaceCtxMatch[1]);
        const kind = url.searchParams.get('kind') as SpaceItemKind;
        const id = String(url.searchParams.get('id') || '');
        if (!['document', 'file', 'link'].includes(kind) || !id) {
          return sendJson(res, 400, { error: '参数不完整' });
        }
        const ctx = this.space.getMaterialContext(threadId, kind, id);
        sendJson(res, 200, ctx);
        return;
      }

      const spaceAssocCreateMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/space\/associations$/);
      if (spaceAssocCreateMatch && method === 'POST') {
        const threadId = decodeURIComponent(spaceAssocCreateMatch[1]);
        const body = await readJsonBody(req);
        const link = this.space.associateMaterialWithTask({
          threadId,
          kind: body.kind as SpaceItemKind,
          id: String(body.id || ''),
          taskId: String(body.taskId || ''),
          role: (body.role as MaterialTaskRole) || 'reference',
          resourceVersion:
            body.resourceVersion !== undefined ? Number(body.resourceVersion) : undefined
        });
        this.threads.emit({ type: 'thread.space_updated', threadId });
        sendJson(res, 201, { link });
        return;
      }

      const spaceAssocDelMatch = pathname.match(/^\/api\/v2\/space\/associations\/([^/]+)$/);
      if (spaceAssocDelMatch && method === 'DELETE') {
        const linkId = decodeURIComponent(spaceAssocDelMatch[1]);
        const out = this.space.unlinkMaterialFromTask(linkId);
        this.threads.emit({ type: 'thread.space_updated', threadId: out.threadId });
        sendJson(res, 200, { ok: true, threadId: out.threadId });
        return;
      }

      const workspaceBrowseMatch = pathname.match(/^\/api\/v2\/threads\/([^/]+)\/workspace-files$/);
      if (workspaceBrowseMatch && method === 'GET') {
        const threadId = decodeURIComponent(workspaceBrowseMatch[1]);
        const thread = this.threads.getThread(threadId);
        if (!thread) return sendJson(res, 404, { error: '对话不存在' });
        if (!thread.workspacePath) {
          sendJson(res, 200, { unconfigured: true, rootPath: null, subpath: '', entries: [] });
          return;
        }
        const subpath = url.searchParams.get('subpath') || '';
        const cleanSub = subpath.replace(/^[/\\]+/, '').replace(/\.\.(\/|\\|$)/g, '');
        const owner = this.db.getMember(thread.activeOwnerMemberId);
        const nodes = this.nodeHub.listNodes();
        const localNodeCandidate =
          (thread.workspaceNodeId ? this.nodeHub.getNode(thread.workspaceNodeId) : null) ??
          (owner?.location === 'local-node' && owner.nodeId ? this.nodeHub.getNode(owner.nodeId) : null) ??
          nodes.find(
            (n) =>
              n.kind === 'local' &&
              n.capabilities.allowedWorkspaceRoots?.some(
                (r) => thread.workspacePath === r || thread.workspacePath!.startsWith(r.replace(/\/+$/, '') + '/')
              )
          ) ??
          (!fs.existsSync(thread.workspacePath) ? nodes.find((n) => n.kind === 'local') ?? null : null);

        if (localNodeCandidate) {
          if (!this.nodeHub.isNodeOnline(localNodeCandidate.id)) {
            sendJson(res, 400, {
              error: 'node_offline',
              message: `本地电脑节点「${localNodeCandidate.name}」当前离线，开机连网后即可跨设备浏览此目录`
            });
            return;
          }
          try {
            const joined = cleanSub
              ? `${thread.workspacePath.replace(/\/+$/, '')}/${cleanSub}`
              : thread.workspacePath;
            const proxied = await this.nodeHub.listNodeDirectory(localNodeCandidate.id, joined);
            const entries = (proxied.entries || []).map((e) => ({
              ...e,
              relPath: cleanSub ? `${cleanSub}/${e.name}` : e.name
            }));
            sendJson(res, 200, {
              unconfigured: false,
              rootPath: thread.workspacePath,
              subpath: cleanSub,
              nodeName: localNodeCandidate.name,
              entries
            });
          } catch (err) {
            sendJson(res, 400, { error: 'workspace_browse_failed', message: (err as Error).message });
          }
          return;
        }

        try {
          const listing = this.space.listWorkspaceFiles(thread.workspacePath, subpath);
          sendJson(res, 200, { unconfigured: false, ...listing });
        } catch (err) {
          sendJson(res, 400, { error: 'workspace_browse_failed', message: (err as Error).message });
        }
        return;
      }

      if (pathname === '/api/v2/tasks' && method === 'POST') {
        const body = await readJsonBody(req);
        const kind = body.kind === 'scheduled' ? 'scheduled' : 'once';
        const startImmediately =
          body.startImmediately !== undefined
            ? Boolean(body.startImmediately)
            : kind !== 'scheduled';
        const created = this.tasks.createOrUpdateTask({
          taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
          sourceThreadId: String(body.sourceThreadId || ''),
          title: String(body.title || ''),
          kind,
          cronExpr: typeof body.cronExpr === 'string' ? body.cronExpr : null,
          intervalSeconds: typeof body.intervalSeconds === 'number' ? body.intervalSeconds : null,
          timezone: typeof body.timezone === 'string' ? body.timezone : 'Asia/Shanghai',
          misfirePolicy:
            body.misfirePolicy === 'skip_stale' || body.misfirePolicy === 'catch_up_once'
              ? body.misfirePolicy
              : undefined,
          leadMemberId: String(body.leadMemberId || ''),
          spec: body.spec as any,
          startImmediately
        });
        if (created.initialRun) {
          void this.tasks.driveRun(created.initialRun.id).catch(() => {});
        }
        sendJson(res, 201, created);
        return;
      }

      const taskDetailMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/);
      if (taskDetailMatch && method === 'DELETE') {
        const taskId = decodeURIComponent(taskDetailMatch[1]);
        const removed = await this.tasks.deleteTask(taskId);
        sendJson(res, 200, { ok: true, taskId, ...removed });
        return;
      }
      if (taskDetailMatch && method === 'GET') {
        const taskId = decodeURIComponent(taskDetailMatch[1]);
        const task = this.tasks.getTask(taskId);
        if (!task) return sendJson(res, 404, { error: '任务不存在' });
        const runs = this.tasks.listRuns(taskId);
        const requestedRunId = url.searchParams.get('runId');
        const activeRun =
          (requestedRunId ? runs.find((r) => r.id === requestedRunId) : null) ?? runs[0] ?? null;
        const steps = activeRun
          ? this.tasks.listSteps(activeRun.id).map((s) => ({
              ...s,
              submissions: this.tasks.listSubmissions(s.id),
              reviews: this.tasks.listReviews(s.id)
            }))
          : [];
        const artifact = activeRun?.finalArtifactId
          ? this.artifacts.getArtifact(activeRun.finalArtifactId)
          : null;
        const versions = artifact ? this.artifacts.listVersions(artifact.id) : [];
        sendJson(res, 200, { task, runs, activeRun, steps, artifact, versions });
        return;
      }

      const toggleMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/schedule$/);
      if (toggleMatch && method === 'POST') {
        const taskId = decodeURIComponent(toggleMatch[1]);
        const body = await readJsonBody(req);
        const task = this.scheduler.toggleTaskSchedule(taskId, Boolean(body.enabled));
        sendJson(res, 200, { task });
        return;
      }

      const runNowMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/run$/);
      if (runNowMatch && method === 'POST') {
        const taskId = decodeURIComponent(runNowMatch[1]);
        const { run } = this.tasks.instantiateRun({
          taskId,
          plannedSlotAt: `manual:${Date.now()}`,
          triggerType: 'manual'
        });
        void this.tasks.driveRun(run.id).catch(() => {});
        sendJson(res, 201, { run });
        return;
      }

      const cancelRunMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/cancel$/);
      if (cancelRunMatch && method === 'POST') {
        const runId = decodeURIComponent(cancelRunMatch[1]);
        const run = await this.tasks.cancelRun(runId);
        sendJson(res, 200, { run });
        return;
      }

      const waitingReplyMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/reply$/);
      if (waitingReplyMatch && method === 'POST') {
        const runId = decodeURIComponent(waitingReplyMatch[1]);
        const body = await readJsonBody(req);
        const run = await this.tasks.resumeWaitingRunWithUserReply({
          runId,
          userReply: String(body.reply || '')
        });
        sendJson(res, 200, { run });
        return;
      }

      const artMatch = pathname.match(/^\/api\/v2\/artifacts\/([^/]+)$/);
      if (artMatch && method === 'GET') {
        const artifactId = decodeURIComponent(artMatch[1]);
        const artifact = this.artifacts.getArtifact(artifactId);
        if (!artifact) return sendJson(res, 404, { error: '文稿不存在' });
        sendJson(res, 200, {
          artifact,
          versions: this.artifacts.listVersions(artifactId)
        });
        return;
      }
      if (artMatch && method === 'POST') {
        const artifactId = decodeURIComponent(artMatch[1]);
        const body = await readJsonBody(req);
        const current = this.artifacts.getArtifact(artifactId);
        if (!current) return sendJson(res, 404, { error: '文稿不存在' });
        const expectedBaseVersion =
          body.expectedBaseVersion !== undefined
            ? Number(body.expectedBaseVersion)
            : current.headVersion;
        const result = this.artifacts.writeArtifact({
          artifactId,
          expectedBaseVersion,
          title: typeof body.title === 'string' ? body.title : undefined,
          content: String(body.content ?? ''),
          writerKind: 'user',
          writerId: 'owner'
        });
        this.threads.emit({ type: 'thread.space_updated', threadId: result.artifact.sourceThreadId });
        sendJson(res, 200, {
          ...result,
          versions: this.artifacts.listVersions(artifactId)
        });
        return;
      }

      // Scoped Agent Sandbox Tool Endpoint (enforces 403 on unauthorized Worker calls!)
      if (pathname === '/api/v2/agent-tools/call' && method === 'POST') {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const claims = this.sandbox.verifyToken(token);
        const body = await readJsonBody(req);
        const result = await this.executeScopedAgentTool(
          claims,
          String(body.toolName || ''),
          (body.args as Record<string, unknown>) ?? {}
        );
        sendJson(res, 200, { result });
        return;
      }

      // Webhook Bot Callback Endpoint (single-use callbackToken, idempotent duplicate 200, forged 403)
      if (pathname === '/api/v2/webhooks/callback' && method === 'POST') {
        const body = await readJsonBody(req);
        const out = this.registry.webhookDriver.receiveCallback({
          attemptId: String(body.attemptId || ''),
          callbackToken: String(body.callbackToken || ''),
          text: typeof body.text === 'string' ? body.text : undefined,
          error: typeof body.error === 'string' ? body.error : undefined
        });
        sendJson(res, out.httpStatus, out);
        return;
      }

      // Reconcile endpoint
      if (pathname === '/api/v2/reconcile' && method === 'POST') {
        const attempts = await this.registry.reconcileInFlightAttempts({ waitTimeoutMs: 5000 });
        const messages = this.threads.syncReconciledThreadTurns();
        const runs = await this.tasks.reconcileInFlightTaskRuns();
        sendJson(res, 200, { attempts, messages, runs });
        return;
      }

      // Serve built static web assets if available
      if (this.staticWebDir && method === 'GET' && !pathname.startsWith('/api/')) {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const candidate = path.resolve(this.staticWebDir, rel);
        if (candidate.startsWith(path.resolve(this.staticWebDir)) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          res.writeHead(200, { 'Content-Type': contentTypeFor(candidate) });
          fs.createReadStream(candidate).pipe(res);
          return;
        }
        const indexHtml = path.join(this.staticWebDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(indexHtml).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      if (err instanceof SandboxForbiddenError) {
        sendJson(res, 403, { error: err.code, message: err.message });
        return;
      }
      const status = typeof (err as any)?.statusCode === 'number' ? (err as any).statusCode : 500;
      const persistedUserMessageId =
        typeof (err as any)?.persistedUserMessageId === 'string'
          ? (err as any).persistedUserMessageId
          : null;
      sendJson(res, status, {
        error: status === 403 ? 'forbidden' : 'request_failed',
        message: (err as Error).message || '请求处理失败',
        ...(persistedUserMessageId ? { persistedUserMessageId } : {})
      });
    }
  }
}

function loadBuildInfoFromDisk(staticWebDir: string | null): BuildInfoMeta {
  const candidates: string[] = [];
  if (staticWebDir) {
    candidates.push(path.resolve(staticWebDir, '../build-info.json'));
  }
  candidates.push(path.resolve(process.cwd(), 'dist/build-info.json'));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BuildInfoMeta>;
        if (parsed.id) {
          return {
            id: String(parsed.id),
            version: String(parsed.version || '2.0.0'),
            builtAt: parsed.builtAt ? String(parsed.builtAt) : undefined,
            commit: parsed.commit ? String(parsed.commit) : undefined
          };
        }
      }
    } catch {
      // ignore unreadable build-info
    }
  }
  return { id: 'dev', version: '2.0.0' };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readRawBody(
  req: http.IncomingMessage,
  maxBytes = 52 * 1024 * 1024
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request payload exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 4 * 1024 * 1024
): Promise<Record<string, any>> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8')) as Record<string, any>;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
