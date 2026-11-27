import { useViewCache, useViewData } from './view-cache.js';
import React, { useEffect, useState } from 'react';
import { Activity, Copy, Laptop, LogOut, MessageSquare, Plus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Trash2, Users, X } from 'lucide-react';
import type { AuthSessionRecord, DriverKind, ExecutionNodeRecord, MemberRecord, MemberUsageSummary, ThreeTierUsage } from '../shared/types.js';
import { AgentAvatar } from './AgentAvatar.js';

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
  const usage = useViewData<{summaries: MemberUsageSummary[]; recent: RecentAttempt[]}>('/api/v2/members/usage', 15000);
  const sessionData = useViewData<{sessions: AuthSessionRecord[]}>('/api/v2/auth/sessions', 0, authRequired);
  const summaries = Object.fromEntries((usage.data?.summaries ?? []).map(s => [s.memberId,s]));
  const recent = usage.data?.recent ?? [];
  const sessions = sessionData.data?.sessions ?? [];
  const [nodePairInfo, setNodePairInfo] = useState<{ code: string; expiresAt: string; kind: 'cloud' | 'local' } | null>(null);
  const [loginMagicInfo, setLoginMagicInfo] = useState<{ code: string; expiresAt: string } | null>(null);
  const [query, setQuery] = useState<string>('');
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
    const report = () => {if (active) setError('暂时无法更新成员信息');};
    void loadUsage().catch(report);
    void loadSessions().catch(report);
    const timer = window.setInterval(() => {if (!document.hidden) void loadUsage(true).catch(report);},15000);
    return () => {active = false;window.clearInterval(timer);};
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
  };

  const handleRevokeNode = async (nodeId: string) => {
    setError('');
    const res = await fetch(`/api/v2/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('移除节点失败');
      return;
    }
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
  };

  const handleRevokeSession = async (sessionId: string) => {
    const res = await fetch(`/api/v2/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!res.ok) return;
    const data = await res.json();
    views.put('/api/v2/auth/sessions',{sessions:data.sessions || []});
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
    await onReloadBootstrap();
  };

  const driverLabels: Record<string, string> = {
    'codex-app-server': '本机 Codex',
    'acp-stdio': '本机 ACP',
    'claude-cli': '本机 Claude Code',
    'remote-node': '跨机执行节点',
    'remote-bridge': '远端桥接',
    'webhook-bot': 'Webhook Bot',
    mock: '模拟运行端'
  };

  const statusLabels: Record<string, string> = {
    ready: '在线就绪',
    busy: '执行中',
    auth_required: '待验证',
    offline: '离线'
  };

  const visibleMembers = members.filter((m) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      m.platformId.toLowerCase().includes(q) ||
      m.driverKind.toLowerCase().includes(q)
    );
  });

  const dispatchLabels = {
    succeeded: '已收到回执', failed: '失败', timed_out: '等待超时', late_ignored: '迟到回执已忽略',
    prepared: '准备中', dispatched: '已投递', running: '执行中', reconciling: '正在核对回执'
  };
  const readyCount = members.filter((m) => m.status === 'ready').length;

  return (
    <section className="members-page">
      <header>
        <div>
          <h1>
            成员与用量统计
            <span className="members-count">{members.length}</span>
          </h1>
          <p>
            管理本机与远端 Agent 成员，实时展示工作台派发、原生回合与可观测 Token 用量流水。
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {onSyncProtocolMemory && (
            <button
              type="button"
              disabled={syncingMemory}
              onClick={async () => {
                setSyncingMemory(true);
                setError('');
                try {
                  const res = await onSyncProtocolMemory();
                  if (res) {
                    setMemoryNotice(
                      `已触发全员协作记忆更新（${res.memberCount} 位成员 · 协议版本 ${res.version}），将在下次对话响应时自动注入最新规范。`
                    );
                  }
                } finally {
                  setSyncingMemory(false);
                }
              }}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <Sparkles size={13} />
              <span>{syncingMemory ? '更新中…' : '同步全员新版协作记忆'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void onRefreshMembers();
              void loadUsage(true).catch(() => setError('暂时无法更新成员信息'));
            }}
            disabled={refreshingMembers}
            className="dw-btn dw-btn-outline dw-btn-sm"
          >
            <RefreshCw size={13} className={refreshingMembers ? 'is-refreshing' : ''} />
            <span>刷新检测</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="dw-btn dw-btn-primary dw-btn-sm"
          >
            <Plus size={14} />
            <span>接入新成员</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="services-error mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="关闭错误">
            <X size={14} />
          </button>
        </div>
      )}
      {memoryNotice && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-xs flex items-center justify-between gap-2"
          style={{ backgroundColor: '#eaf7f2', color: '#27846b' }}
        >
          <span>{memoryNotice}</span>
          <button type="button" onClick={() => setMemoryNotice('')} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={handleAddMember}
          className="mb-6 rounded-xl border p-4 flex flex-col gap-3 text-xs dw-inline-panel"
        >
          <div className="font-semibold text-[13px]">
            登记新 Agent / Bot 成员
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1.5">
              <span>成员备注名称</span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：DeepSeek 研发"
                className="dw-input"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span>驱动协议</span>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {(['codex-app-server', 'claude-cli', 'acp-stdio', 'webhook-bot', 'remote-bridge'] as DriverKind[]).map(
                  (dk) => (
                    <button
                      key={dk}
                      type="button"
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
                      className={driverKind === dk ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                    >
                      {driverLabels[dk]}
                    </button>
                  )
                )}
              </div>
            </label>
            <label className="flex flex-col gap-1.5">
              <span>{driverKind === 'webhook-bot' ? 'Webhook URL' : '可执行命令路径（可选）'}</span>
              <input
                type="text"
                value={commandOrUrl}
                onChange={(e) => setCommandOrUrl(e.target.value)}
                placeholder={driverKind === 'webhook-bot' ? 'https://...' : '/Users/.../.local/bin/codex'}
                className="dw-input"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowAdd(false)} className="dw-btn dw-btn-outline dw-btn-sm">
              取消
            </button>
            <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
              确认接入
            </button>
          </div>
        </form>
      )}

      <div className="members-toolbar">
        <div className="members-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索成员名称或平台…"
            className="dw-input"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="members-summary">
          <i aria-hidden="true" />
          <span>可派单 {readyCount} / {members.length}</span>
        </div>
      </div>

      {visibleMembers.length === 0 ? (
        <div className="members-table-wrap">
          <div className="members-empty">
            <Users size={28} />
            <h2>没有找到匹配的成员</h2>
            <p>调整搜索词或点击右上角“接入新成员”添加新的协作 Agent。</p>
          </div>
        </div>
      ) : (
        <div className="members-table-wrap">
          <table className="members-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>运行协议</th>
                <th>连接状态</th>
                <th>累计用量</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleMembers.map((m) => {
                const sum = summaries[m.id];
                const isReady = m.status === 'ready';
                return (
                  <tr key={m.id}>
                    <td>
                      <div className="member-identity">
                        <AgentAvatar name={m.name} platformId={m.platformId} status={m.status} />
                        <div>
                          <button
                            type="button"
                            onClick={() => void onStartChatWithMember(m.id)}
                            className="member-name"
                          >
                            {m.name}
                          </button>
                          <span className="member-caption">
                            {m.statusMessage} · 并发上限 {m.capabilities.maxConcurrentRuns}
                          </span>
                          {m.config.hubTransport === 'grok-webhook' && (
                            <span className="member-caption">
                              {sum?.lastDispatchStatus && sum.lastActiveAt
                                ? `最近派单 ${new Date(sum.lastActiveAt).toLocaleString('zh-CN')} · ${dispatchLabels[sum.lastDispatchStatus]}`
                                : sum ? '暂无派单记录' : '正在读取派单记录…'}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="member-platform">{driverLabels[m.driverKind] || m.driverKind}</span>
                    </td>
                    <td>
                      <span className={`member-status ${isReady ? 'is-ready' : 'is-pending'}`}>
                        <i aria-hidden="true" />
                        <span>{isReady && m.config.hubTransport === 'grok-webhook' ? '按需投递' : statusLabels[m.status] || m.status}</span>
                      </span>
                    </td>
                    <td>
                      <div className="text-xs" style={{ color: '#394b66' }}>
                        <strong>{sum?.workbenchDispatches ?? 0}</strong> 次派发 ·{' '}
                        <strong>{sum?.nativeTurns ?? 0}</strong> 原生轮
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: '#8b97ab' }}>
                        Token：{sum && sum.totalTokens > 0 ? sum.totalTokens.toLocaleString() : '平台未暴露'}
                      </div>
                    </td>
                    <td>
                      <div className="member-actions">
                        <button
                          type="button"
                          onClick={() => void onStartChatWithMember(m.id)}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <MessageSquare size={12} />
                          <span>发起对话</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveMember(m)}
                          className="dw-btn dw-btn-ghost dw-btn-icon"
                          aria-label={`移除 ${m.name}`}
                          title="移除成员"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Execution Nodes & Cross-Device Sessions */}
      <div className="management-empty-card mt-6">
        <header className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <strong className="inline-flex items-center gap-1.5 text-sm">
            <Server size={15} />
            <span>执行节点（跨机 / 本地接入）</span>
          </strong>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void handleGenerateNodePair('cloud')}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <Server size={12} />
              <span>接入云端 VPS 节点</span>
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateNodePair('local')}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <Laptop size={12} />
              <span>接入本机电脑节点</span>
            </button>
          </div>
        </header>

        {nodePairInfo && (
          <div className="p-3 mb-3 rounded-lg border text-xs" style={{ borderColor: '#d7e3f9', background: '#f5f9ff' }}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <strong>
                一次性配对码（{nodePairInfo.kind === 'cloud' ? '云端节点' : '本地电脑节点'}，5 分钟内有效）：
                <span className="ml-1 font-mono text-sm">{nodePairInfo.code}</span>
              </strong>
              <button
                type="button"
                className="dw-btn dw-btn-outline dw-btn-sm"
                onClick={() => {
                  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://work.manyaitool.com';
                  const cmd = `node dist/node-runner/index.mjs pair --server ${origin} --code ${nodePairInfo.code} --kind ${nodePairInfo.kind}`;
                  void navigator.clipboard?.writeText(cmd);
                }}
              >
                <Copy size={12} />
                <span>复制配对命令</span>
              </button>
            </div>
            <code className="block text-[11px] break-all" style={{ color: '#475a75' }}>
              {`node dist/node-runner/index.mjs pair --server ${typeof window !== 'undefined' ? window.location.origin : 'https://work.manyaitool.com'} --code ${nodePairInfo.code} --kind ${nodePairInfo.kind}`}
            </code>
          </div>
        )}

        {nodes.length === 0 ? (
          <p>暂无已配对的执行节点。点击上方按钮生成配对码，即可把任意 VPS 或个人电脑上的 Agent 接入此云端工作台。</p>
        ) : (
          <div className="members-table-wrap">
            <table className="members-table">
              <thead>
                <tr>
                  <th>节点名称</th>
                  <th>类型 / 系统</th>
                  <th>状态</th>
                  <th>最近心跳</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id}>
                    <td className="text-xs font-medium">{n.name}</td>
                    <td className="text-xs" style={{ color: '#6b7a90' }}>
                      {n.kind === 'cloud' ? '云端节点' : '本地电脑'} · {n.platform}
                    </td>
                    <td>
                      <span className={`connector-health ${n.status === 'online' ? 'ready' : 'attention'}`}>
                        {n.status === 'online' ? '在线' : '离线'}
                      </span>
                    </td>
                    <td className="text-xs" style={{ color: '#8f9bae' }}>
                      {n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleString('zh-CN') : '尚未连入'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => void handleRevokeNode(n.id)}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                        style={{ color: '#9c524a' }}
                      >
                        <Trash2 size={12} />
                        <span>吊销</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {authRequired && (
        <div className="management-empty-card mt-4">
          <header className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <strong className="inline-flex items-center gap-1.5 text-sm">
              <ShieldCheck size={15} />
              <span>跨设备登录安全</span>
            </strong>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleGenerateLoginCode()}
                className="dw-btn dw-btn-outline dw-btn-sm"
              >
                <span>生成手机免密登录码</span>
              </button>
              {onLogout && (
                <button
                  type="button"
                  onClick={() => void onLogout()}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                  style={{ color: '#9c524a' }}
                >
                  <LogOut size={12} />
                  <span>退出当前设备</span>
                </button>
              )}
            </div>
          </header>
          {loginMagicInfo && (
            <p className="text-xs mb-2">
              新设备一次性登录码（5 分钟有效）：<strong className="font-mono text-sm">{loginMagicInfo.code}</strong>
            </p>
          )}
          {sessions.length > 0 && (
            <div className="members-table-wrap">
              <table className="members-table">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>IP</th>
                    <th>最近活跃</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="text-xs font-medium">
                        {s.deviceName}
                        {s.current ? '（当前设备）' : ''}
                      </td>
                      <td className="text-xs" style={{ color: '#6b7a90' }}>{s.ip}</td>
                      <td className="text-xs" style={{ color: '#8f9bae' }}>
                        {new Date(s.lastSeenAt).toLocaleString('zh-CN')}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() => void handleRevokeSession(s.id)}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <span>下线</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Detailed Three-Tier Dispatch & Token Usage Ledger */}
      <div className="agent-usage mt-7">
        <header>
          <strong>
            <Activity size={15} />
            <span>近期派发与三层用量流水</span>
          </strong>
        </header>
        {recent.length === 0 ? (
          <p>暂无调用流水，发送一条对话或执行任务后此处将记录实时调度耗费。</p>
        ) : (
          <div className="members-table-wrap">
            <table className="members-table">
              <thead>
                <tr>
                  <th>执行成员</th>
                  <th>调用类型</th>
                  <th>状态</th>
                  <th>消耗与上下文</th>
                  <th style={{ textAlign: 'right' }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const memName = members.find((m) => m.id === r.memberId)?.name || r.memberId;
                  const kindText = ATTEMPT_KIND_LABELS[r.targetKind] || r.targetKind;
                  const statusText = ATTEMPT_STATUS_LABELS[r.status] || r.status;
                  const tokens = r.usage?.providerUsage?.observable
                    ? `${r.usage.providerUsage.totalTokens?.toLocaleString() || 0} tok（缓存 ${r.usage.providerUsage.cachedInputTokens ?? 0}）`
                    : `${(r.promptBytes / 1024).toFixed(1)} KB 上下文`;
                  return (
                    <tr key={r.id}>
                      <td className="text-xs font-medium">{memName}</td>
                      <td className="text-xs" style={{ color: '#6b7a90' }}>{kindText}</td>
                      <td>
                        <span
                          className={`connector-health ${
                            r.status === 'succeeded'
                              ? 'ready'
                              : r.status === 'failed' || r.status === 'timed_out'
                                ? 'attention'
                                : ''
                          }`}
                        >
                          {statusText}
                        </span>
                        {r.errorMessage && (
                          <div
                            className="text-[11px] mt-1 max-w-[240px] truncate"
                            style={{ color: '#b75c4a' }}
                            title={r.errorMessage}
                          >
                            {r.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="text-xs" style={{ color: '#5b6c84' }}>{tokens}</td>
                      <td className="text-xs" style={{ textAlign: 'right', color: '#8f9bae' }}>
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
          </div>
        )}
      </div>
    </section>
  );
}
