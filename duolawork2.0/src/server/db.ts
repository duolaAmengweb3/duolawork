import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExcludedClaudeVps, type MemberCapabilities, type MemberRecord } from '../shared/types.js';

export class DuolaWorkDatabase {
  public readonly sqlite: DatabaseSync;
  public readonly dbPath: string;
  private txDepth = 0;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    this.migrate();
  }

  public inTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }
    this.txDepth += 1;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.sqlite.exec('ROLLBACK');
      } catch {
        // ignore rollback error on closed/aborted tx
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS v2_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        driver_kind TEXT NOT NULL,
        location TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,
        status_message TEXT NOT NULL DEFAULT '',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_artifacts (
        id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        title TEXT NOT NULL,
        head_version INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES v2_artifacts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        based_on_version INTEGER NOT NULL,
        branch_kind TEXT NOT NULL CHECK (branch_kind IN ('main', 'conflict_branch')),
        writer_kind TEXT NOT NULL CHECK (writer_kind IN ('user', 'agent')),
        writer_id TEXT NOT NULL,
        attempt_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, version)
      );

      CREATE TABLE IF NOT EXISTS v2_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'default',
        workspace_path TEXT,
        title TEXT NOT NULL,
        active_owner_member_id TEXT NOT NULL REFERENCES v2_members(id),
        bound_artifact_id TEXT REFERENCES v2_artifacts(id),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES v2_threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        target_member_id TEXT,
        attempt_id TEXT,
        body TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        task_card_json TEXT,
        turn_status TEXT NOT NULL DEFAULT 'completed',
        usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );

      CREATE TABLE IF NOT EXISTS v2_handoff_cursors (
        thread_id TEXT NOT NULL REFERENCES v2_threads(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES v2_members(id),
        native_session_id TEXT,
        last_seen_seq INTEGER NOT NULL DEFAULT 0,
        context_epoch TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS v2_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'default',
        source_thread_id TEXT NOT NULL REFERENCES v2_threads(id),
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('once', 'scheduled')),
        cron_expr TEXT,
        interval_seconds INTEGER,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        misfire_policy TEXT NOT NULL DEFAULT 'skip_stale',
        schedule_enabled INTEGER NOT NULL DEFAULT 1,
        template_version INTEGER NOT NULL DEFAULT 1,
        lead_member_id TEXT NOT NULL REFERENCES v2_members(id),
        lead_session_key TEXT NOT NULL,
        tool_policy TEXT NOT NULL DEFAULT 'duolabase_readonly',
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES v2_tasks(id) ON DELETE CASCADE,
        run_number INTEGER NOT NULL,
        planned_slot_at TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_stage TEXT NOT NULL DEFAULT 'steps_running',
        waiting_question TEXT,
        integration_worktree_path TEXT,
        integration_branch TEXT,
        final_artifact_id TEXT REFERENCES v2_artifacts(id),
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_number),
        UNIQUE(task_id, planned_slot_at)
      );

      CREATE TABLE IF NOT EXISTS v2_task_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES v2_task_runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES v2_tasks(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        assignee_member_id TEXT NOT NULL REFERENCES v2_members(id),
        depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]',
        brief TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        tool_policy TEXT NOT NULL DEFAULT 'duolabase_readonly',
        use_worktree INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        review_round INTEGER NOT NULL DEFAULT 0,
        isolated_session_key TEXT NOT NULL,
        native_session_id TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        latest_submission_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS v2_step_submissions (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES v2_task_steps(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES v2_task_runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        assignee_member_id TEXT NOT NULL,
        attempt_id TEXT,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        artifact_id TEXT,
        artifact_version INTEGER,
        commit_sha TEXT,
        status TEXT NOT NULL DEFAULT 'submitted',
        created_at TEXT NOT NULL,
        UNIQUE(step_id, version)
      );

      CREATE TABLE IF NOT EXISTS v2_step_reviews (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES v2_task_steps(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES v2_task_runs(id) ON DELETE CASCADE,
        submission_version INTEGER NOT NULL,
        lead_member_id TEXT NOT NULL,
        attempt_id TEXT,
        verdict TEXT NOT NULL,
        comments TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_dispatch_attempts (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        step_id TEXT,
        member_id TEXT NOT NULL REFERENCES v2_members(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL,
        native_session_id TEXT,
        native_turn_id TEXT,
        bridge_meta_json TEXT,
        status TEXT NOT NULL,
        slot_held INTEGER NOT NULL DEFAULT 1,
        base_artifact_id TEXT,
        base_artifact_version INTEGER,
        prompt_digest TEXT NOT NULL,
        prompt_bytes INTEGER NOT NULL DEFAULT 0,
        handoff_bytes INTEGER NOT NULL DEFAULT 0,
        response_text TEXT,
        usage_json TEXT NOT NULL,
        error_message TEXT,
        dispatched_at TEXT NOT NULL,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS v2_scoped_tokens (
        token TEXT PRIMARY KEY,
        principal_kind TEXT NOT NULL,
        member_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        step_id TEXT,
        allowed_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        tool_policy TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_legacy_archives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'channel',
        meta_json TEXT NOT NULL DEFAULT '{}',
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_space_folders (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES v2_threads(id) ON DELETE CASCADE,
        parent_folder_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_space_files (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES v2_threads(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        storage_rel_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        uploader_id TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_space_links (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES v2_threads(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_space_item_meta (
        object_kind TEXT NOT NULL CHECK (object_kind IN ('document', 'file', 'link')),
        object_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        folder_id TEXT,
        pinned_at TEXT,
        deleted_at TEXT,
        source_message_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_kind, object_id)
      );

      CREATE TABLE IF NOT EXISTS v2_space_material_links (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        object_kind TEXT NOT NULL CHECK (object_kind IN ('document', 'file', 'link')),
        object_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES v2_tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('input', 'output', 'reference')),
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(object_kind, object_id, task_id, role)
      );

      CREATE TABLE IF NOT EXISTS v2_auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_auth_magic_codes (
        code_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('login', 'node_pair')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_auth_audit_logs (
        id TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_inline_action_receipts (
        action_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        result_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
        platform TEXT NOT NULL DEFAULT 'unknown',
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'offline',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        last_heartbeat_at TEXT,
        app_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const threadCols = this.sqlite.prepare(`PRAGMA table_info(v2_threads)`).all() as Array<{ name: string }>;
    if (!threadCols.some((c) => c.name === 'pinned_at')) {
      this.sqlite.exec(`ALTER TABLE v2_threads ADD COLUMN pinned_at TEXT`);
    }
    if (!threadCols.some((c) => c.name === 'workspace_node_id')) {
      this.sqlite.exec(`ALTER TABLE v2_threads ADD COLUMN workspace_node_id TEXT`);
    }
    const memberCols = this.sqlite.prepare(`PRAGMA table_info(v2_members)`).all() as Array<{ name: string }>;
    if (!memberCols.some((c) => c.name === 'node_id')) {
      this.sqlite.exec(`ALTER TABLE v2_members ADD COLUMN node_id TEXT`);
    }
    const spaceFileCols = this.sqlite.prepare(`PRAGMA table_info(v2_space_files)`).all() as Array<{ name: string }>;
    if (!spaceFileCols.some((c) => c.name === 'storage_driver')) {
      this.sqlite.exec(`ALTER TABLE v2_space_files ADD COLUMN storage_driver TEXT NOT NULL DEFAULT 'local_fs'`);
    }
    if (!spaceFileCols.some((c) => c.name === 'storage_key')) {
      this.sqlite.exec(`ALTER TABLE v2_space_files ADD COLUMN storage_key TEXT`);
    }
    const metaCols = this.sqlite.prepare(`PRAGMA table_info(v2_space_item_meta)`).all() as Array<{ name: string }>;
    if (!metaCols.some((c) => c.name === 'source_message_id')) {
      this.sqlite.exec(`ALTER TABLE v2_space_item_meta ADD COLUMN source_message_id TEXT`);
    }
    const cursorCols = this.sqlite.prepare(`PRAGMA table_info(v2_handoff_cursors)`).all() as Array<{ name: string }>;
    if (!cursorCols.some((c) => c.name === 'bridge_meta_json')) {
      this.sqlite.exec(`ALTER TABLE v2_handoff_cursors ADD COLUMN bridge_meta_json TEXT`);
    }
    if (!cursorCols.some((c) => c.name === 'delivered_revisions_json')) {
      this.sqlite.exec(`ALTER TABLE v2_handoff_cursors ADD COLUMN delivered_revisions_json TEXT`);
    }
    const msgCols = this.sqlite.prepare(`PRAGMA table_info(v2_thread_messages)`).all() as Array<{ name: string }>;
    if (!msgCols.some((c) => c.name === 'tool_trace_json')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN tool_trace_json TEXT`);
    }
    if (!msgCols.some((c) => c.name === 'handoff_meta_json')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN handoff_meta_json TEXT`);
    }
    if (!msgCols.some((c) => c.name === 'client_request_id')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN client_request_id TEXT`);
    }
    if (!msgCols.some((c) => c.name === 'paired_message_id')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN paired_message_id TEXT`);
    }
    if (!msgCols.some((c) => c.name === 'inline_actions_applied')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN inline_actions_applied INTEGER NOT NULL DEFAULT 0`);
    }
    if (!msgCols.some((c) => c.name === 'clarification_card_json')) {
      this.sqlite.exec(`ALTER TABLE v2_thread_messages ADD COLUMN clarification_card_json TEXT`);
    }
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_thread_msg_client_req
      ON v2_thread_messages(thread_id, client_request_id)
      WHERE client_request_id IS NOT NULL;
    `);

    const runCols = this.sqlite.prepare(`PRAGMA table_info(v2_task_runs)`).all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === 'lead_member_id')) {
      this.sqlite.exec(`ALTER TABLE v2_task_runs ADD COLUMN lead_member_id TEXT`);
    }
    if (!runCols.some((c) => c.name === 'lead_session_key')) {
      this.sqlite.exec(`ALTER TABLE v2_task_runs ADD COLUMN lead_session_key TEXT`);
    }
    if (!runCols.some((c) => c.name === 'tool_policy')) {
      this.sqlite.exec(`ALTER TABLE v2_task_runs ADD COLUMN tool_policy TEXT`);
    }
    if (!runCols.some((c) => c.name === 'spec_json')) {
      this.sqlite.exec(`ALTER TABLE v2_task_runs ADD COLUMN spec_json TEXT`);
    }

    // Collapse legacy consecutive switch_notice spam, keeping the newest notice in each consecutive run
    this.sqlite.exec(`
      DELETE FROM v2_thread_messages
      WHERE author_kind = 'switch_notice'
        AND EXISTS (
          SELECT 1 FROM v2_thread_messages newer
          WHERE newer.thread_id = v2_thread_messages.thread_id
            AND newer.author_kind = 'switch_notice'
            AND newer.seq > v2_thread_messages.seq
            AND NOT EXISTS (
              SELECT 1 FROM v2_thread_messages mid
              WHERE mid.thread_id = v2_thread_messages.thread_id
                AND mid.seq > v2_thread_messages.seq
                AND mid.seq < newer.seq
                AND mid.author_kind != 'switch_notice'
            )
        );
    `);

    // Idempotent cleanup: clear unedited auto-generated empty placeholder docs from earlier 2.0 seeds
    this.sqlite.exec(`
      UPDATE v2_threads
      SET bound_artifact_id = NULL
      WHERE bound_artifact_id IN (
        SELECT id FROM v2_artifacts
        WHERE title LIKE '%-文稿.md'
          AND head_version = 1
          AND content LIKE '%在此编辑或审阅当前对话的方案与交付成果%'
      );
      DELETE FROM v2_artifacts
      WHERE title LIKE '%-文稿.md'
        AND head_version = 1
        AND content LIKE '%在此编辑或审阅当前对话的方案与交付成果%'
        AND id NOT IN (SELECT final_artifact_id FROM v2_task_runs WHERE final_artifact_id IS NOT NULL);
    `);

    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO v2_settings (key, value_json, updated_at) VALUES (?, ?, ?)`
      )
      .run('duolabase', JSON.stringify({ enabled: true, endpoint: 'https://duolabase.manyaitool.com/mcp' }), now);
  }

  public upsertMember(member: Omit<MemberRecord, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): MemberRecord {
    const now = new Date().toISOString();
    const existing = this.getMember(member.id);
    const createdAt = existing?.createdAt ?? member.createdAt ?? now;
    const updatedAt = member.updatedAt ?? now;
    const resolvedNodeId = member.nodeId !== undefined ? member.nodeId : existing?.nodeId ?? null;
    this.sqlite
      .prepare(
        `INSERT INTO v2_members (
          id, name, platform_id, driver_kind, location, node_id, capabilities_json,
          status, status_message, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          platform_id = excluded.platform_id,
          driver_kind = excluded.driver_kind,
          location = excluded.location,
          node_id = excluded.node_id,
          capabilities_json = excluded.capabilities_json,
          status = excluded.status,
          status_message = excluded.status_message,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at`
      )
      .run(
        member.id,
        member.name,
        member.platformId,
        member.driverKind,
        member.location,
        resolvedNodeId,
        JSON.stringify(member.capabilities),
        member.status,
        member.statusMessage,
        JSON.stringify(member.config),
        createdAt,
        updatedAt
      );
    return this.getMember(member.id)!;
  }

  public getMember(id: string): MemberRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM v2_members WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapMemberRow(row) : null;
  }

  public listMembers(): MemberRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM v2_members ORDER BY created_at ASC, id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapMemberRow);
  }

  public getSetting<T>(key: string, fallback: T): T {
    const row = this.sqlite
      .prepare(`SELECT value_json FROM v2_settings WHERE key = ?`)
      .get(key) as { value_json: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  public setSetting(key: string, value: unknown): void {
    this.sqlite
      .prepare(
        `INSERT INTO v2_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  /**
   * Non-destructively imports existing local Coding Agents (pure T3-style independent sessions)
   * and read-only Hub member seeds from ~/.config/agent-hub.
   * Never writes to ~/.config/agent-hub and strictly excludes ClaudeVPS!
   */
  public importExistingAgentHubReadOnly(agentHubDir = path.join(os.homedir(), '.config', 'agent-hub')): {
    importedMemberIds: string[];
    excludedClaudeVps: boolean;
  } {
    const imported: string[] = [];
    const codexBin = resolveLocalCliBinary('codex') || path.join(os.homedir(), '.local', 'bin', 'codex');
    const agyBin = resolveLocalCliBinary('agy');
    const claudeBin = resolveLocalCliBinary('claude');

    // 1. Local Codex member (preserves Codex memberId if present in native-coding.json; ZERO session binding!)
    let codexMemberId = 'member_26ac2c60371e4158bd6df1b0fa0db37d';
    const ncPath = path.join(agentHubDir, 'native-coding.json');
    if (fs.existsSync(ncPath)) {
      try {
        const nc = JSON.parse(fs.readFileSync(ncPath, 'utf8')) as Record<string, Record<string, unknown>>;
        for (const [mid, rec] of Object.entries(nc)) {
          if (rec.engine === 'codex') {
            codexMemberId = mid;
          }
        }
      } catch {
        // ignore malformed optional file
      }
    }

    const codexCaps: MemberCapabilities = {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 3
    };
    this.upsertMember({
      id: codexMemberId,
      name: 'Codex',
      platformId: 'codex',
      driverKind: 'codex-app-server',
      location: 'local',
      capabilities: codexCaps,
      status: fs.existsSync(codexBin) ? 'ready' : 'offline',
      statusMessage: fs.existsSync(codexBin) ? '本机 Codex 已就绪（独立对话会话）' : '未检测到本机 codex 可执行文件',
      config: { command: codexBin }
    });
    imported.push(codexMemberId);

    // 2. Local Claude Code CLI (T3-style direct CLI sessions, strictly separate from excluded VPS ClaudeVPS)
    if (claudeBin) {
      const localClaudeId = 'member_local_claude_code';
      this.upsertMember({
        id: localClaudeId,
        name: 'Claude',
        platformId: 'claude-code',
        driverKind: 'claude-cli',
        location: 'local',
        capabilities: {
          supportsIsolatedSessions: true,
          supportsSessionResume: true,
          supportsCancel: true,
          maxConcurrentRuns: 2
        },
        status: 'ready',
        statusMessage: '本机 Claude Code 已就绪（独立对话会话）',
        config: { command: claudeBin }
      });
      imported.push(localClaudeId);
    }

    // 3. Remote Gemini2VPS member (preserving exact member_ccdf940ba6d3426da01b9f65048909e2, zero VPS SSH/reinstall)
    const cfgPath = path.join(agentHubDir, 'config.json');
    const hasHubConfig = fs.existsSync(cfgPath);
    const geminiVpsId = 'member_ccdf940ba6d3426da01b9f65048909e2';
    this.upsertMember({
      id: geminiVpsId,
      name: 'Gemini2VPS',
      platformId: 'antigravity',
      driverKind: 'remote-bridge',
      location: 'remote-bridge',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: false,
        maxConcurrentRuns: 2
      },
      status: hasHubConfig ? 'ready' : 'offline',
      statusMessage: hasHubConfig ? '远端 Antigravity 运行端在线桥接' : '缺少远端桥接配置',
      config: {
        agentHubConfigPath: cfgPath,
        remoteMode: 'native-runtime',
        remoteRuntimeId: '9de3f1a3-ef75-48bd-b89b-4b20c69e6578'
      }
    });
    imported.push(geminiVpsId);

    // 4. Local Antigravity ACP (Gemini本机, T3-style independent sessions)
    if (agyBin) {
      const localGeminiId = 'member_57804695524e4e8cad1d8dd3bb272736';
      this.upsertMember({
        id: localGeminiId,
        name: 'Gemini (本机)',
        platformId: 'antigravity',
        driverKind: 'acp-stdio',
        location: 'local',
        capabilities: {
          supportsIsolatedSessions: true,
          supportsSessionResume: true,
          supportsCancel: true,
          maxConcurrentRuns: 2
        },
        status: 'ready',
        statusMessage: '本机 Antigravity (Gemini) 已就绪（独立对话会话）',
        config: { command: agyBin }
      });
      imported.push(localGeminiId);
    }

    // 5. Offline/local fallback from read-only agent-connections.json (e.g. grok1, muse1)
    const knownFallbacks: Record<string, { name: string; platformId: string }> = {
      member_dfaf1af46a9a44ac9d44e1cdf77675d4: { name: 'grok1', platformId: 'grok-bot' },
      member_5843640cb61c4ab18c52c39bc6911deb: { name: 'muse1', platformId: 'muse' }
    };
    const acPath = path.join(agentHubDir, 'agent-connections.json');
    if (fs.existsSync(acPath)) {
      try {
        const ac = JSON.parse(fs.readFileSync(acPath, 'utf8')) as {
          accounts?: Record<string, { memberId?: string; status?: string; enabled?: boolean; message?: string; name?: string; platformId?: string }>;
        };
        for (const rec of Object.values(ac.accounts ?? {})) {
          const mid = typeof rec?.memberId === 'string' ? rec.memberId.trim() : '';
          if (!mid || imported.includes(mid)) continue;
          const fallbackMeta = knownFallbacks[mid];
          const name = fallbackMeta?.name || (typeof rec.name === 'string' && rec.name) || mid;
          const platformId = fallbackMeta?.platformId || (typeof rec.platformId === 'string' && rec.platformId) || 'webhook-bot';
          if (isExcludedClaudeVps({ id: mid, name, platformId, location: hasHubConfig ? 'remote-bridge' : 'webhook' })) {
            continue;
          }
          this.upsertMember({
            id: mid,
            name,
            platformId,
            driverKind: hasHubConfig ? 'remote-bridge' : 'webhook-bot',
            location: hasHubConfig ? 'remote-bridge' : 'webhook',
            capabilities: {
              supportsIsolatedSessions: false,
              supportsSessionResume: false,
              supportsCancel: false,
              maxConcurrentRuns: 1
            },
            status: rec.status === 'ready' ? 'ready' : 'offline',
            statusMessage: rec.status === 'ready' ? '专用浏览器连接已就绪' : '固定窗口 Bot 待接入',
            config: hasHubConfig
              ? { agentHubConfigPath: cfgPath, remoteMode: 'hub-channel' }
              : { mode: 'serialized-webhook' }
          });
          imported.push(mid);
        }
      } catch {
        // ignore malformed optional file
      }
    }

    // Ensure baseline grok1 member exists even if agent-connections.json is absent
    const grokId = 'member_dfaf1af46a9a44ac9d44e1cdf77675d4';
    if (!imported.includes(grokId)) {
      this.upsertMember({
        id: grokId,
        name: 'grok1',
        platformId: 'grok-bot',
        driverKind: hasHubConfig ? 'remote-bridge' : 'webhook-bot',
        location: hasHubConfig ? 'remote-bridge' : 'webhook',
        capabilities: {
          supportsIsolatedSessions: false,
          supportsSessionResume: false,
          supportsCancel: false,
          maxConcurrentRuns: 1
        },
        status: 'ready',
        statusMessage: '固定窗口 Webhook Bot（并发自动串行隔离）',
        config: hasHubConfig
          ? { agentHubConfigPath: cfgPath, remoteMode: 'hub-channel' }
          : { mode: 'serialized-webhook' }
      });
      imported.push(grokId);
    }

    // Note: ClaudeVPS (member_bf4fdac30b4542c8988bb6725f47ec0b) is STRICTLY EXCLUDED per owner rule.
    return { importedMemberIds: imported, excludedClaudeVps: true };
  }

  public close(): void {
    this.sqlite.close();
  }
}

export function compareNodeVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

export function resolveLocalCliBinary(
  name: string,
  opts?: { homeDir?: string; pathEnv?: string }
): string | null {
  const home = opts?.homeDir ?? os.homedir();
  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
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
  for (const part of pathEnv.split(path.delimiter)) {
    if (part && !candidates.includes(part)) candidates.push(part);
  }
  const binName = process.platform === 'win32' ? `${name}.cmd` : name;
  for (const dir of candidates) {
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
      // ignore non-executable candidate
    }
  }
  return null;
}

function mapMemberRow(row: Record<string, unknown>): MemberRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    platformId: String(row.platform_id),
    driverKind: row.driver_kind as MemberRecord['driverKind'],
    location: row.location as MemberRecord['location'],
    nodeId: row.node_id ? String(row.node_id) : null,
    capabilities: JSON.parse(String(row.capabilities_json)) as MemberCapabilities,
    status: row.status as MemberRecord['status'],
    statusMessage: String(row.status_message ?? ''),
    config: JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
