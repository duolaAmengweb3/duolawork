import { outcomeStatus } from '../shared/task-progress.js';
import React, { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CalendarClock,
  Clock,
  Pause,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2
} from 'lucide-react';
import type { MemberRecord, TaskRecord, TaskRunRecord, ThreadRecord } from '../shared/types.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.js';
import { Frame, FrameFooter, FrameHeader, FramePanel } from './components/ui/frame.js';
import { Input } from './components/ui/input.js';
import { PaginationBar, usePagination } from './components/ui/pagination.js';
import { Tabs, TabsList, TabsTab } from './components/ui/tabs.js';
import { Tracker, type TrackerBlockProps } from './components/ui/tremor.js';
import { formatCronHuman } from './lib/format.js';

export interface TaskWithLatestRun extends TaskRecord {
  latestRun: TaskRunRecord | null;
}

function buildMiniTracker(task: TaskWithLatestRun): TrackerBlockProps[] {
  const latest = task.latestRun;
  const slots: TrackerBlockProps[] = [
    { color: 'neutral', tooltip: '历史周期' },
    { color: 'neutral', tooltip: '历史周期' },
    { color: 'neutral', tooltip: '历史周期' },
    { color: 'neutral', tooltip: '历史周期' }
  ];
  if (!latest) {
    slots.push({
      color: task.kind === 'scheduled' && task.scheduleEnabled ? 'blue' : 'neutral',
      tooltip: task.kind === 'scheduled' ? '等待定时触发' : '待启动'
    });
    return slots;
  }
  const color: TrackerBlockProps['color'] =
    latest.status === 'completed'
      ? 'emerald'
      : latest.status === 'failed' || latest.status === 'timed_out'
        ? 'rose'
        : latest.status === 'waiting_user' || latest.status === 'paused'
          ? 'amber'
          : latest.status === 'running'
            ? 'blue'
            : 'neutral';
  slots.push({
    color,
    tooltip: `第 ${latest.runNumber} 期 · ${latest.status}`
  });
  return slots;
}

export function SchedulesPage({
  tasks,
  members,
  threads,
  onOpenTask,
  onOpenThread,
  onToggleSchedule,
  onRunTaskNow,
  onCancelRun,
  onDeleteTask,
  onRefresh
}: {
  tasks: TaskWithLatestRun[];
  members: MemberRecord[];
  threads: ThreadRecord[];
  onOpenTask: (taskId: string) => void;
  onOpenThread: (threadId: string) => void;
  onToggleSchedule: (taskId: string, enabled: boolean) => Promise<void>;
  onRunTaskNow: (taskId: string, retryFromRunId?: string) => Promise<void>;
  onCancelRun?: (runId: string) => Promise<void>;
  onDeleteTask?: (taskId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'once' | 'archive'>('all');
  const [query, setQuery] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const archived = useMemo(() => {
    const activeThreads = new Set(threads.map((t) => t.id));
    return new Set(
      tasks
        .filter(
          (t) =>
            t.kind === 'once' &&
            t.latestRun &&
            ['completed', 'failed', 'timed_out', 'canceled'].includes(t.latestRun.status) &&
            !activeThreads.has(t.sourceThreadId)
        )
        .map((t) => t.id)
    );
  }, [tasks, threads]);

  const current = tasks.filter((t) => !archived.has(t.id));
  const activeSchedulesCount = current.filter(
    (t) => t.kind === 'scheduled' && t.scheduleEnabled && t.status === 'active'
  ).length;

  const filtered = useMemo(() => {
    const base =
      filter === 'archive'
        ? tasks.filter((t) => archived.has(t.id))
        : current.filter((t) => filter === 'all' || t.kind === filter);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((t) => {
      const leadName = members.find((m) => m.id === t.leadMemberId)?.name || '';
      return t.title.toLowerCase().includes(q) || leadName.toLowerCase().includes(q);
    });
  }, [filter, tasks, archived, current, query, members]);

  const renderTaskRow = (task: TaskWithLatestRun) => {
    const leadMember = members.find((m) => m.id === task.leadMemberId);
    const leadName = leadMember?.name || task.leadMemberId;
    const originThread = threads.find((t) => t.id === task.sourceThreadId);
    const latest = task.latestRun;

    const statusText =
      outcomeStatus(latest) ??
      (task.status === 'paused'
        ? latest?.status === 'running'
          ? '当前步骤结束后暂停'
          : '已暂停'
        : !latest
          ? task.kind === 'scheduled'
            ? task.scheduleEnabled
              ? '等待定时触发'
              : '已暂停'
            : '待启动'
          : latest.status === 'completed'
            ? task.kind === 'scheduled'
              ? `第 ${latest.runNumber} 期已完成`
              : '已完成'
            : latest.status === 'waiting_user'
              ? '待你确认'
              : latest.status === 'failed'
                ? '执行失败'
                : latest.status === 'timed_out'
                  ? '最近一期超时'
                  : latest.status === 'canceled'
                    ? '已取消'
                    : '进行中');

    const badgeVariant =
      latest?.status === 'completed'
        ? 'success'
        : latest?.status === 'failed' || latest?.status === 'timed_out'
          ? 'error'
          : latest?.status === 'waiting_user'
            ? 'warning'
            : task.status === 'paused' || (!latest && task.kind === 'scheduled' && !task.scheduleEnabled)
              ? 'secondary'
              : 'info';

    const canRunNow =
      task.status === 'active' &&
      (!latest ||
        (task.kind === 'once' &&
          !latest.progress?.some((s) => s.result === 'external') &&
          ['failed', 'timed_out'].includes(latest.status)) ||
        (task.kind === 'scheduled' &&
          !['running', 'waiting_user', 'waiting_node_online', 'paused'].includes(latest.status)));

    const confirmingDel = confirmDeleteId === task.id;

    return (
      <article
        key={task.id}
        className="schedule-card grid grid-cols-1 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/35 lg:grid-cols-[minmax(0,2fr)_148px_138px_auto]"
      >
        {/* Identity & Title */}
        <div className="flex min-w-0 items-start gap-3">
          <div className="pt-0.5 shrink-0">
            <AgentAvatar
              small
              name={leadName}
              platformId={leadMember?.platformId}
              status={leadMember?.status}
            />
          </div>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onOpenTask(task.id)}
              className="block max-w-full truncate text-left text-[13.5px] font-semibold text-foreground hover:underline"
              title={task.title}
            >
              {task.title}
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
              <span>负责人：{leadName}</span>
              {originThread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(originThread.id)}
                  className="inline-flex items-center gap-0.5 text-info-foreground hover:underline"
                >
                  <span>来自：{originThread.title}</span>
                  <ArrowUpRight size={11} />
                </button>
              )}
            </div>
            {latest?.summary && (latest.status === 'failed' || latest.status === 'timed_out') && (
              <p
                className="mt-1.5 max-w-full truncate rounded-md bg-destructive/6 px-2 py-1 text-[11px] text-destructive-foreground"
                title={latest.summary}
              >
                {latest.summary}
              </p>
            )}
          </div>
        </div>

        {/* Schedule Cadence */}
        <div className="flex flex-col gap-0.5">
          {task.kind === 'scheduled' && task.cronExpr ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Clock size={12} className="text-muted-foreground shrink-0" />
                <span>{formatCronHuman(task.cronExpr)}</span>
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {task.cronExpr} · {task.timezone.replace('Asia/', '')}
              </span>
            </>
          ) : (
            <>
              <span className="text-xs font-medium text-muted-foreground">单次协作任务</span>
              <span className="font-mono text-[10.5px] text-muted-foreground/80">
                {new Date(task.updatedAt).toLocaleDateString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </>
          )}
        </div>

        {/* Status Pill + Tremor Tracker */}
        <div className="flex items-center gap-2.5">
          <Badge variant={badgeVariant} size="sm" className="schedule-pill">
            {statusText}
          </Badge>
          <Tracker data={buildMiniTracker(task)} className="hidden sm:flex" />
        </div>

        {/* Quiet Inline Actions */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {latest?.status === 'running' && onCancelRun && (
            <Button
              variant="outline"
              size="xs"
              disabled={busyId === task.id}
              onClick={async () => {
                setBusyId(task.id);
                try {
                  await onCancelRun(latest.id);
                } finally {
                  setBusyId(null);
                }
              }}
            >
              <Square size={10} />
              <span>停止</span>
            </Button>
          )}

          {canRunNow && (
            <Button
              variant="outline"
              size="xs"
              disabled={busyId === task.id}
              onClick={async () => {
                setBusyId(task.id);
                setConfirmDeleteId(null);
                try {
                  await onRunTaskNow(task.id, task.kind === 'once' ? latest?.id : undefined);
                } finally {
                  setBusyId(null);
                }
              }}
            >
              <Play size={11} />
              <span>{task.kind === 'once' && latest ? '重新运行整项任务' : '立即执行'}</span>
            </Button>
          )}

          {task.kind === 'scheduled' && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void onToggleSchedule(task.id, !task.scheduleEnabled)}
            >
              {task.scheduleEnabled ? <Pause size={11} /> : <Play size={11} />}
              <span>{task.scheduleEnabled ? '运行中' : '已暂停'}</span>
            </Button>
          )}

          <Button variant="ghost" size="xs" onClick={() => onOpenTask(task.id)}>
            查看详情
          </Button>

          {onDeleteTask && (
            <Button
              variant={confirmingDel ? 'destructive' : 'ghost'}
              size="xs"
              disabled={busyId === task.id}
              onClick={async () => {
                if (!confirmingDel) {
                  setConfirmDeleteId(task.id);
                  return;
                }
                setBusyId(task.id);
                setConfirmDeleteId(null);
                try {
                  await onDeleteTask(task.id);
                } finally {
                  setBusyId(null);
                }
              }}
              className={confirmingDel ? '' : 'text-muted-foreground hover:text-destructive-foreground'}
            >
              <Trash2 size={11} />
              <span>{confirmingDel ? '确认删除' : '删除'}</span>
            </Button>
          )}
        </div>
      </article>
    );
  };

  const scheduledGroup = filtered.filter((t) => t.kind === 'scheduled');
  const onceGroup = filtered.filter((t) => t.kind !== 'scheduled');
  const scheduledPager = usePagination(scheduledGroup, 6, `${filter}:${query}`);
  const oncePager = usePagination(onceGroup, 6, `${filter}:${query}`);
  const filteredPager = usePagination(filtered, 10, `${filter}:${query}`);

  return (
    <section className="h-full w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        {/* Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
                任务与定时总览
              </h1>
              <Badge variant={activeSchedulesCount > 0 ? 'success' : 'secondary'} size="sm">
                {activeSchedulesCount} 个周期计划运行中
              </Badge>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              集中管理周期计划与单次协作任务，按时间节律追踪每期交付状态。
            </p>
          </div>

          <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
            <RefreshCw size={13} />
            <span>刷新</span>
          </Button>
        </header>

        {/* Filter Toolbar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={filter}
            onValueChange={(v) => setFilter(v as 'all' | 'scheduled' | 'once' | 'archive')}
          >
            <TabsList size="sm">
              <TabsTab value="all">当前任务 ({current.length})</TabsTab>
              <TabsTab value="scheduled">
                定时长期 ({current.filter((t) => t.kind === 'scheduled').length})
              </TabsTab>
              <TabsTab value="once">
                单次任务 ({current.filter((t) => t.kind === 'once').length})
              </TabsTab>
              <TabsTab value="archive">已归档 ({archived.size})</TabsTab>
            </TabsList>
          </Tabs>

          <div className="relative flex w-full items-center sm:w-64">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 z-10 text-muted-foreground"
            />
            <Input
              nativeInput
              size="sm"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选任务标题或负责人…"
              className="pl-7 [&_input]:pl-7"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <Frame>
            <FramePanel>
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarClock />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">还没有立项或定时任务</EmptyTitle>
                  <EmptyDescription>
                    在任意对话里点击「指派任务」或让负责人立项后，即可在此统一跟进周期计划、步骤状态和最终结果。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </FramePanel>
          </Frame>
        ) : filter === 'all' && scheduledGroup.length > 0 && onceGroup.length > 0 ? (
          <div className="flex flex-col gap-5">
            <Frame>
              <FrameHeader className="flex-row items-center justify-between px-4 py-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  周期计划 · CRON
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {scheduledGroup.length} 项
                </span>
              </FrameHeader>
              <FramePanel className="max-h-[440px] overflow-y-auto p-0 coss-scroll">
                <div className="divide-y divide-border">{scheduledPager.pageItems.map(renderTaskRow)}</div>
              </FramePanel>
              {scheduledPager.totalPages > 1 && (
                <FrameFooter>
                  <PaginationBar
                    page={scheduledPager.page}
                    totalPages={scheduledPager.totalPages}
                    startIndex={scheduledPager.startIndex}
                    endIndex={scheduledPager.endIndex}
                    total={scheduledPager.total}
                    onPageChange={scheduledPager.setPage}
                  />
                </FrameFooter>
              )}
            </Frame>

            <Frame>
              <FrameHeader className="flex-row items-center justify-between px-4 py-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  单次协作任务
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {onceGroup.length} 项
                </span>
              </FrameHeader>
              <FramePanel className="max-h-[440px] overflow-y-auto p-0 coss-scroll">
                <div className="divide-y divide-border">{oncePager.pageItems.map(renderTaskRow)}</div>
              </FramePanel>
              {oncePager.totalPages > 1 && (
                <FrameFooter>
                  <PaginationBar
                    page={oncePager.page}
                    totalPages={oncePager.totalPages}
                    startIndex={oncePager.startIndex}
                    endIndex={oncePager.endIndex}
                    total={oncePager.total}
                    onPageChange={oncePager.setPage}
                  />
                </FrameFooter>
              )}
            </Frame>
          </div>
        ) : (
          <Frame>
            <FramePanel className="max-h-[560px] overflow-y-auto p-0 coss-scroll">
              <div className="divide-y divide-border">{filteredPager.pageItems.map(renderTaskRow)}</div>
            </FramePanel>
            {filteredPager.totalPages > 1 && (
              <FrameFooter>
                <PaginationBar
                  page={filteredPager.page}
                  totalPages={filteredPager.totalPages}
                  startIndex={filteredPager.startIndex}
                  endIndex={filteredPager.endIndex}
                  total={filteredPager.total}
                  onPageChange={filteredPager.setPage}
                />
              </FrameFooter>
            )}
          </Frame>
        )}
      </div>
    </section>
  );
}
