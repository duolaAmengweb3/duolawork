import type {
  DispatchAttemptRecord,
  DriverKind,
  MemberRecord,
  MemberStatus,
  ProviderUsageMetrics,
  TurnPhase
} from '../../shared/types.js';

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpHttpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface TurnImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataBase64: string;
  localPath?: string;
}

export const SPACE_TOOL_NAMES = new Set([
  'space_list_materials',
  'space_read_material',
  'space_create_folder',
  'space_save_file',
  'space_save_document',
  'space_save_link',
  'space_move_item',
  'chat_attach_image'
]);

/**
 * Shared DuolaBase + Collaboration Space tools exposed to both thread owners and task workers
 * when `toolPolicy !== 'none'`. Server-side `AuthSandbox` enforces thread scope, read-only vs full, and 403 secret bounds.
 */
export const SPACE_AND_DUOLABASE_TOOLS: DynamicToolDefinition[] = [
  {
    name: 'space_list_materials',
    description: '列出当前对话右侧协作空间里的全部文件夹与活跃文档、文件、链接列表（含 id、目录路径、标题、类型、大小与更新时间）。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'space_read_material',
    description: '读取当前对话右侧协作空间内某份文档正文、文本文件内容或链接详情。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['document', 'file', 'link'] },
        id: { type: 'string' }
      },
      required: ['kind', 'id']
    }
  },
  {
    name: 'space_create_folder',
    description: '在当前对话右侧协作空间创建文件夹（支持单层 title 或多层嵌套 path，如 "调研资料/2026-11/图表"；同名目录已存在时自动复用不重复创建）。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '单层文件夹名称' },
        path: { type: 'string', description: '嵌套文件夹路径，使用 / 分隔，例如 "竞品分析/截图"' },
        parentFolderId: { type: 'string', description: '可选父文件夹 ID（不填则在根目录创建）' }
      }
    }
  },
  {
    name: 'space_save_file',
    description:
      '保存任意格式的文件到当前对话右侧协作空间（支持 .csv/.json/.html/.py/.txt/.svg/.png/.jpg/.pdf/.xlsx/.docx/.zip/.mp4 等所有格式）。文本类传 content，二进制传 dataBase64，或直接传当前执行机已生成的本地绝对路径 localPath（自动读取上传，最大 24 MiB）。支持指定 folderId 或 folderPath（自动建目录）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '保存的文件名（含扩展名，如 report.csv、chart.png、page.html）' },
        content: { type: 'string', description: 'UTF-8 文本文件内容（与 dataBase64 / localPath 三选一）' },
        dataBase64: { type: 'string', description: 'Base64 编码的二进制文件内容（与 content / localPath 三选一）' },
        localPath: { type: 'string', description: '当前执行节点本机已生成的文件绝对路径（用于直接上传图片/PDF/Excel/压缩包等任意文件）' },
        mimeType: { type: 'string', description: '可选 MIME 类型，不填按扩展名自动识别' },
        folderId: { type: 'string', description: '可选目标文件夹 ID' },
        folderPath: { type: 'string', description: '可选目标文件夹路径（如 "数据导出/图表"），不存在会自动创建' },
        replaceExisting: { type: 'boolean', description: '同目录下存在同名文件时是否覆盖更新并刷新更新时间，默认 true' }
      },
      required: ['name']
    }
  },
  {
    name: 'space_save_document',
    description: '在当前对话右侧协作空间创建或更新 Markdown 文档（支持指定 folderId 或 folderPath 自动归档到文件夹，并刷新更新时间）。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题（如 方案评审.md）' },
        content: { type: 'string', description: '完整 Markdown 正文' },
        documentId: { type: 'string', description: '可选：更新指定已有文档 ID' },
        folderId: { type: 'string', description: '可选目标文件夹 ID' },
        folderPath: { type: 'string', description: '可选目标文件夹路径（如 "周报/2026-11"），不存在会自动创建' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'space_save_link',
    description: '在当前对话右侧协作空间保存外部参考链接（支持指定 folderId 或 folderPath）。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        url: { type: 'string' },
        note: { type: 'string' },
        folderId: { type: 'string' },
        folderPath: { type: 'string' }
      },
      required: ['title', 'url']
    }
  },
  {
    name: 'space_move_item',
    description: '将右侧协作空间中的文档、文件或链接移动到指定文件夹（或根目录）或重命名。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['document', 'file', 'link'] },
        id: { type: 'string' },
        folderId: { type: ['string', 'null'], description: '目标文件夹 ID；传 null 移回根目录' },
        folderPath: { type: 'string', description: '目标文件夹路径（不存在会自动创建）；传 "" 移回根目录' },
        title: { type: 'string', description: '可选新名称' }
      },
      required: ['kind', 'id']
    }
  },
  {
    name: 'chat_attach_image',
    description:
      '将本地生成的图片（PNG/JPG/WEBP/GIF/SVG）上传为对话图片，返回可在回复中直接渲染的 markdownEmbed（如 ![说明](/api/v2/chat-images/...)），前端会直接展示图片并提供「保存到资料区」和「保存到本地」按钮。支持传 localPath 或 dataBase64。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '图片文件名（如 chart.png、cover.jpg）' },
        localPath: { type: 'string', description: '执行机本机图片绝对路径' },
        dataBase64: { type: 'string', description: 'Base64 图片内容（与 localPath 二选一）' },
        mimeType: { type: 'string' },
        alt: { type: 'string', description: '图片说明文字' }
      },
      required: ['name']
    }
  },
  {
    name: 'duolabase:connector_list',
    description: '列出 DuolaBase 已配置的外部服务连接器及其状态、健康度与分类。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        query: { type: 'string' }
      }
    }
  },
  {
    name: 'duolabase:connector_discover',
    description: '发现指定 DuolaBase 连接器提供的工具名称、入参 Schema 与描述。',
    inputSchema: {
      type: 'object',
      properties: { connectorId: { type: 'string' } },
      required: ['connectorId']
    }
  },
  {
    name: 'duolabase:connector_call',
    description: '通过 DuolaBase 安全代理调用已连接且处于 active 状态的外部服务工具（如 Gmail、GitHub、飞书等，切勿输出密钥）。',
    inputSchema: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        toolName: { type: 'string' },
        arguments: { type: 'object' }
      },
      required: ['connectorId', 'toolName']
    }
  },
  {
    name: 'duolabase:vault_list',
    description: '检索 DuolaBase Vault 中已托管的凭证名称、服务名、字段引用说明与可用状态（绝不返回明文密码）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        service: { type: 'string' },
        project: { type: 'string' }
      }
    }
  },
  {
    name: 'duolabase:vault_http_proxy',
    description: '通过 DuolaBase 代注入指定凭证发起受管 HTTP 请求，让 Agent 安全使用凭证而不暴露明文密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        credentialId: { type: 'string' },
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
        headers: { type: 'object' },
        body: {},
        params: { type: 'object' }
      },
      required: ['credentialId', 'url']
    }
  }
];

export interface SessionBindingInput {
  member: MemberRecord;
  scopeKey: string;
  cwd: string;
  existingNativeSessionId?: string | null;
  existingBridgeMeta?: Record<string, unknown> | null;
  dynamicTools?: DynamicToolDefinition[];
  mcpServers?: McpHttpServerConfig[];
}

export interface EnsuredSession {
  nativeSessionId: string;
  resumed: boolean;
  bridgeMeta?: Record<string, unknown>;
}

export interface TurnStreamEvent {
  kind: 'started' | 'delta' | 'tool' | 'dispatched_meta' | 'waiting_for_receipt' | 'activity';
  phase?: TurnPhase;
  text?: string;
  toolId?: string;
  toolName?: string;
  toolSummary?: string;
  toolStatus?: 'running' | 'done' | 'error';
  nativeTurnId?: string;
  bridgeMeta?: Record<string, unknown>;
}

export interface TurnDispatchInput {
  attemptId: string;
  member: MemberRecord;
  scopeKey: string;
  cwd: string;
  nativeSessionId: string;
  bridgeMeta?: Record<string, unknown> | null;
  prompt: string;
  fallbackFullPrompt?: string;
  timeoutMs?: number;
  dynamicTools?: DynamicToolDefinition[];
  mcpServers?: McpHttpServerConfig[];
  images?: TurnImageAttachment[];
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface GeneratedImage {
  id: string;
  dataBase64?: string;
  localPath?: string;
}

export interface TurnExecutionResult {
  generatedImages?: GeneratedImage[];
  text: string;
  nativeSessionId: string;
  nativeTurnId: string | null;
  bridgeMeta?: Record<string, unknown> | null;
  sessionReset?: boolean;
  providerUsage: ProviderUsageMetrics;
}

export interface ReconcileResult {
  waitingForReceipt?: boolean;
  activity?: 'executing' | 'queued' | 'waiting_reply';
  state: 'completed' | 'still_running' | 'not_found' | 'failed';
  text?: string;
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  providerUsage?: ProviderUsageMetrics;
  errorMessage?: string;
}

export interface AgentDriver {
  readonly kind: DriverKind;
  checkHealth(member: MemberRecord): Promise<{ status: MemberStatus; message: string }>;
  ensureSession(input: SessionBindingInput): Promise<EnsuredSession>;
  runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult>;
  reconcileAttempt(
    member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult>;
  abortTurn(member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean>;
  disposeScope?(member: MemberRecord, bridgeMeta?: Record<string, unknown> | null): Promise<void>;
}

export function emptyUnobservableUsage(): ProviderUsageMetrics {
  return {
    observable: false,
    modelRequests: null,
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
    totalTokens: null
  };
}

export function redactSecrets(input: string, maxLen = 1200): string {
  const sanitized = String(input || '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_+/=.~:-]+/gi, '$1 [REDACTED]')
    .replace(/(?:\bsk-|dw2_tok_|ahv1_|ahr_|ghp_|gho_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_+/=.-]+/g, '[REDACTED]')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:token|access_token|refresh_token|id_token|api_?key|key|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|secret|auth|password|passwd|pwd)=)[^&\s"'`]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie)\s*:\s*)(?:(?:Bearer|Basic)\s+)?[^\r\n"']+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(\b(?:[A-Z0-9_]*_)?(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_TOKEN)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'`]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(--(?:password|passwd|pass|token|access-token|secret|api-key|apikey|auth|cookie)\b(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s"'`]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/(-u|--user)\s+[^\s:]+:[^\s"']+/gi, '$1 [REDACTED]');
  return Number.isFinite(maxLen) ? sanitized.slice(0, maxLen) : sanitized;
}

const SECRET_FLAG_TAKING_VALUE_LOWER = new Set([
  '--header',
  '-u',
  '--user',
  '--password',
  '--passwd',
  '--pass',
  '--token',
  '--access-token',
  '--secret',
  '--api-key',
  '--apikey',
  '--auth',
  '-b',
  '--cookie',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary'
]);

const SENSITIVE_ASSIGNMENT_RE =
  /^[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api_?key|private_key|access_key|auth|cookie)[A-Za-z0-9_.-]*=/i;

function tokenizeShellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function stripUrlSecrets(text: string): string {
  return text.replace(/https?:\/\/[^\s"'`<>]+/gi, (rawUrl) => {
    try {
      const u = new URL(rawUrl);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return rawUrl.replace(/\/\/[^@/\s]+@/, '//').split(/[?#]/)[0];
    }
  });
}

export function sanitizeToolSummary(
  kind: 'command' | 'file' | 'search' | 'tool',
  raw: unknown
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;

  if (kind !== 'command') {
    const cleaned = redactSecrets(stripUrlSecrets(trimmed), 80).trim();
    return cleaned || undefined;
  }

  // Unwrap `/bin/zsh -lc "..."` wrappers before tokenizing
  let unwrapped = trimmed.replace(/^\/?(?:usr\/)?(?:local\/)?bin\/(?:zsh|bash|sh)\s+-[a-z]*c\s+/i, '').trim();
  if (
    (unwrapped.startsWith('"') && unwrapped.endsWith('"')) ||
    (unwrapped.startsWith("'") && unwrapped.endsWith("'"))
  ) {
    unwrapped = unwrapped.slice(1, -1).trim();
  }

  const tokens = tokenizeShellWords(unwrapped);
  const safeTokens: string[] = [];
  let skipNextArg = false;

  for (const tok of tokens) {
    if (skipNextArg) {
      skipNextArg = false;
      continue;
    }
    if (!tok) continue;
    // Drop env assignments before or around the executable (e.g. MYSQL_PWD=... or SECRET=...)
    if (safeTokens.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      continue;
    }
    if (SENSITIVE_ASSIGNMENT_RE.test(tok)) {
      continue;
    }
    const lowerTok = tok.toLowerCase();
    // Handle `--password=foo` and case-sensitive `-H` (HTTP header) without swallowing `mysql -h host`
    const flagEqIdx = lowerTok.indexOf('=');
    const flagName = flagEqIdx >= 0 ? lowerTok.slice(0, flagEqIdx) : lowerTok;
    if (tok === '-H' || SECRET_FLAG_TAKING_VALUE_LOWER.has(flagName)) {
      if (flagEqIdx < 0) skipNextArg = true;
      continue;
    }
    // Strip URL userinfo + query params cleanly
    const cleanTok = /^https?:\/\//i.test(tok)
      ? stripUrlSecrets(tok)
      : redactSecrets(tok, 64);
    if (!cleanTok || cleanTok === '[REDACTED]') continue;
    safeTokens.push(cleanTok);
    if (safeTokens.length >= 3) break;
  }

  if (safeTokens.length === 0) {
    return '[command]';
  }
  const summary = redactSecrets(safeTokens.join(' '), 80).trim();
  return summary ? summary.slice(0, 80) : undefined;
}
