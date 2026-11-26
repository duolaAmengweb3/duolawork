import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  isExcludedClaudeVps,
  type DispatchAttemptRecord,
  type MemberRecord,
  type ProviderUsageMetrics
} from '../../shared/types.js';
import { buildEnrichedPath, resolveLocalProxyEnv } from './codex-driver.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  sanitizeToolSummary,
  type AgentDriver,
  type EnsuredSession,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  type TurnStreamEvent
} from './types.js';

function execCliClosedStdin(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: resolveLocalProxyEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-16_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8_000);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findLocalBinaryOnPath(name: string): string | null {
  const binName = process.platform === 'win32' ? `${name}.cmd` : name;
  for (const dir of buildEnrichedPath().split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        if (process.platform !== 'win32') {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return candidate;
      }
    } catch {
      // ignore unreadable/non-executable candidate
    }
  }
  return null;
}

interface SingleRunOutcome {
  ok: boolean;
  hadOutput: boolean;
  text: string;
  nativeSessionId: string;
  providerUsage: ProviderUsageMetrics;
  errorMessage?: string;
}

/**
 * Local T3-style Claude Code CLI driver:
 * - Drives local macOS `claude` CLI directly via `-p --output-format stream-json --verbose --include-partial-messages`.
 * - Each DuolaWork thread/task step owns its own fresh UUID session (`--session-id` / `--resume`),
 *   with ZERO binding or syncing to external IDE/CLI sessions.
 * - Strictly blocks protected VPS `ClaudeVPS` via `isExcludedClaudeVps`.
 */
export class ClaudeCliDriver implements AgentDriver {
  public readonly kind = 'claude-cli' as const;
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly abortedAttempts = new Set<string>();
  private readonly authFailureByMember = new Map<string, { message: string; at: number }>();
  private readonly liveVerifiedAtByMember = new Map<string, number>();

  public resolveBinary(member: MemberRecord): string | null {
    const configured = typeof member.config.command === 'string' ? member.config.command.trim() : '';
    if (configured && fs.existsSync(configured)) {
      return configured;
    }
    return findLocalBinaryOnPath('claude');
  }

  public async checkHealth(
    member: MemberRecord,
    options?: { deepProbe?: boolean }
  ): Promise<{ status: MemberRecord['status']; message: string }> {
    if (isExcludedClaudeVps(member)) {
      return { status: 'offline', message: '按所有者规则排除 VPS 订阅 Claude 实例' };
    }
    const cachedAuthErr = this.authFailureByMember.get(member.id);
    if (cachedAuthErr && (!options?.deepProbe || Date.now() - cachedAuthErr.at < 30_000)) {
      return { status: 'auth_required', message: cachedAuthErr.message };
    }
    const bin = this.resolveBinary(member);
    if (!bin) {
      return { status: 'offline', message: '未检测到本机 claude 可执行文件' };
    }
    try {
      const authRes = await execCliClosedStdin(bin, ['auth', 'status'], 8_000);
      const parsed = tryParseJsonObject(authRes.stdout);
      if (parsed?.loggedIn === false) {
        return { status: 'auth_required', message: '本机 Claude Code 尚未完成账号登录' };
      }
      if (options?.deepProbe) {
        const lastOk = this.liveVerifiedAtByMember.get(member.id) ?? 0;
        if (cachedAuthErr || Date.now() - lastOk > 10 * 60_000) {
          const probeOut = await execCliClosedStdin(
            bin,
            ['-p', 'OK', '--max-turns', '1', '--output-format', 'json', '--no-session-persistence'],
            15_000
          );
          const combined = `${probeOut.stdout}\n${probeOut.stderr}`;
          if (/OAuth token revoked|Failed to authenticate|Please log in again|api_error_status":401/i.test(combined)) {
            const msg = '本机 Claude Code 登录凭证已失效，请在终端执行 claude login 重新登录';
            this.authFailureByMember.set(member.id, { message: msg, at: Date.now() });
            return { status: 'auth_required', message: msg };
          }
          if (probeOut.timedOut) {
            return { status: 'offline', message: '本机 Claude Code 连通性探测超时' };
          }
          const probeJson = tryParseJsonObject(probeOut.stdout);
          if (probeOut.code !== 0 || probeJson?.is_error === true) {
            const errDetail = typeof probeJson?.result === 'string' ? probeJson.result : combined.trim().slice(0, 120);
            return { status: 'offline', message: redactSecrets(errDetail || '本机 Claude Code 探测返回异常') };
          }
          this.authFailureByMember.delete(member.id);
          this.liveVerifiedAtByMember.set(member.id, Date.now());
        }
      }
      if (parsed?.loggedIn === true) {
        const email = typeof parsed.email === 'string' && parsed.email ? ` (${parsed.email})` : '';
        return { status: 'ready', message: `本机 Claude Code 已就绪${email}` };
      }
      return { status: 'ready', message: '本机 Claude Code CLI 已就绪' };
    } catch (err: any) {
      const parsedErr = tryParseJsonObject(String(err?.stdout || ''));
      if (parsedErr?.loggedIn === false) {
        return { status: 'auth_required', message: '本机 Claude Code 尚未完成账号登录' };
      }
      return { status: 'offline', message: redactSecrets((err as Error).message) };
    }
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('按保护规则禁止连接被排除的 VPS Claude 实例');
    }
    const bin = this.resolveBinary(input.member);
    if (!bin) {
      throw new Error('未找到本机 Claude Code 可执行文件');
    }

    if (input.existingNativeSessionId && UUID_RE.test(input.existingNativeSessionId)) {
      const initialized =
        input.existingBridgeMeta?.claudeSessionInitialized !== undefined
          ? Boolean(input.existingBridgeMeta.claudeSessionInitialized)
          : true;
      return {
        nativeSessionId: input.existingNativeSessionId,
        resumed: initialized,
        bridgeMeta: { claudeSessionInitialized: initialized }
      };
    }

    const freshId = randomUUID();
    return {
      nativeSessionId: freshId,
      resumed: false,
      bridgeMeta: { claudeSessionInitialized: false }
    };
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('按保护规则禁止连接被排除的 VPS Claude 实例');
    }
    const bin = this.resolveBinary(input.member);
    if (!bin) {
      throw new Error('未找到本机 Claude Code 可执行文件');
    }

    fs.mkdirSync(input.cwd, { recursive: true });
    onEvent?.({ kind: 'started' });

    const useResume = Boolean(input.bridgeMeta?.claudeSessionInitialized);
    let outcome = await this.executeSingleRun(bin, input, input.nativeSessionId, useResume, input.prompt, onEvent);
    let sessionReset = false;

    // If resuming an unpersisted/stale UUID failed with zero output, start fresh once (T3-style)
    if (!outcome.ok && useResume && !outcome.hadOutput && !this.abortedAttempts.has(input.attemptId)) {
      const freshSessionId = randomUUID();
      sessionReset = true;
      outcome = await this.executeSingleRun(
        bin,
        input,
        freshSessionId,
        false,
        input.fallbackFullPrompt || input.prompt,
        onEvent
      );
    }

    if (this.abortedAttempts.has(input.attemptId)) {
      this.abortedAttempts.delete(input.attemptId);
      throw new Error('本机 Claude Code 任务已取消');
    }
    if (!outcome.ok) {
      throw new Error(outcome.errorMessage || '本机 Claude Code 执行失败');
    }

    return {
      text: outcome.text,
      nativeSessionId: outcome.nativeSessionId,
      nativeTurnId: input.attemptId,
      bridgeMeta: { claudeSessionInitialized: true },
      ...(sessionReset ? { sessionReset: true } : {}),
      providerUsage: outcome.providerUsage
    };
  }

  private async executeSingleRun(
    bin: string,
    input: TurnDispatchInput,
    sessionId: string,
    useResume: boolean,
    promptText: string,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<SingleRunOutcome> {
    let tmpMcpPath: string | null = null;
    try {
      if (input.mcpServers && input.mcpServers.length > 0) {
        tmpMcpPath = path.join(os.tmpdir(), `dw2-claude-mcp-${input.attemptId}-${randomUUID().slice(0, 6)}.json`);
        const mcpConfigObj = {
          mcpServers: Object.fromEntries(
            input.mcpServers.map((s) => [
              s.name,
              {
                type: 'http',
                url: s.url,
                ...(s.headers && Object.keys(s.headers).length > 0 ? { headers: s.headers } : {})
              }
            ])
          )
        };
        fs.writeFileSync(tmpMcpPath, JSON.stringify(mcpConfigObj), { mode: 0o600 });
      }

      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        'bypassPermissions',
        ...(tmpMcpPath ? ['--mcp-config', tmpMcpPath] : []),
        ...(useResume ? ['--resume', sessionId] : ['--session-id', sessionId])
      ];

      const child = spawn(bin, args, {
        cwd: input.cwd,
        env: resolveLocalProxyEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.activeProcesses.set(input.attemptId, child);

    let streamedText = '';
    let assistantText = '';
    let resultText = '';
    let resultSessionId = sessionId;
    let resultIsError = false;
    let resultErrorMsg = '';
    let resultUsageRaw: unknown = null;
    let numTurns: number | null = null;
    let stderr = '';
    let timedOut = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          streamedText += ev.delta.text;
          onEvent?.({ kind: 'delta', text: ev.delta.text });
        }
        return;
      }

      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        const parts: string[] = [];
        for (const item of msg.message.content) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
          } else if (item?.type === 'tool_use' && item.name) {
            const inp = item.input && typeof item.input === 'object' ? (item.input as Record<string, unknown>) : {};
            const toolName = String(item.name);
            const summary =
              inp.command !== undefined
                ? sanitizeToolSummary('command', inp.command)
                : inp.file_path !== undefined || inp.path !== undefined
                  ? sanitizeToolSummary('file', inp.file_path ?? inp.path)
                  : sanitizeToolSummary('search', inp.pattern ?? inp.query);
            onEvent?.({
              kind: 'tool',
              toolId: item.id ? String(item.id) : undefined,
              toolName,
              toolSummary: summary,
              toolStatus: 'running'
            });
          }
        }
        if (parts.length > 0) {
          assistantText = parts.join('');
        }
        return;
      }

      if (msg.type === 'result') {
        if (typeof msg.session_id === 'string' && msg.session_id) {
          resultSessionId = msg.session_id;
        }
        if (typeof msg.result === 'string') {
          resultText = msg.result;
        }
        if (msg.is_error === true) {
          resultIsError = true;
          if (Array.isArray(msg.errors) && msg.errors.length > 0) {
            resultErrorMsg = String(msg.errors[0]);
          } else if (typeof msg.result === 'string' && msg.result) {
            resultErrorMsg = msg.result;
          }
        }
        if (msg.usage) {
          resultUsageRaw = msg.usage;
        }
        if (typeof msg.num_turns === 'number') {
          numTurns = msg.num_turns;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.stdin.on('error', () => {
      // ignore EPIPE if process exited early
    });
    child.stdin.end(promptText);

    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutMs);

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        let childClosed = false;
        let rlClosed = false;
        let settledCode: number | null = null;
        const maybeResolve = () => {
          if (childClosed && rlClosed) {
            resolve(settledCode);
          }
        };
        rl.once('close', () => {
          rlClosed = true;
          maybeResolve();
        });
        child.once('error', (err) => reject(err));
        child.once('close', (code) => {
          settledCode = code;
          childClosed = true;
          maybeResolve();
        });
      });

      const finalText = (resultText || streamedText || assistantText).trim();
      const hadOutput = finalText.length > 0;

      if (timedOut) {
        return {
          ok: false,
          hadOutput,
          text: finalText,
          nativeSessionId: resultSessionId,
          providerUsage: emptyUnobservableUsage(),
          errorMessage: '本机 Claude Code 等待回复超时'
        };
      }

      if (exitCode !== 0 || resultIsError) {
        return {
          ok: false,
          hadOutput,
          text: finalText,
          nativeSessionId: resultSessionId,
          providerUsage: parseClaudeUsage(resultUsageRaw, numTurns),
          errorMessage: redactSecrets(resultErrorMsg || stderr || `claude 进程退出 (${exitCode ?? 'unknown'})`)
        };
      }

      return {
        ok: true,
        hadOutput,
        text: finalText,
        nativeSessionId: resultSessionId,
        providerUsage: parseClaudeUsage(resultUsageRaw, numTurns)
      };
    } catch (err) {
      return {
        ok: false,
        hadOutput: false,
        text: '',
        nativeSessionId: resultSessionId,
        providerUsage: emptyUnobservableUsage(),
        errorMessage: redactSecrets((err as Error).message)
      };
      } finally {
        clearTimeout(timeoutHandle);
        this.activeProcesses.delete(input.attemptId);
      }
    } finally {
      if (tmpMcpPath) {
        fs.rmSync(tmpMcpPath, { force: true });
      }
    }
  }

  public async reconcileAttempt(): Promise<ReconcileResult> {
    return { state: 'not_found' };
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    this.abortedAttempts.add(attempt.id);
    const child = this.activeProcesses.get(attempt.id);
    if (!child) return false;
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 1500).unref();
      return true;
    } catch {
      return false;
    }
  }
}

function tryParseJsonObject(raw: string): Record<string, any> | null {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function parseClaudeUsage(raw: unknown, numTurns: number | null): ProviderUsageMetrics {
  if (!raw || typeof raw !== 'object') return emptyUnobservableUsage();
  const u = raw as Record<string, unknown>;
  const rawInput = typeof u.input_tokens === 'number' ? u.input_tokens : null;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : null;
  if (rawInput === null && output === null) return emptyUnobservableUsage();
  const inputTokens = (rawInput ?? 0) + cacheRead + cacheCreate;
  const uncachedInputTokens = (rawInput ?? 0) + cacheCreate;
  const outputTokens = output ?? 0;
  return {
    observable: true,
    modelRequests: numTurns ?? 1,
    inputTokens,
    cachedInputTokens: cacheRead,
    uncachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}
