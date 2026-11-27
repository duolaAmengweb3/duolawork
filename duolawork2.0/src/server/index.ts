import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuolaWorkApp } from './app.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.DUOLAWORK_V2_PORT || process.env.PORT || 8780);
const host = process.env.DUOLAWORK_HOST || '127.0.0.1';
const dbPath = process.env.DUOLAWORK_V2_DB || undefined;
const filesDir = process.env.DUOLAWORK_FILES_DIR || undefined;
const lockFilePath = process.env.DUOLAWORK_LOCK_FILE || undefined;
const cloudMode = process.env.DUOLAWORK_CLOUD_MODE === '1' || process.env.DUOLAWORK_CLOUD_MODE === 'true';
const autoImportAgentHub =
  process.env.DUOLAWORK_V2_AUTO_IMPORT !== undefined
    ? process.env.DUOLAWORK_V2_AUTO_IMPORT !== '0'
    : !cloudMode;

const app = new DuolaWorkApp({
  dbPath,
  filesDir,
  lockFilePath,
  autoImportAgentHub,
  refreshRegisteredHubHealth: autoImportAgentHub || cloudMode,
  staticWebDir: path.join(rootDir, 'dist/web')
});

const { url } = await app.listen(port, host);
void app.registry.reconcileInFlightAttempts({ waitTimeoutMs: 3000 }).then(async () => {
  app.threads.syncReconciledThreadTurns();
  await app.tasks.reconcileInFlightTaskRuns();
});

console.log(`DuolaWork 2.0 (${cloudMode ? 'cloud' : 'standalone'}) listening on ${url}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}
