import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gracefullyStopDuolaWorkProcesses,
  partitionPortListeners,
  transactionalAppInstall
} from './activate-helpers.mjs';

const require = createRequire(import.meta.url);
const { resolveDesktopBootMode } = require('../desktop/boot-mode.cjs');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = path.join(rootDir, 'release', 'DuolaWork.app');
const buildInfoPath = path.join(rootDir, 'dist', 'build-info.json');
const targetReleaseDir =
  process.env.DUOLAWORK_TARGET_RELEASE_DIR || path.resolve(rootDir, '..', 'release');
const targetApp = path.join(targetReleaseDir, 'DuolaWork.app');
const legacyV2App = path.join(targetReleaseDir, 'Agent Hub.app');
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

function getProcessCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
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

async function waitPidsExit(pids, timeoutMs = 8000) {
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

function resolveActiveBootMode() {
  const desktopCfgDir = path.join(os.homedir(), '.config', 'duolawork-desktop');
  const clientCfgPath = path.join(desktopCfgDir, 'client.json');
  const cloudAccessPath = path.join(desktopCfgDir, 'cloud-access.json');
  let clientConfig = null;
  try {
    if (fs.existsSync(clientCfgPath)) {
      clientConfig = JSON.parse(fs.readFileSync(clientCfgPath, 'utf8'));
    }
  } catch {
    clientConfig = null;
  }
  return resolveDesktopBootMode({
    envCloudUrl: process.env.DUOLAWORK_CLOUD_URL || '',
    clientConfig,
    hasCloudAccess: fs.existsSync(cloudAccessPath),
    testMode: process.env.DUOLAWORK_V2_TEST_MODE === '1'
  });
}

function isTargetAppCmd(cmd) {
  return cmd.includes(targetApp) && !cmd.includes('/duolawork2.0/');
}

function listTargetAppMainPids() {
  try {
    const out = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    const pids = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(' ');
      if (sp <= 0) continue;
      const pid = Number(trimmed.slice(0, sp).trim());
      const cmd = trimmed.slice(sp + 1);
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        pid !== process.pid &&
        isTargetAppCmd(cmd) &&
        cmd.trimEnd().endsWith('/Contents/MacOS/Electron')
      ) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function rmTreeForce(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  } catch {
    // Fallback on macOS APFS/Spotlight ENOTEMPTY locks inside .app bundles
  }
  if (fs.existsSync(dirPath)) {
    execFileSync('/bin/rm', ['-rf', dirPath]);
  }
}

const protectedBefore = hashProtectedFiles();
const chromePidsBefore = listManagedChromePids();
const bootMode = resolveActiveBootMode();
console.log(
  `[activate] protected files hashed: ${Object.keys(protectedBefore).length}, chrome PIDs: ${chromePidsBefore.join(',') || 'none'}`
);

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

// 2. Identify port 8780 listeners safely, preserve unrelated processes, and send only SIGTERM to DuolaWork
const { duolaworkPids: port8780DuolaPids, unrelatedPids } = partitionPortListeners(
  getListeningPids(8780),
  getProcessCommand,
  targetApp,
  chromePidsBefore
);
const appMainPids = listTargetAppMainPids().filter((pid) => !chromePidsBefore.includes(pid));
await gracefullyStopDuolaWorkProcesses({
  duolaworkPids: [...port8780DuolaPids, ...appMainPids],
  unrelatedPids,
  bootMode: bootMode.mode,
  signalPid: (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {
      // ignore ESRCH
    }
  },
  waitExit: (pids, timeoutMs) => waitPidsExit(pids, timeoutMs),
  waitPortFree: (timeoutMs) => waitPortFree(8780, timeoutMs),
  gracefulTimeoutMs: Number(process.env.DUOLAWORK_ACTIVATE_WAIT_MS || 8000)
});

// 3 + 4. Preserve 1.9.6 backup, install transactionally keeping previous bundle until verification succeeds!
fs.mkdirSync(targetReleaseDir, { recursive: true });
const legacyAppVer = fs.existsSync(legacyV2App) ? readBundleVersion(legacyV2App) : '';
if (fs.existsSync(legacyV2App) && legacyAppVer && legacyAppVer.startsWith('1.') && !fs.existsSync(backup196App)) {
  console.log(`[activate] backing up legacy ${legacyAppVer} -> ${backup196App}`);
  fs.renameSync(legacyV2App, backup196App);
}
const previousVersion = fs.existsSync(targetApp) ? readBundleVersion(targetApp) : legacyAppVer;

const { result: verifyReport } = await transactionalAppInstall({
  builtApp,
  targetApp,
  targetReleaseDir,
  exists: (p) => fs.existsSync(p),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  copyBundle: async (src, dest) => {
    execFileSync('/usr/bin/ditto', [src, dest], { stdio: 'inherit' });
  },
  rename: (src, dest) => fs.renameSync(src, dest),
  rmTree: rmTreeForce,
  verifyInstalled: async (installedAppPath) => {
    console.log(`[activate] staged & verifying ${installedAppPath}`);
    console.log(`[activate] boot mode: ${bootMode.mode}${bootMode.cloudUrl ? ` (${bootMode.cloudUrl})` : ''}`);

    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.rmSync(launchPng, { force: true });
    const appExec = path.join(installedAppPath, 'Contents', 'MacOS', 'Electron');
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
    let memberCount = null;
    let threadCount = null;
    let taskCount = null;
    const deadline = Date.now() + 25_000;

    try {
      if (bootMode.mode === 'cloud') {
        let pngReady = false;
        while (Date.now() < deadline) {
          if (!isPidAlive(launched.pid)) {
            throw new Error(`激活后的 DuolaWork 桌面端进程提前退出 (pid=${launched.pid})`);
          }
          if (fs.existsSync(launchPng) && fs.statSync(launchPng).size > 10000) {
            pngReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!pngReady || !isPidAlive(launched.pid)) {
          throw new Error('激活后的 DuolaWork Cloud 桌面端未在预期时间内完成截图就绪');
        }
        const healthRes = await fetch(`${bootMode.cloudUrl}/api/v2/health`);
        if (!healthRes.ok) {
          throw new Error(`Cloud 健康检查失败: HTTP ${healthRes.status}`);
        }
        health = await healthRes.json();
        assert.equal(health.status, 'ok');
        assert.equal(health.version, buildInfo.version);
        assert.equal(health.buildId, buildInfo.id);
      } else {
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
          throw new Error('激活后的 DuolaWork Local 桌面端未在预期时间内完成渲染就绪或截图');
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
        memberCount = boot.members?.length ?? 0;
        threadCount = boot.threads?.length ?? 0;
        taskCount = boot.tasks?.length ?? 0;
      }

      const protectedAfter = hashProtectedFiles();
      assert.deepEqual(
        protectedAfter,
        protectedBefore,
        'Protected ~/.config/agent-hub/ files must remain untouched'
      );

      const chromePidsAfter = listManagedChromePids();
      for (const pid of chromePidsBefore) {
        assert.ok(chromePidsAfter.includes(pid), `Managed Chrome PID ${pid} must stay alive across activation`);
      }

      return {
        health,
        memberCount,
        threadCount,
        taskCount,
        pid: launched.pid,
        chromePidsAfter,
        protectedAfter
      };
    } catch (verifyErr) {
      if (launched.pid && isPidAlive(launched.pid)) {
        try {
          process.kill(launched.pid, 'SIGTERM');
          await waitPidsExit([launched.pid], 3000);
        } catch {
          // ignore
        }
      }
      throw verifyErr;
    }
  }
});

const report = {
  activatedAt: new Date().toISOString(),
  bootMode: bootMode.mode,
  cloudUrl: bootMode.cloudUrl || null,
  targetApp,
  backup196App: fs.existsSync(backup196App) ? backup196App : null,
  previousVersion,
  installedVersion: readBundleVersion(targetApp),
  buildInfo,
  health: verifyReport.health,
  pid: verifyReport.pid,
  launchScreenshot: launchPng,
  memberCount: verifyReport.memberCount,
  threadCount: verifyReport.threadCount,
  taskCount: verifyReport.taskCount,
  chromePidsBefore,
  chromePidsAfter: verifyReport.chromePidsAfter,
  protectedFilesVerified: Object.keys(verifyReport.protectedAfter)
};
fs.writeFileSync(activationJson, JSON.stringify(report, null, 2) + '\n');
console.log(
  `[activate] SUCCESS mode=${bootMode.mode} version=${report.installedVersion} buildId=${buildInfo.id} pid=${report.pid}`
);
