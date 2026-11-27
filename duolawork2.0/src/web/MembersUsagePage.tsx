import { useViewCache, useViewData } from './view-cache.js';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Copy,
  Laptop,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  AuthSessionRecord,
  DriverKind,
  ExecutionNodeRecord,
  MemberRecord,
  MemberUsageSummary,
  ThreeTierUsage
} from '../shared/types.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.js';
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from './components/ui/frame.js';
import { Input } from './components/ui/input.js';
import { Tabs, TabsList, TabsTab } from './components/ui/tabs.js';
import { CategoryBar, UsageProportionBar } from './components/ui/tremor.js';
import { formatCompactTokens } from './lib/format.js';

interface RecentAttempt {
  id: string;
  memberId: string;
  targetKind: string;
  status: string;
  promptBytes: number;
  usage: ThreeTierUsage;
  errorMessage: string | null;
  dispatchedAt: string;
}

const ATTEMPT_KIND_LABELS: Record<string, string> = {
  thread_message: '对话',
  task_step: '任务步骤',
  lead_review: '负责人核验',
  lead_final: '最终汇总'
};

const ATTEMPT_STATUS_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  running: '执行中',
  dispatched: '已派发',
  prepared: '准备中',
  reconciling: '对账中',
  late_ignored: '超时后忽略'
};

const USAGE_BAR_COLORS = [
  'bg-blue-500 dark:bg-blue-400',
  'bg-emerald-500 dark:bg-emerald-400',
  'bg-amber-500 dark:bg-amber-400',
  'bg-violet-500 dark:bg-violet-400',
  'bg-neutral-500 dark:bg-neutral-400'
];

export function MembersUsagePage({
  members,
  nodes = [],
  authRequired = false,
  onLogout,
  refreshingMembers,
  onRefreshMembers,
  onReloadBootstrap,
  onStartChatWithMember,
  onSyncProtocolMemory
}: {
  members: MemberRecord[];
  nodes?: ExecutionNodeRecord[];
  authRequired?: boolean;
  onLogout?: () => Promise<void>;
  refreshingMembers: boolean;
  onRefreshMembers: () => Promise<void>;
  onReloadBootstrap: () => Promise<void>;
  onStartChatWithMember: (memberId: string) => Promise<void>;
  onSyncProtocolMemory?: () => Promise<{ version: string; memberCount: number } | null>;
}): React.JSX.Element {
  const views = useViewCache();
  const usage = useViewData<{ summaries: MemberUsageSummary[]; recent: RecentAttempt[] }>(
    '/api/v2/members/usage',
    15000
  );
  const sessionData = useViewData<{ sessions: AuthSessionRecord[] }>(
    '/api/v2/auth/sessions',
    0,
    authRequired
  );
  const summaries = useMemo(
    () => Object.fromEntries((usage.data?.summaries ?? []).map((s) => [s.memberId, s])),
    [usage.data]
  );
  const recent = usage.data?.recent ?? [];
  const sessions = sessionData.data?.sessions ?? [];
  const [nodePairInfo, setNodePairInfo] = useState<{
    code: string;
    expiresAt: string;
    kind: 'cloud' | 'local';
  } | null>(null);
  const [loginMagicInfo, setLoginMagicInfo] = useState<{ code: string; expiresAt: string } | null>(null);
  const [query, setQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'attention'>('all');
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [driverKind, setDriverKind] = useState<DriverKind>('codex-app-server');
  const [platformId, setPlatformId] = useState<string>('codex');
  const [commandOrUrl, setCommandOrUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [memoryNotice, setMemoryNotice] = useState<string>('');
  const [syncingMemory, setSyncingMemory] = useState<boolean>(false);

  const loadUsage = usage.read;
  const loadSessions = sessionData.read;
  useEffect(() => {
    let active = true;
    const report = () => {
      if (active) setError('暂时无法更新成员信息');
    };
    void loadUsage().catch(report);
    void loadSessions().catch(report);
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadUsage(true).catch(report);
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadUsage, loadSessions, members.length]);

  const handleGenerateNodePair = async (kind: 'cloud' | 'local') => {
    setError('');
    const res = await fetch('/api/v2/nodes/pair-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || '生成节点配对码失败');
      return;
    }
    setNodePairInfo({ code: data.code, expiresAt: data.expiresAt, kind });
    toast.success('已生成 5 分钟有效的节点配对码');
  };

  const handleRevokeNode = async (nodeId: string) => {
    setError('');
    const res = await fetch(`/api/v2/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('移除节点失败');
      return;
    }
    toast.success('已吊销执行节点');
    await onReloadBootstrap();
  };

  const handleGenerateLoginCode = async () => {
    const res = await fetch('/api/v2/auth/magic-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: '移动端/新设备' })
    });
    if (!res.ok) return;
    const data = await res.json();
    setLoginMagicInfo({ code: data.code, expiresAt: data.expiresAt });
    toast.success('已生成新设备一次性登录码');
  };

  const handleRevokeSession = async (sessionId: string) => {
    const res = await fetch(`/api/v2/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) return;
    const data = await res.json();
    views.put('/api/v2/auth/sessions', { sessions: data.sessions || [] });
    toast.success('设备会话已下线');
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    const location =
      driverKind === 'webhook-bot'
        ? 'webhook'
        : driverKind === 'remote-bridge'
          ? 'remote-bridge'
          : 'local';
    const config =
      driverKind === 'webhook-bot'
        ? { webhookUrl: commandOrUrl.trim() }
        : driverKind === 'remote-bridge'
          ? { endpointHint: commandOrUrl.trim() }
          : commandOrUrl.trim()
            ? { command: commandOrUrl.trim() }
            : {};

    const res = await fetch('/api/v2/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        platformId: platformId.trim() || driverKind,
        driverKind,
        location,
        config
      })
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message || '接入成员失败');
      return;
    }
    setShowAdd(false);
    setName('');
    setCommandOrUrl('');
    toast.success(`已接入成员 ${name.trim()}`);
    await onReloadBootstrap();
    await loadUsage(true);
  };

  const handleRemoveMember = async (member: MemberRecord) => {
    setError('');
    const res = await fetch(`/api/v2/members/${encodeURIComponent(member.id)}`, {
      method: 'DELETE'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || '移除成员失败');
      return;
    }
    toast.success(`已移除成员 ${member.name}`);
    await onReloadBootstrap();
  };

  const driverLabels: Record<string, string> = {
    'codex-app-server': '本机 Codex',
    'acp-stdio': '本机 ACP',
    'claude-cli': '本机 Claude Code',
    'remote-node': '跨机节点',
    'remote-bridge': '远端桥接',
    'webhook-bot': 'Webhook',
    mock: '模拟运行端'
  };

  const statusLabels: Record<string, string> = {
    ready: '在线就绪',
    busy: '执行中',
    auth_required: '待验证',
    offline: '离线'
  };

  const dispatchLabels: Record<string, string> = {
    succeeded: '已收到回执',
    failed: '失败',
    timed_out: '等待超时',
    late_ignored: '迟到回执已忽略',
    prepared: '准备中',
    dispatched: '已投递',
    running: '执行中',
    reconciling: '正在核对回执'
  };

  const readyCount = members.filter((m) => m.status === 'ready').length;
  const authReqCount = members.filter((m) => m.status === 'auth_required').length;
  const offlineCount = Math.max(0, members.length - readyCount - authReqCount);
  const onlineNodesCount = nodes.filter((n) => n.status === 'online').length;

  const { totalTokens, totalDispatches, totalTurns, maxMemberTokens, tokenSegments, topConsumerLabel } =
    useMemo(() => {
      let tok = 0;
      let disp = 0;
      let turns = 0;
      let maxTok = 0;
      const ranked: Array<{ name: string; tokens: number }> = [];
      for (const m of members) {
        const s = summaries[m.id];
        if (!s) continue;
        tok += s.totalTokens || 0;
        disp += s.workbenchDispatches || 0;
        turns += s.nativeTurns || 0;
        if ((s.totalTokens || 0) > maxTok) maxTok = s.totalTokens || 0;
        if ((s.totalTokens || 0) > 0) ranked.push({ name: m.name, tokens: s.totalTokens });
      }
      ranked.sort((a, b) => b.tokens - a.tokens);
      const segs = ranked.slice(0, 4).map((item, idx) => ({
        value: item.tokens,
        color: USAGE_BAR_COLORS[idx % USAGE_BAR_COLORS.length],
        label: `${item.name}: ${formatCompactTokens(item.tokens)}`
      }));
      const top =
        ranked[0] && tok > 0
          ? `${ranked[0].name} 占比 ${Math.round((ranked[0].tokens / tok) * 100)}%`
          : '按成员实时汇总';
      return {
        totalTokens: tok,
        totalDispatches: disp,
        totalTurns: turns,
        maxMemberTokens: maxTok,
        tokenSegments: segs,
        topConsumerLabel: top
      };
    }, [members, summaries]);

  const visibleMembers = members.filter((m) => {
    if (statusFilter === 'ready' && m.status !== 'ready') return false;
    if (statusFilter === 'attention' && m.status === 'ready') return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      m.platformId.toLowerCase().includes(q) ||
      m.driverKind.toLowerCase().includes(q)
    );
  });

  const attentionCount = members.length - readyCount;

  return (
    <section className="h-full w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        {/* Page Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
                成员与用量统计
              </h1>
              <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                {readyCount} / {members.length} 就绪
              </Badge>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              统一管理本机与远端 Agent 成员、跨机执行节点与实时 Token 消耗流水。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onSyncProtocolMemory && (
              <Button
                variant="outline"
                size="sm"
                disabled={syncingMemory}
                onClick={async () => {
                  setSyncingMemory(true);
                  setError('');
                  try {
                    const res = await onSyncProtocolMemory();
                    if (res) {
                      const msg = `已触发全员协作记忆更新（${res.memberCount} 位成员 · 协议版本 ${res.version}），将在下次对话响应时自动注入最新规范。`;
                      setMemoryNotice(msg);
                      toast.success(`已同步 ${res.memberCount} 位成员协作记忆 (${res.version})`);
                    }
                  } finally {
                    setSyncingMemory(false);
                  }
                }}
              >
                <Sparkles size={13} />
                <span>{syncingMemory ? '更新中…' : '同步全员新版协作记忆'}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void onRefreshMembers();
                void loadUsage(true).catch(() => setError('暂时无法更新成员信息'));
              }}
              disabled={refreshingMembers}
            >
              <RefreshCw size={13} className={refreshingMembers ? 'is-refreshing' : ''} />
              <span>刷新检测</span>
            </Button>
            <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
              <Plus size={14} />
              <span>接入新成员</span>
            </Button>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 text-xs text-destructive-foreground"
          >
            <span>{error}</span>
            <Button variant="ghost" size="icon-xs" onClick={() => setError('')} aria-label="关闭错误">
              <X size={13} />
            </Button>
          </div>
        )}

        {memoryNotice && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl border border-success/25 bg-success/8 px-3.5 py-2.5 text-xs text-success-foreground"
          >
            <span>{memoryNotice}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMemoryNotice('')}
              aria-label="关闭提示"
            >
              <X size={13} />
            </Button>
          </div>
        )}

        {showAdd && (
          <Frame className="dw-inline-panel">
            <FramePanel className="p-4 sm:p-5">
              <form onSubmit={handleAddMember} className="flex flex-col gap-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">登记新 Agent / Bot 成员</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setShowAdd(false)}
                    aria-label="关闭接入表单"
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">成员备注名称</span>
                    <Input
                      nativeInput
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如：DeepSeek 研发"
                      className="dw-input-coss"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">驱动协议</span>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {(
                        [
                          'codex-app-server',
                          'claude-cli',
                          'acp-stdio',
                          'webhook-bot',
                          'remote-bridge'
                        ] as DriverKind[]
                      ).map((dk) => (
                        <Button
                          key={dk}
                          size="xs"
                          variant={driverKind === dk ? 'default' : 'outline'}
                          onClick={() => {
                            setDriverKind(dk);
                            setPlatformId(
                              dk === 'codex-app-server'
                                ? 'codex'
                                : dk === 'claude-cli'
                                  ? 'claude-code'
                                  : dk === 'acp-stdio'
                                    ? 'antigravity'
                                    : dk === 'webhook-bot'
                                      ? 'grok-bot'
                                      : 'remote'
                            );
                          }}
                        >
                          {driverLabels[dk]}
                        </Button>
                      ))}
                    </div>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">
                      {driverKind === 'webhook-bot' ? 'Webhook URL' : '可执行命令路径（可选）'}
                    </span>
                    <Input
                      nativeInput
                      type="text"
                      value={commandOrUrl}
                      onChange={(e) => setCommandOrUrl(e.target.value)}
                      placeholder={
                        driverKind === 'webhook-bot' ? 'https://...' : '/Users/.../.local/bin/codex'
                      }
                    />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                    取消
                  </Button>
                  <Button type="submit" size="sm">
                    确认接入
                  </Button>
                </div>
              </form>
            </FramePanel>
          </Frame>
        )}

        {/* Bento KPI Overview (Coss Frame + Tremor CategoryBar) */}
        <Frame>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>在线可派单</span>
                <Badge variant={readyCount > 0 ? 'success' : 'secondary'} size="sm">
                  {readyCount === members.length ? '全员就绪' : `待处理 ${attentionCount}`}
                </Badge>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {readyCount}
                </span>
                <span className="text-xs text-muted-foreground">/ {members.length} 位成员</span>
              </div>
              <CategoryBar
                segments={[
                  { value: readyCount, color: 'bg-emerald-500', label: `在线 ${readyCount}` },
                  { value: authReqCount, color: 'bg-amber-500', label: `待验证 ${authReqCount}` },
                  { value: offlineCount, color: 'bg-neutral-400/50', label: `离线 ${offlineCount}` }
                ]}
              />
            </FramePanel>

            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>累计可观测 Token</span>
                <span className="truncate text-[11px]">{topConsumerLabel}</span>
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {totalTokens > 0 ? formatCompactTokens(totalTokens) : '—'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {totalDispatches} 派发 · {totalTurns} 轮
                </span>
              </div>
              <CategoryBar
                segments={
                  tokenSegments.length > 0
                    ? tokenSegments
                    : [{ value: 1, color: 'bg-foreground/10', label: '暂无 Token 消耗' }]
                }
              />
            </FramePanel>

            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>跨机执行节点</span>
                <Badge variant={onlineNodesCount > 0 ? 'success' : 'secondary'} size="sm">
                  {onlineNodesCount > 0 ? '心跳正常' : '未连接'}
                </Badge>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {onlineNodesCount}
                </span>
                <span className="text-xs text-muted-foreground">/ {nodes.length} 在线</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {nodes.length > 0
                  ? nodes.map((n) => n.name).join(' · ')
                  : '支持配对 VPS 或个人电脑节点'}
              </div>
            </FramePanel>
          </div>
        </Frame>

        {/* Members Roster (Coss Frame + Responsive Grid, Zero Right-Edge Clipping) */}
        <Frame>
          <FrameHeader className="flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as 'all' | 'ready' | 'attention')}
            >
              <TabsList size="sm">
                <TabsTab value="all">全部 ({members.length})</TabsTab>
                <TabsTab value="ready">在线 ({readyCount})</TabsTab>
                <TabsTab value="attention">待处理 ({attentionCount})</TabsTab>
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
                placeholder="搜索成员名称或平台…"
                className="pl-7 [&_input]:pl-7"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                  className="absolute right-2 z-10 text-muted-foreground hover:text-foreground"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </FrameHeader>

          <FramePanel className="overflow-hidden p-0">
            {visibleMembers.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">没有找到匹配的成员</EmptyTitle>
                  <EmptyDescription>
                    调整筛选条件或点击右上角「接入新成员」添加协作 Agent。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y divide-border">
                <div className="hidden grid-cols-[minmax(0,2fr)_110px_minmax(150px,1.1fr)_124px] items-center gap-3 bg-muted/40 px-4 py-2 text-[11px] font-medium text-muted-foreground md:grid">
                  <span>成员与运行端</span>
                  <span>连接状态</span>
                  <span>派发与 Token 用量</span>
                  <span className="text-right">操作</span>
                </div>

                {visibleMembers.map((m, idx) => {
                  const sum = summaries[m.id];
                  const isReady = m.status === 'ready';
                  const isAuth = m.status === 'auth_required';
                  const memberTokens = sum?.totalTokens ?? 0;
                  return (
                    <div
                      key={m.id}
                      className="grid grid-cols-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/35 md:grid-cols-[minmax(0,2fr)_110px_minmax(150px,1.1fr)_124px]"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <AgentAvatar name={m.name} platformId={m.platformId} status={m.status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => void onStartChatWithMember(m.id)}
                              className="truncate text-left text-[13px] font-semibold text-foreground hover:underline"
                            >
                              {m.name}
                            </button>
                            <Badge variant="outline" size="sm" className="font-mono text-[10px]">
                              {driverLabels[m.driverKind] || m.driverKind}
                            </Badge>
                          </div>
                          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                            {m.statusMessage} · 并发上限 {m.capabilities.maxConcurrentRuns}
                          </div>
                          {m.config.hubTransport === 'grok-webhook' && (
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                              {sum?.lastDispatchStatus && sum.lastActiveAt
                                ? `最近派单 ${new Date(sum.lastActiveAt).toLocaleString('zh-CN')} · ${dispatchLabels[sum.lastDispatchStatus] || sum.lastDispatchStatus}`
                                : sum
                                  ? '暂无派单记录'
                                  : '正在读取派单记录…'}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center">
                        <Badge
                          variant={isReady ? 'success' : isAuth ? 'warning' : 'secondary'}
                          size="sm"
                          className="gap-1.5 px-2"
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              isReady
                                ? 'bg-emerald-500'
                                : isAuth
                                  ? 'bg-amber-500'
                                  : 'bg-neutral-400'
                            }`}
                          />
                          <span>
                            {isReady && m.config.hubTransport === 'grok-webhook'
                              ? '按需投递'
                              : statusLabels[m.status] || m.status}
                          </span>
                        </Badge>
                      </div>

                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2 font-mono text-[11.5px] tabular-nums">
                          <strong className="font-semibold text-foreground">
                            {memberTokens > 0 ? formatCompactTokens(memberTokens) : '未暴露'}
                          </strong>
                          <span className="text-[11px] text-muted-foreground">
                            {sum?.workbenchDispatches ?? 0} 派发 · {sum?.nativeTurns ?? 0} 轮
                          </span>
                        </div>
                        <UsageProportionBar
                          value={memberTokens}
                          max={maxMemberTokens}
                          colorClass={USAGE_BAR_COLORS[idx % USAGE_BAR_COLORS.length]}
                        />
                      </div>

                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => void onStartChatWithMember(m.id)}
                        >
                          <MessageSquare size={12} />
                          <span>发起对话</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleRemoveMember(m)}
                          aria-label={`移除 ${m.name}`}
                          title="移除成员"
                          className="text-muted-foreground hover:text-destructive-foreground"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </FramePanel>
        </Frame>

        {/* Execution Nodes & Cross-Device Sessions */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Frame>
            <FrameHeader className="flex-row items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                  <Server size={14} className="text-muted-foreground" />
                  <span>执行节点</span>
                </FrameTitle>
                <FrameDescription className="text-[11.5px]">
                  接入 VPS 或个人电脑节点运行本地 Agent
                </FrameDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="outline" size="xs" onClick={() => void handleGenerateNodePair('cloud')}>
                  <Server size={11} />
                  <span>VPS</span>
                </Button>
                <Button variant="outline" size="xs" onClick={() => void handleGenerateNodePair('local')}>
                  <Laptop size={11} />
                  <span>本机</span>
                </Button>
              </div>
            </FrameHeader>
            <FramePanel className="overflow-hidden p-0">
              {nodePairInfo && (
                <div className="border-b border-border bg-info/6 px-4 py-3 text-xs">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      {nodePairInfo.kind === 'cloud' ? '云端节点' : '本地电脑'}配对码（5 分钟有效）：
                      <code className="ml-1.5 rounded bg-background px-1.5 py-0.5 font-mono text-[13px] font-semibold">
                        {nodePairInfo.code}
                      </code>
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const origin =
                          typeof window !== 'undefined'
                            ? window.location.origin
                            : 'https://work.manyaitool.com';
                        const cmd = `node dist/node-runner/index.mjs pair --server ${origin} --code ${nodePairInfo.code} --kind ${nodePairInfo.kind}`;
                        void navigator.clipboard?.writeText(cmd);
                        toast.success('已复制节点配对命令');
                      }}
                    >
                      <Copy size={11} />
                      <span>复制命令</span>
                    </Button>
                  </div>
                  <code className="block break-all font-mono text-[11px] text-muted-foreground">
                    {`node dist/node-runner/index.mjs pair --server ${typeof window !== 'undefined' ? window.location.origin : 'https://work.manyaitool.com'} --code ${nodePairInfo.code} --kind ${nodePairInfo.kind}`}
                  </code>
                </div>
              )}
              {nodes.length === 0 ? (
                <div className="px-4 py-7 text-center text-xs text-muted-foreground">
                  暂无已配对的执行节点，点击右上角按钮生成配对码即可接入。
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {nodes.map((n) => (
                    <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {n.name}
                          </span>
                          <Badge variant={n.status === 'online' ? 'success' : 'warning'} size="sm">
                            {n.status === 'online' ? '在线' : '离线'}
                          </Badge>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {n.kind === 'cloud' ? '云端节点' : '本地电脑'} · {n.platform} ·{' '}
                          {n.lastHeartbeatAt
                            ? new Date(n.lastHeartbeatAt).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit'
                              })
                            : '尚未连入'}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleRevokeNode(n.id)}
                        className="text-destructive-foreground hover:bg-destructive/8"
                      >
                        <Trash2 size={12} />
                        <span>吊销</span>
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </FramePanel>
          </Frame>

          {authRequired && (
            <Frame>
              <FrameHeader className="flex-row items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                    <ShieldCheck size={14} className="text-muted-foreground" />
                    <span>跨设备登录安全</span>
                  </FrameTitle>
                  <FrameDescription className="text-[11.5px]">
                    管理已授权终端会话与一次性免密登录码
                  </FrameDescription>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="outline" size="xs" onClick={() => void handleGenerateLoginCode()}>
                    <span>手机登录码</span>
                  </Button>
                  {onLogout && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void onLogout()}
                      className="text-destructive-foreground hover:bg-destructive/8"
                    >
                      <LogOut size={12} />
                      <span>退出</span>
                    </Button>
                  )}
                </div>
              </FrameHeader>
              <FramePanel className="overflow-hidden p-0">
                {loginMagicInfo && (
                  <div className="border-b border-border bg-info/6 px-4 py-2.5 text-xs">
                    一次性登录码（5 分钟有效）：
                    <strong className="ml-1 font-mono text-sm text-foreground">
                      {loginMagicInfo.code}
                    </strong>
                  </div>
                )}
                {sessions.length === 0 ? (
                  <div className="px-4 py-7 text-center text-xs text-muted-foreground">
                    暂无其他活跃设备会话。
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {sessions.map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {s.deviceName}
                            </span>
                            {s.current && (
                              <Badge variant="secondary" size="sm">
                                当前设备
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                            {s.ip} · {new Date(s.lastSeenAt).toLocaleString('zh-CN')}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => void handleRevokeSession(s.id)}
                        >
                          下线
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </FramePanel>
            </Frame>
          )}
        </div>

        {/* Detailed Three-Tier Dispatch & Token Usage Ledger */}
        <Frame>
          <FrameHeader className="flex-row items-center justify-between px-4 py-3">
            <div>
              <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                <Activity size={14} className="text-muted-foreground" />
                <span>近期派发与三层用量流水</span>
              </FrameTitle>
              <FrameDescription className="text-[11.5px]">
                记录每次工作台派发、原生回合与 Token / 上下文开销
              </FrameDescription>
            </div>
            <Badge variant="outline" size="sm" className="font-mono tabular-nums">
              {recent.length} 条记录
            </Badge>
          </FrameHeader>

          <FramePanel className="overflow-x-auto p-0">
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                暂无调用流水，发送一条对话或执行任务后此处将记录实时调度耗费。
              </div>
            ) : (
              <table className="members-table w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-[11px] font-medium text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">执行成员</th>
                    <th className="px-4 py-2.5 font-medium">调用类型</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">消耗与上下文</th>
                    <th className="px-4 py-2.5 text-right font-medium">时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recent.map((r) => {
                    const memName = members.find((m) => m.id === r.memberId)?.name || r.memberId;
                    const kindText = ATTEMPT_KIND_LABELS[r.targetKind] || r.targetKind;
                    const statusText = ATTEMPT_STATUS_LABELS[r.status] || r.status;
                    const tokens = r.usage?.providerUsage?.observable
                      ? `${r.usage.providerUsage.totalTokens?.toLocaleString() || 0} tok（缓存 ${r.usage.providerUsage.cachedInputTokens ?? 0}）`
                      : `${(r.promptBytes / 1024).toFixed(1)} KB 上下文`;
                    const badgeVariant =
                      r.status === 'succeeded'
                        ? 'success'
                        : r.status === 'failed' || r.status === 'timed_out'
                          ? 'error'
                          : 'secondary';
                    return (
                      <tr key={r.id} className="transition-colors hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium text-foreground">{memName}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{kindText}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant={badgeVariant} size="sm">
                            {statusText}
                          </Badge>
                          {r.errorMessage && (
                            <div
                              className="mt-1 max-w-[260px] truncate text-[11px] text-destructive-foreground"
                              title={r.errorMessage}
                            >
                              {r.errorMessage}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                          {tokens}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
                          {new Date(r.dispatchedAt).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </FramePanel>
        </Frame>
      </div>
    </section>
  );
}
