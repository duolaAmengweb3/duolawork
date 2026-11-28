export function isDuolaWorkProcessCommand(cmd, targetAppPath = '') {
  const raw = String(cmd || '').trim();
  if (!raw) return false;
  if (raw.includes('agent-hub/profiles') || raw.includes('Google Chrome')) return false;
  if (targetAppPath && raw.includes(targetAppPath)) return true;
  if (raw.includes('/DuolaWork.app/') && !raw.includes('/.staging-') && !raw.includes('/previous-Agent-Hub')) {
    return true;
  }
  if (
    raw.includes('dist/server/') ||
    raw.includes('desktop/main.cjs') ||
    raw.includes('duolawork2.0/dist/server/') ||
    raw.includes('duolawork2.0/desktop/main.cjs') ||
    raw.includes('duolawork-v2')
  ) {
    return true;
  }
  return false;
}

export function partitionPortListeners(pids, getCommand, targetAppPath = '', chromePids = []) {
  const chromeSet = new Set(chromePids);
  const duolaworkPids = [];
  const unrelatedPids = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || chromeSet.has(pid)) continue;
    const command = String(getCommand(pid) || '').trim();
    if (isDuolaWorkProcessCommand(command, targetAppPath)) {
      duolaworkPids.push(pid);
    } else {
      unrelatedPids.push({ pid, command: command || '(unknown)' });
    }
  }
  return { duolaworkPids, unrelatedPids };
}

export async function gracefullyStopDuolaWorkProcesses({
  duolaworkPids,
  unrelatedPids,
  bootMode,
  signalPid,
  waitExit,
  waitPortFree,
  gracefulTimeoutMs = 8000
}) {
  if (bootMode === 'local' && unrelatedPids.length > 0) {
    const desc = unrelatedPids.map((u) => `${u.pid} (${u.command})`).join(', ');
    throw new Error(
      `[activate] 端口 8780 正被非 DuolaWork 进程占用，拒绝终止无关进程: ${desc}`
    );
  }

  const targets = [...new Set(duolaworkPids.filter((p) => Number.isInteger(p) && p > 0))];
  if (targets.length === 0) return { stoppedPids: [] };

  for (const pid of targets) {
    signalPid(pid, 'SIGTERM');
  }

  const remaining = await waitExit(targets, gracefulTimeoutMs);
  const portFree = bootMode === 'local' ? await waitPortFree(gracefulTimeoutMs) : true;
  if (remaining.length > 0 || !portFree) {
    throw new Error(
      `[activate] DuolaWork 未在 ${Math.round(gracefulTimeoutMs / 1000)}s 内完成退出（可能存在未保存草稿或用户在退出确认框点击了「继续编辑」），已安全中止升级并保留原进程 [${remaining.join(',')}]，未发送 SIGKILL。`
    );
  }

  return { stoppedPids: targets };
}

export async function transactionalAppInstall({
  builtApp,
  targetApp,
  targetReleaseDir,
  exists,
  mkdir,
  copyBundle,
  rename,
  rmTree,
  verifyInstalled
}) {
  mkdir(targetReleaseDir);
  const stamp = `${Date.now()}-${process.pid}`;
  const stagingTarget = `${targetReleaseDir}/.staging-DuolaWork-${stamp}.app`;
  const rollbackTarget = `${targetReleaseDir}/.rollback-DuolaWork-${stamp}.app`;

  rmTree(stagingTarget);
  rmTree(rollbackTarget);

  await copyBundle(builtApp, stagingTarget);

  let hadPrevious = false;
  if (exists(targetApp)) {
    rename(targetApp, rollbackTarget);
    hadPrevious = true;
  }
  rename(stagingTarget, targetApp);

  try {
    const result = await verifyInstalled(targetApp);
    if (hadPrevious && exists(rollbackTarget)) {
      rmTree(rollbackTarget);
    }
    return { rolledBack: false, result };
  } catch (err) {
    try {
      if (exists(targetApp)) rmTree(targetApp);
      if (hadPrevious && exists(rollbackTarget)) {
        rename(rollbackTarget, targetApp);
      }
    } catch (rollbackErr) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} (rollback also failed: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        })`
      );
    }
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} [已回滚至升级前版本]`
    );
  }
}
