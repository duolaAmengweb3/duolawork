import { outcomeStatus } from '../shared/task-progress.js';
import React, { useMemo, useState } from 'react';
import { ArrowUpRight, CalendarClock, Clock, Pause, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import type { MemberRecord, TaskRecord, TaskRunRecord, ThreadRecord } from '../shared/types.js';

export interface TaskWithLatestRun extends TaskRecord {
  latestRun: TaskRunRecord | null;
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const archived = useMemo(() => {
    const activeThreads = new Set(threads.map(t => t.id));
    return new Set(tasks.filter(t => t.kind === 'once' && t.latestRun && ['completed','failed','timed_out','canceled'].includes(t.latestRun.status)
      && !activeThreads.has(t.sourceThreadId)).map(t => t.id));
  }, [tasks, threads]);
  const current = tasks.filter(t => !archived.has(t.id));
  const filtered = filter === 'archive' ? tasks.filter(t => archived.has(t.id))
    : current.filter(t => filter === 'all' || t.kind === filter);

  return (
    <section className="scheduled-workspace">
      <div className="schedule-heading">
        <div>
          <span className="schedule-heading-icon">
            <Clock size={22} />
          </span>
          <div>
            <h1>任务与定时总览</h1>
            <p>
              集中管理全部单次与周期任务的执行状态、启停计划与每期交付成果，保持主对话栏清爽不拥挤。
            </p>
          </div>
        </div>

        <button type="button" onClick={() => void onRefresh()} className="dw-btn dw-btn-outline dw-btn-sm">
          <RefreshCw size={13} />
          <span>刷新</span>
        </button>
      </div>

      <div className="schedule-toolbar">
        <div className="connector-categories">
          {([
            ['all', `当前任务 (${current.length})`],
            ['scheduled', `定时长期 (${current.filter((t) => t.kind === 'scheduled').length})`],
            ['once', `单次任务 (${current.filter((t) => t.kind === 'once').length})`],
            ['archive', '已归档 (' + archived.size + ')']
          ] as const).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="schedule-empty">
          <CalendarClock size={36} />
          <h2>还没有立项或定时任务</h2>
          <p>在任意对话里点击“指派任务”或让负责人立项后，即可在此统一跟进周期计划、步骤状态和最终结果。</p>
        </div>
      ) : (
        <div className="schedule-list">
          {filtered.map((task) => {
            const leadName = members.find((m) => m.id === task.leadMemberId)?.name || task.leadMemberId;
            const originThread = threads.find((t) => t.id === task.sourceThreadId);
            const latest = task.latestRun;
            const statusText = outcomeStatus(latest) ?? (task.status === 'paused' ? (latest?.status === 'running' ? '当前步骤结束后暂停' : '已暂停') : !latest
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

            const pillClass =
              latest?.status === 'completed'
                ? 'completed'
                : !latest && task.kind === 'scheduled' && !task.scheduleEnabled
                  ? 'paused'
                  : latest?.status === 'failed' || latest?.status === 'timed_out' || latest?.status === 'waiting_user'
                    ? 'error'
                    : '';

            const confirmingDel = confirmDeleteId === task.id;

            return (
              <article key={task.id} className="schedule-card">
                <div className="schedule-card-top">
                  <span className={`schedule-pill ${pillClass}`}>
                    {statusText}
                  </span>
                  <span className="schedule-muted">负责人：{leadName}</span>
                  <button type="button" onClick={() => onOpenTask(task.id)} className="dw-btn dw-btn-primary dw-btn-sm">
                    查看详情
                  </button>
                </div>

                <button type="button" onClick={() => onOpenTask(task.id)} className="schedule-card-main">
                  <h2>{task.title}</h2>
                  <span>
                    <Clock size={13} />
                    <span>
                      {task.kind === 'scheduled' && task.cronExpr
                        ? `周期规则 ${task.cronExpr} (${task.timezone})`
                        : '单次任务'}
                    </span>
                  </span>
                </button>

                {latest?.summary && (latest.status === 'failed' || latest.status === 'timed_out') && (
                  <p className="schedule-error mb-3 truncate" title={latest.summary}>
                    {latest.summary}
                  </p>
                )}

                <div className="schedule-card-status">
                  <div>
                    {originThread && (
                      <button
                        type="button"
                        onClick={() => onOpenThread(originThread.id)}
                        className="inline-flex items-center gap-1"
                        style={{ color: '#476dc4' }}
                      >
                        <span>来自：{originThread.title}</span>
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {latest?.status === 'running' && onCancelRun && (
                      <button
                        type="button"
                        disabled={busyId === task.id}
                        onClick={async () => {
                          setBusyId(task.id);
                          try {
                            await onCancelRun(latest.id);
                          } finally {
                            setBusyId(null);
                          }
                        }}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        <Square size={11} />
                        <span>停止</span>
                      </button>
                    )}
                    {task.status === 'active' && (!latest || (task.kind === 'once' && !latest.progress?.some(s=>s.result==='external') && ['failed','timed_out'].includes(latest.status)) || (task.kind === 'scheduled' && !['running','waiting_user','waiting_node_online','paused'].includes(latest.status))) && (
                    <button
                      type="button"
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
                      className="dw-btn dw-btn-outline dw-btn-sm"
                    >
                      <Play size={12} />
                      <span>{task.kind === 'once' && latest ? '重新运行整项任务' : '立即执行'}</span>
                    </button>
                    )}
                    {task.kind === 'scheduled' && (
                      <button
                        type="button"
                        onClick={() => void onToggleSchedule(task.id, !task.scheduleEnabled)}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        {task.scheduleEnabled ? <Pause size={12} /> : <Play size={12} />}
                        <span>{task.scheduleEnabled ? '运行中' : '已暂停'}</span>
                      </button>
                    )}
                    {onDeleteTask && (
                      <button
                        type="button"
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
                        className="dw-btn dw-btn-outline dw-btn-sm"
                        style={confirmingDel ? { borderColor: '#be4343', color: '#be4343' } : { color: '#9c524a' }}
                      >
                        <Trash2 size={12} />
                        <span>{confirmingDel ? '确认删除' : '删除'}</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
