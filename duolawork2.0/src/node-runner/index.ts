import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { AcpStdioDriver } from '../server/drivers/acp-driver.js';
import { ClaudeCliDriver } from '../server/drivers/claude-cli-driver.js';
import { CodexAppServerDriver, resolveLocalProxyEnv } from '../server/drivers/codex-driver.js';
import { MockDriver } from '../server/drivers/mock-driver.js';
import { redactSecrets, type AgentDriver, type TurnExecutionResult } from '../server/drivers/types.js';
import type { NodeHelloMember } from '../server/node-hub.js';
import { isExcludedClaudeVps, type DriverKind, type MemberRecord, type WorkspaceFileEntry } from '../shared/types.js';

interface OutboxEntry {
  attemptId: string;
  ok: boolean;
  text?: string;
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  sessionReset?: boolean;
  providerUsage?: TurnExecutionResult['providerUsage'];
  errorMessage?: string;
  createdAt: number;
}

export interface NodeRunnerConfig {
  serverUrl: string; // e.g. https://work.manyaitool.com or http://127.0.0.1:8780
  nodeToken: string;
  name: string;
  kind: 'cloud' | 'local';
  members: NodeHelloMember[];
  allowWorkspaceBrowse?: boolean;
  allowedWorkspaceRoots?: string[];
  outboxPath?: string;
  appVersion?: string;
  mockDriver?: MockDriver;
}

const OUTBOX_TTL_MS = 24 * 3600 * 1000;

/**
 * Universal Outbound Execution Node (`duolawork-node`):
 * - Runs on ANY Linux VPS, Mac, or Windows machine behind NAT/firewalls.
 * - Connects outbound to the DuolaWork Cloud Control Plane over WebSocket.
 * - Reuses existing local drivers (`CodexAppServerDriver`, `ClaudeCliDriver`, `AcpStdioDriver`) with ZERO rewrite!
 * - Persists finished results in a local `outbox.json` until Cloud sends `turn.ack`,
 *   guaranteeing zero lost replies and zero duplicate LLM executions across disconnects or cloud restarts.
 */
export class DuolaWorkNodeRunner {
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly runningAttempts = new Map<string, { member: MemberRecord; driver: AgentDriver }>();
  private readonly pendingToolCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly outboxPath: string | null;

  constructor(private readonly config: NodeRunnerConfig) {
    this.drivers.set('codex-app-server', new CodexAppServerDriver());
    this.drivers.set('claude-cli', new ClaudeCliDriver());
    this.drivers.set('acp-stdio', new AcpStdioDriver());
    this.drivers.set('mock', config.mockDriver ?? new MockDriver());
    this.outboxPath = config.outboxPath ?? null;
    this.loadOutbox();
  }

  public start(): Promise<void> {
    this.stopped = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.connect((err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('NODE_STOPPED'));
    }
    this.pendingToolCalls.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private buildWsUrl(): string {
    const base = this.config.serverUrl.replace(/\/+$/, '');
    const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    return `${wsBase}/api/v2/nodes/ws`;
  }

  private resolveProxyUrl(targetUrl: URL): string | null {
    const host = targetUrl.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
    const proxyEnv = resolveLocalProxyEnv();
    const raw =
      proxyEnv.HTTPS_PROXY ||
      proxyEnv.https_proxy ||
      proxyEnv.HTTP_PROXY ||
      proxyEnv.http_proxy ||
      '';
    return /^https?:\/\//i.test(raw) ? raw : null;
  }

  private openWsSocket(wsUrl: string): Promise<WebSocket> {
    const parsed = new URL(wsUrl);
    const proxyUrl = this.resolveProxyUrl(parsed);
    const headers = { Authorization: `Bearer ${this.config.nodeToken}` };
    if (!proxyUrl) {
      return Promise.resolve(new WebSocket(wsUrl, { headers }));
    }

    const proxy = new URL(proxyUrl);
    const targetPort = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
    const connectHost = `${parsed.hostname}:${targetPort}`;

    return new Promise<WebSocket>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: 'CONNECT',
        path: connectHost,
        headers: { Host: connectHost }
      });
      req.once('error', reject);
      req.once('connect', (res, tunnelSocket) => {
        if (res.statusCode !== 200) {
          tunnelSocket.destroy();
          reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
          return;
        }
        const transport =
          parsed.protocol === 'wss:'
            ? tls.connect({ socket: tunnelSocket, servername: parsed.hostname })
            : tunnelSocket;
        const ws = new WebSocket(wsUrl, {
          headers,
          createConnection: () => transport
        });
        resolve(ws);
      });
      req.end();
    });
  }

  private connect(onFirstWelcome?: (err?: Error) => void): void {
    if (this.stopped) return;
    void this.openWsSocket(this.buildWsUrl())
      .then((ws) => {
        if (this.stopped) {
          ws.close();
          return;
        }
        this.bindSocket(ws, onFirstWelcome);
      })
      .catch((err) => {
        if (onFirstWelcome) {
          onFirstWelcome(err instanceof Error ? err : new Error(String(err)));
        } else if (!this.stopped) {
          this.scheduleReconnect();
        }
      });
  }

  private bindSocket(ws: WebSocket, onFirstWelcome?: (err?: Error) => void): void {
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      const safeMembers = this.config.members.filter(
        (m) => !isExcludedClaudeVps({ id: m.id, name: m.name, platformId: m.platformId, driverKind: 'remote-node', location: this.config.kind === 'cloud' ? 'cloud-node' : 'local-node' })
      );
      this.send({
        type: 'node.hello',
        name: this.config.name,
        kind: this.config.kind,
        platform: process.platform,
        version: this.config.appVersion || '2.0.0',
        drivers: [...this.drivers.keys()],
        allowWorkspaceBrowse: Boolean(this.config.allowWorkspaceBrowse),
        allowedWorkspaceRoots: this.config.allowedWorkspaceRoots ?? [],
        members: safeMembers
      });

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: 'node.ping', ts: Date.now(), activeAttempts: [...this.runningAttempts.keys()] });
        }
      }, 15_000);
      this.pingTimer.unref?.();
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'node.welcome') {
        this.flushOutbox();
        onFirstWelcome?.();
        return;
      }
      void this.handleServerFrame(msg).catch(() => {});
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      if (onFirstWelcome) {
        onFirstWelcome(err instanceof Error ? err : new Error(String(err)));
        onFirstWelcome = undefined;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delays = [1000, 2000, 5000, 10000, 15000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleServerFrame(msg: any): Promise<void> {
    const type = String(msg?.type || '');

    if (type === 'node.ping') {
      this.send({ type: 'node.pong', ts: msg.ts ?? Date.now() });
      return;
    }
    if (type === 'node.pong') return;

    if (type === 'turn.ack') {
      const attemptId = String(msg.attemptId || '');
      if (attemptId && this.outbox.delete(attemptId)) {
        this.saveOutbox();
      }
      return;
    }

    if (type === 'turn.tool_result') {
      const callId = String(msg.callId || '');
      const pending = this.pendingToolCalls.get(callId);
      if (!pending) return;
      this.pendingToolCalls.delete(callId);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(String(msg.error || '工具调用被拒绝')));
      return;
    }

    if (type === 'session.ensure') {
      const reqId = String(msg.reqId || '');
      try {
        const member = msg.member as MemberRecord;
        if (isExcludedClaudeVps(member)) {
          throw new Error('按所有者规则禁止调用被排除的 VPS Claude 实例');
        }
        const driver = this.resolveDriver(member.driverKind);
        const ensured = await driver.ensureSession({
          member,
          scopeKey: String(msg.scopeKey || ''),
          cwd: String(msg.cwd || os.tmpdir()),
          existingNativeSessionId: msg.existingNativeSessionId ?? null,
          dynamicTools: Array.isArray(msg.dynamicTools) ? msg.dynamicTools : []
        });
        this.send({ type: 'rpc.result', reqId, ok: true, result: ensured });
      } catch (err) {
        this.send({ type: 'rpc.result', reqId, ok: false, error: redactSecrets((err as Error).message) });
      }
      return;
    }

    if (type === 'turn.dispatch') {
      const attemptId = String(msg.attemptId || '');
      if (!attemptId) return;

      // Idempotent replay if already completed in local outbox!
      const cached = this.outbox.get(attemptId);
      if (cached) {
        this.emitOutboxEntry(cached);
        return;
      }

      const member = msg.member as MemberRecord;
      if (isExcludedClaudeVps(member)) {
        this.recordAndEmitOutbox({
          attemptId,
          ok: false,
          errorMessage: '按所有者规则禁止调用被排除的 VPS Claude 实例',
          createdAt: Date.now()
        });
        return;
      }

      const driver = this.resolveDriver(member.driverKind);
      this.runningAttempts.set(attemptId, { member, driver });

      void driver
        .runTurn(
          {
            attemptId,
            member,
            scopeKey: String(msg.scopeKey || ''),
            cwd: String(msg.cwd || os.tmpdir()),
            nativeSessionId: String(msg.nativeSessionId || ''),
            prompt: String(msg.prompt || ''),
            fallbackFullPrompt: typeof msg.fallbackFullPrompt === 'string' ? msg.fallbackFullPrompt : undefined,
            timeoutMs: typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 900_000,
            dynamicTools: Array.isArray(msg.dynamicTools) ? msg.dynamicTools : [],
            onToolCall: (toolName, args) => this.invokeCloudTool(attemptId, toolName, args)
          },
          (ev) => {
            if (ev.kind === 'started') {
              this.send({ type: 'turn.started', attemptId });
            } else if (ev.kind === 'delta' && ev.text) {
              this.send({ type: 'turn.delta', attemptId, text: ev.text });
            } else if (ev.kind === 'tool' && ev.toolName) {
              this.send({
                type: 'turn.tool_trace',
                attemptId,
                toolId: ev.toolId,
                name: ev.toolName,
                summary: ev.toolSummary,
                status: ev.toolStatus
              });
            }
          }
        )
        .then((res) => {
          this.runningAttempts.delete(attemptId);
          this.recordAndEmitOutbox({
            attemptId,
            ok: true,
            text: res.text,
            nativeSessionId: res.nativeSessionId,
            nativeTurnId: res.nativeTurnId,
            sessionReset: res.sessionReset,
            providerUsage: res.providerUsage,
            createdAt: Date.now()
          });
        })
        .catch((err) => {
          this.runningAttempts.delete(attemptId);
          this.recordAndEmitOutbox({
            attemptId,
            ok: false,
            errorMessage: redactSecrets((err as Error).message || '节点执行失败'),
            createdAt: Date.now()
          });
        });
      return;
    }

    if (type === 'turn.abort') {
      const attemptId = String(msg.attemptId || '');
      const running = this.runningAttempts.get(attemptId);
      if (running) {
        await running.driver.abortTurn(running.member, { id: attemptId } as any).catch(() => {});
      }
      return;
    }

    if (type === 'turn.reconcile') {
      const reqId = String(msg.reqId || '');
      const attemptId = String(msg.attemptId || '');
      if (this.runningAttempts.has(attemptId)) {
        this.send({ type: 'rpc.result', reqId, ok: true, result: { state: 'still_running' } });
        return;
      }
      const cached = this.outbox.get(attemptId);
      if (cached) {
        if (cached.ok) {
          this.send({
            type: 'rpc.result',
            reqId,
            ok: true,
            result: {
              state: 'completed',
              text: cached.text ?? '',
              nativeSessionId: cached.nativeSessionId ?? null,
              nativeTurnId: cached.nativeTurnId ?? null,
              providerUsage: cached.providerUsage
            }
          });
        } else {
          this.send({
            type: 'rpc.result',
            reqId,
            ok: true,
            result: { state: 'failed', errorMessage: cached.errorMessage || '节点执行失败' }
          });
        }
        return;
      }
      this.send({ type: 'rpc.result', reqId, ok: true, result: { state: 'not_found' } });
      return;
    }

    if (type === 'fs.list_dir') {
      const reqId = String(msg.reqId || '');
      try {
        if (!this.config.allowWorkspaceBrowse) {
          throw new Error('该执行节点未开启本地目录浏览权限');
        }
        const roots = (this.config.allowedWorkspaceRoots ?? []).map((r) => path.resolve(r));
        const target = path.resolve(String(msg.targetPath || roots[0] || os.homedir()));
        const isAllowed =
          roots.length > 0 &&
          roots.some((root) => target === root || target.startsWith(root + path.sep));
        if (!isAllowed) {
          throw new Error('目标目录不在该节点授权白名单范围内');
        }
        const dirents = fs.readdirSync(target, { withFileTypes: true });
        const entries: WorkspaceFileEntry[] = [];
        for (const d of dirents) {
          if (d.name.startsWith('.') || d.name === 'node_modules') continue;
          const full = path.join(target, d.name);
          let st: fs.Stats | null = null;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          entries.push({
            name: d.name,
            relPath: d.name,
            kind: d.isDirectory() ? 'dir' : 'file',
            sizeBytes: d.isDirectory() ? 0 : st.size,
            updatedAt: st.mtime.toISOString()
          });
          if (entries.length >= 200) break;
        }
        entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        this.send({ type: 'rpc.result', reqId, ok: true, result: { root: target, entries } });
      } catch (err) {
        this.send({ type: 'rpc.result', reqId, ok: false, error: redactSecrets((err as Error).message) });
      }
      return;
    }
  }

  private invokeCloudTool(
    attemptId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('云端控制面连接已断开，无法调用沙箱工具'));
    }
    const callId = `tc_${randomUUID().slice(0, 12)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error(`云端工具调用超时: ${toolName}`));
      }, 30_000);
      timer.unref?.();
      this.pendingToolCalls.set(callId, { resolve, reject, timer });
      this.send({ type: 'turn.tool_call', callId, attemptId, toolName, args });
    });
  }

  private resolveDriver(kind: DriverKind | string): AgentDriver {
    const d = this.drivers.get(kind);
    if (!d) throw new Error(`节点不支持该本地驱动类型: ${kind}`);
    return d;
  }

  private recordAndEmitOutbox(entry: OutboxEntry): void {
    this.outbox.set(entry.attemptId, entry);
    this.saveOutbox();
    this.emitOutboxEntry(entry);
  }

  private emitOutboxEntry(entry: OutboxEntry): void {
    if (entry.ok) {
      this.send({
        type: 'turn.completed',
        attemptId: entry.attemptId,
        text: entry.text ?? '',
        nativeSessionId: entry.nativeSessionId ?? '',
        nativeTurnId: entry.nativeTurnId ?? null,
        sessionReset: entry.sessionReset ?? false,
        providerUsage: entry.providerUsage
      });
    } else {
      this.send({
        type: 'turn.failed',
        attemptId: entry.attemptId,
        errorMessage: entry.errorMessage || '节点执行失败'
      });
    }
  }

  private flushOutbox(): void {
    const cutoff = Date.now() - OUTBOX_TTL_MS;
    let mutated = false;
    for (const [id, entry] of this.outbox.entries()) {
      if (entry.createdAt < cutoff) {
        this.outbox.delete(id);
        mutated = true;
        continue;
      }
      this.emitOutboxEntry(entry);
    }
    if (mutated) this.saveOutbox();
  }

  private loadOutbox(): void {
    if (!this.outboxPath || !fs.existsSync(this.outboxPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.outboxPath, 'utf8')) as OutboxEntry[];
      const cutoff = Date.now() - OUTBOX_TTL_MS;
      for (const e of raw) {
        if (e?.attemptId && e.createdAt >= cutoff) {
          this.outbox.set(e.attemptId, e);
        }
      }
    } catch {
      // ignore corrupted outbox
    }
  }

  private saveOutbox(): void {
    if (!this.outboxPath) return;
    try {
      fs.mkdirSync(path.dirname(this.outboxPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.outboxPath, JSON.stringify([...this.outbox.values()], null, 2), { mode: 0o600 });
    } catch {
      // ignore outbox persistence errors
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

// Standalone CLI entrypoint: `node dist/node-runner/index.mjs [--config /path/to/node.json]`
async function runCliIfMain(): Promise<void> {
  let isMain = false;
  if (process.argv[1]) {
    try {
      const realArg = fs.realpathSync(process.argv[1]);
      isMain =
        import.meta.url === pathToFileURL(realArg).href ||
        import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
    } catch {
      isMain = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
    }
  }
  if (!isMain) return;

  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath =
    (configIdx >= 0 && args[configIdx + 1]) ||
    process.env.DUOLAWORK_NODE_CONFIG ||
    path.join(os.homedir(), '.config', 'duolawork-node', 'config.json');

  if (args[0] === 'pair') {
    const serverIdx = args.indexOf('--server');
    const codeIdx = args.indexOf('--code');
    const nameIdx = args.indexOf('--name');
    const kindIdx = args.indexOf('--kind');
    const serverUrl = (serverIdx >= 0 ? args[serverIdx + 1] : '').replace(/\/+$/, '');
    const code = codeIdx >= 0 ? args[codeIdx + 1] : '';
    const name = nameIdx >= 0 ? args[nameIdx + 1] : os.hostname();
    const kind = kindIdx >= 0 && args[kindIdx + 1] === 'cloud' ? 'cloud' : 'local';
    if (!serverUrl || !code) {
      console.error('用法: duolawork-node pair --server https://work.manyaitool.com --code 123456 [--name 节点名] [--kind local|cloud]');
      process.exit(1);
    }
    const res = await fetch(`${serverUrl}/api/v2/nodes/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, kind, platform: process.platform })
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      console.error('配对失败:', data?.message || data?.error || res.status);
      process.exit(1);
    }
    const cfg: NodeRunnerConfig = {
      serverUrl,
      nodeToken: data.nodeToken,
      name: data.node.name,
      kind: data.node.kind,
      allowWorkspaceBrowse: kind === 'local',
      allowedWorkspaceRoots: kind === 'local' ? [os.homedir()] : [],
      outboxPath: path.join(path.dirname(configPath), 'outbox.json'),
      members: []
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log(`节点配对成功: ${data.node.id} (${data.node.name}) -> 配置已保存至 ${configPath}`);
    return;
  }

  if (!fs.existsSync(configPath)) {
    console.error(`未找到节点配置文件: ${configPath}（请先运行 pair 子命令完成配对）`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as NodeRunnerConfig;
  if (!cfg.outboxPath) {
    cfg.outboxPath = path.join(path.dirname(configPath), 'outbox.json');
  }
  const runner = new DuolaWorkNodeRunner(cfg);
  await runner.start();
  console.log(`[duolawork-node] connected to ${cfg.serverUrl} as "${cfg.name}" (${cfg.kind})`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      runner.stop();
      process.exit(0);
    });
  }
}

void runCliIfMain();
