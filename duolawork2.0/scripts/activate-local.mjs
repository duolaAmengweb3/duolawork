import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = path.join(rootDir, 'release', 'Agent Hub.app');
const buildInfoPath = path.join(rootDir, 'dist', 'build-info.json');
const targetReleaseDir = '/Users/duola/Desktop/Xduola/32号-Agent-Hub/release';
const targetApp = path.join(targetReleaseDir, 'Agent Hub.app');
const backup196App = path.join(targetReleaseDir, 'previous-Agent-Hub-1.9.6.app');
const evidenceDir = path.join(rootDir, 'evidence', 'v2-final');
const launchPng = path.join(evidenceDir, 'desktop-activated.png');
const activationJson = path.join(evidenceDir, 'activation.json');
const agentHubDir = path.join(os.homedir(), '.config', 'agent-hub');

if (!fs.existsSync(path.join(builtApp, 'Contents/MacOS/Electron')) || !fs.existsSync(buildInfoPath)) {
  throw new Error('缺少打包产物，请先运行 npm run build && npm run package:mac');
}
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));

function hashProtectedFiles() {
  const names = [
    'config.json',
    'vault.enc',
    'vault-key.oscrypt',
    'browser-profiles.json',
    'agent-connections.json',
    'native-coding.json'
  ];
  const out = {};
  for (const name of names) {
    const p = path.join(agentHubDir, name);
    if (fs.existsSync(p)) {
      out[name] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }
  return out;
}

function listManagedChromePids() {
  try {
    const txt = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const pids = [];
    for (const line of txt.split('\n')) {
      if (
        line.includes('agent-hub/profiles') &&
        !line.includes('Google Chrome Helper') &&
        !line.includes('grep')
      ) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid > 0) pids.push(pid);
      }
    }
    return pids.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function getListeningPids(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    return out
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

async function waitPortFree(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getListeningPids(port).length === 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidsExit(pids, timeoutMs = 6000) {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = unique.filter((p) => isPidAlive(p));
    if (alive.length === 0) return [];
    await new Promise((r) => setTimeout(r, 150));
  }
  return unique.filter((p) => isPidAlive(p));
}

function readBundleVersion(appPath) {
  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) return '';
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return '';
  }
}

const protectedBefore = hashProtectedFiles();
const chromePidsBefore = listManagedChromePids();
console.log(`[activate] protected files hashed: ${Object.keys(protectedBefore).length}, chrome PIDs: ${chromePidsBefore.join(',') || 'none'}`);

// 1. Gracefully stop legacy 1.9.6 on port 8766 (checking active work first!)
const pids8766 = getListeningPids(8766);
if (pids8766.length > 0) {
  try {
    const awRes = await fetch('http://127.0.0.1:8766/api/local/active-work');
    if (awRes.ok) {
      const aw = await awRes.json();
      if (aw.busy && process.env.FORCE_ACTIVATE !== '1') {
        throw new Error(`1.9.6 正在执行任务，拒绝中断: ${JSON.stringify(aw)}`);
      }
    }
  } catch (err) {
    if (String(err.message).includes('拒绝中断')) throw err;
  }

  try {
    const prep = await fetch('http://127.0.0.1:8766/api/local/prepare-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'upgrade_to_duolawork_2_0' })
    });
    if (prep.ok) {
      const body = await prep.json();
      console.log(`[activate] 1.9.6 prepare-update -> ${JSON.stringify(body)}`);
    }
  } catch {
    // ignore if endpoint already stopping
  }

  const legacyPids = pids8766.filter((pid) => !chromePidsBefore.includes(pid));
  for (const pid of legacyPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const freed = await waitPortFree(8766, 8000);
  if (!freed) {
    throw new Error('端口 8766 未在 8s 内释放，中止替换以保护现场');
  }
  await waitPidsExit(legacyPids, 4000);
}

// 2. Gracefully stop any running DuolaWork 2.0 server/app on port 8780
const pids8780 = getListeningPids(8780).filter((pid) => !chromePidsBefore.includes(pid));
for (const pid of pids8780) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}
if (pids8780.length > 0) {
  const freed8780 = await waitPortFree(8780, 6000);
  let remaining = await waitPidsExit(pids8780, 5000);
  if (!freed8780 || remaining.length > 0) {
    const fallbackPids = new Set([
      ...remaining,
      ...getListeningPids(8780).filter((pid) => !chromePidsBefore.includes(pid))
    ]);
    for (const pid of fallbackPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await waitPidsExit([...fallbackPids], 3000);
    await waitPortFree(8780, 3000);
  }
  await new Promise((r) => setTimeout(r, 300));
}

// 3. Preserve 1.9.6 backup & atomically install 2.0.0 into live release/Agent Hub.app
fs.mkdirSync(targetReleaseDir, { recursive: true });
const previousVersion = fs.existsSync(targetApp) ? readBundleVersion(targetApp) : '';
if (fs.existsSync(targetApp)) {
  if (previousVersion && !previousVersion.startsWith('2.') && !fs.existsSync(backup196App)) {
    console.log(`[activate] backing up legacy ${previousVersion} -> ${backup196App}`);
    fs.renameSync(targetApp, backup196App);
  }
}

const stagingTarget = path.join(targetReleaseDir, `.staging-Agent Hub-${Date.now()}.app`);
fs.rmSync(stagingTarget, { recursive: true, force: true });
execFileSync('/usr/bin/ditto', [builtApp, stagingTarget], { stdio: 'inherit' });
if (fs.existsSync(targetApp)) {
  const prevTrash = path.join(targetReleaseDir, '.prev-Agent Hub.app');
  fs.rmSync(prevTrash, { recursive: true, force: true });
  fs.renameSync(targetApp, prevTrash);
  fs.renameSync(stagingTarget, targetApp);
  fs.rmSync(prevTrash, { recursive: true, force: true });
} else {
  fs.renameSync(stagingTarget, targetApp);
}
console.log(`[activate] installed ${targetApp}`);

// 4. Launch installed desktop app detached & capture launch screenshot
fs.mkdirSync(evidenceDir, { recursive: true });
fs.rmSync(launchPng, { force: true });
const appExec = path.join(targetApp, 'Contents', 'MacOS', 'Electron');
const cleanLaunchEnv = { ...process.env };
for (const k of [
  'ELECTRON_RUN_AS_NODE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
]) {
  delete cleanLaunchEnv[k];
}
const launched = spawn(appExec, [], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...cleanLaunchEnv,
    DUOLAWORK_V2_LAUNCH_EVIDENCE: launchPng
  }
});
launched.unref();

let health = null;
const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  try {
    const res = await fetch('http://127.0.0.1:8780/api/v2/health');
    if (res.ok) {
      const data = await res.json();
      if (
        data.desktopReady &&
        data.renderedBuildId === buildInfo.id &&
        fs.existsSync(launchPng) &&
        fs.statSync(launchPng).size > 10000
      ) {
        health = data;
        break;
      }
    }
  } catch {
    // wait for startup
  }
  await new Promise((r) => setTimeout(r, 300));
}

if (!health) {
  throw new Error('激活后的 DuolaWork 2.0 桌面端未在预期时间内完成渲染就绪或截图');
}

assert.equal(health.version, buildInfo.version);
assert.equal(health.buildId, buildInfo.id);
assert.equal(health.desktopReady, true);
assert.equal(health.renderedBuildId, buildInfo.id);

const boot = await (await fetch('http://127.0.0.1:8780/api/v2/bootstrap')).json();
const hasClaudeVps = (boot.members || []).some(
  (m) =>
    m.id === 'member_bf4fdac30b4542c8988bb6725f47ec0b' ||
    String(m.name || '').toLowerCase().includes('claudevps') ||
    (m.platformId === 'claude-code' && (m.driverKind === 'remote-bridge' || m.location === 'remote-bridge'))
);
assert.equal(hasClaudeVps, false, 'ClaudeVPS must never appear in active members');
assert.ok((boot.members || []).length >= 2, 'Expected imported members >= 2');

const protectedAfter = hashProtectedFiles();
assert.deepEqual(protectedAfter, protectedBefore, 'Protected ~/.config/agent-hub/ files must remain untouched');

const chromePidsAfter = listManagedChromePids();
for (const pid of chromePidsBefore) {
  assert.ok(chromePidsAfter.includes(pid), `Managed Chrome PID ${pid} must stay alive across activation`);
}

const report = {
  activatedAt: new Date().toISOString(),
  targetApp,
  backup196App: fs.existsSync(backup196App) ? backup196App : null,
  previousVersion,
  installedVersion: readBundleVersion(targetApp),
  buildInfo,
  health,
  pid: launched.pid,
  launchScreenshot: launchPng,
  memberCount: boot.members?.length ?? 0,
  threadCount: boot.threads?.length ?? 0,
  taskCount: boot.tasks?.length ?? 0,
  chromePidsBefore,
  chromePidsAfter,
  protectedFilesVerified: Object.keys(protectedAfter)
};
fs.writeFileSync(activationJson, JSON.stringify(report, null, 2) + '\n');
console.log(`[activate] SUCCESS version=${report.installedVersion} buildId=${buildInfo.id} pid=${launched.pid}`);
