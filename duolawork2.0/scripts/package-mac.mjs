import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
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
  const candidates = [
    process.env.DUOLAWORK_ELECTRON_APP,
    path.join(rootDir, 'node_modules/electron/dist/Electron.app'),
    '/Users/duola/Desktop/Xduola/.worktrees/agent-hub-conversation-20261031/node_modules/electron/dist/Electron.app'
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(path.join(p, 'Contents/MacOS/Electron')));
  if (!found) {
    throw new Error('未找到可用 Electron.app 模板');
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

const templateApp = findElectronTemplateApp();
const releaseDir = path.join(rootDir, 'release');
fs.mkdirSync(releaseDir, { recursive: true });
const stagingApp = path.join(releaseDir, `.staging-Agent Hub.app`);
const targetApp = path.join(releaseDir, 'Agent Hub.app');
fs.rmSync(stagingApp, { recursive: true, force: true });

console.log(`[package:mac] copying Electron template -> ${stagingApp}`);
execFileSync('/usr/bin/ditto', [templateApp, stagingApp], { stdio: 'inherit' });

const appResourcesDir = path.join(stagingApp, 'Contents', 'Resources');
const embeddedAppDir = path.join(appResourcesDir, 'app');
fs.rmSync(path.join(appResourcesDir, 'default_app.asar'), { force: true });
fs.mkdirSync(embeddedAppDir, { recursive: true });

fs.cpSync(path.join(rootDir, 'dist'), path.join(embeddedAppDir, 'dist'), { recursive: true });
fs.cpSync(path.join(rootDir, 'desktop'), path.join(embeddedAppDir, 'desktop'), { recursive: true });
fs.writeFileSync(
  path.join(embeddedAppDir, 'package.json'),
  JSON.stringify(
    {
      name: 'duolawork',
      productName: 'DuolaWork',
      version: String(pkg.version || '2.0.0'),
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
const compatSearchDirs = [
  '/Users/duola/Desktop/Xduola/32号-Agent-Hub/release/Agent Hub.app/Contents/Resources/app/local',
  '/Users/duola/Desktop/Xduola/32号-Agent-Hub/release/previous-Agent-Hub-1.9.6.app/Contents/Resources/app/local'
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
setPlistKey(plistPath, 'CFBundleName', 'Agent Hub');
setPlistKey(plistPath, 'CFBundleIdentifier', 'com.duola.agenthub');
setPlistKey(plistPath, 'CFBundleShortVersionString', String(pkg.version || '2.0.0'));
setPlistKey(plistPath, 'CFBundleVersion', String(buildInfo.id));
setPlistKey(plistPath, 'CFBundleIconFile', 'DuolaWork.icns');

fs.rmSync(targetApp, { recursive: true, force: true });
fs.renameSync(stagingApp, targetApp);

console.log('[package:mac] codesigning Agent Hub.app...');
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', targetApp], {
  stdio: 'inherit'
});

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
  console.log(`[package:mac] verified packaged app & persistence: ${targetApp}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
