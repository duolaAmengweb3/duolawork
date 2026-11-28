#!/usr/bin/env node
/**
 * Safe, non-destructive Local -> Cloud snapshot exporter for DuolaWork 2.0:
 * - Creates a consistent WAL-safe copy of ~/.config/agent-hub/duolawork-v2.sqlite via `VACUUM INTO`
 *   WITHOUT modifying any file under ~/.config/agent-hub/!
 * - Copies Collaboration Space files into the output bundle directory.
 * - Verifies strictly zero `ClaudeVPS` (`member_bf4fdac30b4542c8988bb6725f47ec0b`) entries exist in the exported DB.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EXCLUDED_CLAUDE_VPS_ID = 'member_bf4fdac30b4542c8988bb6725f47ec0b';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(
  (outIdx >= 0 && args[outIdx + 1]) ||
    path.join(os.tmpdir(), `duolawork-cloud-bundle-${Date.now()}`)
);
const srcDbPath =
  process.env.DUOLAWORK_V2_DB ||
  path.join(os.homedir(), '.config', 'agent-hub', 'duolawork-v2.sqlite');
const srcFilesDir = path.join(path.dirname(srcDbPath), 'duolawork-v2-files');

if (!fs.existsSync(srcDbPath)) {
  console.error(`[migrate] 未找到本机数据库: ${srcDbPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const dstDbPath = path.join(outDir, 'duolawork-v2.sqlite');
if (fs.existsSync(dstDbPath)) fs.unlinkSync(dstDbPath);

const srcDb = new DatabaseSync(srcDbPath, { readOnly: true });
try {
  srcDb.exec(`VACUUM INTO '${dstDbPath.replace(/'/g, "''")}'`);
} finally {
  srcDb.close();
}

// Sanitize exported snapshot only (never touch source DB!)
const dstDb = new DatabaseSync(dstDbPath);
try {
  dstDb.prepare(`DELETE FROM v2_members WHERE id = ? OR lower(name) LIKE '%claudevps%'`).run(EXCLUDED_CLAUDE_VPS_ID);
  const check = dstDb
    .prepare(`SELECT COUNT(*) AS cnt FROM v2_members WHERE id = ? OR lower(name) LIKE '%claudevps%'`)
    .get(EXCLUDED_CLAUDE_VPS_ID);
  if (Number(check?.cnt || 0) !== 0) {
    throw new Error('安全校验失败：导出快照中仍存在被排除的 ClaudeVPS 成员');
  }
  const threadCount = dstDb.prepare(`SELECT COUNT(*) AS cnt FROM v2_threads`).get().cnt;
  const taskCount = dstDb.prepare(`SELECT COUNT(*) AS cnt FROM v2_tasks WHERE kind = 'scheduled' AND schedule_enabled = 1`).get().cnt;
  const memberCount = dstDb.prepare(`SELECT COUNT(*) AS cnt FROM v2_members`).get().cnt;

  let copiedFiles = 0;
  const dstFilesDir = path.join(outDir, 'files');
  if (fs.existsSync(srcFilesDir)) {
    fs.cpSync(srcFilesDir, dstFilesDir, { recursive: true });
    const countFiles = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
        else copiedFiles += 1;
      }
    };
    countFiles(dstFilesDir);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        bundleDir: outDir,
        dbPath: dstDbPath,
        filesDir: dstFilesDir,
        stats: { threads: threadCount, activeScheduledTasks: taskCount, members: memberCount, copiedFiles },
        excludedClaudeVpsVerified: true
      },
      null,
      2
    )
  );
} finally {
  dstDb.close();
}
