import { useViewCache, useViewData } from './view-cache.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
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
import type { DuolaBasePublicStatus } from '../shared/types.js';
import { ServiceIcon } from './ServiceIcon.js';

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

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: '', label: '全部' },
  { id: 'office_social', label: '办公协同' },
  { id: 'dev_cloud', label: '开发与云' },
  { id: 'ai_model', label: '模型服务' },
  { id: 'finance_wallet', label: '链上数据' },
  { id: 'general', label: '通用' }
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
  const views = useViewCache();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [toolsByConn, setToolsByConn] = useState<Record<string, Array<{ name: string; description?: string }>>>({});
  const [expandedConnId, setExpandedConnId] = useState<string | null>(null);

  // Add/edit drawer
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

  // Optional DuolaBase endpoint/token config
  const [configOpen, setConfigOpen] = useState<boolean>(false);
  const [cfgEndpoint, setCfgEndpoint] = useState<string>(duolabaseStatus.endpoint);
  const [cfgToken, setCfgToken] = useState<string>('');

  const qs = new URLSearchParams();
  if (category) qs.set('category',category);
  if (query.trim()) qs.set('query',query.trim());
  const enabled = duolabaseStatus.enabled && duolabaseStatus.hasToken;
  const url = '/api/v2/duolabase/connectors?'+qs.toString();
  const {data, read} = useViewData<{items?: ConnectorItem[]} | ConnectorItem[]>(url, 30000, enabled);
  const items = Array.isArray(data) ? data : data?.items ?? [];
  const loadConnectors = async () => {
    views.expire('/api/v2/duolabase/connectors');
    setLoading(true); setError('');
    try { await read(); } catch (err) { setError((err as Error).message); }
    finally {setLoading(false);}
  };
  useEffect(() => {
    let active = true;
    setLoading(enabled && !views.peek(url));setError('');
    void read().catch(err => {if (active) setError(err.message);})
      .finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [enabled, read, url, views]);

  const handleCheck = async (id: string) => {
    setCheckingId(id);
    setError('');
    try {
      const res = await fetch(`/api/v2/duolabase/connectors/${encodeURIComponent(id)}/check`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '检测失败');
      setNotice('已完成连通性检测并同步工具列表');
      setTimeout(() => setNotice(''), 2500);
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '读取工具列表失败');
      const tools = Array.isArray(data?.tools) ? data.tools : Array.isArray(data?.items) ? data.items : [];
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '保存连接器失败');
      setEditorOpen(false);
      setNotice('连接器已保存并托管至 DuolaBase');
      setTimeout(() => setNotice(''), 2500);
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
      await onReloadStatus();
      await loadConnectors();
    }
  };

  const activeCount = useMemo(
    () => items.filter((i) => isConnectorReady(i)).length,
    [items]
  );

  return (
    <section className="workspace-services">
      <div className="connector-workspace">
        <header className="services-header">
          <div>
            <span className="service-heading-icon">
              <Plug size={20} />
            </span>
            <div>
              <h1>连接器统一管理</h1>
              <p>
                由 DuolaBase 统一托管 OAuth 与外部工具权限（按需懒加载，不向每轮对话灌注整套工具列表）。
              </p>
            </div>
          </div>

          <div className="services-header-actions">
            <button
              type="button"
              onClick={() => void loadConnectors()}
              disabled={loading}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <RefreshCw size={13} className={loading ? 'is-refreshing' : ''} />
              <span>刷新</span>
            </button>
            <button
              type="button"
              onClick={() => setConfigOpen((v) => !v)}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <Settings2 size={13} />
              <span>服务设置</span>
            </button>
            <button
              type="button"
              onClick={() => void onToggleDuolabase()}
              className="dw-btn dw-btn-outline dw-btn-sm"
              style={{ color: duolabaseStatus.enabled ? '#27846b' : '#7b879c' }}
            >
              {duolabaseStatus.enabled ? `已启用 · 在线 ${activeCount}/${items.length}` : '已关闭 · 点击启用'}
            </button>
            <button
              type="button"
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
              className="dw-btn dw-btn-primary dw-btn-sm"
            >
              <Plus size={14} />
              <span>添加连接器</span>
            </button>
          </div>
        </header>

        {configOpen && (
          <form
            onSubmit={handleSaveGatewayConfig}
            className="mb-5 rounded-xl border p-4 flex flex-col gap-3 text-xs dw-inline-panel"
          >
            <div className="flex items-center justify-between">
              <strong>DuolaBase 网关设置</strong>
              <a
                href={duolabaseStatus.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="connector-login"
              >
                <span>打开 DuolaBase 控制台</span>
                <ExternalLink size={12} />
              </a>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span>MCP 接入地址</span>
                <input
                  type="url"
                  value={cfgEndpoint}
                  onChange={(e) => setCfgEndpoint(e.target.value)}
                  className="dw-input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span>
                  管理令牌（{duolabaseStatus.hasToken ? `已就绪 · 来源：${duolabaseStatus.tokenSource}` : '未配置'}）
                </span>
                <input
                  type="password"
                  value={cfgToken}
                  onChange={(e) => setCfgToken(e.target.value)}
                  placeholder={duolabaseStatus.hasToken ? '留空保持已有令牌不变' : '粘贴 Bearer 访问令牌'}
                  className="dw-input"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfigOpen(false)} className="dw-btn dw-btn-outline dw-btn-sm">
                取消
              </button>
              <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                保存配置
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="services-error mb-4 flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="关闭错误">
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div
            className="mb-4 rounded-lg px-3 py-2 text-xs flex items-center gap-1.5"
            style={{ backgroundColor: '#eaf7f2', color: '#27846b' }}
          >
            <Check size={14} />
            <span>{notice}</span>
          </div>
        )}

        <div className="connector-browse">
          <div className="connector-categories">
            {CATEGORIES.map((c) => (
              <button
                key={c.id || 'all'}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="connector-search">
            <Search size={14} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索连接器名称或平台…"
              className="dw-input"
            />
          </div>
        </div>

        {editorOpen && (
          <form
            onSubmit={handleSaveConnector}
            className="mb-6 rounded-xl border p-5 connector-form dw-inline-panel"
          >
            <div className="flex items-center justify-between">
              <strong style={{ fontSize: 15 }}>{editId ? '更新连接器配置' : '接入新外部连接器'}</strong>
              <button type="button" onClick={() => setEditorOpen(false)} aria-label="关闭编辑">
                <X size={15} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label>
                <span>连接器名称</span>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例如：GitHub 研发仓库"
                  className="dw-input"
                />
              </label>
              <label>
                <span>业务分类</span>
                <div className="flex flex-wrap gap-1 pt-1">
                  {CATEGORIES.filter((c) => c.id).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setEditCategory(c.id)}
                      className={editCategory === c.id ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </label>
              <label>
                <span>传输协议</span>
                <div className="flex gap-1.5 pt-1">
                  {(['http_mcp', 'http_api'] as const).map((tr) => (
                    <button
                      key={tr}
                      type="button"
                      onClick={() => setEditTransport(tr)}
                      className={editTransport === tr ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                    >
                      {tr === 'http_mcp' ? 'HTTP MCP' : 'HTTP API'}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label>
                <span>Endpoint URL</span>
                <input
                  type="url"
                  required
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://api.example.com/mcp"
                  className="dw-input"
                />
              </label>
              <label>
                <span>认证凭证（加密存入 DuolaBase Vault）</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditAuthMode(editAuthMode === 'none' ? 'bearer' : 'none')}
                    className="dw-btn dw-btn-outline dw-btn-sm"
                  >
                    {editAuthMode === 'none' ? '无需鉴权' : 'Bearer Token'}
                  </button>
                  {editAuthMode === 'bearer' && (
                    <input
                      type="password"
                      value={editToken}
                      onChange={(e) => setEditToken(e.target.value)}
                      placeholder={editId ? '留空保留原密钥' : '粘贴 API Token / 密钥'}
                      className="dw-input"
                    />
                  )}
                </div>
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setEditorOpen(false)} className="dw-btn dw-btn-outline dw-btn-sm">
                取消
              </button>
              <button type="submit" disabled={saving} className="dw-btn dw-btn-primary dw-btn-sm">
                {saving ? '保存检测中…' : '保存并检测'}
              </button>
            </footer>
          </form>
        )}

        {!duolabaseStatus.enabled || !duolabaseStatus.hasToken ? (
          <div className="connector-start">
            <Plug size={34} />
            <h2>{!duolabaseStatus.enabled ? 'DuolaBase 连接器当前已关闭' : '尚未检测到 DuolaBase 授权令牌'}</h2>
            <p>
              {!duolabaseStatus.enabled
                ? '启用后可在此集中查看与管理飞书、GitHub、Gmail、Notion、Vercel 等外部服务连接。'
                : '请点击右上角“服务设置”填入 DuolaBase 访问令牌，或保持本机 Codex 的 [mcp_servers.duolabase] 配置有效。'}
            </p>
          </div>
        ) : data === undefined ? (
          error ? null : <p className="connector-empty-inline" role="status">正在读取连接器…</p>
        ) : items.length === 0 ? (
          <p className="connector-empty-inline">没有匹配的连接器，可点击右上角「添加连接器」快速接入。</p>
        ) : (
          <div className="connector-section">
            <div className="connector-section-heading">
              <h2>
                已托管服务 <span>{items.length}</span>
              </h2>
              <small>均通过 DuolaBase 代理鉴权与调用</small>
            </div>
            <div className="connector-grid">
              {items.map((conn) => {
                const isOk = isConnectorReady(conn);
                const isDisabled = conn.status === 'disabled' || conn.status === 'inactive';
                const expanded = expandedConnId === conn.id;
                const tools = toolsByConn[conn.id] ?? conn.tools ?? [];
                return (
                  <article key={conn.id} className="connector-row connector-card">
                    <div className="connector-card-top">
                      <ServiceIcon provider={conn.provider} />
                      <span className={`connector-health ${isOk ? 'ready' : isDisabled ? 'paused' : 'attention'}`}>
                        {isDisabled ? '已停用' : isOk ? '可用' : conn.health || conn.status || '待检测'}
                      </span>
                    </div>

                    <div className="connector-main">
                      <h3>{conn.name}</h3>
                      <p>
                        {conn.provider || 'custom'} · {conn.transport || 'http_mcp'}
                        {conn.toolCount !== undefined ? ` · ${conn.toolCount} 个工具` : ''}
                      </p>
                      {conn.endpointUrl && <small>{conn.endpointUrl}</small>}
                    </div>

                    {conn.lastError && <div className="services-error">{conn.lastError}</div>}

                    <div className="connector-card-actions">
                      <button
                        type="button"
                        onClick={() => void handleToggleTools(conn.id)}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        <Wrench size={12} />
                        <span>查看工具</span>
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCheck(conn.id)}
                        disabled={checkingId === conn.id}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        <RefreshCw size={12} className={checkingId === conn.id ? 'is-refreshing' : ''} />
                        <span>检测</span>
                      </button>
                      <button
                        type="button"
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
                        className="dw-btn dw-btn-ghost dw-btn-sm"
                      >
                        编辑
                      </button>
                    </div>

                    {expanded && (
                      <div className="connector-tools">
                        {tools.length === 0 ? (
                          <p>暂未发现可用工具或正在读取…</p>
                        ) : (
                          tools.map((t) => (
                            <div key={t.name}>
                              <strong>{t.name}</strong>
                              {t.description && <p>{t.description}</p>}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
