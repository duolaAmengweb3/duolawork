import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { DuolaWorkDatabase } from './db.js';
import type { AuthSessionRecord } from '../shared/types.js';

export const SESSION_COOKIE_NAME = 'dw2_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAGIC_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 10 * 60 * 1000;
const MAX_MAGIC_CODE_FAILURES_PER_IP = 5;
const MAX_MAGIC_CODE_FAILURES_GLOBAL = 12;
const MAGIC_GLOBAL_LOCKOUT_MS = 60 * 1000;

export interface CloudAuthOptions {
  required?: boolean;
  adminPasswordHash?: string | null;
  adminPasswordPlain?: string | null;
  apiBearerToken?: string | null;
  publicOrigins?: string[];
}

export interface AuthCheckResult {
  authenticated: boolean;
  via: 'disabled' | 'cookie' | 'bearer' | 'none';
  sessionId?: string;
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(plain: string, storedHash: string): boolean {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  try {
    const derived = scryptSync(plain, salt, 64);
    const expected = Buffer.from(keyHex, 'hex');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class CloudAuthManager {
  private readonly required: boolean;
  private readonly envPasswordHash: string | null;
  private readonly apiBearerTokenHash: string | null;
  private readonly allowedOrigins: Set<string>;
  private readonly failedAttempts = new Map<string, { count: number; lockedUntil: number }>();
  private readonly magicFailedByIp = new Map<
    string,
    { count: number; windowStart: number; lockedUntil: number }
  >();
  private readonly magicFailedGlobal = new Map<
    'login' | 'node_pair',
    { count: number; windowStart: number; lockedUntil: number }
  >();

  constructor(
    private readonly db: DuolaWorkDatabase,
    options: CloudAuthOptions = {}
  ) {
    const rawHash = options.adminPasswordHash ?? process.env.DUOLAWORK_ADMIN_PASSWORD_HASH ?? null;
    const rawPlain = options.adminPasswordPlain ?? process.env.DUOLAWORK_ADMIN_PASSWORD ?? null;
    const envRequired = process.env.DUOLAWORK_AUTH_REQUIRED === '1' || process.env.DUOLAWORK_AUTH_REQUIRED === 'true';

    this.envPasswordHash = rawHash
      ? rawHash.trim()
      : rawPlain && rawPlain.trim()
        ? hashPassword(rawPlain.trim())
        : null;

    const bearer = options.apiBearerToken ?? process.env.DUOLAWORK_API_TOKEN ?? null;
    this.apiBearerTokenHash = bearer && bearer.trim() ? sha256Hex(bearer.trim()) : null;

    this.required = Boolean(options.required ?? (envRequired || this.envPasswordHash || this.getStoredPasswordHash()));

    const origins = [
      ...(options.publicOrigins ?? []),
      ...(process.env.DUOLAWORK_PUBLIC_ORIGINS
        ? process.env.DUOLAWORK_PUBLIC_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
        : []),
      ...(process.env.DUOLAWORK_PUBLIC_ORIGIN ? [process.env.DUOLAWORK_PUBLIC_ORIGIN.trim()] : [])
    ];
    this.allowedOrigins = new Set(origins.map((o) => o.replace(/\/+$/, '')));
  }

  public isAuthRequired(): boolean {
    return this.required || Boolean(this.getEffectivePasswordHash());
  }

  public hasPasswordConfigured(): boolean {
    return Boolean(this.getEffectivePasswordHash());
  }

  private getStoredPasswordHash(): string | null {
    const stored = this.db.getSetting<{ passwordHash?: string } | null>('auth.admin', null);
    return stored?.passwordHash ? String(stored.passwordHash) : null;
  }

  private getEffectivePasswordHash(): string | null {
    return this.envPasswordHash || this.getStoredPasswordHash();
  }

  public setAdminPassword(plain: string): void {
    const clean = String(plain || '').trim();
    if (clean.length < 8) {
      throw new Error('管理员密码长度至少需要 8 位');
    }
    this.db.setSetting('auth.admin', {
      passwordHash: hashPassword(clean),
      updatedAt: new Date().toISOString()
    });
  }

  public getClientIp(req: http.IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  public isSecureRequest(req: http.IncomingMessage): boolean {
    const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (proto === 'https') return true;
    return Boolean((req.socket as any)?.encrypted);
  }

  public checkRequest(req: http.IncomingMessage): AuthCheckResult {
    if (!this.isAuthRequired()) {
      return { authenticated: true, via: 'disabled' };
    }

    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ') && this.apiBearerTokenHash) {
      const token = authHeader.slice(7).trim();
      const digest = sha256Hex(token);
      if (safeEqualHex(digest, this.apiBearerTokenHash)) {
        return { authenticated: true, via: 'bearer' };
      }
    }

    const cookies = parseCookies(String(req.headers.cookie || ''));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    if (rawSession) {
      const tokenHash = sha256Hex(rawSession);
      const nowIso = new Date().toISOString();
      const row = this.db.sqlite
        .prepare(
          `SELECT id, expires_at FROM v2_auth_sessions
           WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
        )
        .get(tokenHash, nowIso) as { id: string; expires_at: string } | undefined;
      if (row) {
        // Sliding session refresh if remaining < 15 days
        const remainingMs = Date.parse(row.expires_at) - Date.now();
        const nextExpires =
          remainingMs < SESSION_TTL_MS / 2
            ? new Date(Date.now() + SESSION_TTL_MS).toISOString()
            : row.expires_at;
        this.db.sqlite
          .prepare(`UPDATE v2_auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
          .run(nowIso, nextExpires, row.id);
        return { authenticated: true, via: 'cookie', sessionId: row.id };
      }
    }

    return { authenticated: false, via: 'none' };
  }

  public assertCsrfOrigin(req: http.IncomingMessage): void {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : '';
    if (!origin) return;
    const host = String(req.headers.host || '').trim();
    const expectedHttp = host ? `http://${host}` : '';
    const expectedHttps = host ? `https://${host}` : '';
    if (origin === expectedHttp || origin === expectedHttps || this.allowedOrigins.has(origin)) {
      return;
    }
    const err = new Error('非法跨站请求来源 (CSRF origin mismatch)');
    (err as any).statusCode = 403;
    throw err;
  }

  public loginWithPassword(input: {
    password: string;
    ip: string;
    userAgent: string;
    deviceName?: string;
    secureCookie: boolean;
  }): { session: AuthSessionRecord; setCookie: string } {
    const now = Date.now();
    const lock = this.failedAttempts.get(input.ip);
    if (lock && lock.lockedUntil > now) {
      const waitSec = Math.ceil((lock.lockedUntil - now) / 1000);
      const err = new Error(`登录失败次数过多，请 ${waitSec} 秒后重试`);
      (err as any).statusCode = 429;
      throw err;
    }

    const effectiveHash = this.getEffectivePasswordHash();
    if (!effectiveHash) {
      const err = new Error('服务端尚未设置管理员密码');
      (err as any).statusCode = 500;
      throw err;
    }

    if (!verifyPassword(String(input.password || ''), effectiveHash)) {
      const nextCount = (lock?.count ?? 0) + 1;
      const lockedUntil = nextCount >= MAX_LOGIN_FAILURES ? now + LOCKOUT_MS : 0;
      this.failedAttempts.set(input.ip, { count: nextCount, lockedUntil });
      this.recordAuditLog('password_login', input.ip, 'failed', `count=${nextCount}`);
      const err = new Error('密码不正确');
      (err as any).statusCode = 401;
      throw err;
    }

    this.failedAttempts.delete(input.ip);
    this.recordAuditLog('password_login', input.ip, 'succeeded', input.deviceName || '');
    return this.createSession({
      ip: input.ip,
      userAgent: input.userAgent,
      deviceName: input.deviceName,
      secureCookie: input.secureCookie
    });
  }

  public createMagicCode(kind: 'login' | 'node_pair', payload: Record<string, unknown> = {}): {
    code: string;
    expiresAt: string;
  } {
    const code = String(randomInt(100000, 999999));
    const codeHash = sha256Hex(`${kind}:${code}`);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MAGIC_CODE_TTL_MS).toISOString();
    this.db.sqlite
      .prepare(
        `INSERT INTO v2_auth_magic_codes (code_hash, kind, payload_json, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      )
      .run(codeHash, kind, JSON.stringify(payload), expiresAt, now.toISOString());
    this.magicFailedGlobal.delete(kind);
    this.recordAuditLog(`magic_code_issue:${kind}`, 'internal', 'succeeded', `expires=${expiresAt}`);
    return { code, expiresAt };
  }

  public consumeMagicCode(
    kind: 'login' | 'node_pair',
    code: string,
    clientIp = 'unknown'
  ): Record<string, unknown> | null {
    const now = Date.now();
    const ipKey = `${kind}:${clientIp || 'unknown'}`;
    const ipState = this.magicFailedByIp.get(ipKey);
    if (ipState && ipState.lockedUntil > now) {
      const waitSec = Math.ceil((ipState.lockedUntil - now) / 1000);
      this.recordAuditLog(`magic_code_redeem:${kind}`, clientIp, 'rate_limited_ip', `wait=${waitSec}s`);
      const err = new Error(`短码尝试失败次数过多，请 ${waitSec} 秒后重试`);
      (err as any).statusCode = 429;
      throw err;
    }

    const globalState = this.magicFailedGlobal.get(kind);
    if (globalState && globalState.lockedUntil > now) {
      const waitSec = Math.ceil((globalState.lockedUntil - now) / 1000);
      this.recordAuditLog(`magic_code_redeem:${kind}`, clientIp, 'rate_limited_global', `wait=${waitSec}s`);
      const err = new Error(`短码尝试过于频繁，当前批次短码已保护性作废，请 ${waitSec} 秒后重新生成`);
      (err as any).statusCode = 429;
      throw err;
    }

    const clean = String(code || '').trim();
    const nowIso = new Date(now).toISOString();
    const matched = clean
      ? this.db.inTransaction(() => {
          const codeHash = sha256Hex(`${kind}:${clean}`);
          const row = this.db.sqlite
            .prepare(
              `SELECT code_hash, payload_json FROM v2_auth_magic_codes
               WHERE code_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?`
            )
            .get(codeHash, kind, nowIso) as { code_hash: string; payload_json: string } | undefined;
          if (!row) return null;
          this.db.sqlite
            .prepare(`UPDATE v2_auth_magic_codes SET consumed_at = ? WHERE code_hash = ?`)
            .run(nowIso, row.code_hash);
          try {
            return JSON.parse(row.payload_json) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
      : null;

    if (!matched) {
      const baseIpCount =
        ipState && now - ipState.windowStart <= LOCKOUT_MS ? ipState.count : 0;
      const nextIpCount = baseIpCount + 1;
      const ipLockedUntil = nextIpCount >= MAX_MAGIC_CODE_FAILURES_PER_IP ? now + LOCKOUT_MS : 0;
      this.magicFailedByIp.set(ipKey, {
        count: nextIpCount,
        windowStart: baseIpCount === 0 ? now : ipState!.windowStart,
        lockedUntil: ipLockedUntil
      });

      const baseGlobalCount =
        globalState && now - globalState.windowStart <= MAGIC_CODE_TTL_MS ? globalState.count : 0;
      const nextGlobalCount = baseGlobalCount + 1;
      const globalLockedUntil =
        nextGlobalCount >= MAX_MAGIC_CODE_FAILURES_GLOBAL ? now + MAGIC_GLOBAL_LOCKOUT_MS : 0;
      this.magicFailedGlobal.set(kind, {
        count: nextGlobalCount,
        windowStart: baseGlobalCount === 0 ? now : globalState!.windowStart,
        lockedUntil: globalLockedUntil
      });

      if (globalLockedUntil > 0) {
        this.db.sqlite
          .prepare(`UPDATE v2_auth_magic_codes SET consumed_at = ? WHERE kind = ? AND consumed_at IS NULL`)
          .run(nowIso, kind);
        this.recordAuditLog(
          `magic_code_redeem:${kind}`,
          clientIp,
          'circuit_breaker_burned_codes',
          `globalCount=${nextGlobalCount}`
        );
      } else {
        this.recordAuditLog(
          `magic_code_redeem:${kind}`,
          clientIp,
          'failed',
          `ipCount=${nextIpCount},globalCount=${nextGlobalCount}`
        );
      }
      return null;
    }

    this.magicFailedByIp.delete(ipKey);
    this.magicFailedGlobal.delete(kind);
    this.recordAuditLog(`magic_code_redeem:${kind}`, clientIp, 'succeeded', '');
    return matched;
  }

  public redeemLoginMagicCode(input: {
    code: string;
    ip: string;
    userAgent: string;
    deviceName?: string;
    secureCookie: boolean;
  }): { session: AuthSessionRecord; setCookie: string } {
    const payload = this.consumeMagicCode('login', input.code, input.ip);
    if (!payload) {
      const err = new Error('一次性登录码无效或已过期');
      (err as any).statusCode = 401;
      throw err;
    }
    return this.createSession({
      ip: input.ip,
      userAgent: input.userAgent,
      deviceName: input.deviceName || (typeof payload.deviceName === 'string' ? payload.deviceName : undefined),
      secureCookie: input.secureCookie
    });
  }

  public createSession(input: {
    ip: string;
    userAgent: string;
    deviceName?: string;
    secureCookie: boolean;
  }): { session: AuthSessionRecord; setCookie: string } {
    const id = 'ses_' + randomUUID().slice(0, 12);
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const deviceName =
      String(input.deviceName || '').trim() || summarizeUserAgent(input.userAgent || '');

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_auth_sessions (
          id, token_hash, device_name, user_agent, ip, expires_at, revoked_at, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, tokenHash, deviceName, (input.userAgent || '').slice(0, 240), input.ip, expiresAt, nowIso, nowIso);

    const setCookie = buildSessionCookie(rawToken, input.secureCookie, Math.floor(SESSION_TTL_MS / 1000));
    return {
      session: {
        id,
        deviceName,
        userAgent: (input.userAgent || '').slice(0, 240),
        ip: input.ip,
        expiresAt,
        createdAt: nowIso,
        lastSeenAt: nowIso,
        current: true
      },
      setCookie
    };
  }

  public listSessions(currentSessionId?: string): AuthSessionRecord[] {
    const nowIso = new Date().toISOString();
    const rows = this.db.sqlite
      .prepare(
        `SELECT id, device_name, user_agent, ip, expires_at, created_at, last_seen_at
         FROM v2_auth_sessions
         WHERE revoked_at IS NULL AND expires_at > ?
         ORDER BY last_seen_at DESC`
      )
      .all(nowIso) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      deviceName: String(r.device_name),
      userAgent: String(r.user_agent),
      ip: String(r.ip),
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
      lastSeenAt: String(r.last_seen_at),
      current: currentSessionId ? String(r.id) === currentSessionId : false
    }));
  }

  public revokeSession(sessionId: string): boolean {
    const res = this.db.sqlite
      .prepare(`UPDATE v2_auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), sessionId);
    const revoked = Number(res.changes || 0) > 0;
    if (revoked) {
      this.recordAuditLog('session_revoke', 'internal', 'succeeded', `sessionId=${sessionId}`);
    }
    return revoked;
  }

  public isSessionActive(sessionId: string | null | undefined): boolean {
    if (!this.isAuthRequired()) return true;
    if (!sessionId) return false;
    const nowIso = new Date().toISOString();
    const row = this.db.sqlite
      .prepare(
        `SELECT 1 FROM v2_auth_sessions
         WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`
      )
      .get(sessionId, nowIso);
    return Boolean(row);
  }

  private recordAuditLog(eventKind: string, ip: string, outcome: string, detail: string): void {
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_auth_audit_logs (id, event_kind, ip, outcome, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          'aud_' + randomUUID().slice(0, 12),
          eventKind,
          String(ip || 'unknown').slice(0, 80),
          outcome,
          String(detail || '').slice(0, 240),
          new Date().toISOString()
        );
    } catch {
      // never fail auth flow if audit insert fails on closed DB
    }
  }

  public clearCookieHeader(secureCookie: boolean): string {
    return buildSessionCookie('', secureCookie, 0);
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function buildSessionCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, maxAgeSeconds)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function summarizeUserAgent(ua: string): string {
  if (/Electron/i.test(ua)) return 'DuolaWork 桌面端';
  if (/iPhone/i.test(ua)) return 'iPhone 浏览器';
  if (/iPad/i.test(ua)) return 'iPad 浏览器';
  if (/Android/i.test(ua)) return 'Android 浏览器';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac 浏览器';
  if (/Windows/i.test(ua)) return 'Windows 浏览器';
  return 'Web 设备';
}
