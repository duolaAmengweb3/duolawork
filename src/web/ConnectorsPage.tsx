import { useViewCache, useViewData } from './view-cache.js';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Wrench,
  X
} from 'lucide-react';
import { toast } from 'sonner';
import type { DuolaBasePublicStatus } from '../shared/types.js';
import { ServiceIcon } from './ServiceIcon.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.js';
import { Frame, FramePanel } from './components/ui/frame.js';
import { Input } from './components/ui/input.js';
import { PaginationBar, usePagination } from './components/ui/pagination.js';
import { Tabs, TabsList, TabsTab } from './components/ui/tabs.js';
import { useI18n } from './lib/i18n.js';

interface ConnectorItem {
  id: string;
  name: string;
  provider?: string;
  category?: string;
  transport?: string;
  status?: string;
  health?: string;
  issueCode?: string | null;
  endpointUrl?: string;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  lastCheckedAt?: string;
  lastError?: string;
}

function isConnectorReady(c: ConnectorItem): boolean {
  if (c.status === 'disabled' || c.status === 'inactive') return false;
  return c.health === 'ready' || c.status === 'active' || c.status === 'connected';
}

const CATEGORIES: Array<{ id: string; zh: string; en: string }> = [
  { id: '', zh: '全部', en: 'All' },
  { id: 'office_social', zh: '办公协同', en: 'Workspace & Social' },
  { id: 'dev_cloud', zh: '开发与云', en: 'Dev & Cloud' },
  { id: 'ai_model', zh: '模型服务', en: 'AI Models' },
  { id: 'finance_wallet', zh: '链上数据', en: 'Finance & Web3' },
  { id: 'general', zh: '通用', en: 'General' }
];

export function ConnectorsPage({
  duolabaseStatus,
  onToggleDuolabase,
  onReloadStatus
}: {
  duolabaseStatus: DuolaBasePublicStatus;
  onToggleDuolabase: () => Promise<void>;
  onReloadStatus: () => Promise<void>;
}): React.JSX.Element {
  const { locale, L } = useI18n();
  const views = useViewCache();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [toolsByConn, setToolsByConn] = useState<
    Record<string, Array<{ name: string; description?: string }>>
  >({});
  const [expandedConnId, setExpandedConnId] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editId, setEditId] = useState<string>('');
  const [editName, setEditName] = useState<string>('');
  const [editProvider, setEditProvider] = useState<string>('custom');
  const [editCategory, setEditCategory] = useState<string>('general');
  const [editTransport, setEditTransport] = useState<'http_mcp' | 'http_api'>('http_mcp');
  const [editUrl, setEditUrl] = useState<string>('');
  const [editAuthMode, setEditAuthMode] = useState<'none' | 'bearer'>('bearer');
  const [editToken, setEditToken] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const [configOpen, setConfigOpen] = useState<boolean>(false);
  const [cfgEndpoint, setCfgEndpoint] = useState<string>(duolabaseStatus.endpoint);
  const [cfgToken, setCfgToken] = useState<string>('');

  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (query.trim()) qs.set('query', query.trim());
  const enabled = duolabaseStatus.enabled && duolabaseStatus.hasToken;
  const url = '/api/v2/duolabase/connectors?' + qs.toString();
  const { data, read } = useViewData<{ items?: ConnectorItem[] } | ConnectorItem[]>(
    url,
    30000,
    enabled
  );
  const items = Array.isArray(data) ? data : data?.items ?? [];
  const connectorsPager = usePagination(items, 9, `${category}:${query}`);

  const loadConnectors = async () => {
    views.expire('/api/v2/duolabase/connectors');
    setLoading(true);
    setError('');
    try {
      await read();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(enabled && !views.peek(url));
    setError('');
    void read()
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, read, url, views]);

  const handleCheck = async (id: string) => {
    setCheckingId(id);
    setError('');
    try {
      const res = await fetch(`/api/v2/duolabase/connectors/${encodeURIComponent(id)}/check`, {
        method: 'POST'
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || L('检测失败', 'Health check failed'));
      toast.success(L('已完成连通性检测并同步工具列表', 'Connectivity verified & tools synced'));
      await loadConnectors();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingId(null);
    }
  };

  const handleToggleTools = async (id: string) => {
    if (expandedConnId === id) {
      setExpandedConnId(null);
      return;
    }
    setExpandedConnId(id);
    if (toolsByConn[id]) return;
    try {
      const res = await fetch(`/api/v2/duolabase/connectors/${encodeURIComponent(id)}/tools`);
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || L('读取工具列表失败', 'Failed to load tool list'));
      const tools = Array.isArray(out?.tools)
        ? out.tools
        : Array.isArray(out?.items)
          ? out.items
          : [];
      setToolsByConn((prev) => ({ ...prev, [id]: tools }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSaveConnector = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !editUrl.trim()) return;
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: editName.trim(),
        provider: editProvider.trim() || 'custom',
        category: editCategory,
        transport: editTransport,
        endpointUrl: editUrl.trim(),
        autoCheck: true
      };
      if (editId) payload.connectorId = editId;
      if (editAuthMode === 'none') {
        payload.authType = 'none';
      } else if (editToken.trim()) {
        payload.authType = 'vault_headers';
        payload.authMode = 'bearer';
        payload.headers = { Authorization: `Bearer ${editToken.trim()}` };
      }
      const res = await fetch('/api/v2/duolabase/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || L('保存连接器失败', 'Failed to save connector'));
      setEditorOpen(false);
      toast.success(L('连接器已保存并托管至 DuolaBase', 'Connector saved to DuolaBase'));
      await loadConnectors();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveGatewayConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/v2/settings/duolabase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: cfgEndpoint.trim(),
        ...(cfgToken.trim() ? { token: cfgToken.trim() } : {})
      })
    });
    if (res.ok) {
      views.expire('/api/v2/duolabase/', true);
      setCfgToken('');
      setConfigOpen(false);
      toast.success(L('已更新 DuolaBase 网关配置', 'DuolaBase gateway config updated'));
      await onReloadStatus();
      await loadConnectors();
    }
  };

  const activeCount = useMemo(() => items.filter((i) => isConnectorReady(i)).length, [items]);

  return (
    <section className="h-full w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        {/* Unified Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
                {L('连接器统一管理', 'Connectors')}
              </h1>
              <Badge variant={duolabaseStatus.enabled ? 'success' : 'secondary'} size="sm">
                {duolabaseStatus.enabled ? L(`在线 ${activeCount} / ${items.length}`, `Ready ${activeCount} / ${items.length}`) : L('已关闭', 'Disabled')}
              </Badge>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              {L('由 DuolaBase 统一托管 OAuth 与外部工具权限，按需懒加载调用。', 'Centralized OAuth and external MCP permissions managed by DuolaBase with on-demand loading.')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => void loadConnectors()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'is-refreshing' : ''} />
              <span>{L('刷新', 'Refresh')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfigOpen((v) => !v)}>
              <Settings2 size={13} />
              <span>{L('服务设置', 'Settings')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void onToggleDuolabase()}>
              <span
                className={`size-1.5 rounded-full ${duolabaseStatus.enabled ? 'bg-emerald-500' : 'bg-neutral-400'}`}
              />
              <span>{duolabaseStatus.enabled ? L('已启用', 'Enabled') : L('点击启用', 'Enable')}</span>
            </Button>
            <Button
              size="sm"
              disabled={!duolabaseStatus.enabled}
              onClick={() => {
                setEditId('');
                setEditName('');
                setEditProvider('custom');
                setEditCategory('general');
                setEditTransport('http_mcp');
                setEditUrl('');
                setEditToken('');
                setEditorOpen(true);
              }}
            >
              <Plus size={14} />
              <span>{L('添加连接器', 'Add Connector')}</span>
            </Button>
          </div>
        </header>

        {configOpen && (
          <Frame className="dw-inline-panel">
            <FramePanel className="p-4 sm:p-5">
              <form onSubmit={handleSaveGatewayConfig} className="flex flex-col gap-3.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm font-semibold text-foreground">{L('DuolaBase 网关设置', 'DuolaBase Gateway')}</strong>
                  <a
                    href={duolabaseStatus.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-info-foreground hover:underline"
                  >
                    <span>{L('打开 DuolaBase 控制台', 'Open DuolaBase Console')}</span>
                    <ExternalLink size={12} />
                  </a>
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('MCP 接入地址', 'MCP Endpoint URL')}</span>
                    <Input
                      nativeInput
                      type="url"
                      value={cfgEndpoint}
                      onChange={(e) => setCfgEndpoint(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">
                      {L('管理令牌（', 'Admin Token (')}
                      {duolabaseStatus.hasToken
                        ? L(`已就绪 · 来源：${duolabaseStatus.tokenSource}`, `Configured · source: ${duolabaseStatus.tokenSource}`)
                        : L('未配置', 'Not configured')}
                      {L('）', ')')}
                    </span>
                    <Input
                      nativeInput
                      type="password"
                      value={cfgToken}
                      onChange={(e) => setCfgToken(e.target.value)}
                      placeholder={
                        duolabaseStatus.hasToken ? L('留空保持已有令牌不变', 'Leave empty to keep existing token') : L('粘贴 Bearer 访问令牌', 'Paste Bearer access token')
                      }
                    />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConfigOpen(false)}>
                    {L('取消', 'Cancel')}
                  </Button>
                  <Button type="submit" size="sm">
                    {L('保存配置', 'Save')}
                  </Button>
                </div>
              </form>
            </FramePanel>
          </Frame>
        )}

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

        {/* Category Tabs + Search */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={category} onValueChange={(v) => setCategory(String(v))}>
            <TabsList size="sm" className="flex-wrap">
              {CATEGORIES.map((c) => (
                <TabsTab key={c.id || 'all'} value={c.id}>
                  {locale === 'en' ? c.en : c.zh}
                </TabsTab>
              ))}
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
              placeholder={L('搜索连接器名称或平台…', 'Search connectors or providers…')}
              className="pl-7 [&_input]:pl-7"
            />
          </div>
        </div>

        {editorOpen && (
          <Frame className="dw-inline-panel">
            <FramePanel className="p-4 sm:p-5">
              <form onSubmit={handleSaveConnector} className="flex flex-col gap-4 text-xs">
                <div className="flex items-center justify-between">
                  <strong className="text-sm font-semibold text-foreground">
                    {editId ? L('更新连接器配置', 'Update Connector') : L('接入新外部连接器', 'Connect External Service')}
                  </strong>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setEditorOpen(false)}
                    aria-label={L('关闭编辑', 'Close editor')}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('连接器名称', 'Connector Name')}</span>
                    <Input
                      nativeInput
                      type="text"
                      required
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={L('例如：GitHub 研发仓库', 'e.g., GitHub Engineering')}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('业务分类', 'Category')}</span>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {CATEGORIES.filter((c) => c.id).map((c) => (
                        <Button
                          key={c.id}
                          size="xs"
                          variant={editCategory === c.id ? 'default' : 'outline'}
                          onClick={() => setEditCategory(c.id)}
                        >
                          {locale === 'en' ? c.en : c.zh}
                        </Button>
                      ))}
                    </div>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('传输协议', 'Transport')}</span>
                    <div className="flex gap-1.5 pt-0.5">
                      {(['http_mcp', 'http_api'] as const).map((tr) => (
                        <Button
                          key={tr}
                          size="xs"
                          variant={editTransport === tr ? 'default' : 'outline'}
                          onClick={() => setEditTransport(tr)}
                        >
                          {tr === 'http_mcp' ? 'HTTP MCP' : 'HTTP API'}
                        </Button>
                      ))}
                    </div>
                  </label>
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">Endpoint URL</span>
                    <Input
                      nativeInput
                      type="url"
                      required
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="https://api.example.com/mcp"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">{L('认证凭证（加密存入 DuolaBase Vault）', 'Credentials (Encrypted in DuolaBase Vault)')}</span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditAuthMode(editAuthMode === 'none' ? 'bearer' : 'none')}
                      >
                        {editAuthMode === 'none' ? L('无需鉴权', 'No Auth') : 'Bearer Token'}
                      </Button>
                      {editAuthMode === 'bearer' && (
                        <div className="flex-1">
                          <Input
                            nativeInput
                            type="password"
                            value={editToken}
                            onChange={(e) => setEditToken(e.target.value)}
                            placeholder={editId ? L('留空保留原密钥', 'Leave blank to keep secret') : L('粘贴 API Token / 密钥', 'Paste API Token / secret')}
                          />
                        </div>
                      )}
                    </div>
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)}>
                    {L('取消', 'Cancel')}
                  </Button>
                  <Button type="submit" size="sm" loading={saving}>
                    {saving ? L('保存检测中…', 'Saving & checking…') : L('保存并检测', 'Save & Verify')}
                  </Button>
                </div>
              </form>
            </FramePanel>
          </Frame>
        )}

        {/* Connector Grid */}
        {!enabled ? (
          <Frame>
            <FramePanel>
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Plug />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">
                    {!duolabaseStatus.enabled
                      ? L('DuolaBase 连接器当前已关闭', 'DuolaBase Connectors Disabled')
                      : L('尚未检测到 DuolaBase 授权令牌', 'DuolaBase Access Token Missing')}
                  </EmptyTitle>
                  <EmptyDescription>
                    {!duolabaseStatus.enabled
                      ? L('启用后可在此集中查看与管理飞书、GitHub、Gmail、Notion、Vercel 等外部服务连接。', 'Enable to manage Lark, GitHub, Gmail, Notion, Vercel, and other MCP tools.')
                      : L('请点击右上角「服务设置」填入 DuolaBase 访问令牌。', 'Open Settings in the top-right corner to enter your DuolaBase token.')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </FramePanel>
          </Frame>
        ) : data === undefined ? (
          error ? null : (
            <div className="py-12 text-center text-xs text-muted-foreground" role="status">
              {L('正在读取连接器…', 'Loading connectors…')}
            </div>
          )
        ) : items.length === 0 ? (
          <Frame>
            <FramePanel>
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Plug />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">{L('没有匹配的连接器', 'No matching connectors')}</EmptyTitle>
                  <EmptyDescription>
                    {L('调整分类或搜索词，或点击右上角「添加连接器」快速接入。', 'Adjust your filters or search query, or click Add Connector above.')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </FramePanel>
          </Frame>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {connectorsPager.pageItems.map((conn) => {
              const isOk = isConnectorReady(conn);
              const isDisabled = conn.status === 'disabled' || conn.status === 'inactive';
              const expanded = expandedConnId === conn.id;
              const tools = toolsByConn[conn.id] ?? conn.tools ?? [];
              return (
                <Card
                  key={conn.id}
                  render={<article />}
                  className="connector-card gap-3.5 p-4 transition-colors hover:border-ring/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="shrink-0">
                        <ServiceIcon provider={conn.provider} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="m-0 truncate text-[14px] font-semibold text-foreground">
                          {conn.name}
                        </h3>
                        <p className="m-0 mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {conn.provider || 'custom'} · {conn.transport || 'http_mcp'}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={isOk ? 'success' : isDisabled ? 'secondary' : 'warning'}
                      size="sm"
                      className="shrink-0"
                    >
                      {isDisabled ? L('已停用', 'Disabled') : isOk ? L('可用', 'Ready') : conn.health || conn.status || L('待检测', 'Pending')}
                    </Badge>
                  </div>

                  {conn.endpointUrl && (
                    <div
                      className="truncate font-mono text-[11px] text-muted-foreground/85"
                      title={conn.endpointUrl}
                    >
                      {conn.endpointUrl}
                    </div>
                  )}

                  {conn.lastError && (
                    <div className="rounded-lg bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive-foreground">
                      {conn.lastError}
                    </div>
                  )}

                  <div className="mt-auto flex items-center justify-between gap-1.5 border-t border-border pt-3">
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void handleToggleTools(conn.id)}
                      >
                        <Wrench size={11} />
                        <span>
                          {L('查看工具', 'Tools')}
                          {conn.toolCount !== undefined ? ` (${conn.toolCount})` : ''}
                        </span>
                        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleCheck(conn.id)}
                        disabled={checkingId === conn.id}
                      >
                        <RefreshCw
                          size={11}
                          className={checkingId === conn.id ? 'is-refreshing' : ''}
                        />
                        <span>{L('检测', 'Check')}</span>
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setEditId(conn.id);
                        setEditName(conn.name);
                        setEditProvider(conn.provider || 'custom');
                        setEditCategory(conn.category || 'general');
                        setEditTransport(conn.transport === 'http_api' ? 'http_api' : 'http_mcp');
                        setEditUrl(conn.endpointUrl || '');
                        setEditToken('');
                        setEditorOpen(true);
                      }}
                    >
                      {L('编辑', 'Edit')}
                    </Button>
                  </div>

                  {expanded && (
                    <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/40 p-2.5 text-xs coss-scroll">
                      {tools.length === 0 ? (
                        <p className="m-0 text-muted-foreground">{L('暂未发现可用工具或正在读取…', 'No tools discovered or still loading…')}</p>
                      ) : (
                        tools.map((t) => (
                          <div
                            key={t.name}
                            className="border-b border-border/60 pb-1.5 last:border-0 last:pb-0"
                          >
                            <div className="font-mono text-[11.5px] font-medium text-foreground">
                              {t.name}
                            </div>
                            {t.description && (
                              <p className="m-0 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                                {t.description}
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
            </div>
            {connectorsPager.totalPages > 1 && (
              <PaginationBar
                page={connectorsPager.page}
                totalPages={connectorsPager.totalPages}
                startIndex={connectorsPager.startIndex}
                endIndex={connectorsPager.endIndex}
                total={connectorsPager.total}
                onPageChange={connectorsPager.setPage}
                className="rounded-xl border border-border bg-card px-4 py-2.5 shadow-xs/5"
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
