import { useViewCache, useViewData } from './view-cache.js';
import React, { useEffect, useState } from 'react';
import {
  Archive,
  Check,
  Copy,
  Ellipsis,
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
import { toast } from 'sonner';
import type { DuolaBasePublicStatus } from '../shared/types.js';
import { hasServiceIcon, ServiceIcon } from './ServiceIcon.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.js';
import { Frame, FrameFooter, FrameHeader, FramePanel } from './components/ui/frame.js';
import { Input } from './components/ui/input.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './components/ui/menu.js';
import { PaginationBar, usePagination } from './components/ui/pagination.js';
import { Tabs, TabsList, TabsTab } from './components/ui/tabs.js';

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
  const views = useViewCache();
  const [statusFilter, setStatusFilter] = useState<'active' | 'disabled' | 'deleted'>('active');
  const [query, setQuery] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
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

  const qs = new URLSearchParams({ status: statusFilter });
  if (projectFilter.trim()) qs.set('project', projectFilter.trim());
  if (query.trim()) qs.set('query', query.trim());
  const enabled = duolabaseStatus.enabled && duolabaseStatus.hasToken;
  const url = '/api/v2/duolabase/vault?' + qs.toString();
  const { data, read } = useViewData<{ items?: VaultItem[] } | VaultItem[]>(url, 30000, enabled);
  const items = Array.isArray(data) ? data : data?.items ?? [];
  const vaultPager = usePagination(items, 7, `${statusFilter}:${query}:${projectFilter}`);

  const loadVault = async () => {
    views.expire('/api/v2/duolabase/vault');
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
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || '保存凭证失败');
      setEditorOpen(false);
      toast.success('凭证已加密保存到 DuolaBase Vault');
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
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || '状态更新失败');
      const labels = { disable: '已停用凭证', enable: '已启用凭证', delete: '已移入回收站', restore: '已恢复凭证' };
      toast.success(`${labels[action]}：${item.name}`);
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
      const out = await res.json();
      if (!res.ok) throw new Error(out.message || '添加项目标签失败');
      toast.success(`已添加项目标签 #${tagDraft.trim()}`);
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
      toast.success('已复制 Vault 引用地址');
      setTimeout(() => setCopiedId(''), 1800);
    } catch {
      toast.info(`引用地址：${refText}`);
    }
  };

  return (
    <section className="h-full w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        {/* Unified Console Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">
                全局凭证库 (Vault)
              </h1>
              <Badge variant={enabled ? 'success' : 'secondary'} size="sm">
                {enabled ? '端到端托管' : '未启用'}
              </Badge>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              所有密钥加密保存于 DuolaBase，桌面端仅管理元数据与{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">vault://</code>{' '}
              引用，不回显明文密钥。
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => void loadVault()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'is-refreshing' : ''} />
              <span>刷新</span>
            </Button>
            <Button
              size="sm"
              disabled={!enabled}
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
            >
              <Plus size={14} />
              <span>添加凭证</span>
            </Button>
          </div>
        </header>

        {/* Security Posture Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/45 px-3.5 py-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck size={14} className="text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong className="font-medium text-foreground">零明文泄露保护</strong> · Agent 仅通过
              Vault HTTP 代理与连接器间接使用凭证
            </span>
          </span>
          <Badge variant="outline" size="sm" className="font-mono text-[10.5px]">
            点击引用即复制
          </Badge>
        </div>

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

        {editorOpen && (
          <Frame className="dw-inline-panel">
            <FramePanel className="p-4 sm:p-5">
              <form onSubmit={handleSaveVault} className="flex flex-col gap-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">
                    {editId ? `轮换 / 编辑凭证 (v${editVersion})` : '加密保存新凭证'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setEditorOpen(false)}
                    aria-label="关闭编辑"
                  >
                    <X size={14} />
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">凭证名称</span>
                    <Input
                      nativeInput
                      type="text"
                      required
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="例如：Cloudflare DNS 主账号"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">所属服务 / 平台</span>
                    <Input
                      nativeInput
                      type="text"
                      value={editService}
                      onChange={(e) => setEditService(e.target.value)}
                      placeholder="例如：cloudflare、github"
                    />
                  </label>
                </div>

                {!editId && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground mr-1">凭证类型：</span>
                    {CREDENTIAL_TYPES.map((ct) => (
                      <Button
                        key={ct.id}
                        size="xs"
                        variant={editType === ct.id ? 'default' : 'outline'}
                        onClick={() => {
                          setEditType(ct.id);
                          setEditFields(ct.defaultFields.map((n) => ({ name: n, value: '' })));
                        }}
                      >
                        {ct.label}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/30 p-3.5">
                  <span className="font-medium text-foreground">密钥字段</span>
                  {editFields.map((row, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[120px_minmax(0,1fr)_30px] items-end gap-2 sm:grid-cols-[150px_minmax(0,1fr)_32px]"
                    >
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">字段名</span>
                        <Input
                          nativeInput
                          size="sm"
                          type="text"
                          value={row.name}
                          onChange={(e) =>
                            setEditFields((arr) =>
                              arr.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x))
                            )
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">密钥值</span>
                        <Input
                          nativeInput
                          size="sm"
                          type="password"
                          value={row.value}
                          onChange={(e) =>
                            setEditFields((arr) =>
                              arr.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x))
                            )
                          }
                          placeholder={editId ? '留空保持原值' : '输入敏感值（提交即加密）'}
                        />
                      </label>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setEditFields((arr) => arr.filter((_, i) => i !== idx))}
                        disabled={editFields.length <= 1}
                        aria-label="删除字段"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setEditFields((arr) => [...arr, { name: 'key', value: '' }])}
                    >
                      <Plus size={12} />
                      <span>新增字段</span>
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">关联项目标签（逗号或空格分隔）</span>
                    <Input
                      nativeInput
                      type="text"
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="duolawork, duolabase"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground">使用说明（勿填密钥本身）</span>
                    <Input
                      nativeInput
                      type="text"
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="账号、环境及使用限制"
                    />
                  </label>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)}>
                    取消
                  </Button>
                  <Button type="submit" size="sm" loading={saving}>
                    {saving ? '保存中…' : '保存凭证'}
                  </Button>
                </div>
              </form>
            </FramePanel>
          </Frame>
        )}

        {taggingItem && (
          <Frame className="dw-inline-panel">
            <FramePanel className="p-3">
              <form onSubmit={handleAddTag} className="flex flex-wrap items-center gap-2 text-xs">
                <Tag size={14} className="text-muted-foreground shrink-0" />
                <span className="font-medium text-foreground shrink-0">
                  为「{taggingItem.name}」追加项目标签：
                </span>
                <div className="flex-1 min-w-[160px]">
                  <Input
                    nativeInput
                    size="sm"
                    type="text"
                    required
                    autoFocus
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="输入项目标识（如 duolawork）"
                  />
                </div>
                <Button type="submit" size="xs">
                  确认
                </Button>
                <Button variant="outline" size="xs" onClick={() => setTaggingItem(null)}>
                  取消
                </Button>
              </form>
            </FramePanel>
          </Frame>
        )}

        {/* Vault List Frame */}
        <Frame>
          <FrameHeader className="flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as 'active' | 'disabled' | 'deleted')}
            >
              <TabsList size="sm">
                {STATUS_TABS.map((t) => (
                  <TabsTab key={t.id} value={t.id}>
                    {t.label}
                  </TabsTab>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
              <div className="relative flex w-full items-center sm:max-w-[260px]">
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
                  placeholder="搜索凭证名称或服务…"
                  className="pl-7 [&_input]:pl-7"
                />
              </div>
              <div className="w-full sm:w-40">
                <Input
                  nativeInput
                  size="sm"
                  type="text"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  placeholder="按 #项目 筛选…"
                />
              </div>
            </div>
          </FrameHeader>

          <FramePanel className="overflow-hidden p-0">
            {!enabled ? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ShieldCheck />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">需要启用并授权 DuolaBase 后查看凭证</EmptyTitle>
                  <EmptyDescription>
                    可在左侧「连接器」页顶部的「服务设置」里查看或配置 DuolaBase 连接状态。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : data === undefined ? (
              error ? null : (
                <div className="px-4 py-12 text-center text-xs text-muted-foreground" role="status">
                  正在读取凭证列表…
                </div>
              )
            ) : items.length === 0 ? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {statusFilter === 'deleted' ? <Archive /> : <KeyRound />}
                  </EmptyMedia>
                  <EmptyTitle className="text-base">当前筛选条件下暂无凭证</EmptyTitle>
                  <EmptyDescription>
                    切换状态标签或点击右上角「添加凭证」写入新密钥。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y divide-border">
                <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.35fr)_116px] items-center gap-3 bg-muted/40 px-4 py-2 text-[11px] font-medium text-muted-foreground md:grid">
                  <span>凭证与归属</span>
                  <span>安全引用与项目标签</span>
                  <span className="text-right">生命周期</span>
                </div>

                {vaultPager.pageItems.map((item) => {
                  const normalizedFields = normalizeVaultFields(item);
                  const firstRef = normalizedFields[0]?.reference || `vault://${item.id}`;
                  const useServiceLogo = hasServiceIcon(item.service);
                  const isCopied = copiedId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-1 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/35 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.35fr)_116px]"
                    >
                      {/* Identity */}
                      <div className="flex min-w-0 items-center gap-3">
                        {useServiceLogo ? (
                          <div className="shrink-0">
                            <ServiceIcon provider={item.service} />
                          </div>
                        ) : (
                          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-xs/5">
                            {item.type === 'login' ? (
                              <ShieldCheck size={16} />
                            ) : item.type === 'ssh' ? (
                              <Lock size={16} />
                            ) : (
                              <KeyRound size={16} />
                            )}
                          </span>
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="truncate text-[13.5px] font-semibold text-foreground">
                              {item.name}
                            </span>
                            <Badge variant="outline" size="sm" className="font-mono text-[10px]">
                              v{item.version}
                            </Badge>
                            <Badge
                              variant={item.status === 'active' ? 'success' : 'secondary'}
                              size="sm"
                            >
                              {item.status === 'active'
                                ? '可使用'
                                : item.status === 'disabled'
                                  ? '已停用'
                                  : '回收站'}
                            </Badge>
                          </div>
                          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                            {item.usageNotes || `${item.type}${item.service ? ` · ${item.service}` : ''}`}
                          </div>
                        </div>
                      </div>

                      {/* Reference & Tags */}
                      <div className="flex min-w-0 flex-col items-start gap-1.5">
                        <button
                          type="button"
                          onClick={() => void copyReference(firstRef, item.id)}
                          title={`点击复制 ${firstRef}`}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/45 px-2 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-ring hover:bg-muted"
                        >
                          {isCopied ? (
                            <Check size={11} className="shrink-0 text-emerald-500" />
                          ) : (
                            <Copy size={11} className="shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{isCopied ? '已复制引用' : firstRef}</span>
                        </button>
                        {(item.projectTags || []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {(item.projectTags || []).map((tag) => (
                              <Badge key={tag} variant="secondary" size="sm" className="text-[10px]">
                                #{tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Lifecycle Actions */}
                      <div className="flex items-center justify-end gap-1.5">
                        {item.status !== 'deleted' ? (
                          <>
                            <Button
                              variant="outline"
                              size="xs"
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
                            >
                              轮换
                            </Button>

                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={`更多操作 ${item.name}`}
                                  >
                                    <Ellipsis size={14} />
                                  </Button>
                                }
                              />
                              <MenuPopup align="end" className="min-w-36">
                                <MenuItem
                                  onClick={() => {
                                    setTaggingItem(item);
                                    setTagDraft('');
                                  }}
                                >
                                  <Tag size={13} />
                                  <span>添加项目标签</span>
                                </MenuItem>
                                <MenuItem
                                  onClick={() =>
                                    void handleLifecycle(
                                      item,
                                      item.status === 'active' ? 'disable' : 'enable'
                                    )
                                  }
                                >
                                  <Lock size={13} />
                                  <span>{item.status === 'active' ? '停用凭证' : '重新启用'}</span>
                                </MenuItem>
                                <MenuSeparator />
                                <MenuItem
                                  variant="destructive"
                                  onClick={() => void handleLifecycle(item, 'delete')}
                                >
                                  <Trash2 size={13} />
                                  <span>移入回收站</span>
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => void handleLifecycle(item, 'restore')}
                          >
                            <RotateCcw size={12} />
                            <span>恢复</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </FramePanel>
          {vaultPager.totalPages > 1 && (
            <FrameFooter>
              <PaginationBar
                page={vaultPager.page}
                totalPages={vaultPager.totalPages}
                startIndex={vaultPager.startIndex}
                endIndex={vaultPager.endIndex}
                total={vaultPager.total}
                onPageChange={vaultPager.setPage}
              />
            </FrameFooter>
          )}
        </Frame>
      </div>
    </section>
  );
}
