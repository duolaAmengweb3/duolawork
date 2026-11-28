import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isExcludedClaudeVps,
  type DriverKind,
  type MemberRecord
} from '../shared/types.js';
import { DuolaWorkDatabase, resolveLocalCliBinary } from './db.js';
import { resolveDefaultAcpArgs } from './drivers/acp-driver.js';

export type DiscoveredAgentStatus = 'ready' | 'needs_login' | 'not_installed';

export interface DiscoveredAgentCandidate {
  id: 'codex' | 'claude' | 'gemini';
  platformId: string;
  name: string;
  driverKind: DriverKind;
  binaryName: string;
  binaryPath: string | null;
  status: DiscoveredAgentStatus;
  hint: string;
  installCommand: string;
  loginCommand: string;
  alreadyMemberId: string | null;
}

export class ForbiddenDiscoveryError extends Error {
  constructor(message = '禁止接入被排除的 VPS Claude 实例') {
    super(message);
    this.name = 'ForbiddenDiscoveryError';
  }
}

interface CandidateSpec {
  id: 'codex' | 'claude' | 'gemini';
  platformId: string;
  defaultMemberId: string;
  name: string;
  driverKind: DriverKind;
  binaryCandidates: string[];
  installCommand: string;
  loginCommand: string;
  maxConcurrentRuns: number;
}

const CANDIDATE_SPECS: CandidateSpec[] = [
  {
    id: 'codex',
    platformId: 'codex',
    defaultMemberId: 'member_26ac2c60371e4158bd6df1b0fa0db37d',
    name: 'Codex',
    driverKind: 'codex-app-server',
    binaryCandidates: ['codex'],
    installCommand: 'npm install -g @openai/codex',
    loginCommand: 'codex login',
    maxConcurrentRuns: 3
  },
  {
    id: 'claude',
    platformId: 'claude-code',
    defaultMemberId: 'member_local_claude_code',
    name: 'Claude',
    driverKind: 'claude-cli',
    binaryCandidates: ['claude'],
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    loginCommand: 'claude login',
    maxConcurrentRuns: 2
  },
  {
    id: 'gemini',
    platformId: 'antigravity',
    defaultMemberId: 'member_57804695524e4e8cad1d8dd3bb272736',
    name: 'Gemini (本机)',
    driverKind: 'acp-stdio',
    binaryCandidates: ['agy', 'gemini'],
    installCommand: 'npm install -g @google/gemini-cli',
    loginCommand: 'gemini',
    maxConcurrentRuns: 2
  }
];

function checkCandidateAuth(
  spec: CandidateSpec,
  binaryPath: string,
  home: string,
  pathEnv: string | undefined,
  envVars: NodeJS.ProcessEnv,
  probeAuth: boolean
): { status: DiscoveredAgentStatus; hint: string } {
  if (spec.id === 'codex') {
    const authed =
      fs.existsSync(path.join(home, '.codex', 'auth.json')) ||
      Boolean(envVars.OPENAI_API_KEY?.trim());
    return authed
      ? { status: 'ready', hint: '检测到本机 Codex 登录凭证，可直接接入复用' }
      : { status: 'needs_login', hint: '已安装 codex，需先运行 codex login 登录自有订阅' };
  }

  if (spec.id === 'claude') {
    if (probeAuth) {
      try {
        const mergedPath = [
          path.dirname(binaryPath),
          path.dirname(process.execPath),
          pathEnv,
          envVars.PATH
        ]
          .filter(Boolean)
          .join(path.delimiter);
        const out = execFileSync(binaryPath, ['auth', 'status'], {
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...envVars, HOME: home, ...(mergedPath ? { PATH: mergedPath } : {}) }
        });
        const parsed = JSON.parse(out.trim()) as { loggedIn?: boolean; subscriptionType?: string };
        if (parsed.loggedIn === true) {
          return {
            status: 'ready',
            hint: parsed.subscriptionType
              ? `本机 Claude Code 已登录（${parsed.subscriptionType}）`
              : '本机 Claude Code 已登录，可直接接入复用'
          };
        }
        if (parsed.loggedIn === false) {
          return { status: 'needs_login', hint: '已安装 claude，请先执行 claude login 登录' };
        }
      } catch {
        // fallback to credential file inspection
      }
    }
    const authed =
      fs.existsSync(path.join(home, '.claude', '.credentials.json')) ||
      Boolean(envVars.ANTHROPIC_API_KEY?.trim());
    return authed
      ? { status: 'ready', hint: '检测到本机 Claude Code 登录状态' }
      : { status: 'needs_login', hint: '已安装 claude，请先执行 claude login 登录' };
  }

  // Gemini / Antigravity ACP
  const baseName = path.basename(binaryPath).replace(/\.(cmd|exe)$/i, '');
  const authed =
    baseName === 'agy' ||
    fs.existsSync(path.join(home, '.antigravity')) ||
    fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')) ||
    Boolean(envVars.GEMINI_API_KEY?.trim());
  return authed
    ? { status: 'ready', hint: '检测到本机 Gemini / Antigravity 运行端，可直接接入' }
    : { status: 'needs_login', hint: '已安装 Gemini CLI，首次运行 gemini 完成账号登录后即可使用' };
}

export function discoverLocalAgents(opts?: {
  homeDir?: string;
  pathEnv?: string;
  existingMembers?: MemberRecord[];
  cloudMode?: boolean;
  probeAuth?: boolean;
  env?: NodeJS.ProcessEnv;
}): { mode: 'local' | 'cloud'; candidates: DiscoveredAgentCandidate[] } {
  if (opts?.cloudMode) {
    return { mode: 'cloud', candidates: [] };
  }
  const home = opts?.homeDir ?? os.homedir();
  const pathEnv = opts?.pathEnv ?? process.env.PATH;
  const envVars = opts?.env ?? process.env;
  const probeAuth = opts?.probeAuth !== false;
  const existing = (opts?.existingMembers ?? []).filter((m) => !isExcludedClaudeVps(m));

  const candidates: DiscoveredAgentCandidate[] = CANDIDATE_SPECS.map((spec) => {
    let binaryName = spec.binaryCandidates[0];
    let binaryPath: string | null = null;
    for (const cmd of spec.binaryCandidates) {
      const found = resolveLocalCliBinary(cmd, { homeDir: home, pathEnv });
      if (found) {
        binaryName = cmd;
        binaryPath = found;
        break;
      }
    }

    const matchedMember = existing.find(
      (m) =>
        (m.location === 'local' || m.location === 'local-node') &&
        (m.driverKind === spec.driverKind || m.platformId === spec.platformId)
    );

    if (!binaryPath) {
      return {
        id: spec.id,
        platformId: spec.platformId,
        name: spec.name,
        driverKind: spec.driverKind,
        binaryName,
        binaryPath: null,
        status: 'not_installed',
        hint: `未在本机检测到 ${spec.binaryCandidates.join(' / ')} 命令`,
        installCommand: spec.installCommand,
        loginCommand: spec.loginCommand,
        alreadyMemberId: matchedMember?.id ?? null
      };
    }

    const auth = checkCandidateAuth(spec, binaryPath, home, pathEnv, envVars, probeAuth);
    return {
      id: spec.id,
      platformId: spec.platformId,
      name: spec.name,
      driverKind: spec.driverKind,
      binaryName,
      binaryPath,
      status: auth.status,
      hint: auth.hint,
      installCommand: spec.installCommand,
      loginCommand: spec.loginCommand,
      alreadyMemberId: matchedMember?.id ?? null
    };
  });

  return { mode: 'local', candidates };
}

export function activateDiscoveredAgent(
  db: DuolaWorkDatabase,
  input: {
    candidateId?: string;
    platformId?: string;
    id?: string;
    name?: string;
    driverKind?: string;
    location?: string;
  },
  opts?: {
    homeDir?: string;
    pathEnv?: string;
    probeAuth?: boolean;
    env?: NodeJS.ProcessEnv;
  }
): MemberRecord {
  const combinedHint = `${input.candidateId ?? ''} ${input.platformId ?? ''} ${input.id ?? ''} ${input.name ?? ''}`.toLowerCase();
  if (combinedHint.includes('claudevps') || isExcludedClaudeVps(input)) {
    throw new ForbiddenDiscoveryError('禁止接入被排除的 VPS Claude 实例');
  }

  const targetKey = (input.candidateId || input.platformId || '').trim().toLowerCase();
  const discovered = discoverLocalAgents({
    homeDir: opts?.homeDir,
    pathEnv: opts?.pathEnv,
    existingMembers: db.listMembers(),
    cloudMode: false,
    probeAuth: opts?.probeAuth,
    env: opts?.env
  });

  const candidate = discovered.candidates.find(
    (c) => c.id === targetKey || c.platformId.toLowerCase() === targetKey
  );
  if (!candidate) {
    throw new Error(`未找到支持自动接入的本机成员类型: ${targetKey || 'unknown'}`);
  }
  if (!candidate.binaryPath) {
    throw new Error(`未检测到本机 ${candidate.name} CLI，请先安装: ${candidate.installCommand}`);
  }

  const spec = CANDIDATE_SPECS.find((s) => s.id === candidate.id)!;
  const memberId = candidate.alreadyMemberId || spec.defaultMemberId;

  if (
    isExcludedClaudeVps({
      id: memberId,
      name: candidate.name,
      platformId: candidate.platformId,
      driverKind: candidate.driverKind,
      location: 'local'
    })
  ) {
    throw new ForbiddenDiscoveryError('禁止接入被排除的 VPS Claude 实例');
  }

  return db.upsertMember({
    id: memberId,
    name: candidate.name,
    platformId: candidate.platformId,
    driverKind: candidate.driverKind,
    location: 'local',
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: spec.maxConcurrentRuns
    },
    status: candidate.status === 'ready' ? 'ready' : 'auth_required',
    statusMessage:
      candidate.status === 'ready'
        ? `本机 ${candidate.name} 已就绪（独立对话会话）`
        : candidate.hint,
    config:
      candidate.driverKind === 'acp-stdio'
        ? { command: candidate.binaryPath, args: resolveDefaultAcpArgs(candidate.binaryPath) }
        : { command: candidate.binaryPath }
  });
}
