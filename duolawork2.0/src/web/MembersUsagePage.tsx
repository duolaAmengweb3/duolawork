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
import {
  type AuthSessionRecord,
  type CompanionKeepaliveStatus,
  type DriverKind,
  type ExecutionNodeRecord,
  type MemberRecord,
  type MemberUsageSummary,
  type ThreeTierUsage
} from '../shared/types.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.js';
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from './components/ui/frame.js';
import { Input } from './components/ui/input.js';
import { PaginationBar, usePagination } from './components/ui/pagination.js';
import { Tabs, TabsList, TabsTab } from './components/ui/tabs.js';
import { CategoryBar, UsageProportionBar } from './components/ui/tremor.js';
import { formatCompactTokens } from './lib/format.js';
import { useI18n } from './lib/i18n.js';

interface DiscoveredAgentCandidate {
  id: 'codex' | 'claude' | 'gemini';
  platformId: string;
  name: string;
  driverKind: DriverKind;
  binaryName: string;
  binaryPath: string | null;
  status: 'ready' | 'needs_login' | 'not_installed';
  hint: string;
  installCommand: string;
  loginCommand: string;
  alreadyMemberId: string | null;
}

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

const ATTEMPT_KIND_LABELS: Record<string, { zh: string; en: string }> = {
  thread_message: { zh: '对话', en: 'Chat' },
  task_step: { zh: '任务步骤', en: 'Task Step' },
  lead_review: { zh: '负责人核验', en: 'Lead Review' },
  lead_final: { zh: '最终汇总', en: 'Final Summary' }
};

const ATTEMPT_STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  succeeded: { zh: '成功', en: 'Succeeded' },
  failed: { zh: '失败', en: 'Failed' },
  timed_out: { zh: '超时', en: 'Timed out' },
  running: { zh: '执行中', en: 'Running' },
  dispatched: { zh: '已派发', en: 'Dispatched' },
  prepared: { zh: '准备中', en: 'Prepared' },
  reconciling: { zh: '对账中', en: 'Reconciling' },
  late_ignored: { zh: '超时后忽略', en: 'Late (ignored)' }
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
  const keepaliveData = useViewData<CompanionKeepaliveStatus>(
    '/api/v2/settings/companion-keepalive',
    0
  );
  const keepaliveStatus = keepaliveData.data ?? null;
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
  const { locale, t, L } = useI18n();
  const [discoverData, setDiscoverData] = useState<{
    mode: 'local' | 'cloud';
    candidates: DiscoveredAgentCandidate[];
  } | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [savingKeepalive, setSavingKeepalive] = useState<'deepseekHarness' | 'grokBot' | null>(null);
  const [keepaliveState, setKeepaliveState] = useState<'loading' | 'ready' | 'error'>(() =>
    views.peek('/api/v2/settings/companion-keepalive') ? 'ready' : 'loading'
  );
  const [keepaliveError, setKeepaliveError] = useState<string>('');

  const loadDiscover = useMemo(
    () => async () => {
      setDiscoverLoading(true);
      try {
        const res = await fetch('/api/v2/members/discover');
        if (res.ok) {
          const data = await res.json();
          setDiscoverData({
            mode: data.mode === 'cloud' ? 'cloud' : 'local',
            candidates: Array.isArray(data.candidates) ? data.candidates : []
          });
        }
      } catch {
        // ignore optional discovery failure
      } finally {
        setDiscoverLoading(false);
      }
    },
    []
  );

  const loadUsage = usage.read;
  const loadSessions = sessionData.read;
  const loadKeepalive = keepaliveData.read;

  const refreshKeepalive = useMemo(
    () => async (force = false) => {
      if (force || !views.peek('/api/v2/settings/companion-keepalive')) {
        setKeepaliveState('loading');
      }
      setKeepaliveError('');
      try {
        const res = await loadKeepalive(force);
        if (res) {
          setKeepaliveState('ready');
        } else {
          setKeepaliveState('error');
          setKeepaliveError(
            L('未能读取伴生应用保活设置，当前状态未知，请重试。', 'Unable to load companion keepalive settings; state unknown.')
          );
        }
      } catch (err) {
        setKeepaliveState('error');
        const detail = err instanceof Error && err.message ? err.message : '';
        setKeepaliveError(
          detail
            ? L(`读取伴生应用保活设置失败（${detail}），当前状态未知。`, `Failed to load companion keepalive (${detail}); state unknown.`)
            : L('读取伴生应用保活设置失败，当前状态未知。', 'Failed to load companion keepalive; state unknown.')
        );
      }
    },
    [loadKeepalive, views, L]
  );

  useEffect(() => {
    if (keepaliveStatus) {
      setKeepaliveState('ready');
      setKeepaliveError('');
    }
  }, [keepaliveStatus]);

  useEffect(() => {
    let active = true;
    const report = () => {
      if (active) setError(L('暂时无法更新成员信息', 'Unable to refresh member info'));
    };
    void loadUsage().catch(report);
    void loadSessions().catch(report);
    void refreshKeepalive(false);
    void loadDiscover();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadUsage(true).catch(report);
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadUsage, loadSessions, refreshKeepalive, loadDiscover, members.length, L]);

  const handleToggleKeepalive = async (key: 'deepseekHarness' | 'grokBot') => {
    if (keepaliveState !== 'ready' || !keepaliveStatus) return;
    const nextValue = !keepaliveStatus[key];
    setSavingKeepalive(key);
    setError('');
    try {
      const res = await fetch('/api/v2/settings/companion-keepalive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: nextValue })
      });
      const data = (await res.json().catch(() => ({}))) as Partial<CompanionKeepaliveStatus> & {
        message?: string;
      };
      if (!res.ok) {
        setError(data.message || L('更新伴生保活开关失败，请重试', 'Failed to update companion keepalive; please retry'));
        return;
      }
      const nextStatus: CompanionKeepaliveStatus = {
        deepseekHarness: Boolean(data.deepseekHarness),
        grokBot: Boolean(data.grokBot),
        revision: typeof data.revision === 'number' ? data.revision : keepaliveStatus.revision + 1,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
        localNodes: Array.isArray(data.localNodes) ? data.localNodes : keepaliveStatus.localNodes
      };
      views.put('/api/v2/settings/companion-keepalive', nextStatus);
      const appName = key === 'deepseekHarness' ? 'DeepSeek Harness' : 'Grok Bot';
      toast.success(
        nextStatus[key]
          ? L(`云端已保存：已开启 ${appName} 自动保活`, `Saved on cloud: keepalive enabled for ${appName}`)
          : L(`云端已保存：已关闭 ${appName} 自动保活`, `Saved on cloud: keepalive disabled for ${appName}`)
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? L(`无法连接控制面，伴生保活设置未保存（${err.message}）`, `Network error while saving keepalive setting (${err.message})`)
          : L('网络异常，伴生保活设置未保存，请重试', 'Network error while saving keepalive setting');
      setError(msg);
      toast.error(msg);
    } finally {
      setSavingKeepalive(null);
    }
  };

  const handleActivateDiscovered = async (candidate: DiscoveredAgentCandidate) => {
    setActivatingId(candidate.id);
    setError('');
    try {
      const res = await fetch('/api/v2/members/discover/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: candidate.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || L('激活成员失败', 'Failed to activate member'));
        return;
      }
      toast.success(L(`已接入 ${candidate.name}`, `Connected ${candidate.name}`));
      await Promise.all([onReloadBootstrap(), loadDiscover(), loadUsage(true)]);
    } finally {
      setActivatingId(null);
    }
  };

  const handleGenerateNodePair = async (kind: 'cloud' | 'local') => {
    setError('');
    const res = await fetch('/api/v2/nodes/pair-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || L('生成节点配对码失败', 'Failed to generate pairing code'));
      return;
    }
    setNodePairInfo({ code: data.code, expiresAt: data.expiresAt, kind });
    toast.success(L('已生成 5 分钟有效的节点配对码', 'Generated 5-min node pairing code'));
  };

  const handleRevokeNode = async (nodeId: string) => {
    setError('');
    const res = await fetch(`/api/v2/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(L('移除节点失败', 'Failed to revoke node'));
      return;
    }
    toast.success(L('已吊销执行节点', 'Revoked execution node'));
    await onReloadBootstrap();
  };

  const handleGenerateLoginCode = async () => {
    const res = await fetch('/api/v2/auth/magic-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: L('移动端/新设备', 'Mobile / New Device') })
    });
    if (!res.ok) return;
    const data = await res.json();
    setLoginMagicInfo({ code: data.code, expiresAt: data.expiresAt });
    toast.success(L('已生成新设备一次性登录码', 'Generated one-time login code'));
  };

  const handleRevokeSession = async (sessionId: string) => {
    const res = await fetch(`/api/v2/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) return;
    const data = await res.json();
    views.put('/api/v2/auth/sessions', { sessions: data.sessions || [] });
    toast.success(L('设备会话已下线', 'Signed out device session'));
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
      setError(data.message || L('接入成员失败', 'Failed to add member'));
      return;
    }
    setShowAdd(false);
    setName('');
    setCommandOrUrl('');
    toast.success(L(`已接入成员 ${name.trim()}`, `Added member ${name.trim()}`));
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
      setError(data.message || L('移除成员失败', 'Failed to remove member'));
      return;
    }
    toast.success(L(`已移除成员 ${member.name}`, `Removed member ${member.name}`));
    await onReloadBootstrap();
  };

  const driverLabels: Record<string, string> = {
    'codex-app-server': L('本机 Codex', 'Local Codex'),
    'acp-stdio': L('本机 ACP', 'Local ACP'),
    'claude-cli': L('本机 Claude Code', 'Local Claude Code'),
    'remote-node': L('跨机节点', 'Remote Node'),
    'remote-bridge': L('远端桥接', 'Remote Bridge'),
    'webhook-bot': 'Webhook',
    mock: L('模拟运行端', 'Mock Runtime')
  };

  const statusLabels: Record<string, string> = {
    ready: L('在线就绪', 'Online'),
    busy: L('执行中', 'Busy'),
    auth_required: L('待验证', 'Needs auth'),
    offline: L('离线', 'Offline')
  };

  const dispatchLabels: Record<string, string> = {
    succeeded: L('已收到回执', 'Receipt received'),
    failed: L('失败', 'Failed'),
    timed_out: L('等待超时', 'Timed out'),
    late_ignored: L('迟到回执已忽略', 'Late receipt ignored'),
    prepared: L('准备中', 'Prepared'),
    dispatched: L('已投递', 'Dispatched'),
    running: L('执行中', 'Running'),
    reconciling: L('正在核对回执', 'Reconciling')
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
          ? L(
              `${ranked[0].name} 占比 ${Math.round((ranked[0].tokens / tok) * 100)}%`,
              `${ranked[0].name} share ${Math.round((ranked[0].tokens / tok) * 100)}%`
            )
          : L('按成员实时汇总', 'Live per-member rollup');
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
  const membersPager = usePagination(visibleMembers, 6, `${statusFilter}:${query}`);
  const recentPager = usePagination(recent, 8);

  return (
    <section className="h-full w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        {/* Page Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
                {t('membersPageTitle')}
              </h1>
              <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                {L(`${readyCount} / ${members.length} 就绪`, `${readyCount} / ${members.length} Ready`)}
              </Badge>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              {t('membersPageDesc')}
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
                      const msg = L(
                        `已触发全员协作记忆更新（${res.memberCount} 位成员 · 协议版本 ${res.version}），将在下次对话响应时自动注入最新规范。`,
                        `Synced collaboration memory for ${res.memberCount} members (protocol ${res.version}). Updates inject on next reply.`
                      );
                      setMemoryNotice(msg);
                      toast.success(L(`已同步 ${res.memberCount} 位成员协作记忆 (${res.version})`, `Synced ${res.memberCount} members (${res.version})`));
                    }
                  } finally {
                    setSyncingMemory(false);
                  }
                }}
              >
                <Sparkles size={13} />
                <span>{syncingMemory ? L('更新中…', 'Syncing…') : L('同步全员新版协作记忆', 'Sync Protocol Memory')}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void onRefreshMembers();
                void loadUsage(true).catch(() => setError(L('暂时无法更新成员信息', 'Unable to refresh member info')));
              }}
              disabled={refreshingMembers}
            >
              <RefreshCw size={13} className={refreshingMembers ? 'is-refreshing' : ''} />
              <span>{L('刷新检测', 'Refresh')}</span>
            </Button>
            <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
              <Plus size={14} />
              <span>{L('接入新成员', 'Add Member')}</span>
            </Button>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 text-xs text-destructive-foreground"
          >
            <span>{error}</span>
            <Button variant="ghost" size="icon-xs" onClick={() => setError('')} aria-label={L('关闭错误', 'Dismiss error')}>
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
              aria-label={L('关闭提示', 'Dismiss notice')}
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
                  <span className="text-sm font-semibold text-foreground">{L('登记新 Agent / Bot 成员', 'Register Agent / Bot Member')}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setShowAdd(false)}
                    aria-label={L('关闭接入表单', 'Close form')}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('成员备注名称', 'Display Name')}</span>
                    <Input
                      nativeInput
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={L('例如：DeepSeek 研发', 'e.g., Codex Engineer')}
                      className="dw-input-coss"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('驱动协议', 'Runtime Driver')}</span>
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
                      {driverKind === 'webhook-bot' ? 'Webhook URL' : L('可执行命令路径（可选）', 'Executable path (optional)')}
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
                    {L('取消', 'Cancel')}
                  </Button>
                  <Button type="submit" size="sm">
                    {L('确认接入', 'Add Member')}
                  </Button>
                </div>
              </form>
            </FramePanel>
          </Frame>
        )}

        {/* BYOS Auto-Discovery (3-minute local CLI onboarding) */}
        <Frame data-testid="byos-discovery-card">
          <FrameHeader className="flex-row items-center justify-between gap-3 px-4 py-3">
            <div>
              <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                <Sparkles size={14} className="text-blue-500" />
                <span>{t('discoverTitle')}</span>
              </FrameTitle>
              <FrameDescription className="text-[11.5px]">{t('discoverDesc')}</FrameDescription>
            </div>
            <Button
              variant="outline"
              size="xs"
              disabled={discoverLoading}
              onClick={() => void loadDiscover()}
            >
              <RefreshCw size={12} className={discoverLoading ? 'is-refreshing' : ''} />
              <span>{t('discoverRefresh')}</span>
            </Button>
          </FrameHeader>
          <FramePanel className="p-3.5 sm:p-4">
            {discoverData?.mode === 'cloud' ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2.5 text-xs text-muted-foreground">
                <Server size={14} className="shrink-0" />
                <span>{t('discoverCloudNote')}</span>
              </div>
            ) : !discoverData ? (
              <div className="py-3 text-center text-xs text-muted-foreground">…</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {discoverData.candidates.map((c) => {
                  const statusBadgeVariant = c.alreadyMemberId
                    ? 'success'
                    : c.status === 'ready'
                      ? 'success'
                      : c.status === 'needs_login'
                        ? 'warning'
                        : 'secondary';
                  const statusLabel = c.alreadyMemberId
                    ? t('discoverConnected')
                    : c.status === 'ready'
                      ? t('discoverReady')
                      : c.status === 'needs_login'
                        ? t('discoverNeedsLogin')
                        : t('discoverNotInstalled');
                  const cmdToCopy = c.status === 'needs_login' ? c.loginCommand : c.installCommand;
                  return (
                    <div
                      key={c.id}
                      data-testid={`discover-card-${c.id}`}
                      className="flex flex-col justify-between gap-2.5 rounded-xl border border-border bg-background/80 p-3 text-xs"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <AgentAvatar small name={c.name} platformId={c.platformId} />
                            <span className="truncate font-semibold text-foreground">
                              {locale === 'en' ? c.name.replace(' (本机)', ' (Local)') : c.name}
                            </span>
                          </div>
                          <Badge variant={statusBadgeVariant} size="sm">
                            {statusLabel}
                          </Badge>
                        </div>
                        <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
                          {locale === 'en'
                            ? c.status === 'ready'
                              ? `Detected locally (${c.binaryName}) and authenticated — ready to activate.`
                              : c.status === 'needs_login'
                                ? `Installed (${c.binaryName}); run ${c.loginCommand} to finish authentication.`
                                : `Not detected on this machine; install via ${c.installCommand} and refresh.`
                            : c.hint}
                        </p>
                        {c.binaryPath && (
                          <div className="truncate font-mono text-[10.5px] text-muted-foreground/85" title={c.binaryPath}>
                            {c.binaryPath}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1">
                        {c.status !== 'ready' ? (
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(cmdToCopy);
                              toast.success(L(`已复制命令: ${cmdToCopy}`, `Copied command: ${cmdToCopy}`));
                            }}
                            className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-[10.5px] text-foreground hover:bg-muted"
                            title={cmdToCopy}
                          >
                            <Copy size={10} className="shrink-0" />
                            <span className="truncate">{cmdToCopy}</span>
                          </button>
                        ) : (
                          <span className="font-mono text-[10.5px] text-muted-foreground">BYOS</span>
                        )}

                        {c.binaryPath && (
                          <Button
                            size="xs"
                            variant={c.alreadyMemberId ? 'outline' : 'default'}
                            disabled={activatingId === c.id}
                            onClick={() => void handleActivateDiscovered(c)}
                          >
                            <span>
                              {activatingId === c.id
                                ? '…'
                                : c.alreadyMemberId
                                  ? t('discoverReactivate')
                                  : t('discoverActivate')}
                            </span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </FramePanel>
        </Frame>

        {/* Bento KPI Overview (Coss Frame + Tremor CategoryBar) */}
        <Frame>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{L('在线可派单', 'Online & Ready')}</span>
                <Badge variant={readyCount > 0 ? 'success' : 'secondary'} size="sm">
                  {readyCount === members.length ? L('全员就绪', 'All ready') : L(`待处理 ${attentionCount}`, `${attentionCount} attention`)}
                </Badge>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {readyCount}
                </span>
                <span className="text-xs text-muted-foreground">/ {L(`${members.length} 位成员`, `${members.length} members`)}</span>
              </div>
              <CategoryBar
                segments={[
                  { value: readyCount, color: 'bg-emerald-500', label: L(`在线 ${readyCount}`, `Ready ${readyCount}`) },
                  { value: authReqCount, color: 'bg-amber-500', label: L(`待验证 ${authReqCount}`, `Auth ${authReqCount}`) },
                  { value: offlineCount, color: 'bg-neutral-400/50', label: L(`离线 ${offlineCount}`, `Offline ${offlineCount}`) }
                ]}
              />
            </FramePanel>

            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{L('累计可观测 Token', 'Observed Tokens')}</span>
                <span className="truncate text-[11px]">{topConsumerLabel}</span>
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {totalTokens > 0 ? formatCompactTokens(totalTokens) : '—'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {L(`${totalDispatches} 派发 · ${totalTurns} 轮`, `${totalDispatches} dispatches · ${totalTurns} turns`)}
                </span>
              </div>
              <CategoryBar
                segments={
                  tokenSegments.length > 0
                    ? tokenSegments
                    : [{ value: 1, color: 'bg-foreground/10', label: L('暂无 Token 消耗', 'No token usage yet') }]
                }
              />
            </FramePanel>

            <FramePanel className="flex flex-col justify-between gap-2.5 p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{L('跨机执行节点', 'Remote Nodes')}</span>
                <Badge variant={onlineNodesCount > 0 ? 'success' : 'secondary'} size="sm">
                  {onlineNodesCount > 0 ? L('心跳正常', 'Healthy') : L('未连接', 'Disconnected')}
                </Badge>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {onlineNodesCount}
                </span>
                <span className="text-xs text-muted-foreground">/ {L(`${nodes.length} 在线`, `${nodes.length} online`)}</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {nodes.length > 0
                  ? nodes.map((n) => n.name).join(' · ')
                  : L('支持配对 VPS 或个人电脑节点', 'Supports pairing VPS or personal computers')}
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
                <TabsTab value="all">{L(`全部 (${members.length})`, `All (${members.length})`)}</TabsTab>
                <TabsTab value="ready">{L(`在线 (${readyCount})`, `Ready (${readyCount})`)}</TabsTab>
                <TabsTab value="attention">{L(`待处理 (${attentionCount})`, `Attention (${attentionCount})`)}</TabsTab>
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
                placeholder={L('搜索成员名称或平台…', 'Search members or platforms…')}
                className="pl-7 [&_input]:pl-7"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={L('清空搜索', 'Clear search')}
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
                  <EmptyTitle className="text-base">{L('没有找到匹配的成员', 'No matching members')}</EmptyTitle>
                  <EmptyDescription>
                    {L('调整筛选条件或点击右上角「接入新成员」添加协作 Agent。', 'Adjust your filters or click Add Member above.')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y divide-border">
                <div className="hidden grid-cols-[minmax(0,2fr)_110px_minmax(150px,1.1fr)_124px] items-center gap-3 bg-muted/40 px-4 py-2 text-[11px] font-medium text-muted-foreground md:grid">
                  <span>{L('成员与运行端', 'Member & Runtime')}</span>
                  <span>{L('连接状态', 'Status')}</span>
                  <span>{L('派发与 Token 用量', 'Dispatches & Tokens')}</span>
                  <span className="text-right">{L('操作', 'Actions')}</span>
                </div>

                {membersPager.pageItems.map((m, idx) => {
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
                            {m.statusMessage} · {L(`并发上限 ${m.capabilities.maxConcurrentRuns}`, `Max concurrency ${m.capabilities.maxConcurrentRuns}`)}
                          </div>
                          {m.config.hubTransport === 'grok-webhook' && (
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                              {sum?.lastDispatchStatus && sum.lastActiveAt
                                ? L(
                                    `最近派单 ${new Date(sum.lastActiveAt).toLocaleString('zh-CN')} · ${dispatchLabels[sum.lastDispatchStatus] || sum.lastDispatchStatus}`,
                                    `Last dispatch ${new Date(sum.lastActiveAt).toLocaleString('en-US')} · ${dispatchLabels[sum.lastDispatchStatus] || sum.lastDispatchStatus}`
                                  )
                                : sum
                                  ? L('暂无派单记录', 'No dispatch history')
                                  : L('正在读取派单记录…', 'Loading dispatch history…')}
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
                              ? L('按需投递', 'On demand')
                              : statusLabels[m.status] || m.status}
                          </span>
                        </Badge>
                      </div>

                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2 font-mono text-[11.5px] tabular-nums">
                          <strong className="font-semibold text-foreground">
                            {memberTokens > 0 ? formatCompactTokens(memberTokens) : L('未暴露', 'N/A')}
                          </strong>
                          <span className="text-[11px] text-muted-foreground">
                            {L(`${sum?.workbenchDispatches ?? 0} 派发 · ${sum?.nativeTurns ?? 0} 轮`, `${sum?.workbenchDispatches ?? 0} runs · ${sum?.nativeTurns ?? 0} turns`)}
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
                          <span>{L('发起对话', 'Chat')}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleRemoveMember(m)}
                          aria-label={L(`移除 ${m.name}`, `Remove ${m.name}`)}
                          title={L('移除成员', 'Remove member')}
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
          {membersPager.totalPages > 1 && (
            <FrameFooter>
              <PaginationBar
                page={membersPager.page}
                totalPages={membersPager.totalPages}
                startIndex={membersPager.startIndex}
                endIndex={membersPager.endIndex}
                total={membersPager.total}
                onPageChange={membersPager.setPage}
              />
            </FrameFooter>
          )}
        </Frame>

        {/* Execution Nodes & Cross-Device Sessions */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Frame>
            <FrameHeader className="flex-row items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                  <Server size={14} className="text-muted-foreground" />
                  <span>{L('执行节点', 'Execution Nodes')}</span>
                </FrameTitle>
                <FrameDescription className="text-[11.5px]">
                  {L('接入 VPS 或个人电脑节点运行本地 Agent', 'Pair VPS or local machine nodes to run Agents')}
                </FrameDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="outline" size="xs" onClick={() => void handleGenerateNodePair('cloud')}>
                  <Server size={11} />
                  <span>VPS</span>
                </Button>
                <Button variant="outline" size="xs" onClick={() => void handleGenerateNodePair('local')}>
                  <Laptop size={11} />
                  <span>{L('本机', 'Local')}</span>
                </Button>
              </div>
            </FrameHeader>
            <FramePanel className="overflow-hidden p-0">
              {nodePairInfo && (
                <div className="border-b border-border bg-info/6 px-4 py-3 text-xs">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      {nodePairInfo.kind === 'cloud' ? L('云端节点', 'Cloud Node') : L('本地电脑', 'Local Machine')}
                      {L('配对码（5 分钟有效）：', ' pairing code (5 min TTL): ')}
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
                        toast.success(L('已复制节点配对命令', 'Copied pairing command'));
                      }}
                    >
                      <Copy size={11} />
                      <span>{L('复制命令', 'Copy Command')}</span>
                    </Button>
                  </div>
                  <code className="block break-all font-mono text-[11px] text-muted-foreground">
                    {`node dist/node-runner/index.mjs pair --server ${typeof window !== 'undefined' ? window.location.origin : 'https://work.manyaitool.com'} --code ${nodePairInfo.code} --kind ${nodePairInfo.kind}`}
                  </code>
                </div>
              )}
              {nodes.length === 0 ? (
                <div className="px-4 py-7 text-center text-xs text-muted-foreground">
                  {L('暂无已配对的执行节点，点击右上角按钮生成配对码即可接入。', 'No paired nodes yet. Generate a pairing code above to connect.')}
                </div>
              ) : (
                <div className="max-h-[260px] divide-y divide-border overflow-y-auto coss-scroll">
                  {nodes.map((n) => (
                    <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {n.name}
                          </span>
                          <Badge variant={n.status === 'online' ? 'success' : 'warning'} size="sm">
                            {n.status === 'online' ? L('在线', 'Online') : L('离线', 'Offline')}
                          </Badge>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {n.kind === 'cloud' ? L('云端节点', 'Cloud') : L('本地电脑', 'Local')} · {n.platform} ·{' '}
                          {n.lastHeartbeatAt
                            ? new Date(n.lastHeartbeatAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit'
                              })
                            : L('尚未连入', 'Not connected yet')}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleRevokeNode(n.id)}
                        className="text-destructive-foreground hover:bg-destructive/8"
                      >
                        <Trash2 size={12} />
                        <span>{L('吊销', 'Revoke')}</span>
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
                    <span>{L('跨设备登录安全', 'Cross-Device Sessions')}</span>
                  </FrameTitle>
                  <FrameDescription className="text-[11.5px]">
                    {L('管理已授权终端会话与一次性免密登录码', 'Manage authorized devices and one-time login codes')}
                  </FrameDescription>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="outline" size="xs" onClick={() => void handleGenerateLoginCode()}>
                    <span>{L('手机登录码', 'Mobile Code')}</span>
                  </Button>
                  {onLogout && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void onLogout()}
                      className="text-destructive-foreground hover:bg-destructive/8"
                    >
                      <LogOut size={12} />
                      <span>{L('退出', 'Sign Out')}</span>
                    </Button>
                  )}
                </div>
              </FrameHeader>
              <FramePanel className="overflow-hidden p-0">
                {loginMagicInfo && (
                  <div className="border-b border-border bg-info/6 px-4 py-2.5 text-xs">
                    {L('一次性登录码（5 分钟有效）：', 'One-time code (5 min TTL): ')}
                    <strong className="ml-1 font-mono text-sm text-foreground">
                      {loginMagicInfo.code}
                    </strong>
                  </div>
                )}
                {sessions.length === 0 ? (
                  <div className="px-4 py-7 text-center text-xs text-muted-foreground">
                    {L('暂无其他活跃设备会话。', 'No other active device sessions.')}
                  </div>
                ) : (
                  <div className="max-h-[260px] divide-y divide-border overflow-y-auto coss-scroll">
                    {sessions.map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {s.deviceName}
                            </span>
                            {s.current && (
                              <Badge variant="secondary" size="sm">
                                {L('当前设备', 'Current Device')}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                            {s.ip} · {new Date(s.lastSeenAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => void handleRevokeSession(s.id)}
                        >
                          {L('下线', 'Revoke')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </FramePanel>
            </Frame>
          )}
        </div>

        {/* Desktop Companion Keepalive Switches (Default OFF) */}
        <Frame data-testid="companion-keepalive-card">
          <FrameHeader className="flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                <Laptop size={14} className="text-muted-foreground" />
                <span>{L('桌面伴生应用自动保活', 'Desktop Companion Keepalive')}</span>
              </FrameTitle>
              <FrameDescription className="text-[11.5px]">
                {L(
                  '默认关闭。云端保存后同步至在线本地节点；节点失联期间暂停自动启动。',
                  'Off by default. Cloud saves sync to online local nodes; auto-launch pauses while a node is disconnected.'
                )}
              </FrameDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 shrink-0" data-testid="keepalive-sync-status">
              {keepaliveState === 'loading' ? (
                <Badge variant="secondary" size="sm">
                  {L('正在读取…', 'Loading…')}
                </Badge>
              ) : keepaliveState === 'error' || !keepaliveStatus ? (
                <>
                  <Badge variant="warning" size="sm" data-testid="keepalive-unknown-state">
                    {L('状态未知', 'Status Unknown')}
                  </Badge>
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="keepalive-retry-btn"
                    onClick={() => void refreshKeepalive(true)}
                  >
                    <RefreshCw size={11} />
                    <span>{L('重试', 'Retry')}</span>
                  </Button>
                </>
              ) : (
                <>
                  <Badge variant="info" size="sm" data-testid="keepalive-cloud-badge">
                    {L(`云端已保存 (v${keepaliveStatus.revision})`, `Cloud saved (r${keepaliveStatus.revision})`)}
                  </Badge>
                  {(() => {
                    const localNodes = keepaliveStatus.localNodes || [];
                    if (localNodes.length === 0) {
                      return (
                        <Badge variant="secondary" size="sm" data-testid="keepalive-device-badge">
                          {L('当前未配对本地节点', 'No local nodes paired')}
                        </Badge>
                      );
                    }
                    const onlineNodes = localNodes.filter((n) => n.online);
                    const syncedNodes = onlineNodes.filter((n) => n.synced);
                    if (onlineNodes.length === 0) {
                      return (
                        <Badge variant="warning" size="sm" data-testid="keepalive-device-badge">
                          {L('设备失联 · 已暂停自动启动', 'Device offline · auto-launch paused')}
                        </Badge>
                      );
                    }
                    if (syncedNodes.length === onlineNodes.length && onlineNodes.length === localNodes.length) {
                      return (
                        <Badge variant="success" size="sm" data-testid="keepalive-device-badge">
                          {L(`设备已收到 (${syncedNodes.length}/${localNodes.length})`, `Device received (${syncedNodes.length}/${localNodes.length})`)}
                        </Badge>
                      );
                    }
                    if (syncedNodes.length < onlineNodes.length) {
                      return (
                        <Badge variant="warning" size="sm" data-testid="keepalive-device-badge">
                          {L(`等待设备确认 (${syncedNodes.length}/${onlineNodes.length})`, `Pending device ACK (${syncedNodes.length}/${onlineNodes.length})`)}
                        </Badge>
                      );
                    }
                    return (
                      <Badge variant="warning" size="sm" data-testid="keepalive-device-badge">
                        {L(`部分节点失联 · 已暂停 (${syncedNodes.length}/${localNodes.length})`, `Partial offline · paused (${syncedNodes.length}/${localNodes.length})`)}
                      </Badge>
                    );
                  })()}
                </>
              )}
            </div>
          </FrameHeader>
          <FramePanel className="p-0">
            {keepaliveState === 'error' && keepaliveError && (
              <div
                role="alert"
                data-testid="keepalive-error-banner"
                className="flex items-center justify-between gap-3 border-b border-border bg-warning/8 px-4 py-2.5 text-xs text-warning-foreground"
              >
                <span>{keepaliveError}</span>
                <Button variant="outline" size="xs" onClick={() => void refreshKeepalive(true)}>
                  {L('重新读取', 'Reload')}
                </Button>
              </div>
            )}
            {keepaliveState === 'ready' && keepaliveStatus && keepaliveStatus.localNodes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-4 py-2 text-[11px] text-muted-foreground">
                <span>{L('设备同步状态：', 'Device sync:')}</span>
                {keepaliveStatus.localNodes.map((n) => (
                  <span key={n.nodeId} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[10.5px]">
                    <span className={`size-1.5 rounded-full ${!n.online ? 'bg-neutral-400' : n.synced ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span>{n.nodeName}:</span>
                    <strong>
                      {!n.online
                        ? L('失联已暂停', 'Offline (paused)')
                        : n.synced
                          ? L(`已收到 (v${n.ackedRevision})`, `Received (r${n.ackedRevision})`)
                          : L('等待确认', 'Pending ACK')}
                    </strong>
                  </span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
              {(
                [
                  {
                    key: 'deepseekHarness' as const,
                    testId: 'keepalive-toggle-deepseek',
                    platformId: 'deepseek-harness',
                    label: 'DeepSeek Harness',
                    desc: L(
                      '关闭后手动退出 DeepSeek Harness 不再每 3 分钟自动拉起。',
                      'When off, quitting DeepSeek Harness prevents automatic background relaunch.'
                    )
                  },
                  {
                    key: 'grokBot' as const,
                    testId: 'keepalive-toggle-grok',
                    platformId: 'grok-bot',
                    label: 'Grok Bot',
                    desc: L(
                      '仅当需要通过桌面连接器保持 Grok Bot 在线时开启。',
                      'Enable only when you want Grok Bot kept running for desktop bridging.'
                    )
                  }
                ]
              ).map((item) => {
                const knownReady = keepaliveState === 'ready' && Boolean(keepaliveStatus);
                const enabled = knownReady ? Boolean(keepaliveStatus![item.key]) : false;
                const rowBadgeVariant = !knownReady
                  ? keepaliveState === 'error'
                    ? 'warning'
                    : 'secondary'
                  : enabled
                    ? 'success'
                    : 'secondary';
                const rowBadgeText = !knownReady
                  ? keepaliveState === 'error'
                    ? L('状态未知', 'Unknown')
                    : L('读取中…', 'Loading…')
                  : enabled
                    ? L('自动保活已开', 'Keepalive On')
                    : L('不自动拉起', 'Keepalive Off');
                return (
                  <div key={item.key} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <AgentAvatar small name={item.label} platformId={item.platformId} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {item.label}
                          </span>
                          <Badge variant={rowBadgeVariant} size="sm">
                            {rowBadgeText}
                          </Badge>
                        </div>
                        <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">{item.desc}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={knownReady ? enabled : 'mixed'}
                      aria-label={item.label}
                      data-testid={item.testId}
                      disabled={!knownReady || savingKeepalive === item.key}
                      onClick={() => void handleToggleKeepalive(item.key)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                        !knownReady
                          ? 'border-border bg-muted/60'
                          : enabled
                            ? 'cursor-pointer border-emerald-600 bg-emerald-600'
                            : 'cursor-pointer border-border bg-muted'
                      }`}
                    >
                      <span
                        className={`pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform ${
                          !knownReady ? 'translate-x-2 opacity-60' : enabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </FramePanel>
        </Frame>

        {/* Detailed Three-Tier Dispatch & Token Usage Ledger */}
        <Frame>
          <FrameHeader className="flex-row items-center justify-between px-4 py-3">
            <div>
              <FrameTitle className="flex items-center gap-1.5 text-[13px]">
                <Activity size={14} className="text-muted-foreground" />
                <span>{L('近期派发与三层用量流水', 'Recent Dispatches & Token Ledger')}</span>
              </FrameTitle>
              <FrameDescription className="text-[11.5px]">
                {L('记录每次工作台派发、原生回合与 Token / 上下文开销', 'Logs workbench dispatches, native turns, and token/context usage')}
              </FrameDescription>
            </div>
            <Badge variant="outline" size="sm" className="font-mono tabular-nums">
              {L(`${recent.length} 条记录`, `${recent.length} entries`)}
            </Badge>
          </FrameHeader>

          <FramePanel className="max-h-[420px] overflow-auto p-0 coss-scroll">
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {L('暂无调用流水，发送一条对话或执行任务后此处将记录实时调度耗费。', 'No dispatch logs yet. Send a message or run a task to record usage.')}
              </div>
            ) : (
              <table className="members-table w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                  <tr className="border-b border-border bg-muted/40 text-[11px] font-medium text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">{L('执行成员', 'Member')}</th>
                    <th className="px-4 py-2.5 font-medium">{L('调用类型', 'Kind')}</th>
                    <th className="px-4 py-2.5 font-medium">{L('状态', 'Status')}</th>
                    <th className="px-4 py-2.5 font-medium">{L('消耗与上下文', 'Tokens / Context')}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{L('时间', 'Time')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentPager.pageItems.map((r) => {
                    const memName = members.find((m) => m.id === r.memberId)?.name || r.memberId;
                    const kindEntry = ATTEMPT_KIND_LABELS[r.targetKind];
                    const kindText = kindEntry ? (locale === 'en' ? kindEntry.en : kindEntry.zh) : r.targetKind;
                    const statusEntry = ATTEMPT_STATUS_LABELS[r.status];
                    const statusText = statusEntry ? (locale === 'en' ? statusEntry.en : statusEntry.zh) : r.status;
                    const tokens = r.usage?.providerUsage?.observable
                      ? L(
                          `${r.usage.providerUsage.totalTokens?.toLocaleString() || 0} tok（缓存 ${r.usage.providerUsage.cachedInputTokens ?? 0}）`,
                          `${r.usage.providerUsage.totalTokens?.toLocaleString() || 0} tok (cached ${r.usage.providerUsage.cachedInputTokens ?? 0})`
                        )
                      : L(`${(r.promptBytes / 1024).toFixed(1)} KB 上下文`, `${(r.promptBytes / 1024).toFixed(1)} KB ctx`);
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
                          {new Date(r.dispatchedAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN', {
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
          {recentPager.totalPages > 1 && (
            <FrameFooter>
              <PaginationBar
                page={recentPager.page}
                totalPages={recentPager.totalPages}
                startIndex={recentPager.startIndex}
                endIndex={recentPager.endIndex}
                total={recentPager.total}
                onPageChange={recentPager.setPage}
              />
            </FrameFooter>
          )}
        </Frame>
      </div>
    </section>
  );
}
