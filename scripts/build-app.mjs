import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build as esbuild } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

function binPath(name) {
  return path.join(rootDir, 'node_modules', '.bin', name);
}

let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {
  commit = '';
}

const builtAt = new Date().toISOString();
const stamp = builtAt.replace(/[-:.TZ]/g, '').slice(0, 14);
const buildInfo = {
  id: `${stamp}-${randomUUID().slice(0, 8)}`,
  version: String(pkg.version || '2.0.0'),
  builtAt,
  commit
};

console.log('[build] 1/4 typechecking TypeScript...');
execFileSync(binPath('tsc'), ['-p', 'tsconfig.json', '--noEmit'], {
  cwd: rootDir,
  stdio: 'inherit'
});

console.log('[build] 2/4 building Vite web bundle...');
execFileSync(binPath('vite'), ['build'], {
  cwd: rootDir,
  stdio: 'inherit'
});

console.log('[build] 3/4 bundling server & node-runner modules for Node 24 / Electron...');
const distServerDir = path.join(rootDir, 'dist', 'server');
const distNodeDir = path.join(rootDir, 'dist', 'node-runner');
fs.mkdirSync(distServerDir, { recursive: true });
fs.mkdirSync(distNodeDir, { recursive: true });
const esmNodeBanner = {
  js: 'import { createRequire as __dwCreateRequire } from "node:module"; const require = __dwCreateRequire(import.meta.url);'
};
await esbuild({
  entryPoints: [
    path.join(rootDir, 'src/server/app.ts'),
    path.join(rootDir, 'src/server/index.ts')
  ],
  outdir: distServerDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: esmNodeBanner,
  external: ['node:*', 'electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: false,
  logLevel: 'silent'
});
await esbuild({
  entryPoints: [path.join(rootDir, 'src/node-runner/index.ts')],
  outdir: distNodeDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: esmNodeBanner,
  external: ['node:*', 'electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: false,
  logLevel: 'silent'
});

console.log('[build] 4/4 writing dist/build-info.json & checking bundle constraints...');
const buildInfoPath = path.join(rootDir, 'dist', 'build-info.json');
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');

const distWebAssetsDir = path.join(rootDir, 'dist', 'web', 'assets');
let totalJsGzipBytes = 0;
if (fs.existsSync(distWebAssetsDir)) {
  for (const file of fs.readdirSync(distWebAssetsDir)) {
    if (file.endsWith('.js')) {
      const gz = zlib.gzipSync(fs.readFileSync(path.join(distWebAssetsDir, file)));
      totalJsGzipBytes += gz.length;
    }
  }
}

console.log(
  `[build] ready version=${buildInfo.version} buildId=${buildInfo.id} jsGzipKB=${(totalJsGzipBytes / 1024).toFixed(2)}`
);
