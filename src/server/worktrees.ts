import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function resolveIntegrationShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command]
    };
  }
  if (existsSync('/bin/zsh')) {
    return { file: '/bin/zsh', args: ['-lc', command] };
  }
  if (existsSync('/bin/bash')) {
    return { file: '/bin/bash', args: ['-lc', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export interface StepWorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseSha: string;
}

export interface IntegrationMergeResult {
  integrationPath: string;
  integrationBranch: string;
  mergedStepBranches: string[];
  headSha: string;
  testOutput?: string;
}

/**
 * Manages isolated Git worktrees per coding step and merges accepted step branches
 * into a Run-scoped integration worktree with verification before final delivery.
 * Uses a per-repository async mutex so concurrent parallel steps never race on git ref locks.
 */
export class WorktreeManager {
  private readonly repoLocks = new Map<string, Promise<void>>();

  constructor(private readonly worktreesRoot: string) {}

  private async withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(repoPath);
    const prev = this.repoLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => current);
    this.repoLocks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.repoLocks.get(key) === chained) {
        this.repoLocks.delete(key);
      }
    }
  }

  public async ensureRunIntegrationWorktree(input: {
    repoPath: string;
    runId: string;
  }): Promise<{ integrationPath: string; integrationBranch: string; baseSha: string }> {
    return this.withRepoLock(input.repoPath, async () => {
      return this.ensureRunIntegrationWorktreeUnlocked(input);
    });
  }

  private async ensureRunIntegrationWorktreeUnlocked(input: {
    repoPath: string;
    runId: string;
  }): Promise<{ integrationPath: string; integrationBranch: string; baseSha: string }> {
    const baseSha = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.repoPath })
    ).stdout.trim();
    const safeRun = input.runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const integrationBranch = `dw2/run-${safeRun}/integration`;
    const integrationPath = path.join(this.worktreesRoot, safeRun, 'integration');

    await fs.mkdir(path.dirname(integrationPath), { recursive: true });
    try {
      await fs.access(path.join(integrationPath, '.git'));
      return { integrationPath, integrationBranch, baseSha };
    } catch {
      // create fresh worktree
    }

    await execFileAsync(
      'git',
      ['worktree', 'add', '-B', integrationBranch, integrationPath, baseSha],
      { cwd: input.repoPath }
    );
    return { integrationPath, integrationBranch, baseSha };
  }

  public async ensureStepWorktree(input: {
    repoPath: string;
    runId: string;
    stepId: string;
  }): Promise<StepWorktreeInfo> {
    return this.withRepoLock(input.repoPath, async () => {
      const { baseSha } = await this.ensureRunIntegrationWorktreeUnlocked({
        repoPath: input.repoPath,
        runId: input.runId
      });
      const safeRun = input.runId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeStep = input.stepId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const branchName = `dw2/run-${safeRun}/${safeStep}`;
      const worktreePath = path.join(this.worktreesRoot, safeRun, safeStep);

      try {
        await fs.access(path.join(worktreePath, '.git'));
        return { worktreePath, branchName, baseSha };
      } catch {
        // create fresh step worktree
      }

      await execFileAsync(
        'git',
        ['worktree', 'add', '-B', branchName, worktreePath, baseSha],
        { cwd: input.repoPath }
      );
      return { worktreePath, branchName, baseSha };
    });
  }

  public async commitStepChangesIfNeeded(
    worktreePath: string,
    commitMessage: string,
    runId?: string
  ): Promise<string | null> {
    const status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath })).stdout.trim();
    if (status.length > 0) {
      await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
      await execFileAsync(
        'git',
        [
          '-c', 'user.name=DuolaWork2',
          '-c', 'user.email=duolawork2@local',
          'commit', '-m', commitMessage
        ],
        { cwd: worktreePath }
      );
      return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
    }

    if (runId) {
      const safeRun = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const integrationBranch = `dw2/run-${safeRun}/integration`;
      try {
        const aheadRaw = (
          await execFileAsync('git', ['rev-list', '--count', `${integrationBranch}..HEAD`], {
            cwd: worktreePath
          })
        ).stdout.trim();
        if ((Number.parseInt(aheadRaw, 10) || 0) <= 0) {
          return null;
        }
      } catch {
        // if base ref check fails, fall through to HEAD
      }
    }

    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
  }

  public async mergeAndVerifyIntegration(input: {
    repoPath: string;
    runId: string;
    stepBranches: string[];
    testCommand?: string | null;
  }): Promise<IntegrationMergeResult> {
    const { integrationPath, integrationBranch } = await this.ensureRunIntegrationWorktree({
      repoPath: input.repoPath,
      runId: input.runId
    });

    const merged: string[] = [];
    for (const branch of input.stepBranches) {
      if (!branch) continue;
      try {
        await execFileAsync(
          'git',
          [
            '-c', 'user.name=DuolaWork2',
            '-c', 'user.email=duolawork2@local',
            'merge', '--no-ff', '-m', `Merge ${branch} into ${integrationBranch}`, branch
          ],
          { cwd: integrationPath }
        );
        merged.push(branch);
      } catch (err) {
        await execFileAsync('git', ['merge', '--abort'], { cwd: integrationPath }).catch(() => {});
        throw new Error(`合并代码分支 ${branch} 冲突: ${(err as Error).message}`);
      }
    }

    let testOutput: string | undefined;
    if (input.testCommand && input.testCommand.trim()) {
      const shell = resolveIntegrationShell(input.testCommand);
      const { stdout, stderr } = await execFileAsync(shell.file, shell.args, {
        cwd: integrationPath,
        timeout: 120_000
      });
      testOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
    }

    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: integrationPath })).stdout.trim();
    return {
      integrationPath,
      integrationBranch,
      mergedStepBranches: merged,
      headSha,
      testOutput
    };
  }

  public async cleanupRunWorktrees(repoPath: string, runId: string): Promise<void> {
    return this.withRepoLock(repoPath, async () => {
      const safeRun = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const runDir = path.join(this.worktreesRoot, safeRun);
      try {
        const entries = await fs.readdir(runDir);
        for (const name of entries) {
          const wtPath = path.join(runDir, name);
          await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath }).catch(() => {});
        }
        await fs.rm(runDir, { recursive: true, force: true });
      } catch {
        // ignore if absent
      }
    });
  }
}
