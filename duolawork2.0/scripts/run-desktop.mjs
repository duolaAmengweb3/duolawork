import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(rootDir, 'dist', 'server', 'app.mjs');
const webEntry = path.join(rootDir, 'dist', 'web', 'index.html');

if (!fs.existsSync(serverEntry) || !fs.existsSync(webEntry)) {
  console.error('[duolawork] Missing built assets. Please run `npm run build` before `npm run desktop`.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
let electronPkgJson = '';
try {
  electronPkgJson = require.resolve('electron/package.json');
} catch {
  console.error('[duolawork] Electron package is not installed. Please run `npm ci` first.');
  process.exit(1);
}

function resolveElectronBinary() {
  try {
    const bin = String(require('electron') || '');
    return bin && fs.existsSync(bin) ? bin : '';
  } catch {
    return '';
  }
}

let electronBin = resolveElectronBinary();
if (!electronBin) {
  const installer = path.join(path.dirname(electronPkgJson), 'install.js');
  if (fs.existsSync(installer)) {
    console.log('[duolawork] Completing Electron binary download...');
    const hasProxy = Boolean(
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    );
    const nodeArgs = hasProxy ? ['--use-env-proxy', installer] : [installer];
    execFileSync(process.execPath, nodeArgs, { cwd: rootDir, stdio: 'inherit' });
    electronBin = resolveElectronBinary();
  }
}

if (!electronBin || !fs.existsSync(electronBin)) {
  console.error(
    '[duolawork] Electron binary missing. Run `node --use-env-proxy node_modules/electron/install.js` and retry.'
  );
  process.exit(1);
}

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [rootDir, ...process.argv.slice(2)], {
  cwd: rootDir,
  env: cleanEnv,
  stdio: 'inherit'
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child.exitCode === null) {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
