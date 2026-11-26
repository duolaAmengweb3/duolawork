import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Check,
  Copy,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  X
} from 'lucide-react';
import type { DuolaBasePublicStatus } from '../shared/types.js';
import { hasServiceIcon, ServiceIcon } from './ServiceIcon.js';

interface VaultItem {
  id: string;
  name: string;
  type: string;
  category?: string;
  service?: string;
  status: 'active' | 'disabled' | 'deleted';
  version: number;
  projectTags?: string[];
  usageNotes?: string;
  description?: string;
  fields?: Array<{ name: string; reference: string }> | Record<string, string>;
  fieldNames?: string[];
  updatedAt?: string;
  lastUsedAt?: string;
}

function normalizeVaultFields(item: VaultItem): Array<{ name: string; reference: string }> {
  if (Array.isArray(item.fields)) return item.fields;
  if (item.fields && typeof item.fields === 'object') {
    return Object.entries(item.fields).map(([name, reference]) => ({
      name,
      reference: String(reference)
    }));
  }
  if (Array.isArray(item.fieldNames) && item.fieldNames.length > 0) {
    return item.fieldNames.map((name) => ({
      name,
      reference: `vault://${item.id}/${name}`
    }));
  }
  return [];
}

const STATUS_TABS: Array<{ id: 'active' | 'disabled' | 'deleted'; label: string }> = [
  { id: 'active', label: '可使用' },
  { id: 'disabled', label: '已停用' },
  { id: 'deleted', label: '回收站' }
];

const CREDENTIAL_TYPES: Array<{ id: string; label: string; defaultFields: string[] }> = [
  { id: 'api_key', label: 'API Key', defaultFields: ['token'] },
  { id: 'token', label: '访问令牌', defaultFields: ['token'] },
  { id: 'login', label: '账号密码', defaultFields: ['username', 'password'] },
  { id: 'app_secret', label: '应用密钥', defaultFields: ['app_id', 'app_secret'] },
  { id: 'ssh', label: 'SSH 私钥', defaultFields: ['username', 'private_key'] },
  { id: 'custom', label: '自定义', defaultFields: ['value'] }
];

export function VaultPage({
  duolabaseStatus
}: {
  duolabaseStatus: DuolaBasePublicStatus;
}): React.JSX.Element {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<'active' | 'disabled' | 'deleted'>('active');
  const [query, setQuery] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string>('');

  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editId, setEditId] = useState<string>('');
  const [editVersion, setEditVersion] = useState<number>(1);
  const [editName, setEditName] = useState<string>('');
  const [editType, setEditType] = useState<string>('api_key');
  const [editService, setEditService] = useState<string>('');
  const [editTags, setEditTags] = useState<string>('');
  const [editNotes, setEditNotes] = useState<string>('');
  const [editFields, setEditFields] = useState<Array<{ name: string; value: string }>>([
    { name: 'token', value: '' }
  ]);
  const [saving, setSaving] = useState<boolean>(false);

  const [taggingItem, setTaggingItem] = useState<VaultItem | null>(null);
  const [tagDraft, setTagDraft] = useState<string>('');

  const loadVault = useCallback(async () => {
    if (!duolabaseStatus.enabled || !duolabaseStatus.hasToken) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ status: statusFilter });
      if (query.trim()) qs.set('query', query.trim());
      if (projectFilter.trim()) qs.set('project', projectFilter.trim());
      const res = await fetch(`/api/v2/duolabase/vault?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '读取凭证库失败');
      const list = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      setItems(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [duolabaseStatus.enabled, duolabaseStatus.hasToken, statusFilter, query, projectFilter]);

  useEffect(() => {
    void loadVault();
  }, [loadVault]);

  const handleSaveVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const fieldsObj: Record<string, string> = {};
      for (const f of editFields) {
        if (f.name.trim() && f.value) {
          fieldsObj[f.name.trim()] = f.value;
        }
      }
      const tags = editTags
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch('/api/v2/duolabase/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editId ? { credentialId: editId, expectedVersion: editVersion } : {}),
          name: editName.trim(),
          type: editType,
          service: editService.trim() || undefined,
          projectTags: tags,
          usageNotes: editNotes.trim() || undefined,
          fields: fieldsObj
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '保存凭证失败');
      setEditorOpen(false);
      setNotice('凭证已加密保存到 DuolaBase Vault');
      setTimeout(() => setNotice(''), 2500);
      await loadVault();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleLifecycle = async (
    item: VaultItem,
    action: 'disable' | 'enable' | 'delete' | 'restore'
  ) => {
    setError('');
    try {
      const res = await fetch(`/api/v2/duolabase/vault/${encodeURIComponent(item.id)}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          expectedVersion: item.version
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '状态更新失败');
      await loadVault();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taggingItem || !tagDraft.trim()) return;
    try {
      const res = await fetch(
        `/api/v2/duolabase/vault/${encodeURIComponent(taggingItem.id)}/tag-project`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: tagDraft.trim() })
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '添加项目标签失败');
      setTaggingItem(null);
      setTagDraft('');
      await loadVault();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyReference = async (refText: string, id: string) => {
    try {
      await navigator.clipboard.writeText(refText);
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 1800);
    } catch {
      setNotice(`引用地址：${refText}`);
    }
  };

  return (
    <section className="workspace-services">
      <div className="vault-workspace">
        <header className="services-header">
          <div>
            <span className="service-heading-icon">
              <KeyRound size={20} />
            </span>
            <div>
              <h1>全局凭证库 (Vault)</h1>
              <p>
                所有密钥加密保存在 DuolaBase，桌面端仅管理元数据与 <code>vault://</code> 引用，不回显明文密钥。
              </p>
            </div>
          </div>

          <div className="services-header-actions">
            <button
              type="button"
              onClick={() => void loadVault()}
              disabled={loading}
              className="dw-btn dw-btn-outline dw-btn-sm"
            >
              <RefreshCw size={13} className={loading ? 'is-refreshing' : ''} />
              <span>刷新</span>
            </button>
            <button
              type="button"
              disabled={!duolabaseStatus.enabled || !duolabaseStatus.hasToken}
              onClick={() => {
                setEditId('');
                setEditName('');
                setEditType('api_key');
                setEditService('');
                setEditTags('');
                setEditNotes('');
                setEditFields([{ name: 'token', value: '' }]);
                setEditorOpen(true);
              }}
              className="dw-btn dw-btn-primary dw-btn-sm"
            >
              <Plus size={14} />
              <span>添加凭证</span>
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
        {notice && <p className="vault-success mb-4">{notice}</p>}

        <div className="vault-toolbar">
          <div className="connector-categories">
            {STATUS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={statusFilter === t.id}
                onClick={() => setStatusFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="vault-search">
            <Search size={14} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索凭证名称或服务…"
              className="dw-input"
            />
          </div>

          <input
            type="text"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            placeholder="按项目标识筛选…"
            className="dw-input"
            style={{ width: 160 }}
          />
        </div>

        {editorOpen && (
          <form
            onSubmit={handleSaveVault}
            className="mb-6 rounded-xl border p-5 flex flex-col gap-4 text-xs dw-inline-panel"
          >
            <div className="flex items-center justify-between font-semibold text-sm">
              <span>{editId ? `轮换 / 编辑凭证 (v${editVersion})` : '加密保存新凭证'}</span>
              <button type="button" onClick={() => setEditorOpen(false)} aria-label="关闭编辑">
                <X size={15} />
              </button>
            </div>
            <div className="vault-form-pair">
              <label className="flex flex-col gap-1.5">
                <span>凭证名称</span>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例如：Cloudflare DNS 主账号"
                  className="dw-input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span>所属服务 / 平台</span>
                <input
                  type="text"
                  value={editService}
                  onChange={(e) => setEditService(e.target.value)}
                  placeholder="例如：cloudflare、github"
                  className="dw-input"
                />
              </label>
            </div>

            {!editId && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span style={{ color: '#7a879d' }}>凭证类型：</span>
                {CREDENTIAL_TYPES.map((ct) => (
                  <button
                    key={ct.id}
                    type="button"
                    onClick={() => {
                      setEditType(ct.id);
                      setEditFields(ct.defaultFields.map((n) => ({ name: n, value: '' })));
                    }}
                    className={editType === ct.id ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                  >
                    {ct.label}
                  </button>
                ))}
              </div>
            )}

            <div className="vault-editor-fields">
              <div className="vault-field-header">
                <span>密钥字段</span>
              </div>
              {editFields.map((row, idx) => (
                <div key={idx} className="vault-editor-field">
                  <label>
                    <span>字段名</span>
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) =>
                        setEditFields((arr) =>
                          arr.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x))
                        )
                      }
                      className="dw-input"
                    />
                  </label>
                  <label>
                    <span>密钥值</span>
                    <input
                      type="password"
                      value={row.value}
                      onChange={(e) =>
                        setEditFields((arr) =>
                          arr.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x))
                        )
                      }
                      placeholder={editId ? '留空保持原值' : '输入敏感值（提交即加密）'}
                      className="dw-input"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditFields((arr) => arr.filter((_, i) => i !== idx))}
                    disabled={editFields.length <= 1}
                    aria-label="删除字段"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEditFields((arr) => [...arr, { name: 'key', value: '' }])}
                className="dw-btn dw-btn-outline dw-btn-sm vault-add-field"
              >
                + 新增字段
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span>关联项目标签（逗号或空格分隔）</span>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="duolawork, duolabase"
                  className="dw-input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span>使用说明（勿填密钥本身）</span>
                <input
                  type="text"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="账号、环境及使用限制"
                  className="dw-input"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditorOpen(false)} className="dw-btn dw-btn-outline dw-btn-sm">
                取消
              </button>
              <button type="submit" disabled={saving} className="dw-btn dw-btn-primary dw-btn-sm">
                {saving ? '保存中…' : '保存凭证'}
              </button>
            </div>
          </form>
        )}

        {taggingItem && (
          <form
            onSubmit={handleAddTag}
            className="mb-5 rounded-xl border p-3 flex items-center gap-2 text-xs dw-inline-panel"
          >
            <Tag size={14} style={{ color: '#355cc9' }} />
            <span className="font-medium shrink-0">为「{taggingItem.name}」追加项目标签：</span>
            <input
              type="text"
              required
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="输入项目标识（如 duolawork）"
              className="dw-input"
            />
            <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
              确认
            </button>
            <button type="button" onClick={() => setTaggingItem(null)} className="dw-btn dw-btn-outline dw-btn-sm">
              取消
            </button>
          </form>
        )}

        {!duolabaseStatus.enabled || !duolabaseStatus.hasToken ? (
          <div className="vault-empty">
            <ShieldCheck size={34} />
            <h2>需要启用并授权 DuolaBase 后查看凭证</h2>
            <p>可在左侧「连接器」页顶部的“服务设置”里查看或配置 DuolaBase 连接状态。</p>
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="vault-empty">
            {statusFilter === 'deleted' ? <Archive size={30} /> : <KeyRound size={30} />}
            <h2>当前筛选条件下暂无凭证</h2>
            <p>切换状态标签或点击右上角“添加凭证”写入新密钥。</p>
          </div>
        ) : (
          <div className="vault-list">
            {items.map((item) => {
              const normalizedFields = normalizeVaultFields(item);
              const firstRef = normalizedFields[0]?.reference || `vault://${item.id}`;
              const useServiceLogo = hasServiceIcon(item.service);
              return (
                <div key={item.id} className="vault-row" style={{ cursor: 'default' }}>
                  {useServiceLogo ? (
                    <ServiceIcon provider={item.service} />
                  ) : (
                    <span className={`vault-symbol ${item.type}`}>
                      {item.type === 'login' ? <ShieldCheck size={18} /> : item.type === 'ssh' ? <Lock size={18} /> : <KeyRound size={18} />}
                    </span>
                  )}

                  <div className="vault-row-main">
                    <strong>
                      <span>{item.name}</span>
                      <span className={`vault-state ${item.status === 'active' ? 'active' : ''}`}>
                        {item.status === 'active' ? '可使用' : item.status === 'disabled' ? '已停用' : '回收站'}
                      </span>
                      <span className="vault-state">
                        {item.type} · v{item.version}
                      </span>
                    </strong>
                    {item.usageNotes && <p>{item.usageNotes}</p>}
                    <div className="vault-reference">
                      <button
                        type="button"
                        onClick={() => void copyReference(firstRef, item.id)}
                        className="inline-flex items-center gap-1 text-xs"
                        style={{ color: '#4d6eb4' }}
                      >
                        {copiedId === item.id ? <Check size={12} /> : <Copy size={12} />}
                        <code>{firstRef}</code>
                      </button>
                      {(item.projectTags || []).map((tag) => (
                        <span key={tag} className="vault-state">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="vault-detail-actions">
                    {item.status !== 'deleted' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setTaggingItem(item);
                            setTagDraft('');
                          }}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <Tag size={12} />
                          <span>标签</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditId(item.id);
                            setEditVersion(item.version);
                            setEditName(item.name);
                            setEditType(item.type);
                            setEditService(item.service || '');
                            setEditTags((item.projectTags || []).join(', '));
                            setEditNotes(item.usageNotes || '');
                            setEditFields(
                              normalizedFields.length
                                ? normalizedFields.map((f) => ({ name: f.name, value: '' }))
                                : [{ name: 'token', value: '' }]
                            );
                            setEditorOpen(true);
                          }}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          轮换
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void handleLifecycle(item, item.status === 'active' ? 'disable' : 'enable')
                          }
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          {item.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleLifecycle(item, 'delete')}
                          className="dw-btn dw-btn-ghost dw-btn-icon"
                          aria-label={`删除凭证 ${item.name}`}
                          style={{ color: '#b06d24' }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleLifecycle(item, 'restore')}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        <RotateCcw size={12} />
                        <span>恢复</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
