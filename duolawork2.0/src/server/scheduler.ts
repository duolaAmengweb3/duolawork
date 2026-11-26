import { Cron } from 'croner';
import type { DuolaWorkDatabase } from './db.js';
import type { TaskEngine } from './tasks-fsm.js';
import type { TaskRecord, TaskRunRecord } from '../shared/types.js';

/**
 * Pure Event/Clock-driven Scheduled Task Trigger:
 * - Zero heartbeat model wakeups when idle!
 * - Evaluates 5-field cron expressions in the task's configured IANA timezone (default `Asia/Shanghai`)
 *   or fixed `intervalSeconds`.
 * - Deduplicates strictly by `(task_id, planned_slot_at)` in SQLite (`UNIQUE(task_id, planned_slot_at)`),
 *   and supports `misfirePolicy: 'skip_stale' | 'catch_up_once'` across downtime!
 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly tasks: TaskEngine
  ) {}

  public start(checkEveryMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPeriodicTick().catch(() => {});
    }, checkEveryMs);
    this.timer.unref();
  }

  private async runPeriodicTick(): Promise<void> {
    const prevRaw = this.db.getSetting<string | null>('scheduler.last_tick_at', null);
    const prevDate = prevRaw && !Number.isNaN(Date.parse(prevRaw)) ? new Date(prevRaw) : undefined;
    const now = new Date();
    await this.tick(now, prevDate ? { lastCheckedAt: prevDate } : undefined);
    this.db.setSetting('scheduler.last_tick_at', now.toISOString());
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluates all enabled scheduled tasks at `now` (and optional downtime window for `catch_up_once`).
   * Launches newly instantiated `TaskRun`s asynchronously without blocking subsequent tasks or future runs!
   */
  public async tick(
    now: Date = new Date(),
    options?: { awaitRuns?: boolean; lastCheckedAt?: Date }
  ): Promise<TaskRunRecord[]> {
    const scheduledTasks = this.tasks
      .listTasks({ kind: 'scheduled' })
      .filter((t) => t.scheduleEnabled && t.status === 'active');

    const startedRuns: TaskRunRecord[] = [];
    const runPromises: Promise<unknown>[] = [];

    for (const task of scheduledTasks) {
      const slotKeys = this.resolveDueSlots(task, now, options?.lastCheckedAt);
      for (const slotKey of slotKeys) {
        const { run, created } = this.tasks.instantiateRun({
          taskId: task.id,
          plannedSlotAt: slotKey,
          triggerType: 'cron'
        });
        if (created) {
          startedRuns.push(run);
          const p = this.tasks.driveRun(run.id).catch(() => {});
          runPromises.push(p);
        }
      }
    }

    if (options?.awaitRuns) {
      await Promise.all(runPromises);
    }
    return startedRuns;
  }

  public toggleTaskSchedule(taskId: string, enabled: boolean): TaskRecord {
    const task = this.tasks.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(`UPDATE v2_tasks SET schedule_enabled = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, enabled ? 'active' : 'paused', now, taskId);
    return this.tasks.getTask(taskId)!;
  }

  private resolveDueSlots(task: TaskRecord, now: Date, lastCheckedAt?: Date): string[] {
    if (task.intervalSeconds && task.intervalSeconds > 0) {
      const bucketMs = task.intervalSeconds * 1000;
      const currentBucket = Math.floor(now.getTime() / bucketMs) * bucketMs;
      if (task.misfirePolicy === 'catch_up_once' && lastCheckedAt) {
        const prevBucket = currentBucket - bucketMs;
        if (prevBucket > lastCheckedAt.getTime()) {
          return [`interval:${prevBucket}`, `interval:${currentBucket}`].slice(-1);
        }
      }
      return [`interval:${currentBucket}`];
    }

    if (task.cronExpr) {
      // Check missed slot if `catch_up_once` and `lastCheckedAt` is provided (up to 12 hours lookback, max 1 catch-up run)
      if (task.misfirePolicy === 'catch_up_once' && lastCheckedAt) {
        const startMin = Math.floor(lastCheckedAt.getTime() / 60_000) + 1;
        const endMin = Math.floor(now.getTime() / 60_000);
        const createdMs = Date.parse(task.createdAt);
        const createdMin = Number.isFinite(createdMs) ? Math.floor(createdMs / 60_000) : 0;
        const lookbackFloor =
          createdMin > 0 && createdMin <= endMin
            ? Math.max(startMin, endMin - 12 * 60, createdMin)
            : Math.max(startMin, endMin - 12 * 60);
        let latestMatchingSlot: string | null = null;
        for (let m = lookbackFloor; m <= endMin; m++) {
          const candidate = new Date(m * 60_000);
          const matchKey = matchCronMinuteInTimezone(task.cronExpr, candidate, task.timezone);
          if (matchKey) latestMatchingSlot = matchKey;
        }
        return latestMatchingSlot ? [latestMatchingSlot] : [];
      }

      const currentSlot = matchCronMinuteInTimezone(task.cronExpr, now, task.timezone);
      return currentSlot ? [currentSlot] : [];
    }

    return [];
  }
}

export function validateCronExpr(
  cronExpr: string,
  timezone = 'Asia/Shanghai'
): { valid: boolean; error?: string } {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    return { valid: false, error: `无效的时区设置: ${timezone}` };
  }

  const trimmed = String(cronExpr || '').trim();
  if (!trimmed) {
    return { valid: false, error: '定时任务 Cron 表达式不能为空' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Cron 表达式需要 5 个字段（分 时 日 月 周），当前共 ${parts.length} 个字段`
    };
  }

  try {
    const job = new Cron(trimmed, { timezone, paused: true });
    const next = job.nextRun();
    job.stop();
    if (!next) {
      return { valid: false, error: `该 Cron 表达式无法计算下次触发时间: ${trimmed}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Cron 表达式格式有误 (${(err as Error).message})`
    };
  }
}

export function matchCronMinuteInTimezone(
  cronExpr: string,
  date: Date,
  timezone = 'Asia/Shanghai'
): string | null {
  const trimmed = String(cronExpr || '').trim();
  if (trimmed.split(/\s+/).length !== 5) return null;

  try {
    const minuteFloorMs = Math.floor(date.getTime() / 60_000) * 60_000;
    const probeBefore = new Date(minuteFloorMs - 1000);
    const job = new Cron(trimmed, { timezone, paused: true });
    const next = job.nextRun(probeBefore);
    job.stop();
    if (!next || next.getTime() !== minuteFloorMs) {
      return null;
    }

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const mapped: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(minuteFloorMs))) {
      if (p.type !== 'literal') mapped[p.type] = p.value;
    }
    const hour = Number(mapped.hour) === 24 ? '00' : mapped.hour;
    return `cron:${timezone}:${mapped.year}-${mapped.month}-${mapped.day}T${hour}:${mapped.minute}`;
  } catch {
    return null;
  }
}
