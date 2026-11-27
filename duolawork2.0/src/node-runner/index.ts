import { runWithChatImages, type ChatImageDelivery } from '../server/drivers/chat-image-delivery.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { AcpStdioDriver } from '../server/drivers/acp-driver.js';
import { ClaudeCliDriver } from '../server/drivers/claude-cli-driver.js';
import { CodexAppServerDriver, resolveLocalProxyEnv } from '../server/drivers/codex-driver.js';
import { MockDriver } from '../server/drivers/mock-driver.js';
import {
  redactSecrets,
  SPACE_TOOL_NAMES,
  type AgentDriver,
  type DynamicToolDefinition,
  type McpHttpServerConfig,
  type TurnExecutionResult,
  type TurnImageAttachment
} from '../server/drivers/types.js';
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
  private canResumeTools = false;
  private readonly pendingToolCalls = new Map<string, { frame: Record<string, unknown>; sent: boolean; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly activeMcpAttempts = new Map<
    string,
    { token: string; tools: DynamicToolDefinition[]; delivery?: ChatImageDelivery }
  >();
  private loopbackMcpServer: http.Server | null = null;
  private loopbackMcpPort: number | null = null;
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

  public async start(): Promise<void> {
    this.stopped = false;
    await this.ensureLoopbackMcpServer();
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
    this.activeMcpAttempts.clear();
    if (this.loopbackMcpServer) {
      try {
        this.loopbackMcpServer.close();
      } catch {
        // ignore
      }
      this.loopbackMcpServer = null;
      this.loopbackMcpPort = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private async ensureLoopbackMcpServer(): Promise<void> {
    if (this.loopbackMcpServer && this.loopbackMcpPort) return;
    const server = http.createServer((req, res) => {
      void this.handleLoopbackMcpRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    this.loopbackMcpServer = server;
    this.loopbackMcpPort = typeof addr === 'object' && addr ? addr.port : null;
  }

  private async handleLoopbackMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const match = reqUrl.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const attemptId = decodeURIComponent(match[1]);
    const entry = this.activeMcpAttempts.get(attemptId);
    const authHeader = String(req.headers.authorization || '');
    if (!entry || authHeader !== `Bearer ${entry.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > 36 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
      chunks.push(buf);
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const handleOne = async (msg: any): Promise<Record<string, unknown> | null> => {
      const id = msg?.id;
      const method = String(msg?.method || '');
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return null;
      }
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: String(msg?.params?.protocolVersion || '2024-11-05'),
            capabilities: { tools: {} },
            serverInfo: { name: 'duolawork-space', version: '2.0.0' }
          }
        };
      }
      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: entry.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          }
        };
      }
      if (method === 'tools/call') {
        const toolName = String(msg?.params?.name || '');
        const toolArgs =
          msg?.params?.arguments && typeof msg.params.arguments === 'object'
            ? (msg.params.arguments as Record<string, unknown>)
            : {};
        if (!entry.tools.some((t) => t.name === toolName)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `未授权或未知协作空间工具: ${toolName}` }]
            }
          };
        }
        try {
          const out = await this.invokeCloudTool(attemptId, toolName, toolArgs);
          this.activeMcpAttempts.get(attemptId)?.delivery?.toolResult(toolName, toolArgs, out);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }]
            }
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: redactSecrets((err as Error).message || '工具调用失败') }]
            }
          };
        }
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    };

    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map(handleOne))).filter(Boolean);
      if (results.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
      return;
    }

    const single = await handleOne(payload);
    if (!single) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(single));
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
        resumesToolCalls: true,
        name: this.config.name,
        kind: this.config.kind,
        platform: process.platform,
        version: this.config.appVersion || '2.0.0',
        drivers: [...this.drivers.keys()],
        allowWorkspaceBrowse: Boolean(this.config.allowWorkspaceBrowse),
        allowedWorkspaceRoots: this.config.allowedWorkspaceRoots ?? [],
        activeAttempts: [...this.runningAttempts.keys()],
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
        this.canResumeTools = msg.resumesToolCalls === true;
        for (const pending of this.pendingToolCalls.values()) {
          if (!pending.sent || this.canResumeTools) {
            this.send(pending.frame);
            pending.sent = true;
          }
        }
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
      if (this.canResumeTools) this.send({ type: 'turn.tool_ack', attemptId: pending.frame.attemptId, callId });
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(String(msg.error || '工具调用被拒绝')));
      return;
    }

    if (type === 'member.check_health') {
      const reqId = String(msg.reqId || '');
      try {
        const member = msg.member as MemberRecord;
        if (isExcludedClaudeVps(member)) {
          this.send({
            type: 'rpc.result',
            reqId,
            ok: true,
            result: { status: 'offline', message: '按所有者规则排除 VPS 订阅 Claude 实例' }
          });
          return;
        }
        const driver = this.resolveDriver(member.driverKind);
        const health =
          driver instanceof ClaudeCliDriver
            ? await driver.checkHealth(member, { deepProbe: true })
            : await driver.checkHealth(member);
        this.send({ type: 'rpc.result', reqId, ok: true, result: health });
      } catch (err) {
        this.send({
          type: 'rpc.result',
          reqId,
          ok: true,
          result: { status: 'offline', message: redactSecrets((err as Error).message) }
        });
      }
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
          existingBridgeMeta: msg.existingBridgeMeta ?? null,
          dynamicTools: Array.isArray(msg.dynamicTools) ? msg.dynamicTools : [],
          mcpServers: Array.isArray(msg.mcpServers) ? (msg.mcpServers as McpHttpServerConfig[]) : []
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

      const dynamicTools: DynamicToolDefinition[] = Array.isArray(msg.dynamicTools) ? msg.dynamicTools : [];
      const incomingMcpServers: McpHttpServerConfig[] = Array.isArray(msg.mcpServers)
        ? (msg.mcpServers as McpHttpServerConfig[])
        : [];
      const effectiveMcpServers: McpHttpServerConfig[] = [...incomingMcpServers];

      const spaceToolsForMcp = dynamicTools.filter((t) => SPACE_TOOL_NAMES.has(t.name));
      if (
        (member.driverKind === 'acp-stdio' || member.driverKind === 'claude-cli') &&
        spaceToolsForMcp.length > 0 &&
        this.loopbackMcpPort
      ) {
        const mcpToken = randomUUID().replace(/-/g, '');
        this.activeMcpAttempts.set(attemptId, { token: mcpToken, tools: spaceToolsForMcp });
        effectiveMcpServers.push({
          name: 'duolawork-space',
          url: `http://127.0.0.1:${this.loopbackMcpPort}/mcp/${encodeURIComponent(attemptId)}`,
          headers: { Authorization: `Bearer ${mcpToken}` }
        });
      }

      const incomingImages: TurnImageAttachment[] = Array.isArray(msg.images)
        ? (msg.images as TurnImageAttachment[])
        : [];
      const hydratedImages: TurnImageAttachment[] = [];
      let tempImageDir: string | null = null;
      if (incomingImages.length > 0) {
        tempImageDir = path.join(os.tmpdir(), 'duolawork-chat-images', attemptId.replace(/[^a-zA-Z0-9_-]/g, '_'));
        fs.mkdirSync(tempImageDir, { recursive: true, mode: 0o700 });
        for (let idx = 0; idx < incomingImages.length; idx++) {
          const img = incomingImages[idx];
          if (!img?.dataBase64) continue;
          const safeName = `${idx + 1}-${path.basename(String(img.name || 'image.png')).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_')}`;
          const localPath = path.join(tempImageDir, safeName);
          try {
            fs.writeFileSync(localPath, Buffer.from(img.dataBase64, 'base64'), { mode: 0o600 });
            hydratedImages.push({ ...img, localPath });
          } catch {
            hydratedImages.push(img);
          }
        }
      }

      const imagePathNote =
        hydratedImages.length > 0
          ? `\n\n[用户随本条消息附带了 ${hydratedImages.length} 张图片，你可直接查看或用本地读取工具查看：\n${hydratedImages
              .map((img) => `- ${img.name} (${img.mimeType})${img.localPath ? ` 本地路径: ${img.localPath}` : ''}`)
              .join('\n')}\n]`
          : '';
      const promptWithImages = `${String(msg.prompt || '')}${imagePathNote}`;
      const fallbackWithImages =
        typeof msg.fallbackFullPrompt === 'string'
          ? `${msg.fallbackFullPrompt}${imagePathNote}`
          : undefined;

      const cleanupTempImages = () => {
        if (tempImageDir) {
          try {
            fs.rmSync(tempImageDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      };

      void runWithChatImages(driver,
          {
            attemptId,
            member,
            scopeKey: String(msg.scopeKey || ''),
            cwd: String(msg.cwd || os.tmpdir()),
            nativeSessionId: String(msg.nativeSessionId || ''),
            bridgeMeta: msg.bridgeMeta ?? null,
            prompt: promptWithImages,
            fallbackFullPrompt: fallbackWithImages,
            timeoutMs: typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 900_000,
            dynamicTools,
            mcpServers: effectiveMcpServers,
            ...(hydratedImages.length > 0 ? { images: hydratedImages } : {}),
            onToolCall: (toolName, args) => this.invokeCloudTool(attemptId, toolName, args)
          },
          (ev) => {
            if (ev.kind === 'started') {
              this.send({ type: 'turn.started', attemptId });
            } else if (ev.kind === 'progress') {
              this.send({ type: 'turn.progress', attemptId });
            } else if (ev.kind === 'activity' && ev.phase) {
              this.send({ type: 'turn.activity', attemptId, phase: ev.phase });
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
          },
          (delivery) => {
            const mcp = this.activeMcpAttempts.get(attemptId);
            if (mcp) mcp.delivery = delivery;
          }
        )
        .then((res) => {
          this.runningAttempts.delete(attemptId);
          this.activeMcpAttempts.delete(attemptId);
          cleanupTempImages();
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
          this.activeMcpAttempts.delete(attemptId);
          cleanupTempImages();
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
    if (this.stopped) return Promise.reject(new Error('执行节点已停止'));
    let effectiveArgs: Record<string, unknown> = args;
    if (
      (toolName === 'space_save_file' || toolName === 'chat_attach_image') &&
      typeof args.localPath === 'string' &&
      args.localPath.trim() &&
      !args.dataBase64 &&
      args.content === undefined
    ) {
      try {
        const resolved = path.resolve(args.localPath.trim());
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          return Promise.reject(new Error(`执行节点上找不到指定文件: ${args.localPath}`));
        }
        const st = fs.statSync(resolved);
        if (st.size === 0) {
          return Promise.reject(new Error(`本地文件为空: ${args.localPath}`));
        }
        if (st.size > 24 * 1024 * 1024) {
          return Promise.reject(new Error(`文件超过 24 MiB 传输上限: ${args.localPath}`));
        }
        const b64 = fs.readFileSync(resolved).toString('base64');
        const nextArgs: Record<string, unknown> = {
          ...args,
          name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : path.basename(resolved),
          dataBase64: b64
        };
        delete nextArgs.localPath;
        effectiveArgs = nextArgs;
      } catch (err) {
        return Promise.reject(new Error(`读取本地文件失败: ${(err as Error).message}`));
      }
    }
    const callId = `tc_${randomUUID().slice(0, 12)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error(`云端工具调用超时: ${toolName}`));
      }, 60_000);
      timer.unref?.();
      const frame = { type: 'turn.tool_call', callId, attemptId, toolName, args: effectiveArgs };
      const sent = this.ws?.readyState === WebSocket.OPEN;
      this.pendingToolCalls.set(callId, { resolve, reject, timer, frame, sent });
      if (sent) this.send(frame);
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

const execFileAsync = promisify(execFile);

async function isMacProcessRunning(pattern: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/pgrep', ['-f', pattern], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureMacCompanionApps(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const proxyEnv = resolveLocalProxyEnv();
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;

  const grokApp = '/Applications/Grok Bot.app';
  if (fs.existsSync(grokApp)) {
    const running = await isMacProcessRunning('/Applications/Grok Bot.app/Contents/MacOS/Grok Bot');
    if (!running) {
      try {
        await execFileAsync('/usr/bin/open', ['-g', '-j', grokApp], { env: cleanEnv, timeout: 10_000 });
        console.log('[duolawork-node] companion keepalive launched Grok Bot.app in background');
      } catch {
        // non-fatal
      }
    }
  }

  const dshApp = '/Applications/DeepSeek Harness.app';
  if (fs.existsSync(dshApp)) {
    const running = await isMacProcessRunning('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
    if (!running) {
      try {
        const openArgs = ['-g', '-j'];
        const httpProxy = proxyEnv.HTTP_PROXY || proxyEnv.http_proxy || '';
        const httpsProxy = proxyEnv.HTTPS_PROXY || proxyEnv.https_proxy || httpProxy;
        if (httpProxy) {
          openArgs.push('--env', `HTTP_PROXY=${httpProxy}`);
        }
        if (httpsProxy) {
          openArgs.push('--env', `HTTPS_PROXY=${httpsProxy}`);
        }
        openArgs.push('--env', 'NO_PROXY=127.0.0.1,localhost,::1');
        openArgs.push(dshApp);
        await execFileAsync('/usr/bin/open', openArgs, { env: cleanEnv, timeout: 10_000 });
        console.log('[duolawork-node] companion keepalive launched DeepSeek Harness.app in background');
      } catch {
        // non-fatal
      }
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
  let companionTimer: NodeJS.Timeout | null = null;
  if (process.platform === 'darwin' && cfg.kind === 'local') {
    void ensureMacCompanionApps();
    companionTimer = setInterval(() => {
      void ensureMacCompanionApps();
    }, 3 * 60_000);
    companionTimer.unref?.();
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (companionTimer) clearInterval(companionTimer);
      runner.stop();
      process.exit(0);
    });
  }
}

void runCliIfMain();
