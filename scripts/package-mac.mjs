import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const buildInfoPath = path.join(rootDir, 'dist', 'build-info.json');

if (!fs.existsSync(buildInfoPath) || !fs.existsSync(path.join(rootDir, 'dist', 'server', 'app.mjs'))) {
  throw new Error('缺少构建产物，请先运行 npm run build');
}
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));

function findElectronTemplateApp() {
  const req = createRequire(import.meta.url);
  let resolvedPkgDir = '';
  let resolvedFromPackage = '';
  try {
    resolvedPkgDir = path.dirname(req.resolve('electron/package.json'));
    resolvedFromPackage = path.join(resolvedPkgDir, 'dist', 'Electron.app');
  } catch {
    resolvedPkgDir = '';
    resolvedFromPackage = '';
  }
  const candidates = [
    process.env.DUOLAWORK_ELECTRON_APP,
    path.join(rootDir, 'node_modules/electron/dist/Electron.app'),
    resolvedFromPackage,
    path.resolve(rootDir, '..', 'node_modules/electron/dist/Electron.app')
  ].filter(Boolean);
  let found = candidates.find((p) => fs.existsSync(path.join(p, 'Contents/MacOS/Electron')));
  if (!found && resolvedPkgDir && fs.existsSync(path.join(resolvedPkgDir, 'install.js'))) {
    console.log('[package:mac] Electron.app template missing; running electron installer...');
    const hasProxy = Boolean(
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    );
    const args = hasProxy ? ['--use-env-proxy', path.join(resolvedPkgDir, 'install.js')] : [path.join(resolvedPkgDir, 'install.js')];
    execFileSync(process.execPath, args, { cwd: rootDir, stdio: 'inherit' });
    found = candidates.find((p) => fs.existsSync(path.join(p, 'Contents/MacOS/Electron')));
  }
  if (!found) {
    throw new Error('未找到可用 Electron.app 模板，请先执行 npm ci 安装 electron');
  }
  return found;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function setPlistKey(plistPath, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], { stdio: 'ignore' });
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath], { stdio: 'ignore' });
  }
}

function parseSignIdentity(argv) {
  let signIdentity = process.env.DUOLAWORK_SIGN_IDENTITY || '-';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sign' && argv[i + 1]) {
      signIdentity = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--sign=')) {
      signIdentity = arg.slice('--sign='.length);
    }
  }
  return signIdentity.trim() || '-';
}

function isMachOBinary(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      magic === 0xfeedface ||
      magic === 0xcefaedfe ||
      magic === 0xfeedfacf ||
      magic === 0xcffaedfe
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walkBundleSignTargets(dir, out = { files: [], frameworks: [], apps: [] }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '_CodeSignature') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkBundleSignTargets(fullPath, out);
      if (entry.name.endsWith('.framework')) {
        out.frameworks.push(fullPath);
      } else if (entry.name.endsWith('.app')) {
        out.apps.push(fullPath);
      }
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith('.dylib') ||
        entry.name.endsWith('.so') ||
        entry.name.endsWith('.node') ||
        isMachOBinary(fullPath))
    ) {
      out.files.push(fullPath);
    }
  }
  return out;
}

function codesignAppBundle(targetApp, signIdentity, entitlementsPath) {
  if (!signIdentity || signIdentity === '-') {
    console.log('[package:mac] codesigning DuolaWork.app (ad-hoc)...');
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', targetApp], {
      stdio: 'inherit'
    });
    return;
  }

  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`[package:mac] Missing entitlements file: ${entitlementsPath}`);
  }

  console.log(`[package:mac] Developer ID signing DuolaWork.app inside-out: ${signIdentity}`);
  const contentsDir = path.join(targetApp, 'Contents');
  const targets = walkBundleSignTargets(contentsDir);

  // Skip bundle primary binaries already signed when their enclosing .framework/.app is signed.
  const bundleRoots = new Set([...targets.frameworks, ...targets.apps, targetApp]);
  const signFile = (itemPath, withEntitlements) => {
    const args = ['--force', '--options', 'runtime', '--timestamp'];
    if (withEntitlements) args.push('--entitlements', entitlementsPath);
    args.push('--sign', signIdentity, itemPath);
    execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
  };

  for (const filePath of targets.files) {
    const parentName = path.basename(path.dirname(filePath));
    const grandParent = path.dirname(path.dirname(filePath));
    const greatGrandParent = path.dirname(grandParent);
    const isMainAppBinary = parentName === 'MacOS' && bundleRoots.has(greatGrandParent);
    const isFrameworkBinary =
      path.basename(filePath) === path.basename(targetApp, '.app') ||
      (bundleRoots.has(greatGrandParent) && path.basename(greatGrandParent).endsWith('.framework'));
    const isVersionedFrameworkBinary =
      path.basename(greatGrandParent) === 'Versions' &&
      bundleRoots.has(path.dirname(greatGrandParent)) &&
      path.basename(filePath) === path.basename(path.dirname(greatGrandParent), '.framework');
    if (isMainAppBinary || isFrameworkBinary || isVersionedFrameworkBinary) continue;
    signFile(filePath, true);
  }

  // Deepest-first ordering guarantees inner frameworks sign before helper apps and main bundle.
  const byDepthDesc = (a, b) => b.split(path.sep).length - a.split(path.sep).length;
  for (const fwPath of targets.frameworks.sort(byDepthDesc)) {
    signFile(fwPath, false);
  }
  for (const helperApp of targets.apps.sort(byDepthDesc)) {
    signFile(helperApp, true);
  }
  signFile(targetApp, true);

  console.log('[package:mac] verifying Developer ID signature...');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', targetApp], {
    stdio: 'inherit'
  });
}

const signIdentity = parseSignIdentity(process.argv.slice(2));
const entitlementsPath = path.join(rootDir, 'desktop', 'entitlements.mac.plist');
const templateApp = findElectronTemplateApp();
const releaseDir = path.join(rootDir, 'dist', 'mac');
fs.mkdirSync(releaseDir, { recursive: true });
const stagingApp = path.join(releaseDir, '.staging-DuolaWork.app');
const targetApp = path.join(releaseDir, 'DuolaWork.app');
const legacyPackagedApp = path.join(releaseDir, 'Agent Hub.app');
fs.rmSync(stagingApp, { recursive: true, force: true });

console.log(`[package:mac] copying Electron template -> ${stagingApp}`);
execFileSync('/usr/bin/ditto', [templateApp, stagingApp], { stdio: 'inherit' });

const appResourcesDir = path.join(stagingApp, 'Contents', 'Resources');
const embeddedAppDir = path.join(appResourcesDir, 'app');
fs.rmSync(path.join(appResourcesDir, 'default_app.asar'), { force: true });
fs.mkdirSync(embeddedAppDir, { recursive: true });

const distSrcDir = path.join(rootDir, 'dist');
const embeddedDistDir = path.join(embeddedAppDir, 'dist');
fs.mkdirSync(embeddedDistDir, { recursive: true });
for (const entry of fs.readdirSync(distSrcDir)) {
  if (entry === 'mac') continue;
  fs.cpSync(path.join(distSrcDir, entry), path.join(embeddedDistDir, entry), { recursive: true });
}
fs.cpSync(path.join(rootDir, 'desktop'), path.join(embeddedAppDir, 'desktop'), { recursive: true });
fs.writeFileSync(
  path.join(embeddedAppDir, 'package.json'),
  JSON.stringify(
    {
      name: 'duolawork',
      productName: 'DuolaWork',
      version: String(pkg.version || '3.0.0'),
      main: 'desktop/main.cjs'
    },
    null,
    2
  ) + '\n'
);

const icnsSrc = path.join(rootDir, 'desktop', 'assets', 'DuolaWork.icns');
if (fs.existsSync(icnsSrc)) {
  fs.copyFileSync(icnsSrc, path.join(appResourcesDir, 'DuolaWork.icns'));
  fs.copyFileSync(icnsSrc, path.join(appResourcesDir, 'electron.icns'));
}

// Preserve standalone external MCP/Feishu helper bundles for live process compatibility without importing 1.x server code
const compatBundleNames = ['feishu-mcp-bundle.cjs', 'mcp-tool-host-bundle.cjs'];
const compatReleaseRoot = process.env.DUOLAWORK_COMPAT_RELEASE_DIR || path.join(rootDir, 'release');
const compatSearchDirs = [
  path.join(compatReleaseRoot, 'DuolaWork.app', 'Contents', 'Resources', 'app', 'local'),
  path.join(compatReleaseRoot, 'Agent Hub.app', 'Contents', 'Resources', 'app', 'local'),
  path.join(compatReleaseRoot, 'previous-Agent-Hub-1.9.6.app', 'Contents', 'Resources', 'app', 'local')
];
for (const bundleName of compatBundleNames) {
  for (const dir of compatSearchDirs) {
    const srcFile = path.join(dir, bundleName);
    if (fs.existsSync(srcFile)) {
      const destLocalDir = path.join(embeddedAppDir, 'local');
      fs.mkdirSync(destLocalDir, { recursive: true });
      fs.copyFileSync(srcFile, path.join(destLocalDir, bundleName));
      break;
    }
  }
}

const plistPath = path.join(stagingApp, 'Contents', 'Info.plist');
setPlistKey(plistPath, 'CFBundleDisplayName', 'DuolaWork');
setPlistKey(plistPath, 'CFBundleName', 'DuolaWork');
setPlistKey(plistPath, 'CFBundleIdentifier', 'com.duola.agenthub');
setPlistKey(plistPath, 'CFBundleShortVersionString', String(pkg.version || '3.0.0'));
setPlistKey(plistPath, 'CFBundleVersion', String(buildInfo.id));
setPlistKey(plistPath, 'CFBundleIconFile', 'DuolaWork.icns');

fs.rmSync(targetApp, { recursive: true, force: true });
fs.rmSync(legacyPackagedApp, { recursive: true, force: true });
fs.renameSync(stagingApp, targetApp);

codesignAppBundle(targetApp, signIdentity, entitlementsPath);

// Isolated cold-start + persistence across relaunch verification
console.log('[package:mac] running isolated Electron cold-start & persistence smoke test...');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-pkg-smoke-'));
const testDbPath = path.join(tmpDir, 'test.sqlite');
const testUserData = path.join(tmpDir, 'electron-userdata');
const testScreenshot = path.join(tmpDir, 'smoke.png');
const execBin = path.join(targetApp, 'Contents', 'MacOS', 'Electron');

async function launchAndWaitHealth(port) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(execBin, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnv,
      DUOLAWORK_V2_TEST_MODE: '1',
      DUOLAWORK_V2_HEADLESS: '1',
      DUOLAWORK_V2_AUTO_IMPORT: '0',
      DUOLAWORK_V2_PORT: String(port),
      DUOLAWORK_V2_DB: testDbPath,
      DUOLAWORK_V2_USER_DATA: testUserData,
      DUOLAWORK_V2_LAUNCH_EVIDENCE: testScreenshot
    }
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d.toString()));
  child.stderr.on('data', (d) => (logs += d.toString()));

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v2/health`);
      if (res.ok) {
        const health = await res.json();
        if (health.desktopReady && health.renderedBuildId === buildInfo.id) {
          return { child, health };
        }
      }
    } catch {
      // retry while booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Packaged Electron smoke startup timed out. Logs:\n${logs}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

try {
  // Pass 1: Cold start & create a new thread
  const port1 = await getFreePort();
  const pass1 = await launchAndWaitHealth(port1);
  try {
    assert.equal(pass1.health.version, buildInfo.version);
    assert.equal(pass1.health.buildId, buildInfo.id);
    assert.equal(pass1.health.desktopReady, true);
    assert.equal(pass1.health.renderedBuildId, buildInfo.id);
    assert.ok(
      fs.existsSync(testScreenshot) && fs.statSync(testScreenshot).size > 1000,
      'Desktop launch screenshot missing or empty in smoke test'
    );

    const boot1 = await (await fetch(`http://127.0.0.1:${port1}/api/v2/bootstrap`)).json();
    // Seed a member via local sqlite? No, with autoImportAgentHub=0 members may be empty; let's test bootstrap & artifact/setting persistence!
    // Verify duolabase setting persistence across relaunch
    const setRes = await fetch(`http://127.0.0.1:${port1}/api/v2/settings/duolabase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, endpoint: 'https://duolabase.manyaitool.com/mcp' })
    });
    assert.equal(setRes.status, 200);
    assert.equal(boot1.buildInfo.id, buildInfo.id);
  } finally {
    await stopChild(pass1.child);
  }

  // Pass 2: Relaunch with auto-import enabled against temp agentHubDir? No, verify setting persisted on same DB!
  const port2 = await getFreePort();
  const pass2 = await launchAndWaitHealth(port2);
  try {
    const boot2 = await (await fetch(`http://127.0.0.1:${port2}/api/v2/bootstrap`)).json();
    assert.equal(boot2.duolabase.enabled, false, 'State persisted across desktop app relaunch');
  } finally {
    await stopChild(pass2.child);
  }
  console.log(`[package:mac] verified packaged app & persistence (${signIdentity === '-' ? 'ad-hoc' : signIdentity}): ${targetApp}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
