import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length
  };
}

export function restoreBackupBundle(options) {
  const bundleDir = path.resolve(String(options?.bundleDir || ''));
  const targetDbPath = path.resolve(String(options?.targetDbPath || ''));
  const targetFilesDir = path.resolve(
    String(
      options?.targetFilesDir ||
        path.join(path.dirname(targetDbPath), 'duolawork-v2-files')
    )
  );

  if (!bundleDir || !fs.existsSync(bundleDir)) {
    throw new Error(`[duolawork-restore] backup bundle missing: ${bundleDir}`);
  }
  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[duolawork-restore] manifest.json missing in bundle: ${bundleDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dbFileName = String(manifest.dbFile || 'duolawork-v2.sqlite');
  const backupDbPath = path.join(bundleDir, dbFileName);
  const backupFilesDir = path.join(bundleDir, String(manifest.filesDir || 'files'));

  if (!fs.existsSync(backupDbPath)) {
    throw new Error(`[duolawork-restore] database file missing in bundle: ${backupDbPath}`);
  }

  const dbDigest = sha256File(backupDbPath);
  if (manifest.dbSha256 && dbDigest.sha256 !== manifest.dbSha256) {
    throw new Error(
      `[duolawork-restore] database checksum mismatch: expected ${manifest.dbSha256}, got ${dbDigest.sha256}`
    );
  }

  // Verify SQLite integrity & referenced rows against bundle files
  const verifyDb = new DatabaseSync(backupDbPath, { readOnly: true });
  try {
    const icRow = verifyDb.prepare('PRAGMA integrity_check').get();
    const ic = String(icRow ? Object.values(icRow)[0] : '');
    if (ic.toLowerCase() !== 'ok') {
      throw new Error(`[duolawork-restore] SQLite integrity_check failed: ${ic}`);
    }
    const referenced = [
      ...verifyDb.prepare(`SELECT id, storage_rel_path, sha256 FROM v2_space_files`).all(),
      ...verifyDb.prepare(`SELECT id, storage_rel_path, sha256 FROM v2_chat_images`).all()
    ];
    for (const row of referenced) {
      const rel = String(row.storage_rel_path || '');
      const full = path.resolve(backupFilesDir, rel);
      const filesRootResolved = path.resolve(backupFilesDir);
      if (!full.startsWith(filesRootResolved + path.sep) || !fs.existsSync(full)) {
        throw new Error(`[duolawork-restore] referenced file missing from bundle: ${rel}`);
      }
      const expectedSha = String(row.sha256 || '').trim();
      if (expectedSha && sha256File(full).sha256 !== expectedSha) {
        throw new Error(`[duolawork-restore] referenced file checksum mismatch: ${rel}`);
      }
    }
  } finally {
    verifyDb.close();
  }

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  for (const item of manifestFiles) {
    const rel = String(item?.relPath || '');
    const full = path.resolve(backupFilesDir, rel);
    const filesRootResolved = path.resolve(backupFilesDir);
    if (!full.startsWith(filesRootResolved + path.sep) || !fs.existsSync(full)) {
      throw new Error(`[duolawork-restore] manifest file missing from bundle: ${rel}`);
    }
    const digest = sha256File(full);
    if (item.sha256 && digest.sha256 !== item.sha256) {
      throw new Error(`[duolawork-restore] manifest checksum mismatch: ${rel}`);
    }
  }

  // Restore DB atomically
  fs.mkdirSync(path.dirname(targetDbPath), { recursive: true, mode: 0o700 });
  const tmpDbPath = `${targetDbPath}.restore.${process.pid}.${Date.now()}`;
  fs.copyFileSync(backupDbPath, tmpDbPath);
  fs.chmodSync(tmpDbPath, 0o600);
  fs.rmSync(`${targetDbPath}-wal`, { force: true });
  fs.rmSync(`${targetDbPath}-shm`, { force: true });
  fs.renameSync(tmpDbPath, targetDbPath);

  // Restore files atomically via staging sibling directory
  fs.mkdirSync(path.dirname(targetFilesDir), { recursive: true, mode: 0o700 });
  const stagedFilesTarget = `${targetFilesDir}.restore.${process.pid}.${Date.now()}`;
  const prevFilesTarget = `${targetFilesDir}.prev.${process.pid}.${Date.now()}`;
  fs.rmSync(stagedFilesTarget, { recursive: true, force: true });
  fs.mkdirSync(stagedFilesTarget, { recursive: true, mode: 0o700 });
  if (fs.existsSync(backupFilesDir)) {
    fs.cpSync(backupFilesDir, stagedFilesTarget, { recursive: true, preserveTimestamps: true });
  }
  if (fs.existsSync(targetFilesDir)) {
    fs.renameSync(targetFilesDir, prevFilesTarget);
  }
  fs.renameSync(stagedFilesTarget, targetFilesDir);
  if (fs.existsSync(prevFilesTarget)) {
    fs.rmSync(prevFilesTarget, { recursive: true, force: true });
  }

  return {
    dbPath: targetDbPath,
    filesDir: targetFilesDir,
    verifiedFiles: manifestFiles.length,
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
  const bundleDir = process.argv[2];
  const targetDbPath = process.argv[3];
  const targetFilesDir = process.argv[4];
  if (!bundleDir || !targetDbPath) {
    console.error('Usage: node restore-backup.mjs <bundleDir> <targetDbPath> [targetFilesDir]');
    process.exit(1);
  }
  const res = restoreBackupBundle({ bundleDir, targetDbPath, targetFilesDir });
  console.log(
    `[duolawork-restore] ok db=${res.dbPath} filesDir=${res.filesDir} verifiedFiles=${res.verifiedFiles}`
  );
}
