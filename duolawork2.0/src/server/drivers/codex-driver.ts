import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DispatchAttemptRecord, MemberRecord, ProviderUsageMetrics } from '../../shared/types.js';
import { compareNodeVersionDesc } from '../db.js';
import { JsonRpcStdioClient } from './jsonrpc-stdio.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  sanitizeToolSummary,
  type AgentDriver,
  type EnsuredSession,
  type GeneratedImage,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  progressOnOutput,
  type TurnStreamEvent
} from './types.js';

interface ActiveCodexTurn {
  rpc: JsonRpcStdioClient;
  threadId: string;
  turnId: string | null;
}

export function buildEnrichedPath(existingPath = process.env.PATH || ''): string {
  const home = os.homedir();
  const candidates: string[] = [path.join(home, '.local', 'bin')];
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const vers = fs
        .readdirSync(nvmDir)
        .filter((v) => v.startsWith('v'))
        .sort(compareNodeVersionDesc);
      for (const ver of vers) {
        candidates.push(path.join(nvmDir, ver, 'bin'));
      }
    }
  } catch {
    // ignore optional nvm scan
  }
  candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  const parts = existingPath.split(path.delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const p of [...candidates, ...parts]) {
    if (p && !merged.includes(p)) merged.push(p);
  }
  return merged.join(path.delimiter);
}

export function resolveLocalProxyEnv(): NodeJS.ProcessEnv {
  const enrichedPath = buildEnrichedPath(process.env.PATH || '');
  const existingNoProxy = String(process.env.NO_PROXY || process.env.no_proxy || '').trim();
  const loopbackBypass = ['127.0.0.1', 'localhost', '::1'];
  const mergedNoProxyParts = existingNoProxy
    ? existingNoProxy.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const host of loopbackBypass) {
    if (!mergedNoProxyParts.includes(host)) mergedNoProxyParts.push(host);
  }
  const mergedNoProxy = mergedNoProxyParts.join(',');
  const hasExistingProxy = Boolean(
    process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.ALL_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy ||
      process.env.all_proxy
  );

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: enrichedPath,
    ...(hasExistingProxy ? { NO_PROXY: mergedNoProxy, no_proxy: mergedNoProxy } : {})
  };
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'agent-hub', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      const proxy = typeof cfg.browserProxyUrl === 'string' ? cfg.browserProxyUrl : '';
      if (proxy) {
        return {
          ...baseEnv,
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ALL_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          all_proxy: proxy,
          NO_PROXY: mergedNoProxy,
          no_proxy: mergedNoProxy
        };
      }
    }
  } catch {
    // ignore optional proxy config
  }
  return baseEnv;
}

export function toCodexWireToolName(logicalName: string): string {
  if (logicalName.startsWith('duolabase:')) {
    return 'hub_duolabase__' + logicalName.slice('duolabase:'.length).replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  return 'hub_' + logicalName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function fromCodexWireToolName(wireName: string, wireToLogical?: Map<string, string>): string {
  const mapped = wireToLogical?.get(wireName);
  if (mapped) return mapped;
  if (wireName.startsWith('hub_duolabase__')) {
    return 'duolabase:' + wireName.slice('hub_duolabase__'.length);
  }
  return wireName.startsWith('hub_') ? wireName.slice(4) : wireName;
}

function toolsetSignature(tools: NonNullable<SessionBindingInput['dynamicTools']>): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export class CodexAppServerDriver implements AgentDriver {
  public readonly kind = 'codex-app-server' as const;
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();
  // Retain unmaterialized session RPC clients until their first turn completes!
  private readonly preparedSessionClients = new Map<string, JsonRpcStdioClient>();

  private resolveBinary(member: MemberRecord): string {
    const configured = typeof member.config.command === 'string' ? member.config.command : '';
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), '.local', 'bin', 'codex');
  }

  private async openInitializedClient(member: MemberRecord, cwd: string): Promise<JsonRpcStdioClient> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      throw new Error(`未找到本机 Codex 可执行文件: ${bin}`);
    }
    fs.mkdirSync(cwd, { recursive: true });
    const rpc = new JsonRpcStdioClient({
      command: bin,
      args: ['app-server', '-c', 'features.api_key_model_discovery=false'],
      cwd,
      env: resolveLocalProxyEnv()
    });
    try {
      await rpc.call('initialize', {
        clientInfo: { name: 'duolawork-v2', version: '2.0.0' },
        capabilities: { experimentalApi: true }
      });
      rpc.sendRaw({ jsonrpc: '2.0', method: 'initialized', params: {} });
      return rpc;
    } catch (err) {
      await rpc.stop();
      throw err;
    }
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      return { status: 'offline', message: '未安装或未找到 codex CLI' };
    }
    let rpc: JsonRpcStdioClient | null = null;
    try {
      rpc = await this.openInitializedClient(member, os.tmpdir());
      const acct = await rpc.call('account/read', { refreshToken: false }, 15_000);
      if (!acct?.account && acct?.requiresOpenaiAuth !== false) {
        return { status: 'auth_required', message: 'Codex 尚未完成本机账号登录' };
      }
      const email = typeof acct?.account?.email === 'string' ? ` (${acct.account.email})` : '';
      return { status: 'ready', message: `本机 Codex 已连接${email}` };
    } catch (err) {
      return { status: 'offline', message: redactSecrets((err as Error).message) };
    } finally {
      await rpc?.stop();
    }
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    const dynamicTools = (input.dynamicTools ?? []).map((t) => ({
      name: toCodexWireToolName(t.name),
      description: t.description,
      inputSchema: t.inputSchema
    }));

    const codexToolset = toolsetSignature(input.dynamicTools ?? []);
    const bridgeMeta = { ...input.existingBridgeMeta, codexToolset };
    // Codex only registers dynamicTools on thread/start. Resume retains the original schema.
    const compatible = input.existingBridgeMeta?.codexToolset === codexToolset ||
      (!input.existingBridgeMeta?.codexToolset && dynamicTools.length === 0);
    if (input.existingNativeSessionId && compatible) {
      const prepared = this.preparedSessionClients.get(input.existingNativeSessionId);
      if (prepared && !prepared.isClosed) {
        return { nativeSessionId: input.existingNativeSessionId, resumed: true, bridgeMeta };
      }
      const rpc = await this.openInitializedClient(input.member, input.cwd);
      try {
        const resumed = await rpc.call('thread/resume', {
          threadId: input.existingNativeSessionId,
          excludeTurns: true,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access'
        });
        const id = String(resumed?.thread?.id || input.existingNativeSessionId);
        this.preparedSessionClients.set(id, rpc);
        return { nativeSessionId: id, resumed: true, bridgeMeta };
      } catch {
        await rpc.stop();
      }
    }

    const rpc = await this.openInitializedClient(input.member, input.cwd);
    try {
      const created = await rpc.call('thread/start', {
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        serviceName: 'duolawork-v2',
        ...(dynamicTools.length > 0 ? { dynamicTools } : {})
      });
      const id = String(created?.thread?.id || '');
      if (!id) throw new Error('Codex app-server 未返回 thread.id');
      this.preparedSessionClients.set(id, rpc);
      return { nativeSessionId: id, resumed: false, bridgeMeta };
    } catch (err) {
      await rpc.stop();
      throw err;
    }
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    const generatedImages = new Map<string, GeneratedImage>();
    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    const wireToLogical = new Map<string, string>();
    const dynamicTools = (input.dynamicTools ?? []).map((t) => {
      const wireName = toCodexWireToolName(t.name);
      wireToLogical.set(wireName, t.name);
      return {
        name: wireName,
        description: t.description,
        inputSchema: t.inputSchema
      };
    });

    let sessionId = input.nativeSessionId;
    let sessionReset = false;
    let rpc = this.preparedSessionClients.get(sessionId);
    if (rpc) {
      this.preparedSessionClients.delete(sessionId);
    }
    if (!rpc || rpc.isClosed) {
      rpc = await this.openInitializedClient(input.member, input.cwd);
      try {
        await rpc.call('thread/resume', {
          threadId: sessionId,
          excludeTurns: true,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access'
        });
      } catch {
        const fresh = await rpc.call('thread/start', {
          cwd: input.cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          serviceName: 'duolawork-v2',
          ...(dynamicTools.length > 0 ? { dynamicTools } : {})
        });
        sessionId = String(fresh?.thread?.id || sessionId);
        sessionReset = true;
      }
    }

    let turnId: string | null = null;
    const finalChunks = new Map<string, string>();
    const progress = progressOnOutput(onEvent);
    let streamedDeltaText = '';
    let latestAgentText = '';
    let modelRequests = 0;
    let lastCumulative: Record<string, number> | null = null;
    let lastSingleUsage: Record<string, number> | null = null;

    const recordUsageSnapshot = (raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      const totalObj = raw.total || raw.total_token_usage || raw;
      const lastObj = raw.last || raw.last_token_usage || null;
      if (lastObj && typeof lastObj.inputTokens === 'number') {
        modelRequests += 1;
        lastSingleUsage = lastObj;
      }
      if (totalObj && typeof totalObj.inputTokens === 'number') {
        lastCumulative = { ...totalObj };
      }
    };

    rpc.onRequest = async (method, params) => {
      if (method === 'item/tool/call' && typeof params.tool === 'string' && params.tool.startsWith('hub_')) {
        const shortName = fromCodexWireToolName(params.tool, wireToLogical);
        const toolId = String(params.callId || params.id || `hub_${shortName}`);
        onEvent?.({
          kind: 'tool',
          toolId,
          toolName: shortName,
          toolSummary: summarizeCodexArgs(params.arguments),
          toolStatus: 'running'
        });
        if (!input.onToolCall) {
          onEvent?.({ kind: 'tool', toolId, toolName: shortName, toolStatus: 'error' });
          return { contentItems: [{ type: 'inputText', text: 'Tool handler unavailable' }], success: false };
        }
        try {
          const res = await input.onToolCall(shortName, params.arguments ?? {});
          onEvent?.({
            kind: 'tool',
            toolId,
            toolName: shortName,
            toolSummary: summarizeCodexArgs(params.arguments),
            toolStatus: 'done'
          });
          const serialized = typeof res === 'string' ? res : JSON.stringify(res);
          return { contentItems: [{ type: 'inputText', text: serialized }], success: true };
        } catch (err) {
          onEvent?.({ kind: 'tool', toolId, toolName: shortName, toolStatus: 'error' });
          return {
            contentItems: [{ type: 'inputText', text: redactSecrets((err as Error).message) }],
            success: false
          };
        }
      }
      return {};
    };

    try {
      const activeState: ActiveCodexTurn = { rpc, threadId: sessionId, turnId: null };
      this.activeTurns.set(input.attemptId, activeState);

      const buffered: Array<[string, Record<string, any>]> = [];
      let finishResolve!: () => void;
      let finishReject!: (err: Error) => void;
      const donePromise = new Promise<void>((res, rej) => {
        finishResolve = res;
        finishReject = rej;
      });

      const handleNotif = (method: string, params: Record<string, any>) => {
        if (params.threadId && params.threadId !== sessionId) return;
        if (!turnId) {
          buffered.push([method, params]);
          return;
        }
        if (params.turnId && params.turnId !== turnId) return;
        if (params.turn?.id && params.turn.id !== turnId) return;

        if (method.startsWith('item/reasoning/') || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') progress();
        if (method === 'turn/started') {
          onEvent?.({ kind: 'started', nativeTurnId: turnId });
        }
        if (method === 'thread/tokenUsage/updated') {
          recordUsageSnapshot(params.tokenUsage || params.usage);
        }
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          streamedDeltaText += params.delta;
          onEvent?.({ kind: 'delta', text: params.delta });
        }
        if (params.item?.type === 'reasoning' && (method === 'item/started' || method === 'item/completed')) {
          onEvent?.({ kind: 'activity', phase: method === 'item/started' ? 'thinking' : 'processing' });
        }
        if (method === 'item/started' && params.item && params.item.type !== 'agentMessage' && params.item.type !== 'reasoning' && params.item.type !== 'userMessage') {
          const trace = extractCodexItemTrace(params.item, 'running');
          if (trace) onEvent?.(trace);
        }
        if (method === 'item/completed' && params.item) {
          if (params.item.type === 'imageGeneration' && params.item.status === 'completed') {
            const { id, result, savedPath } = params.item;
            generatedImages.set(id, { id, dataBase64: result, localPath: savedPath });
          }
          if (params.item.type === 'agentMessage') {
            const txt = String(params.item.text || '');
            if (txt) {
              latestAgentText = txt;
            }
            if (params.item.phase === 'final_answer' && params.item.id && txt) {
              finalChunks.set(String(params.item.id), txt);
            }
          } else if (params.item.type !== 'reasoning' && params.item.type !== 'userMessage') {
            const st = params.item.status === 'failed' ? 'error' : 'done';
            const trace = extractCodexItemTrace(params.item, st);
            if (trace) onEvent?.(trace);
          }
        }
        if (method === 'turn/completed') {
          const st = params.turn?.status;
          if (st === 'failed' || st === 'interrupted') {
            finishReject(new Error(params.turn?.error?.message || `Codex turn ${st}`));
          } else {
            finishResolve();
          }
        }
      };

      rpc.on('notification', handleNotif);
      rpc.once('closed', (err) => finishReject(err));

      const timer = setTimeout(() => {
        finishReject(new Error('Codex 原生回合超时'));
      }, timeoutMs);

      try {
        const effectivePrompt =
          sessionReset && input.fallbackFullPrompt ? input.fallbackFullPrompt : input.prompt;
        const turnInputs: Array<Record<string, unknown>> = [{ type: 'text', text: effectivePrompt }];
        for (const img of input.images ?? []) {
          if (img.localPath) {
            turnInputs.push({ type: 'localImage', path: img.localPath });
          } else if (img.dataBase64 && img.mimeType) {
            turnInputs.push({ type: 'image', url: `data:${img.mimeType};base64,${img.dataBase64}` });
          }
        }
        const started = await rpc.call('turn/start', {
          threadId: sessionId,
          input: turnInputs
        });
        turnId = String(started?.turn?.id || '');
        if (!turnId) throw new Error('Codex turn/start 未返回 turn.id');
        activeState.turnId = turnId;
        onEvent?.({ kind: 'dispatched_meta', nativeTurnId: turnId });

        for (const [m, p] of buffered) {
          handleNotif(m, p);
        }
        buffered.length = 0;

        await donePromise;
      } finally {
        clearTimeout(timer);
        rpc.off('notification', handleNotif);
      }

      const finalText =
        finalChunks.size > 0
          ? [...finalChunks.values()].join('\n\n').trim()
          : (latestAgentText || streamedDeltaText).trim();

      const usage = computeCodexUsage(modelRequests, lastCumulative, lastSingleUsage);
      return {
        text: finalText,
        ...(generatedImages.size ? { generatedImages: [...generatedImages.values()] } : {}),
        bridgeMeta: { ...input.bridgeMeta, codexToolset: toolsetSignature(input.dynamicTools ?? []) },
        nativeSessionId: sessionId,
        nativeTurnId: turnId,
        ...(sessionReset ? { sessionReset: true } : {}),
        providerUsage: usage
      };
    } finally {
      this.activeTurns.delete(input.attemptId);
      await rpc.stop();
    }
  }

  public async reconcileAttempt(
    member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult> {
    if (!attempt.nativeSessionId) {
      return { state: 'not_found' };
    }
    let rpc: JsonRpcStdioClient | null = null;
    try {
      rpc = await this.openInitializedClient(member, os.tmpdir());
      await rpc.call('thread/resume', {
        threadId: attempt.nativeSessionId,
        excludeTurns: true
      });
      const readRes = await rpc.call('thread/read', {
        threadId: attempt.nativeSessionId,
        includeTurns: true
      });
      const thread = readRes?.thread;
      if (thread?.status?.type === 'active' || thread?.status?.type === 'running') {
        return { state: 'still_running', nativeSessionId: attempt.nativeSessionId };
      }
      const turns: any[] = Array.isArray(thread?.turns) ? thread.turns : [];
      const matched = attempt.nativeTurnId
        ? turns.find((t) => t.id === attempt.nativeTurnId)
        : turns[turns.length - 1];
      if (!matched) {
        return { state: 'not_found' };
      }
      if (matched.status === 'failed' || matched.status === 'interrupted') {
        return {
          state: 'failed',
          nativeSessionId: attempt.nativeSessionId,
          nativeTurnId: matched.id,
          errorMessage: matched.error?.message || `Turn ${matched.status}`
        };
      }
      const items: any[] = Array.isArray(matched.items) ? matched.items : [];
      const agentTexts = items
        .filter((it) => it?.type === 'agentMessage' && typeof it.text === 'string')
        .map((it) => String(it.text).trim())
        .filter(Boolean);
      if (agentTexts.length > 0) {
        return {
          state: 'completed',
          text: agentTexts[agentTexts.length - 1],
          nativeSessionId: attempt.nativeSessionId,
          nativeTurnId: matched.id,
          providerUsage: emptyUnobservableUsage()
        };
      }
      return { state: 'not_found' };
    } catch {
      return { state: 'not_found' };
    } finally {
      await rpc?.stop();
    }
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    const active = this.activeTurns.get(attempt.id);
    if (!active) return false;
    try {
      if (active.turnId) {
        await active.rpc.call(
          'turn/interrupt',
          { threadId: active.threadId, turnId: active.turnId },
          5000
        ).catch(() => {});
      }
      await active.rpc.stop();
      return true;
    } catch {
      return false;
    }
  }
}

function summarizeCodexArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (a.command !== undefined && a.command !== null) {
    return sanitizeToolSummary('command', a.command);
  }
  if (a.file_path !== undefined || a.path !== undefined) {
    return sanitizeToolSummary('file', a.file_path ?? a.path);
  }
  if (a.query !== undefined) {
    return sanitizeToolSummary('search', a.query);
  }
  const raw = a.title ?? a.artifactId;
  return raw ? sanitizeToolSummary('tool', raw) : undefined;
}

function extractCodexItemTrace(
  item: Record<string, any>,
  status: 'running' | 'done' | 'error'
): TurnStreamEvent | null {
  const kindType = String(item.type || '');
  if (!kindType) return null;
  const toolId = item.id ? String(item.id) : undefined;
  if (kindType === 'commandExecution') {
    const cmd = sanitizeToolSummary('command', item.command);
    return { kind: 'tool', toolId, toolName: '执行命令', toolSummary: cmd, toolStatus: status };
  }
  if (kindType === 'fileChange') {
    const firstFile = Array.isArray(item.changes) && item.changes[0]?.path ? String(item.changes[0].path) : item.path;
    const summary = sanitizeToolSummary('file', firstFile);
    return { kind: 'tool', toolId, toolName: '编辑文件', toolSummary: summary, toolStatus: status };
  }
  if (kindType === 'mcpToolCall') {
    const name = item.tool ? String(item.tool) : item.server ? String(item.server) : 'MCP 工具';
    const summary = summarizeCodexArgs(item.arguments);
    return { kind: 'tool', toolId, toolName: name, toolSummary: summary, toolStatus: status };
  }
  if (kindType === 'webSearch') {
    const q = sanitizeToolSummary('search', item.query);
    return { kind: 'tool', toolId, toolName: '联网检索', toolSummary: q, toolStatus: status };
  }
  return { kind: 'tool', toolId, toolName: kindType, toolStatus: status };
}

function computeCodexUsage(
  modelRequests: number,
  cumulative: Record<string, number> | null,
  single: Record<string, number> | null
): ProviderUsageMetrics {
  const src = cumulative || single;
  if (!src) return emptyUnobservableUsage();
  const input = Number(src.inputTokens ?? src.input_tokens ?? 0);
  const cached = Number(src.cachedInputTokens ?? src.cached_input_tokens ?? 0);
  const output = Number(src.outputTokens ?? src.output_tokens ?? 0);
  const total = Number(src.totalTokens ?? src.total_tokens ?? input + output);
  return {
    observable: true,
    modelRequests: modelRequests > 0 ? modelRequests : 1,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, input - cached),
    outputTokens: output,
    totalTokens: total
  };
}
