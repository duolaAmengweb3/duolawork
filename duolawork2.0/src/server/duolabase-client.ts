import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DuolaWorkDatabase } from './db.js';
import { redactSecrets } from './drivers/types.js';
import type { DuolaBasePublicStatus } from '../shared/types.js';

const DEFAULT_ENDPOINT = 'https://duolabase.manyaitool.com/mcp';

function deriveMasterKey(): Buffer | null {
  const raw = process.env.DUOLAWORK_MASTER_KEY;
  if (!raw || !raw.trim()) return null;
  return createHash('sha256').update(raw.trim()).digest();
}

export function encryptSettingSecret(plain: string): string {
  const key = deriveMasterKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSettingSecret(stored: string): string {
  if (!stored.startsWith('enc:v1:')) return stored;
  const key = deriveMasterKey();
  if (!key) return '';
  const parts = stored.split(':');
  if (parts.length !== 5) return '';
  try {
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const data = Buffer.from(parts[4], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

interface DuolaBaseSetting {
  enabled: boolean;
  endpoint: string;
  token?: string;
}

export class DuolaBaseClient {
  private externalCaller?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly allowHostDiscovery = true,
    externalCaller?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
  ) {
    this.externalCaller = externalCaller;
  }

  public setExternalCaller(
    fn?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.externalCaller = fn;
  }

  private resolveCredentials(): {
    enabled: boolean;
    endpoint: string;
    token: string | null;
    tokenSource: DuolaBasePublicStatus['tokenSource'];
  } {
    const setting = this.db.getSetting<DuolaBaseSetting>('duolabase', {
      enabled: true,
      endpoint: DEFAULT_ENDPOINT
    });
    const enabled = setting.enabled !== false;
    const envUrl = process.env.DUOLABASE_MCP_URL?.trim();
    const envToken = process.env.DUOLABASE_MCP_TOKEN?.trim();
    let endpoint = (envUrl || setting.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');

    if (envToken) {
      return {
        enabled,
        endpoint,
        token: envToken,
        tokenSource: 'env'
      };
    }

    if (typeof setting.token === 'string' && setting.token.trim()) {
      const decrypted = decryptSettingSecret(setting.token.trim());
      if (decrypted) {
        return {
          enabled,
          endpoint,
          token: decrypted,
          tokenSource: 'settings'
        };
      }
    }

    if (this.externalCaller) {
      return {
        enabled,
        endpoint,
        token: null,
        tokenSource: 'mock'
      };
    }

    if (this.allowHostDiscovery) {
      const fromCodex = this.readCodexDuolaBaseSectionReadOnly();
      if (fromCodex) {
        if (fromCodex.url && !setting.endpoint) {
          endpoint = fromCodex.url;
        } else if (fromCodex.url && setting.endpoint === DEFAULT_ENDPOINT) {
          endpoint = fromCodex.url;
        }
        if (fromCodex.token) {
          return {
            enabled,
            endpoint,
            token: fromCodex.token,
            tokenSource: 'codex_config'
          };
        }
      }
    }

    return {
      enabled,
      endpoint,
      token: null,
      tokenSource: 'none'
    };
  }

  private readCodexDuolaBaseSectionReadOnly(): { url?: string; token?: string } | null {
    try {
      const tomlPath = path.join(os.homedir(), '.codex', 'config.toml');
      if (!fs.existsSync(tomlPath)) return null;
      const lines = fs.readFileSync(tomlPath, 'utf8').split(/\r?\n/);
      let inSection = false;
      const buf: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          if (trimmed === '[mcp_servers.duolabase]') {
            inSection = true;
            continue;
          }
          if (inSection && !trimmed.startsWith('[mcp_servers.duolabase.')) {
            break;
          }
        }
        if (inSection) buf.push(line);
      }
      if (buf.length === 0) return null;
      const block = buf.join('\n');
      const urlMatch = block.match(/^\s*url\s*=\s*"([^"]+)"/m);
      const authMatch = block.match(/Authorization\s*=\s*"Bearer\s+([^"]+)"/i);
      return {
        url: urlMatch?.[1]?.trim(),
        token: authMatch?.[1]?.trim()
      };
    } catch {
      return null;
    }
  }

  public getPublicStatus(): DuolaBasePublicStatus {
    const creds = this.resolveCredentials();
    const consoleUrl = creds.endpoint.replace(/\/mcp$/, '');
    return {
      enabled: creds.enabled,
      endpoint: creds.endpoint,
      hasToken: Boolean(creds.token || this.externalCaller),
      tokenSource: creds.tokenSource,
      consoleUrl
    };
  }

  public getActiveMcpConfig(): { name: 'duolabase'; url: string; headers: Record<string, string> } | null {
    const creds = this.resolveCredentials();
    if (!creds.enabled || !creds.token) {
      return null;
    }
    return {
      name: 'duolabase',
      url: creds.endpoint,
      headers: {
        Authorization: `Bearer ${creds.token}`
      }
    };
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15_000
  ): Promise<any> {
    if (this.externalCaller) {
      return this.externalCaller(toolName, args);
    }

    const creds = this.resolveCredentials();
    if (!creds.enabled) {
      throw new Error('DuolaBase 已关闭，请先在设置中启用后再管理连接器或凭证');
    }
    if (!creds.token) {
      throw new Error('未配置 DuolaBase 访问令牌（可在连接器/凭证页配置或通过本机 Codex 配置授权）');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(creds.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${creds.token}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `dw2-${randomUUID().slice(0, 8)}`,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args
          }
        }),
        signal: controller.signal
      });

      const contentType = res.headers.get('content-type') || '';
      const rawText = await res.text();

      if (!res.ok) {
        throw new Error(`DuolaBase HTTP ${res.status}: ${redactSecrets(rawText)}`);
      }

      let rpc: any;
      if (contentType.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) {
        const dataLines = rawText
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== '[DONE]');
        const lastPayload = dataLines[dataLines.length - 1];
        if (!lastPayload) {
          throw new Error('DuolaBase SSE 返回为空');
        }
        rpc = JSON.parse(lastPayload);
      } else {
        rpc = JSON.parse(rawText);
      }

      if (rpc?.error) {
        throw new Error(`DuolaBase RPC 错误: ${redactSecrets(String(rpc.error.message || rpc.error.code || 'unknown'))}`);
      }

      const result = rpc?.result;
      const textItem = Array.isArray(result?.content)
        ? result.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string')
        : null;
      const payloadText = textItem?.text ?? '';
      let parsed: any = payloadText;
      if (payloadText) {
        try {
          parsed = JSON.parse(payloadText);
        } catch {
          parsed = { text: payloadText };
        }
      } else {
        parsed = result ?? {};
      }

      if (result?.isError) {
        const msg =
          typeof parsed === 'object' && parsed !== null
            ? String(parsed.message || parsed.error || payloadText || '工具执行失败')
            : String(payloadText || '工具执行失败');
        throw new Error(redactSecrets(msg));
      }

      return parsed;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error('连接 DuolaBase 超时');
      }
      throw new Error(redactSecrets((err as Error).message || 'DuolaBase 调用失败'));
    } finally {
      clearTimeout(timer);
    }
  }
}
