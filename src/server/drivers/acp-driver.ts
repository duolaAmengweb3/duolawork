import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DispatchAttemptRecord, MemberRecord, ProviderUsageMetrics } from '../../shared/types.js';
import { JsonRpcStdioClient } from './jsonrpc-stdio.js';
import { resolveLocalProxyEnv } from './codex-driver.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  sanitizeToolSummary,
  type AgentDriver,
  type EnsuredSession,
  type McpHttpServerConfig,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  progressOnOutput,
  type TurnStreamEvent
} from './types.js';

type AcpOption = {
  id: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string; options?: Array<{ value: string; name: string }> }>;
};
function acpOptions(data: any): AcpOption[] {
  return Array.isArray(data?.configOptions) ? data.configOptions : [];
}
function optionValues(option?: AcpOption) {
  return (option?.options ?? []).flatMap(
    (o) => o.options ?? (o.value ? [{ value: o.value, name: o.name || o.value }] : [])
  );
}
async function selectAcpModel(rpc: JsonRpcStdioClient, sessionId: string, data: any, model: string) {
  const option = acpOptions(data).find((o) => o.category === 'model');
  if (option)
    return rpc.call('session/set_config_option', { sessionId, configId: option.id, value: model }, 12000);
  return rpc.call('session/set_model', { sessionId, modelId: model }, 12000);
}

function buildAcpMcpServers(list?: McpHttpServerConfig[]) {
  if (!list || list.length === 0) return [];
  return list.map((s) => ({
    type: 'http',
    name: s.name,
    url: s.url,
    headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value }))
  }));
}

async function callSessionWithMcpFallback(
  rpc: JsonRpcStdioClient,
  method: 'session/resume' | 'session/new',
  params: { sessionId?: string; cwd: string },
  mcpServers: ReturnType<typeof buildAcpMcpServers>,
  timeoutMs = 30_000
): Promise<any> {
  try {
    return await rpc.call(method, { ...params, mcpServers }, timeoutMs);
  } catch (err) {
    if (mcpServers.length === 0) throw err;
    const localOnly = mcpServers.filter((s) => s.name === 'duolawork-space');
    if (localOnly.length > 0 && localOnly.length < mcpServers.length) {
      try {
        return await rpc.call(method, { ...params, mcpServers: localOnly }, timeoutMs);
      } catch {
        // fall through to empty mcpServers
      }
    }
    return await rpc.call(method, { ...params, mcpServers: [] }, timeoutMs);
  }
}

export function resolveDefaultAcpArgs(binaryPath: string): string[] {
  const base = path.basename(binaryPath || '').replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (base === 'gemini' || base.startsWith('gemini-')) {
    return ['--acp', '--approval-mode', 'yolo'];
  }
  return ['acp', '--dangerously-skip-permissions'];
}

export class AcpStdioDriver implements AgentDriver {
  public readonly kind = 'acp-stdio' as const;
  private readonly activeClients = new Map<string, { rpc: JsonRpcStdioClient; sessionId: string }>();

  private resolveBinary(member: MemberRecord): string {
    const configured = typeof member.config.command === 'string' ? member.config.command : '';
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), '.local', 'bin', 'agy');
  }

  private async openInitializedAcp(
    member: MemberRecord,
    cwd: string
  ): Promise<{ rpc: JsonRpcStdioClient; capabilities: Record<string, any> }> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      throw new Error(`未找到本机 ACP 运行端可执行文件: ${bin}`);
    }
    const effectiveCwd =
      typeof member.config.defaultCwd === 'string' && member.config.defaultCwd.trim()
        ? member.config.defaultCwd.trim()
        : cwd;
    const args =
      Array.isArray(member.config.args) && member.config.args.length > 0
        ? member.config.args.map(String)
        : resolveDefaultAcpArgs(bin);
    fs.mkdirSync(effectiveCwd, { recursive: true });
    const rpc = new JsonRpcStdioClient({
      command: bin,
      args,
      cwd: effectiveCwd,
      env: resolveLocalProxyEnv()
    });
    try {
      const capabilities = await rpc.call(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'duolawork-v2', version: '2.0.0' },
          clientCapabilities: {}
        },
        20_000
      );
      return { rpc, capabilities: capabilities ?? {} };
    } catch (err) {
      await rpc.stop();
      throw err;
    }
  }

  public async listModels(member: MemberRecord, selectedModel?: string) {
    const { rpc } = await this.openInitializedAcp(member, os.tmpdir());
    try {
      const fresh = await rpc.call('session/new', { cwd: os.tmpdir(), mcpServers: [] }, 15000);
      const opt = acpOptions(fresh).find((o) => o.category === 'model');
      const models = opt
        ? optionValues(opt).map((o) => ({
            id: o.value,
            label: o.name,
            efforts: [] as string[],
            defaultEffort: undefined as string | undefined
          }))
        : (fresh.models?.availableModels ?? []).map((m: any) => ({
            id: m.modelId,
            label: m.name,
            efforts: [] as string[],
            defaultEffort: undefined
          }));
      const defaultModel = opt?.currentValue ?? fresh.models?.currentModelId;
      const current = selectedModel || defaultModel;
      const target = models.find((m: { id: string }) => m.id === current);
      if (target && opt) {
        const values =
          selectedModel && current !== defaultModel
            ? await selectAcpModel(rpc, fresh.sessionId, fresh, current)
            : fresh;
        const effort = acpOptions(values).find((o) => o.category === 'thought_level');
        target.efforts = optionValues(effort).map((o) => o.value);
        target.defaultEffort = effort?.currentValue;
      }
      return { models, defaultModel };
    } finally {
      await rpc.stop();
    }
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      return { status: 'offline', message: `未找到本机 ACP 运行端可执行文件: ${bin}` };
    }
    let rpc: JsonRpcStdioClient | null = null;
    try {
      const opened = await this.openInitializedAcp(member, os.tmpdir());
      rpc = opened.rpc;
      const agentName = String(opened.capabilities?.agentInfo?.name || 'ACP');
      const supportsResume = Boolean(
        opened.capabilities?.agentCapabilities?.loadSession ?? true
      );
      return {
        status: 'ready',
        message: `${agentName} ACP 已就绪 (会话恢复=${supportsResume ? '支持' : '快照回退'})`
      };
    } catch (err) {
      return { status: 'offline', message: redactSecrets((err as Error).message) };
    } finally {
      await rpc?.stop();
    }
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    const { rpc, capabilities } = await this.openInitializedAcp(input.member, input.cwd);
    const mcpServers = buildAcpMcpServers(input.mcpServers);
    try {
      const canResume = capabilities?.agentCapabilities?.loadSession !== false;
      if (input.existingNativeSessionId && canResume) {
        try {
          const data = await callSessionWithMcpFallback(
            rpc,
            'session/resume',
            { sessionId: input.existingNativeSessionId, cwd: input.cwd },
            mcpServers
          );
          const id = String(data?.sessionId || input.existingNativeSessionId);
          return { nativeSessionId: id, resumed: true };
        } catch {
          // Fall back to new session if old session id cannot resume
        }
      }
      const created = await callSessionWithMcpFallback(
        rpc,
        'session/new',
        { cwd: input.cwd },
        mcpServers
      );
      const id = String(created?.sessionId || '');
      if (!id) throw new Error('ACP session/new 未返回 sessionId');
      return { nativeSessionId: id, resumed: false };
    } finally {
      await rpc.stop();
    }
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    const { rpc } = await this.openInitializedAcp(input.member, input.cwd);
    const mcpServers = buildAcpMcpServers(input.mcpServers);
    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    let sessionId = input.nativeSessionId;
    let sessionReset = false;
    const progress = progressOnOutput(onEvent);
    let text = '';

    rpc.onRequest = async (_method, params) => {
      const options = Array.isArray(params?.options) ? params.options : [];
      const preferred =
        options.find((o: any) => o?.kind === 'allow_once' || o?.kind === 'allow_always') ??
        options.find((o: any) => typeof o?.optionId === 'string' && /allow|proceed/i.test(o.optionId)) ??
        options[0];
      const optionId = typeof preferred?.optionId === 'string' ? preferred.optionId : 'allow';
      return { outcome: { outcome: 'selected', optionId } };
    };

    try {
      let session;
      try {
        session=await callSessionWithMcpFallback(rpc, 'session/resume', {sessionId,cwd:input.cwd}, mcpServers);
      } catch {
        session=await callSessionWithMcpFallback(rpc, 'session/new', {cwd:input.cwd}, mcpServers);
        sessionId=String(session?.sessionId || sessionId);
        sessionReset=true;
      }
      if (input.member.inference) {
        const selected=await selectAcpModel(rpc,sessionId,session,input.member.inference.model);
        if (input.member.inference.effort) {
          const effort=acpOptions(selected).find(o=>o.category==='thought_level');
          if (!effort || !optionValues(effort).some(o=>o.value===input.member.inference!.effort)) throw new Error('执行端已调整此模型支持的推理强度，请重新选择');
          await rpc.call('session/set_config_option',{sessionId,configId:effort.id,value:input.member.inference.effort},12000);
        }
      }

      this.activeClients.set(input.attemptId, { rpc, sessionId });

      let receivingThought = false;
      const onNotif = (method: string, params: Record<string, any>) => {
        if (method !== 'session/update' || params.sessionId !== sessionId) return;
        const upd = params.update;
        if (upd?.sessionUpdate === 'agent_thought_chunk') {
          if (receivingThought) progress();
          if (!receivingThought) onEvent?.({ kind: 'activity', phase: 'thinking' });
          receivingThought = true;
          return;
        }
        if (upd?.sessionUpdate === 'agent_message_chunk' || upd?.sessionUpdate === 'tool_call' || upd?.sessionUpdate === 'tool_call_update') {
          receivingThought = false;
        }
        if (upd?.sessionUpdate === 'agent_message_chunk' && upd.content?.type === 'text') {
          const chunk = String(upd.content.text || '');
          text += chunk;
          onEvent?.({ kind: 'delta', text: chunk });
        } else if (upd?.sessionUpdate === 'tool_call' || upd?.sessionUpdate === 'tool_call_update') {
          const toolStatus: 'running' | 'done' | 'error' =
            upd.status === 'failed' ? 'error' : upd.status === 'completed' ? 'done' : 'running';
          const summary =
            upd.rawInput?.command !== undefined
              ? sanitizeToolSummary('command', upd.rawInput.command)
              : upd.rawInput?.file_path !== undefined || upd.rawInput?.path !== undefined
                ? sanitizeToolSummary('file', upd.rawInput.file_path ?? upd.rawInput.path)
                : upd.rawInput?.name !== undefined || upd.rawInput?.title !== undefined || upd.rawInput?.folderPath !== undefined
                  ? sanitizeToolSummary(
                      'file',
                      [upd.rawInput.folderPath, upd.rawInput.name ?? upd.rawInput.title].filter(Boolean).join('/')
                    )
                  : sanitizeToolSummary('search', upd.rawInput?.query);
          onEvent?.({
            kind: 'tool',
            toolId: upd.toolCallId ? String(upd.toolCallId) : undefined,
            toolName: String(upd.title || upd.kind || 'tool'),
            toolSummary: summary,
            toolStatus
          });
        }
      };
      rpc.on('notification', onNotif);

      onEvent?.({ kind: 'started' });
      let effectivePrompt =
        sessionReset && input.fallbackFullPrompt ? input.fallbackFullPrompt : input.prompt;
      // Note: `agy acp` rejects inline base64 image blocks inside `session/prompt` at runtime.
      // Instead, `node-runner` (or local host) provides real on-disk `localPath`s that ACP reads natively.
      const localImgPaths = (input.images ?? []).filter((img) => img.localPath);
      if (localImgPaths.length > 0 && !effectivePrompt.includes('[用户随本条消息附带了')) {
        effectivePrompt += `\n\n[用户随本条消息附带了 ${localImgPaths.length} 张图片，可直接用读取工具查看：\n${localImgPaths
          .map((img) => `- ${img.name} (${img.mimeType}) 本地路径: ${img.localPath}`)
          .join('\n')}\n]`;
      }
      const res = await rpc.call(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: effectivePrompt }]
        },
        timeoutMs
      );
      rpc.off('notification', onNotif);

      if (res?.stopReason === 'cancelled') {
        throw new Error('ACP 会话请求已取消');
      }

      const usage = parseAcpUsage(res?.usage);
      return {
        text: text.trim(),
        nativeSessionId: sessionId,
        nativeTurnId: res?.turnId ? String(res.turnId) : null,
        ...(sessionReset ? { sessionReset: true } : {}),
        providerUsage: usage
      };
    } finally {
      this.activeClients.delete(input.attemptId);
      await rpc.stop();
    }
  }

  public async reconcileAttempt(): Promise<ReconcileResult> {
    return { state: 'not_found' };
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    const active = this.activeClients.get(attempt.id);
    if (!active) return false;
    try {
      active.rpc.sendRaw({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: active.sessionId }
      });
      await active.rpc.stop();
      return true;
    } catch {
      return false;
    }
  }
}

function parseAcpUsage(raw: any): ProviderUsageMetrics {
  if (!raw || typeof raw !== 'object') return emptyUnobservableUsage();
  const input = typeof raw.inputTokens === 'number' ? raw.inputTokens : null;
  const output = typeof raw.outputTokens === 'number' ? raw.outputTokens : null;
  const cached = typeof raw.cachedInputTokens === 'number' ? raw.cachedInputTokens : null;
  if (input === null && output === null) return emptyUnobservableUsage();
  return {
    observable: true,
    modelRequests: typeof raw.modelRequests === 'number' ? raw.modelRequests : null,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: input !== null && cached !== null ? Math.max(0, input - cached) : input,
    outputTokens: output,
    totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : (input ?? 0) + (output ?? 0)
  };
}
