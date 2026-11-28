import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const srcDb = process.argv[2] || '/var/lib/duolawork/duolawork-v2.sqlite';
const backupDir = process.argv[3] || '/var/lib/duolawork/backups';
const retainDays = Math.max(1, Number(process.argv[4] || 14) || 14);

if (!fs.existsSync(srcDb)) {
  console.error(`[duolawork-backup] source database missing: ${srcDb}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const finalPath = path.join(backupDir, `dw2-${stamp}.sqlite`);
const tmpPath = `${finalPath}.tmp.${process.pid}`;

fs.rmSync(tmpPath, { force: true });

const db = new DatabaseSync(srcDb, { readOnly: true });
try {
  const pages = await backup(db, tmpPath);
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, finalPath);
  const size = fs.statSync(finalPath).size;

  const cutoffMs = Date.now() - retainDays * 86_400_000;
  for (const name of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, name);
    if (name.startsWith('dw2-') && name.includes('.sqlite.tmp.')) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < Date.now() - 3_600_000) fs.rmSync(full, { force: true });
      } catch {
        // ignore
      }
      continue;
    }
    if (/^dw2-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite$/.test(name)) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        // ignore
      }
    }
  }

  console.log(`[duolawork-backup] ok file=${finalPath} pages=${pages} bytes=${size}`);
} catch (err) {
  fs.rmSync(tmpPath, { force: true });
  throw err;
} finally {
  db.close();
}
