import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function pad(n) {
  return String(n).padStart(2, '0');
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return { sha256: hash.digest('hex'), bytes: buf.length };
}

function resolveDefaultFilesDir(srcDb, explicitFilesDir) {
  if (explicitFilesDir && String(explicitFilesDir).trim()) {
    return path.resolve(String(explicitFilesDir).trim());
  }
  if (process.env.DUOLAWORK_FILES_DIR && process.env.DUOLAWORK_FILES_DIR.trim()) {
    return path.resolve(process.env.DUOLAWORK_FILES_DIR.trim());
  }
  const dbDir = path.dirname(path.resolve(srcDb));
  const prodSibling = path.join(dbDir, 'files');
  if (fs.existsSync(prodSibling)) return prodSibling;
  return path.join(dbDir, 'duolawork-v2-files');
}

function collectFilesRecursive(rootDir, baseDir = rootDir) {
  const entries = [];
  if (!fs.existsSync(rootDir)) return entries;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectFilesRecursive(abs, baseDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, abs).split(path.sep).join('/');
      const { sha256, bytes } = sha256File(abs);
      entries.push({ relPath, sha256, bytes });
    }
  }
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;
}

function chooseUniqueBundleDir(backupDir, now = new Date()) {
  const baseStamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const candidate = path.join(backupDir, `dw2-${baseStamp}`);
  if (!fs.existsSync(candidate)) return candidate;
  const secStamp = `${baseStamp}-${pad(now.getUTCSeconds())}`;
  const secCandidate = path.join(backupDir, `dw2-${secStamp}`);
  if (!fs.existsSync(secCandidate)) return secCandidate;
  return path.join(backupDir, `dw2-${secStamp}-${process.pid}`);
}

export async function createBackupBundle(options) {
  const srcDb = path.resolve(options?.srcDb || '/var/lib/duolawork/duolawork-v2.sqlite');
  const backupDir = path.resolve(options?.backupDir || '/var/lib/duolawork/backups');
  const retainDays = Math.max(1, Number(options?.retainDays || 14) || 14);
  const srcFilesDir = resolveDefaultFilesDir(srcDb, options?.srcFilesDir);

  if (!fs.existsSync(srcDb)) {
    throw new Error(`[duolawork-backup] source database missing: ${srcDb}`);
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const now = new Date();
  const stagedDir = path.join(
    backupDir,
    `.tmp-dw2-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${process.pid}-${Date.now()}`
  );
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.mkdirSync(stagedDir, { recursive: true, mode: 0o700 });

  const dbFileName = 'duolawork-v2.sqlite';
  const stagedDbPath = path.join(stagedDir, dbFileName);
  const stagedFilesDir = path.join(stagedDir, 'files');

  let pages = 0;
  const srcHandle = new DatabaseSync(srcDb, { readOnly: true });
  try {
    pages = await backup(srcHandle, stagedDbPath);
  } finally {
    srcHandle.close();
  }
  fs.chmodSync(stagedDbPath, 0o600);

  let integrityCheck = '';
  let counts = { threads: 0, artifacts: 0, spaceFiles: 0, chatImages: 0 };
  let referencedRows = [];

  const verifyHandle = new DatabaseSync(stagedDbPath, { readOnly: true });
  try {
    const icRow = verifyHandle.prepare('PRAGMA integrity_check').get();
    integrityCheck = String(icRow ? Object.values(icRow)[0] : '');
    if (integrityCheck.toLowerCase() !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${integrityCheck || 'empty'}`);
    }
    counts = {
      threads: Number(verifyHandle.prepare('SELECT COUNT(*) AS c FROM v2_threads').get()?.c ?? 0),
      artifacts: Number(verifyHandle.prepare('SELECT COUNT(*) AS c FROM v2_artifacts').get()?.c ?? 0),
      spaceFiles: Number(verifyHandle.prepare('SELECT COUNT(*) AS c FROM v2_space_files').get()?.c ?? 0),
      chatImages: Number(verifyHandle.prepare('SELECT COUNT(*) AS c FROM v2_chat_images').get()?.c ?? 0)
    };
    const spaceFileRows = verifyHandle
      .prepare(`SELECT id, storage_rel_path, sha256, size_bytes FROM v2_space_files`)
      .all()
      .map((r) => ({ table: 'v2_space_files', ...r }));
    const chatImageRows = verifyHandle
      .prepare(`SELECT id, storage_rel_path, sha256, size_bytes FROM v2_chat_images`)
      .all()
      .map((r) => ({ table: 'v2_chat_images', ...r }));
    referencedRows = [...spaceFileRows, ...chatImageRows];
  } catch (err) {
    verifyHandle.close();
    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
  verifyHandle.close();

  fs.mkdirSync(stagedFilesDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(srcFilesDir)) {
    fs.cpSync(srcFilesDir, stagedFilesDir, { recursive: true, preserveTimestamps: true });
  }

  const backedFiles = collectFilesRecursive(stagedFilesDir);
  const byRel = new Map(backedFiles.map((f) => [f.relPath, f]));

  const missingRefs = [];
  for (const row of referencedRows) {
    const relPath = String(row.storage_rel_path || '').split(path.sep).join('/');
    const matched = byRel.get(relPath);
    if (!matched) {
      missingRefs.push(`${row.table}:${row.id}:${relPath}`);
      continue;
    }
    const expectedSha = String(row.sha256 || '').trim();
    if (expectedSha && matched.sha256 !== expectedSha) {
      fs.rmSync(stagedDir, { recursive: true, force: true });
      throw new Error(
        `[duolawork-backup] checksum mismatch for ${row.table}:${row.id} (${relPath}): expected ${expectedSha}, got ${matched.sha256}`
      );
    }
  }
  if (missingRefs.length > 0) {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw new Error(
      `[duolawork-backup] missing referenced files in ${srcFilesDir}: ${missingRefs.slice(0, 10).join(', ')}${
        missingRefs.length > 10 ? ` (+${missingRefs.length - 10} more)` : ''
      }`
    );
  }

  const dbDigest = sha256File(stagedDbPath);
  const manifest = {
    version: 2,
    createdAt: now.toISOString(),
    dbFile: dbFileName,
    dbSha256: dbDigest.sha256,
    dbBytes: dbDigest.bytes,
    pages,
    integrityCheck,
    filesDir: 'files',
    sourceFilesDir: fs.existsSync(srcFilesDir) ? srcFilesDir : null,
    counts,
    files: backedFiles
  };
  const manifestPath = path.join(stagedDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  const finalBundleDir = chooseUniqueBundleDir(backupDir, now);
  fs.renameSync(stagedDir, finalBundleDir);

  const cutoffMs = Date.now() - retainDays * 86_400_000;
  for (const name of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, name);
    if (full === finalBundleDir) continue;
    if (name.startsWith('.tmp-dw2-') || (name.startsWith('dw2-') && name.includes('.sqlite.tmp.'))) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < Date.now() - 3_600_000) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // ignore
      }
      continue;
    }
    if (
      /^dw2-\d{4}-\d{2}-\d{2}-\d{4}(?:-\d{2}(?:-\d+)?)?$/.test(name) ||
      /^dw2-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite$/.test(name)
    ) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    bundleDir: finalBundleDir,
    dbPath: path.join(finalBundleDir, dbFileName),
    filesDir: path.join(finalBundleDir, 'files'),
    manifestPath: path.join(finalBundleDir, 'manifest.json'),
    manifest
  };
}

function isCliMain() {
  if (!process.argv[1]) return false;
  try {
    const realArg = fs.realpathSync(process.argv[1]);
    return (
      import.meta.url === pathToFileURL(realArg).href ||
      import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    );
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isCliMain()) {
  const srcDb = process.argv[2] || '/var/lib/duolawork/duolawork-v2.sqlite';
  const backupDir = process.argv[3] || '/var/lib/duolawork/backups';
  const retainDays = Math.max(1, Number(process.argv[4] || 14) || 14);
  const srcFilesDir = process.argv[5] || undefined;
  const res = await createBackupBundle({ srcDb, backupDir, retainDays, srcFilesDir });
  console.log(
    `[duolawork-backup] ok bundle=${res.bundleDir} pages=${res.manifest.pages} dbBytes=${res.manifest.dbBytes} files=${res.manifest.files.length} spaceFiles=${res.manifest.counts.spaceFiles} chatImages=${res.manifest.counts.chatImages}`
  );
}
