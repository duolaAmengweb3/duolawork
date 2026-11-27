import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  Film,
  Folder,
  FolderInput,
  FolderOpen,
  History,
  Image,
  KeyRound,
  Link2,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Music,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Quote,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  Users,
  X
} from 'lucide-react';
import {
  isLocalCodingMember,
  type ArtifactRecord,
  type ArtifactVersionRecord,
  type DuolaBasePublicStatus,
  type MaterialContextResult,
  type MaterialTaskRole,
  type MemberRecord,
  type SpaceFolderRecord,
  type SpaceItemKind,
  type SpaceItemView,
  type TaskRecord,
  type TaskRunRecord,
  type TaskStepRecord,
  type ThreadRecord,
  type WorkspaceFileEntry
} from '../shared/types.js';
import { AgentAvatar } from './AgentAvatar.js';
import { MarkdownView } from './markdown.js';

export interface SpaceTaskSummary extends TaskRecord {
  latestRun: TaskRunRecord | null;
  steps?: TaskStepRecord[];
}

export interface SpaceReferenceChip {
  id: string;
  kind: SpaceItemKind | 'workspace_file';
  title: string;
  snippet: string;
  subLabel?: string;
  version?: number;
  url?: string;
}

export type WorkbenchNavPage = 'connectors' | 'vault' | 'members' | 'schedules';

export interface CollaborationSpacePanelProps {
  thread: ThreadRecord | null;
  materialsState: 'ready' | 'loading' | 'error';
  members: MemberRecord[];
  duolabaseStatus: DuolaBasePublicStatus;
  hasDesktopDialog: boolean;
  refreshingMembers: boolean;
  wideSpace: boolean;
  onToggleWide: () => void;
  onCloseSpace: () => void;
  tab: 'documents' | 'tasks' | 'resources';
  onTabChange: (tab: 'documents' | 'tasks' | 'resources') => void;
  selection: { kind: SpaceItemKind; id: string } | null;
  onSelectItem: (sel: { kind: SpaceItemKind; id: string } | null) => void;
  focusFolderRequest?: { folderId: string | null; seq: number } | null;
  folders: SpaceFolderRecord[];
  items: SpaceItemView[];
  trash: SpaceItemView[];
  threadTasks: SpaceTaskSummary[];
  artifact: ArtifactRecord | null;
  versions: ArtifactVersionRecord[];
  docEditing: boolean;
  setDocEditing: (v: boolean) => void;
  docDraft: string;
  setDocDraft: (v: string) => void;
  docNotice: string;
  onSaveArtifact: () => Promise<void>;
  onCopyArtifact: () => Promise<void>;
  onExportArtifact: () => void;
  onSendArtifactBackToOriginChat: () => Promise<void>;
  onSelectVersion: (content: string) => void;
  onRefreshSpace: () => Promise<void>;
  onQuoteToChat: (ref: SpaceReferenceChip) => void;
  onOpenTask: (taskId: string) => void;
  onOpenCreateTask: () => void;
  onChooseWorkspace: () => Promise<void>;
  onSaveWorkspacePath: (path: string | null) => Promise<void>;
  onRefreshMembers: () => Promise<void>;
  onToggleDuolabase: () => Promise<void>;
  onNavigatePage: (page: WorkbenchNavPage) => void;
  onFocusChat?: () => void;
  onNotify: (msg: string) => void;
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function itemIcon(item: SpaceItemView) {
  if (item.kind === 'link') return Link2;
  if (item.kind === 'document') return FileText;
  if (item.previewKind === 'image') return Image;
  if (item.previewKind === 'video') return Film;
  if (item.previewKind === 'audio') return Music;
  return File;
}

function kindLabel(item: SpaceItemView): string {
  if (item.kind === 'link') return '链接';
  if (item.kind === 'document') return `v${item.version ?? 1}`;
  if (item.previewKind === 'image') return `图片 · ${formatBytes(item.sizeBytes)}`;
  if (item.previewKind === 'pdf') return `PDF · ${formatBytes(item.sizeBytes)}`;
  if (item.previewKind === 'video') return `视频 · ${formatBytes(item.sizeBytes)}`;
  if (item.previewKind === 'audio') return `音频 · ${formatBytes(item.sizeBytes)}`;
  return formatBytes(item.sizeBytes);
}

const ROLE_META: Record<MaterialTaskRole, { label: string; badgeClass: string }> = {
  input: { label: '输入材料', badgeClass: 'working' },
  output: { label: '工作成果', badgeClass: 'done' },
  reference: { label: '相关资料', badgeClass: '' }
};

export function CollaborationSpacePanel(props: CollaborationSpacePanelProps): React.JSX.Element {
  const {
    thread,
    members,
    duolabaseStatus,
    hasDesktopDialog,
    refreshingMembers,
    wideSpace,
    onToggleWide,
    onCloseSpace,
    tab,
    onTabChange,
    selection,
    onSelectItem,
    focusFolderRequest,
    folders,
    items,
    trash,
    threadTasks,
    artifact,
    versions,
    docEditing,
    setDocEditing,
    docDraft,
    setDocDraft,
    docNotice,
    onSaveArtifact,
    onCopyArtifact,
    onExportArtifact,
    onSendArtifactBackToOriginChat,
    onSelectVersion,
    onRefreshSpace,
    onQuoteToChat,
    onOpenTask,
    onOpenCreateTask,
    onChooseWorkspace,
    onSaveWorkspacePath,
    onRefreshMembers,
    onToggleDuolabase,
    onNavigatePage,
    onFocusChat,
    onNotify
  } = props;

  const [query, setQuery] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<'' | SpaceItemKind>('');
  const [filterMenuOpen, setFilterMenuOpen] = useState<boolean>(false);
  const [addMenuOpen, setAddMenuOpen] = useState<boolean>(false);
  const [expandedRecent, setExpandedRecent] = useState<boolean>(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [rowMenuKey, setRowMenuKey] = useState<string | null>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState<boolean>(false);
  const [undoTrash, setUndoTrash] = useState<{ kind: SpaceItemKind; id: string; title: string } | null>(null);
  const [taskFilter, setTaskFilter] = useState<'active' | 'done' | 'all'>('active');
  const [historyMenuOpen, setHistoryMenuOpen] = useState<boolean>(false);
  const [dragging, setDragging] = useState<boolean>(false);

  const [createMode, setCreateMode] = useState<'document' | 'link' | 'folder' | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [draftUrl, setDraftUrl] = useState<string>('https://');
  const [draftNote, setDraftNote] = useState<string>('');

  const [renameTarget, setRenameTarget] = useState<
    | { target: 'item'; kind: SpaceItemKind; id: string; title: string }
    | { target: 'folder'; id: string; title: string }
    | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<{
    kind: SpaceItemKind;
    id: string;
    title: string;
    folderId: string | null;
  } | null>(null);

  const [materialContext, setMaterialContext] = useState<MaterialContextResult | null>(null);
  const [contextOpen, setContextOpen] = useState<boolean>(true);
  const [linkPickerOpen, setLinkPickerOpen] = useState<boolean>(false);
  const [linkRole, setLinkRole] = useState<MaterialTaskRole>('reference');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [fileTextPreview, setFileTextPreview] = useState<string>('');
  const [fileTextState, setFileTextState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [htmlPreviewMode, setHtmlPreviewMode] = useState<'render' | 'source'>('render');

  const [wsSubpath, setWsSubpath] = useState<string>('');
  const [wsEntries, setWsEntries] = useState<WorkspaceFileEntry[]>([]);
  const [wsError, setWsError] = useState<string>('');
  const [wsBusy, setWsBusy] = useState<boolean>(false);
  const [editingWsPath, setEditingWsPath] = useState<boolean>(false);
  const [wsPathInput, setWsPathInput] = useState<string>('');
  const [confirmPurgeKey, setConfirmPurgeKey] = useState<string | null>(null);
  const [resSummary, setResSummary] = useState<{
    connectorCount: number;
    vaultCount: number | null;
    activeConnectors: Array<{ id: string; name: string; provider?: string; toolCount?: number }>;
  } | null>(null);
  const [resBusy, setResBusy] = useState<boolean>(false);

  const memberById = useMemo(() => {
    const map = new Map<string, MemberRecord>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const selectedItem = useMemo(() => {
    if (!selection) return null;
    return items.find((i) => i.kind === selection.kind && i.id === selection.id) ?? null;
  }, [items, selection]);

  useEffect(() => {
    if (focusFolderRequest) {
      setShowTrash(false);
      setActiveFolderId(focusFolderRequest.folderId);
    }
  }, [focusFolderRequest]);

  useEffect(() => {
    setShowTrash(false);
    setCreateMode(null);
    setRenameTarget(null);
    setMoveTarget(null);
    setRowMenuKey(null);
    setFolderMenuId(null);
    setActiveFolderId(null);
    setExpandedRecent(false);
    setWsSubpath('');
    setEditingWsPath(false);
    setUndoTrash(null);
    setLinkPickerOpen(false);
    setConfirmPurgeKey(null);
  }, [thread?.id]);

  useEffect(() => {
    if (!undoTrash) return;
    const t = setTimeout(() => setUndoTrash(null), 6000);
    return () => clearTimeout(t);
  }, [undoTrash]);

  useEffect(() => {
    setFileTextPreview('');
    setHtmlPreviewMode('render');
    if (!selection || selection.kind !== 'file' || selectedItem?.previewKind !== 'text') {
      setFileTextState('idle');
      return;
    }
    const isHtml = /\.html?$/i.test(selectedItem.title || '') || (selectedItem.mimeType || '').includes('text/html');
    const maxChars = isHtml ? 4_000_000 : 64_000;
    let alive = true;
    setFileTextState('loading');
    fetch(`/api/v2/space/files/${encodeURIComponent(selection.id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((txt) => {
        if (!alive) return;
        setFileTextPreview(txt.slice(0, maxChars));
        setFileTextState('ready');
      })
      .catch(() => {
        if (alive) setFileTextState('error');
      });
    return () => {
      alive = false;
    };
  }, [selection, selectedItem?.previewKind, selectedItem?.title, selectedItem?.mimeType]);

  const loadMaterialContext = useCallback(async () => {
    if (!thread?.id || !selection) {
      setMaterialContext(null);
      return;
    }
    try {
      const qs = new URLSearchParams({ kind: selection.kind, id: selection.id });
      const res = await fetch(
        `/api/v2/threads/${encodeURIComponent(thread.id)}/space/context?${qs.toString()}`
      );
      if (res.ok) {
        setMaterialContext(await res.json());
      } else {
        setMaterialContext(null);
      }
    } catch {
      setMaterialContext(null);
    }
  }, [thread?.id, selection]);

  useEffect(() => {
    setLinkPickerOpen(false);
    void loadMaterialContext();
  }, [loadMaterialContext, artifact?.headVersion]);

  const loadWorkspaceFiles = useCallback(
    async (sub = '') => {
      if (!thread?.id || !thread.workspacePath) {
        setWsEntries([]);
        setWsError('');
        return;
      }
      setWsBusy(true);
      setWsError('');
      try {
        const q = sub ? `?subpath=${encodeURIComponent(sub)}` : '';
        const res = await fetch(
          `/api/v2/threads/${encodeURIComponent(thread.id)}/workspace-files${q}`
        );
        const data = await res.json();
        if (!res.ok) {
          setWsError(data.message || '目录读取失败');
          setWsEntries([]);
          return;
        }
        setWsEntries(data.entries || []);
        setWsSubpath(data.subpath || '');
      } catch {
        setWsError('目录读取失败');
      } finally {
        setWsBusy(false);
      }
    },
    [thread?.id, thread?.workspacePath]
  );

  useEffect(() => {
    if (tab === 'resources' && thread?.workspacePath) {
      void loadWorkspaceFiles('');
    } else {
      setWsEntries([]);
    }
  }, [tab, thread?.id, thread?.workspacePath, loadWorkspaceFiles]);

  useEffect(() => {
    if (tab !== 'resources' || !duolabaseStatus.enabled || !duolabaseStatus.hasToken) {
      return;
    }
    let alive = true;
    setResBusy(true);
    Promise.all([
      fetch('/api/v2/duolabase/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v2/duolabase/connectors').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ])
      .then(([statusJson, connJson]) => {
        if (!alive) return;
        const rawList = Array.isArray(connJson?.items)
          ? connJson.items
          : Array.isArray(connJson)
            ? connJson
            : [];
        const activeConnectors = rawList
          .filter((c: any) => c && c.status !== 'disabled' && c.status !== 'inactive')
          .slice(0, 6)
          .map((c: any) => ({
            id: String(c.id || ''),
            name: String(c.name || c.provider || '连接器'),
            provider: typeof c.provider === 'string' ? c.provider : undefined,
            toolCount: typeof c.toolCount === 'number' ? c.toolCount : undefined
          }));
        const sys = statusJson?.systemInfo;
        setResSummary({
          connectorCount:
            typeof sys?.connectorCount === 'number' ? sys.connectorCount : rawList.length,
          vaultCount: typeof sys?.vaultCount === 'number' ? sys.vaultCount : null,
          activeConnectors
        });
      })
      .finally(() => {
        if (alive) setResBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, duolabaseStatus.enabled, duolabaseStatus.hasToken]);

  const mutateItem = async (
    kind: SpaceItemKind,
    id: string,
    payload: {
      action: 'pin' | 'unpin' | 'move' | 'rename' | 'delete' | 'restore';
      title?: string;
      folderId?: string | null;
    },
    itemTitle?: string
  ) => {
    const res = await fetch(`/api/v2/space/items/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      onNotify(err.message || err.error || '操作资料失败');
      return;
    }
    if (payload.action === 'delete') {
      if (selection?.kind === kind && selection.id === id) {
        onSelectItem(null);
      }
      setUndoTrash({
        kind,
        id,
        title: itemTitle || items.find((i) => i.kind === kind && i.id === id)?.title || '资料'
      });
    } else if (payload.action === 'restore') {
      setUndoTrash(null);
    }
    await onRefreshSpace();
  };

  const uploadFileList = async (files: File[]) => {
    if (!thread?.id || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 16 * 1024 * 1024) {
          onNotify(`文件 ${file.name} 超过 16 MiB 限制`);
          continue;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('文件读取失败'));
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}/space/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64: base64,
            folderId: activeFolderId
          })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          onNotify(err.message || `上传 ${file.name} 失败`);
        }
      }
      await onRefreshSpace();
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFileList(files);
  };

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (!thread?.id) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      await uploadFileList(files);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!thread?.id || !createMode) return;
    const title = draftTitle.trim();
    if (!title) return;

    if (createMode === 'folder') {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}/space/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, parentFolderId: activeFolderId })
      });
      if (res.ok) {
        setCreateMode(null);
        await onRefreshSpace();
      } else {
        const err = await res.json().catch(() => ({}));
        onNotify(err.message || '新建文件夹失败');
      }
      return;
    }

    if (createMode === 'document') {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}/space/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          content: draftNote || `# ${title.replace(/\.md$/i, '')}\n\n`,
          folderId: activeFolderId
        })
      });
      if (res.ok) {
        const data = await res.json();
        setCreateMode(null);
        await onRefreshSpace();
        if (data.artifact?.id) {
          onSelectItem({ kind: 'document', id: data.artifact.id });
          setDocEditing(true);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        onNotify(err.message || '新建文档失败');
      }
      return;
    }

    if (createMode === 'link') {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}/space/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          url: draftUrl.trim(),
          note: draftNote.trim(),
          folderId: activeFolderId
        })
      });
      if (res.ok) {
        setCreateMode(null);
        await onRefreshSpace();
      } else {
        const err = await res.json().catch(() => ({}));
        onNotify(err.message || '添加链接失败');
      }
    }
  };

  const handleRenameConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget) return;
    const clean = renameTarget.title.trim();
    if (!clean) return;
    if (renameTarget.target === 'folder') {
      const res = await fetch(`/api/v2/space/folders/${encodeURIComponent(renameTarget.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: clean })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onNotify(err.message || '重命名文件夹失败');
        return;
      }
      await onRefreshSpace();
    } else {
      await mutateItem(renameTarget.kind, renameTarget.id, { action: 'rename', title: clean });
    }
    setRenameTarget(null);
  };

  const handleDeleteFolder = async (folderId: string) => {
    const target = folders.find((f) => f.id === folderId) ?? null;
    const res = await fetch(`/api/v2/space/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      if (activeFolderId === folderId) {
        setActiveFolderId(target?.parentFolderId ?? null);
      }
      await onRefreshSpace();
    } else {
      const err = await res.json().catch(() => ({}));
      onNotify(err.message || '删除文件夹失败');
    }
  };

  const handleAssociateTask = async (taskId: string) => {
    if (!thread?.id || !selection) return;
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}/space/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: selection.kind,
        id: selection.id,
        taskId,
        role: linkRole,
        resourceVersion:
          selection.kind === 'document' ? artifact?.headVersion ?? 1 : 1
      })
    });
    if (res.ok) {
      setLinkPickerOpen(false);
      await loadMaterialContext();
    } else {
      const err = await res.json().catch(() => ({}));
      onNotify(err.message || '关联任务失败');
    }
  };

  const handleUnlinkTask = async (linkId: string) => {
    const res = await fetch(`/api/v2/space/associations/${encodeURIComponent(linkId)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await loadMaterialContext();
    } else {
      const err = await res.json().catch(() => ({}));
      onNotify(err.message || '取消关联失败');
    }
  };

  const handlePurgeTrashItem = async (kind: SpaceItemKind, id: string) => {
    const res = await fetch(`/api/v2/space/items/${kind}/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      onNotify(err.message || '彻底删除失败');
      return;
    }
    setConfirmPurgeKey(null);
    setUndoTrash(null);
    await onRefreshSpace();
  };

  const buildQuoteChip = (item: SpaceItemView): SpaceReferenceChip => {
    if (item.kind === 'document') {
      return {
        id: item.id,
        kind: 'document',
        title: item.title,
        version: item.version ?? 1,
        subLabel: `v${item.version ?? 1}`,
        snippet: `参考文档《${item.title}》(id=${item.id}, v${item.version ?? 1})`
      };
    }
    if (item.kind === 'link') {
      return {
        id: item.id,
        kind: 'link',
        title: item.title,
        url: item.url,
        subLabel: '链接',
        snippet: `参考链接《${item.title}》(${item.url})`
      };
    }
    return {
      id: item.id,
      kind: 'file',
      title: item.title,
      subLabel: formatBytes(item.sizeBytes),
      snippet: `参考文件「${item.title}」(id=${item.id})`
    };
  };

  const searching = Boolean(query.trim() || kindFilter);
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (kindFilter && it.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        (it.excerpt || '').toLowerCase().includes(q) ||
        (it.url || '').toLowerCase().includes(q)
      );
    });
  }, [items, query, kindFilter]);

  const folderById = useMemo(() => {
    const map = new Map<string, SpaceFolderRecord>();
    for (const f of folders) map.set(f.id, f);
    return map;
  }, [folders]);

  const folderPathById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders) {
      const parts: string[] = [];
      const seen = new Set<string>();
      let cur: SpaceFolderRecord | undefined = f;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur.title);
        cur = cur.parentFolderId ? folderById.get(cur.parentFolderId) : undefined;
      }
      map.set(f.id, parts.join('/'));
    }
    return map;
  }, [folders, folderById]);

  const effectiveActiveFolderId = useMemo(
    () => (activeFolderId && folderById.has(activeFolderId) ? activeFolderId : null),
    [activeFolderId, folderById]
  );

  useEffect(() => {
    if (activeFolderId && !folderById.has(activeFolderId)) {
      setActiveFolderId(null);
    }
  }, [activeFolderId, folderById]);

  // Top section: strictly chronological (updatedAt DESC) across all folders so newly saved or edited items are found immediately.
  const recentItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const cmp = b.updatedAt.localeCompare(a.updatedAt);
      return cmp !== 0 ? cmp : b.createdAt.localeCompare(a.createdAt);
    });
  }, [items]);

  const childrenFoldersByParent = useMemo(() => {
    const map = new Map<string | null, SpaceFolderRecord[]>();
    for (const f of folders) {
      const parent = f.parentFolderId && folderById.has(f.parentFolderId) ? f.parentFolderId : null;
      const list = map.get(parent) ?? [];
      list.push(f);
      map.set(parent, list);
    }
    return map;
  }, [folders, folderById]);

  const breadcrumbs = useMemo(() => {
    const trail: SpaceFolderRecord[] = [];
    const seen = new Set<string>();
    let cur = effectiveActiveFolderId ? folderById.get(effectiveActiveFolderId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      trail.unshift(cur);
      cur = cur.parentFolderId ? folderById.get(cur.parentFolderId) : undefined;
    }
    return trail;
  }, [effectiveActiveFolderId, folderById]);

  const currentChildFolders = useMemo(
    () => childrenFoldersByParent.get(effectiveActiveFolderId) ?? [],
    [childrenFoldersByParent, effectiveActiveFolderId]
  );

  const currentFolderItems = useMemo(() => {
    return items
      .filter((it) => {
        const fid = it.folderId && folderById.has(it.folderId) ? it.folderId : null;
        return fid === effectiveActiveFolderId;
      })
      .sort((a, b) => {
        if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) {
          return a.pinnedAt ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [items, folderById, effectiveActiveFolderId]);

  const folderEntryCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of folders) {
      if (f.parentFolderId && folderById.has(f.parentFolderId)) {
        counts.set(f.parentFolderId, (counts.get(f.parentFolderId) ?? 0) + 1);
      }
    }
    for (const it of items) {
      if (it.folderId && folderById.has(it.folderId)) {
        counts.set(it.folderId, (counts.get(it.folderId) ?? 0) + 1);
      }
    }
    return counts;
  }, [folders, items, folderById]);

  const formatSpaceTime = (iso: string): string => {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const diffMs = Date.now() - ts;
    if (diffMs >= 0 && diffMs < 60_000) return '刚刚';
    if (diffMs >= 60_000 && diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}分钟前`;
    const d = new Date(ts);
    const now = new Date();
    const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return hhmm;
    }
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) {
      return `${mm}-${dd} ${hhmm}`;
    }
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  const filteredTasks = useMemo(() => {
    return threadTasks.filter((t) => {
      const rs = t.latestRun?.status;
      const done =
        rs === 'completed' || rs === 'failed' || rs === 'canceled' || t.status === 'completed';
      if (taskFilter === 'active') return !done;
      if (taskFilter === 'done') return done;
      return true;
    });
  }, [threadTasks, taskFilter]);

  const conflictVersionsCount = versions.filter((v) => v.branchKind === 'conflict_branch').length;

  const renderItemRow = (
    item: SpaceItemView,
    opts?: { showFolderChip?: boolean; showTime?: boolean; keyPrefix?: string }
  ) => {
    const Icon = itemIcon(item);
    const key = `${opts?.keyPrefix ?? 'dir'}:${item.kind}:${item.id}`;
    const menuOpen = rowMenuKey === key;
    const folderLabel = item.folderId ? folderPathById.get(item.folderId) || '' : '';
    const timeLabel = opts?.showTime !== false ? formatSpaceTime(item.updatedAt) : '';
    return (
      <div key={key} className="material-row" data-item-id={item.id} data-item-kind={item.kind}>
        <button
          type="button"
          onClick={() => {
            setDocEditing(false);
            onSelectItem({ kind: item.kind, id: item.id });
          }}
          className="material-item-open"
          title={`${item.title} · ${kindLabel(item)}${folderLabel ? ` · 目录：${folderLabel}` : ''}`}
        >
          <Icon size={15} />
          <span className="material-item-title">
            <span>
              {item.pinnedAt && (
                <span className="material-pin-badge" title="已置顶">
                  <Pin size={10} />
                </span>
              )}
              {item.title}
            </span>
            <span className="material-item-meta">
              <span>{kindLabel(item)}</span>
              {opts?.showFolderChip && folderLabel && (
                <span className="material-folder-chip" title={folderLabel}>
                  <Folder size={9} />
                  <span>{folderLabel}</span>
                </span>
              )}
              {item.taskId && <span>· 任务产物</span>}
              {timeLabel && <span>· {timeLabel}</span>}
            </span>
          </span>
        </button>

        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setRowMenuKey(menuOpen ? null : key)}
            className="material-row-menu"
            aria-label={`操作资料 ${item.title}`}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="chat-context-menu absolute right-0 top-full mt-1">
              <button
                type="button"
                onClick={() => {
                  setRowMenuKey(null);
                  void mutateItem(item.kind, item.id, { action: item.pinnedAt ? 'unpin' : 'pin' });
                }}
              >
                {item.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />}
                <span>{item.pinnedAt ? '取消置顶' : '置顶'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setRowMenuKey(null);
                  onQuoteToChat(buildQuoteChip(item));
                }}
              >
                <MessageSquare size={13} />
                <span>引用到对话</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setRowMenuKey(null);
                  setRenameTarget({ target: 'item', kind: item.kind, id: item.id, title: item.title });
                }}
              >
                <Pencil size={13} />
                <span>重命名</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setRowMenuKey(null);
                  setMoveTarget({ kind: item.kind, id: item.id, title: item.title, folderId: item.folderId });
                }}
              >
                <FolderInput size={13} />
                <span>移动到文件夹</span>
              </button>
              <button
                type="button"
                className="destructive"
                onClick={() => {
                  setRowMenuKey(null);
                  void mutateItem(item.kind, item.id, { action: 'delete' }, item.title);
                }}
              >
                <Trash2 size={13} />
                <span>移到回收站</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderFolderRow = (folder: SpaceFolderRecord): React.ReactNode => {
    const menuOpen = folderMenuId === folder.id;
    const entryCount = folderEntryCountById.get(folder.id) ?? 0;

    return (
      <div key={folder.id} className="material-folder-row relative" data-folder-id={folder.id}>
        <button
          type="button"
          onClick={() => setActiveFolderId(folder.id)}
          className="material-folder-open"
          title={`打开文件夹「${folder.title}」`}
        >
          <Folder size={15} />
          <span className="material-folder-name">{folder.title}</span>
          <span className="material-folder-count">{entryCount > 0 ? `${entryCount} 项` : '空'}</span>
          <ChevronRight size={13} className="material-folder-chevron" />
        </button>

        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setFolderMenuId(menuOpen ? null : folder.id)}
            className="material-row-menu"
            aria-label={`管理文件夹 ${folder.title}`}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="chat-context-menu absolute right-0 top-full mt-1">
              <button
                type="button"
                onClick={() => {
                  setFolderMenuId(null);
                  setActiveFolderId(folder.id);
                }}
              >
                <FolderOpen size={13} />
                <span>打开文件夹</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFolderMenuId(null);
                  setActiveFolderId(folder.id);
                  setCreateMode('document');
                  setDraftTitle('');
                  setDraftNote('');
                }}
              >
                <FileText size={13} />
                <span>在此新建文档</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFolderMenuId(null);
                  setActiveFolderId(folder.id);
                  setCreateMode('folder');
                  setDraftTitle('');
                }}
              >
                <Folder size={13} />
                <span>在此新建子文件夹</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFolderMenuId(null);
                  setRenameTarget({ target: 'folder', id: folder.id, title: folder.title });
                }}
              >
                <Pencil size={13} />
                <span>重命名文件夹</span>
              </button>
              <button
                type="button"
                className="destructive"
                onClick={() => {
                  setFolderMenuId(null);
                  void handleDeleteFolder(folder.id);
                }}
              >
                <Trash2 size={13} />
                <span>删除文件夹</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderContextSection = () => {
    if (!selection) return null;
    const linkedTasks = materialContext?.tasks ?? [];
    const sources = materialContext?.sources ?? [];
    return (
      <div className="material-context">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setContextOpen((o) => !o)}
            className="inline-flex items-center gap-1 font-semibold"
            style={{ color: '#4f627f' }}
          >
            {contextOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>关联任务与来源 ({linkedTasks.length + sources.length})</span>
          </button>
          {threadTasks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setContextOpen(true);
                setLinkPickerOpen((v) => !v);
              }}
              className="dw-btn dw-btn-outline dw-btn-sm"
              style={{ height: 24, fontSize: 11, padding: '0 8px' }}
            >
              <Plus size={11} />
              <span>关联任务</span>
            </button>
          )}
        </div>

        {linkPickerOpen && (
          <div className="material-associate-form p-2.5 rounded-lg border" style={{ borderColor: '#dce3f0', background: '#fff' }}>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[11px]" style={{ color: '#8795aa' }}>关系：</span>
              {(['input', 'output', 'reference'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setLinkRole(r)}
                  className={`task-overview-state ${linkRole === r ? ROLE_META[r].badgeClass : ''}`}
                  style={linkRole === r ? { outline: '1.5px solid #416ee6' } : undefined}
                >
                  {ROLE_META[r].label}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
              {threadTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void handleAssociateTask(t.id)}
                  className="text-left px-2 py-1 rounded border text-xs truncate hover:bg-[#f2f6ff]"
                  style={{ borderColor: '#e5ebf4' }}
                >
                  {t.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {contextOpen && (
          <>
            {linkedTasks.length === 0 && sources.length === 0 ? (
              <p className="mt-2">暂未绑定任务，点击右上角“关联任务”可标记为输入材料或成果。</p>
            ) : (
              <>
                {linkedTasks.length > 0 && (
                  <div className="material-context-tasks">
                    {linkedTasks.map((lk) => {
                      const meta = ROLE_META[lk.role] || ROLE_META.reference;
                      return (
                        <div key={lk.id}>
                          <button type="button" onClick={() => onOpenTask(lk.taskId)}>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`task-overview-state ${meta.badgeClass}`}>{meta.label}</span>
                              {lk.versionChanged && (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px]"
                                  style={{ color: '#b77824' }}
                                >
                                  <AlertTriangle size={10} />
                                  <span>v{lk.resourceVersion}→v{lk.currentVersion}</span>
                                </span>
                              )}
                            </div>
                            <strong className="block mt-1 text-xs">{lk.taskTitle}</strong>
                          </button>
                          {lk.origin === 'manual' && (
                            <button
                              type="button"
                              onClick={() => void handleUnlinkTask(lk.id)}
                              className="material-unlink"
                              aria-label={`取消关联 ${lk.taskTitle}`}
                            >
                              取消关联
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {sources.length > 0 && (
                  <div className="material-source-history">
                    {sources.map((src) => (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => {
                          if (onFocusChat) {
                            onFocusChat();
                          } else {
                            onSelectItem(null);
                          }
                        }}
                        title="回到左侧对话区域"
                      >
                        <small>
                          来源消息 · {src.authorKind === 'user' ? '你' : memberById.get(src.authorId)?.name || src.authorId} ·{' '}
                          {new Date(src.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </small>
                        <span>{src.body}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <aside
      aria-label="协作空间"
      onClick={() => {
        setFilterMenuOpen(false);
        setAddMenuOpen(false);
        setRowMenuKey(null);
        setFolderMenuId(null);
        setHistoryMenuOpen(false);
      }}
      onDragEnter={(e) => {
        if (tab === 'documents' && !selection && !showTrash) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (tab === 'documents' && !selection && !showTrash) {
          e.preventDefault();
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDrop={(e) => void handleDropFiles(e)}
      className={`collaboration-space space-redesign ${wideSpace ? 'space-expanded' : ''}`}
    >
      {dragging && (
        <div
          className="absolute inset-2 z-50 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 pointer-events-none"
          style={{
            borderColor: '#355cc9',
            backgroundColor: '#edf2ff',
            color: '#355cc9'
          }}
        >
          <UploadCloud size={28} />
          <span className="text-xs font-semibold">松手上传到当前协作空间</span>
        </div>
      )}

      {/* Top Bar */}
      <div className="space-title">
        <div className="space-navigation">
          {selection || showTrash ? (
            <button
              type="button"
              onClick={() => {
                onSelectItem(null);
                setShowTrash(false);
              }}
              className="space-back"
            >
              <ArrowLeft size={14} />
              <span>返回列表</span>
            </button>
          ) : (
            <strong>协作空间</strong>
          )}
        </div>

        <div className="space-window-actions">
          <button
            type="button"
            onClick={onToggleWide}
            aria-label={wideSpace ? '标准协作空间宽度' : '展开协作空间宽度'}
            title={wideSpace ? '标准宽度' : '宽屏显示'}
          >
            {wideSpace ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={onCloseSpace}
            aria-label="收起协作空间"
            title="收起协作空间"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Category Tabs */}
      {!selection && !showTrash && (
        <nav aria-label="协作空间分类" className="space-tabs">
          {([
            ['documents', `资料${items.length > 0 ? ` (${items.length})` : ''}`],
            ['tasks', `任务${threadTasks.length > 0 ? ` (${threadTasks.length})` : ''}`],
            ['resources', '资源']
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onTabChange(key)}
              className={tab === key ? 'active' : ''}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {/* Undo Trash & Error/Notice Banners */}
      {docNotice && selection?.kind !== 'document' && (
        <div className="space-undo" role="status">
          <span>{docNotice}</span>
        </div>
      )}
      {undoTrash && (
        <div className="space-undo">
          <span>已移入回收站：{undoTrash.title}</span>
          <button
            type="button"
            onClick={() => void mutateItem(undoTrash.kind, undoTrash.id, { action: 'restore' })}
            className="font-semibold underline"
          >
            撤销
          </button>
        </div>
      )}

      {/* Content Area */}
      <div className="space-content">
        {showTrash ? (
          <div>
            <div className="space-recycle-heading">
              <Trash2 size={15} />
              <h2>回收站 ({trash.length})</h2>
            </div>
            {trash.length === 0 ? (
              <div className="space-blank">
                <span><Trash2 size={20} /></span>
                <strong>回收站为空</strong>
                <p>移出列表的资料会暂存于此并可随时恢复。</p>
              </div>
            ) : (
              trash.map((it) => {
                const trashKey = `${it.kind}:${it.id}`;
                const confirming = confirmPurgeKey === trashKey;
                return (
                  <div key={trashKey} className="space-trash-row">
                    <span>
                      <strong>{it.title}</strong>
                      <small>{kindLabel(it)}</small>
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void mutateItem(it.kind, it.id, { action: 'restore' })}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                      >
                        <RotateCcw size={12} />
                        <span>恢复</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirming) {
                            void handlePurgeTrashItem(it.kind, it.id);
                          } else {
                            setConfirmPurgeKey(trashKey);
                          }
                        }}
                        className="dw-btn dw-btn-outline dw-btn-sm"
                        style={confirming ? { borderColor: '#be4343', color: '#be4343' } : { color: '#a75229' }}
                      >
                        <Trash2 size={12} />
                        <span>{confirming ? '确认删除' : '彻底删除'}</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : selection?.kind === 'document' && artifact?.id !== selection.id ? (
          <p role="status">{docNotice || '正在加载文稿…'}</p>
        ) : selection?.kind === 'document' ? (
          <div className="flex flex-col h-full min-h-0">
            <div className="space-detail-heading">
              <div className="flex items-center justify-between gap-2">
                <small>文档 · v{artifact?.headVersion ?? 1}{conflictVersionsCount > 0 ? ` · ${conflictVersionsCount} 份冲突保留稿` : ''}</small>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDocEditing(false)}
                    className={!docEditing ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                    style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocEditing(true)}
                    className={docEditing ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                    style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                  >
                    编辑
                  </button>
                </div>
              </div>
              <h2>{artifact?.title || selectedItem?.title || '文档详情'}</h2>
              {docNotice && <span>{docNotice}</span>}
            </div>

            <div className="space-detail-actions">
              {selectedItem && (
                <button
                  type="button"
                  onClick={() => onQuoteToChat(buildQuoteChip(selectedItem))}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                >
                  <Quote size={11} />
                  <span>引用到对话</span>
                </button>
              )}
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => setHistoryMenuOpen((o) => !o)}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                >
                  <History size={11} />
                  <span>版本 ({versions.length})</span>
                </button>
                {historyMenuOpen && (
                  <div className="chat-context-menu absolute left-0 top-full mt-1 w-60 max-h-60 overflow-y-auto">
                    {versions.map((ver) => (
                      <button
                        key={ver.id}
                        type="button"
                        onClick={() => {
                          onSelectVersion(ver.content);
                          setHistoryMenuOpen(false);
                        }}
                        className="flex-col items-start gap-0.5"
                      >
                        <strong>
                          v{ver.version} · {ver.branchKind === 'conflict_branch' ? '冲突保留稿' : '主稿'}
                        </strong>
                        <small>
                          写入者：{ver.writerKind === 'user' ? '你' : memberById.get(ver.writerId)?.name || ver.writerId}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" onClick={onCopyArtifact} className="dw-btn dw-btn-outline dw-btn-sm">
                <Copy size={11} />
                <span>复制</span>
              </button>
              <button type="button" onClick={onExportArtifact} className="dw-btn dw-btn-outline dw-btn-sm">
                <Download size={11} />
                <span>导出</span>
              </button>
              <button type="button" onClick={onSaveArtifact} className="dw-btn dw-btn-outline dw-btn-sm">
                保存修改
              </button>
              <button type="button" onClick={onSendArtifactBackToOriginChat} className="dw-btn dw-btn-primary dw-btn-sm">
                发回原对话继续改
              </button>
              {artifact && (
                <button
                  type="button"
                  onClick={() => void mutateItem('document', artifact.id, { action: 'delete' }, artifact.title)}
                  className="dw-btn dw-btn-outline dw-btn-sm ml-auto"
                  style={{ color: '#a75229' }}
                >
                  <Trash2 size={11} />
                  <span>移到回收站</span>
                </button>
              )}
            </div>

            {docEditing ? (
              <textarea
                value={docDraft}
                onChange={(e) => setDocDraft(e.target.value)}
                aria-label="文稿编辑器"
                className="dw-textarea flex-1 min-h-[220px] font-mono text-xs"
              />
            ) : (
              <div className="space-prose flex-1 min-h-[200px] overflow-y-auto pr-1">
                <MarkdownView
                  text={docDraft}
                  imageActions={{
                    onDownloadLocal: (src, alt) => {
                      const href = src.startsWith('/api/v2/')
                        ? `${src}${src.includes('?') ? '&' : '?'}download=1`
                        : `/api/v2/media/download?url=${encodeURIComponent(src)}${alt ? `&name=${encodeURIComponent(alt)}` : ''}`;
                      const a = document.createElement('a');
                      a.href = href;
                      a.download = alt || 'image';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }
                  }}
                />
              </div>
            )}

            {renderContextSection()}
          </div>
        ) : selection?.kind === 'file' && selectedItem ? (
          <div className="flex flex-col gap-3">
            <div className="space-detail-heading">
              <small>{kindLabel(selectedItem)}</small>
              <h2>{selectedItem.title}</h2>
              <span>上传于 {new Date(selectedItem.createdAt).toLocaleString('zh-CN')}</span>
            </div>

            {selectedItem.previewKind === 'image' && (
              <div className="shared-media-preview large">
                <img src={`/api/v2/space/files/${encodeURIComponent(selectedItem.id)}`} alt={selectedItem.title} />
              </div>
            )}
            {selectedItem.previewKind === 'video' && (
              <div className="shared-media-preview large">
                <video src={`/api/v2/space/files/${encodeURIComponent(selectedItem.id)}`} controls />
              </div>
            )}
            {selectedItem.previewKind === 'audio' && (
              <audio src={`/api/v2/space/files/${encodeURIComponent(selectedItem.id)}`} controls className="w-full" />
            )}
            {selectedItem.previewKind === 'pdf' && (
              <iframe
                src={`/api/v2/space/files/${encodeURIComponent(selectedItem.id)}`}
                title={selectedItem.title}
                className="material-pdf-frame"
              />
            )}
            {selectedItem.previewKind === 'text' && (() => {
              const isHtmlFile =
                /\.html?$/i.test(selectedItem.title || '') ||
                (selectedItem.mimeType || '').includes('text/html');
              if (isHtmlFile) {
                return (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setHtmlPreviewMode('render')}
                        className={htmlPreviewMode === 'render' ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                        style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                      >
                        网页预览
                      </button>
                      <button
                        type="button"
                        onClick={() => setHtmlPreviewMode('source')}
                        className={htmlPreviewMode === 'source' ? 'dw-btn dw-btn-primary dw-btn-sm' : 'dw-btn dw-btn-outline dw-btn-sm'}
                        style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                      >
                        源码
                      </button>
                    </div>
                    {fileTextState === 'loading' ? (
                      <pre className="material-file-text">正在读取网页内容…</pre>
                    ) : fileTextState === 'error' ? (
                      <pre className="material-file-text">读取网页内容失败</pre>
                    ) : htmlPreviewMode === 'render' ? (
                      <iframe
                        sandbox=""
                        srcDoc={fileTextPreview}
                        title={selectedItem.title}
                        className="material-pdf-frame"
                      />
                    ) : (
                      <pre className="material-file-text">{fileTextPreview || '(空文件)'}</pre>
                    )}
                  </div>
                );
              }
              return (
                <pre className="material-file-text">
                  {fileTextState === 'loading'
                    ? '正在读取文件内容…'
                    : fileTextState === 'error'
                      ? '读取文件内容失败'
                      : fileTextPreview || '(空文件)'}
                </pre>
              );
            })()}
            {selectedItem.previewKind === 'binary' && (
              <div className="shared-file-meta">
                <File size={22} />
                <div>
                  <strong>{selectedItem.title}</strong>
                  <p>此格式保留原件，可下载后使用对应应用打开。</p>
                </div>
              </div>
            )}

            <div className="space-detail-actions">
              <button
                type="button"
                onClick={() => onQuoteToChat(buildQuoteChip(selectedItem))}
                className="dw-btn dw-btn-outline dw-btn-sm"
              >
                <MessageSquare size={12} />
                <span>引用到对话</span>
              </button>
              <a
                href={`/api/v2/space/files/${encodeURIComponent(selectedItem.id)}?download=1`}
                download={selectedItem.title}
                className="dw-btn dw-btn-primary dw-btn-sm"
              >
                <Download size={12} />
                <span>下载原件</span>
              </a>
              <button
                type="button"
                onClick={() => void mutateItem('file', selectedItem.id, { action: 'delete' }, selectedItem.title)}
                className="dw-btn dw-btn-outline dw-btn-sm ml-auto"
                style={{ color: '#a75229' }}
              >
                <Trash2 size={12} />
                <span>移到回收站</span>
              </button>
            </div>

            {renderContextSection()}
          </div>
        ) : selection?.kind === 'link' && selectedItem ? (
          <div className="flex flex-col gap-3">
            <div className="space-detail-heading">
              <small>外部链接</small>
              <h2>{selectedItem.title}</h2>
            </div>
            <a href={selectedItem.url} target="_blank" rel="noreferrer" className="shared-ref flex items-center justify-between gap-2">
              <span className="truncate">{selectedItem.url}</span>
              <ArrowUpRight size={14} />
            </a>
            {selectedItem.note && <p className="space-muted">{selectedItem.note}</p>}
            <div className="space-detail-actions">
              <button
                type="button"
                onClick={() => onQuoteToChat(buildQuoteChip(selectedItem))}
                className="dw-btn dw-btn-outline dw-btn-sm"
              >
                <MessageSquare size={12} />
                <span>引用到对话</span>
              </button>
              <a href={selectedItem.url} target="_blank" rel="noreferrer" className="dw-btn dw-btn-primary dw-btn-sm">
                <ExternalLink size={12} />
                <span>打开链接</span>
              </a>
              <button
                type="button"
                onClick={() => void mutateItem('link', selectedItem.id, { action: 'delete' }, selectedItem.title)}
                className="dw-btn dw-btn-outline dw-btn-sm ml-auto"
                style={{ color: '#a75229' }}
              >
                <Trash2 size={12} />
                <span>移除</span>
              </button>
            </div>

            {renderContextSection()}
          </div>
        ) : tab === 'documents' ? (
          <div className="material-library flex flex-col min-h-full">
            <div className="space-toolbar">
              <label className="space-search">
                <Search size={13} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索资料…"
                  aria-label="搜索协作空间资料"
                />
              </label>

              <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void handleUploadFiles(e)} />
              <button
                type="button"
                disabled={!thread || uploading}
                onClick={() => fileInputRef.current?.click()}
                className="dw-btn dw-btn-outline"
                aria-label="上传文件"
                title={uploading ? '上传中…' : '上传本地文件'}
              >
                <Paperclip size={14} />
              </button>

              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => {
                    setFilterMenuOpen((o) => !o);
                    setAddMenuOpen(false);
                  }}
                  className="dw-btn dw-btn-outline"
                  style={kindFilter ? { borderColor: '#355cc9', color: '#355cc9' } : undefined}
                  aria-label="筛选资料类型"
                >
                  <SlidersHorizontal size={14} />
                </button>
                {filterMenuOpen && (
                  <div className="chat-context-menu absolute right-0 top-full mt-1">
                    {([
                      ['', '全部类型'],
                      ['document', '文档'],
                      ['file', '文件'],
                      ['link', '外部链接']
                    ] as const).map(([val, label]) => (
                      <button
                        key={val || 'all'}
                        type="button"
                        onClick={() => {
                          setKindFilter(val);
                          setFilterMenuOpen(false);
                        }}
                      >
                        <span className="flex-1 text-left">{label}</span>
                        {kindFilter === val && <Check size={12} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  disabled={!thread}
                  onClick={() => {
                    setAddMenuOpen((o) => !o);
                    setFilterMenuOpen(false);
                  }}
                  className="dw-btn dw-btn-outline"
                  aria-label="添加资料"
                >
                  <Plus size={14} />
                </button>
                {addMenuOpen && (
                  <div className="chat-context-menu absolute right-0 top-full mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setAddMenuOpen(false);
                        setCreateMode('document');
                        setDraftTitle('');
                        setDraftNote('');
                      }}
                    >
                      <FileText size={13} />
                      <span>新建文档</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddMenuOpen(false);
                        setCreateMode('link');
                        setDraftTitle('');
                        setDraftUrl('https://');
                        setDraftNote('');
                      }}
                    >
                      <Link2 size={13} />
                      <span>添加链接</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddMenuOpen(false);
                        setCreateMode('folder');
                        setDraftTitle('');
                      }}
                    >
                      <Folder size={13} />
                      <span>新建文件夹</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {createMode && (
              <form
                onSubmit={handleCreateSubmit}
                className="mb-3 rounded-xl border p-3 flex flex-col gap-2 text-xs dw-inline-panel"
              >
                <div className="font-semibold">
                  {createMode === 'document' ? '新建文档' : createMode === 'link' ? '添加链接' : '新建文件夹'}
                  {effectiveActiveFolderId
                    ? `（在 /${folderPathById.get(effectiveActiveFolderId) || '当前目录'}）`
                    : ''}
                </div>
                <input
                  type="text"
                  required
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder={
                    createMode === 'document'
                      ? '文档名称（如：产品方案.md）'
                      : createMode === 'link'
                        ? '链接标题'
                        : '文件夹名称'
                  }
                  className="dw-input"
                />
                {createMode === 'link' && (
                  <input
                    type="url"
                    required
                    value={draftUrl}
                    onChange={(e) => setDraftUrl(e.target.value)}
                    placeholder="https://..."
                    className="dw-input"
                  />
                )}
                {createMode !== 'folder' && (
                  <textarea
                    rows={createMode === 'document' ? 3 : 2}
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder={createMode === 'document' ? '初始正文内容（可选）' : '备注说明（可选）'}
                    className="dw-textarea"
                  />
                )}
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => setCreateMode(null)} className="dw-btn dw-btn-outline dw-btn-sm">
                    取消
                  </button>
                  <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                    确认
                  </button>
                </div>
              </form>
            )}

            {renameTarget && (
              <form
                onSubmit={handleRenameConfirm}
                className="mb-3 rounded-xl border p-3 flex flex-col gap-2 text-xs dw-inline-panel"
              >
                <div className="font-semibold">重命名</div>
                <input
                  type="text"
                  required
                  value={renameTarget.title}
                  onChange={(e) => setRenameTarget({ ...renameTarget, title: e.target.value })}
                  className="dw-input"
                />
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => setRenameTarget(null)} className="dw-btn dw-btn-outline dw-btn-sm">
                    取消
                  </button>
                  <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                    保存
                  </button>
                </div>
              </form>
            )}

            {moveTarget && (
              <div
                className="mb-3 rounded-xl border p-3 flex flex-col gap-1.5 text-xs dw-inline-panel"
              >
                <div className="font-semibold">移动「{moveTarget.title}」到目录</div>
                <button
                  type="button"
                  onClick={() => {
                    void mutateItem(moveTarget.kind, moveTarget.id, { action: 'move', folderId: null });
                    setMoveTarget(null);
                  }}
                  className="dw-btn dw-btn-outline dw-btn-sm justify-start"
                >
                  / 根目录
                </button>
                {folders.map((fld) => (
                  <button
                    key={fld.id}
                    type="button"
                    onClick={() => {
                      void mutateItem(moveTarget.kind, moveTarget.id, { action: 'move', folderId: fld.id });
                      setMoveTarget(null);
                    }}
                    className="dw-btn dw-btn-outline dw-btn-sm justify-start truncate"
                  >
                    / {folderPathById.get(fld.id) || fld.title}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setMoveTarget(null)}
                  className="dw-btn dw-btn-ghost dw-btn-sm self-end"
                >
                  取消
                </button>
              </div>
            )}

            {props.materialsState !== 'ready' && thread ? (
              <div className="space-blank my-auto" role="status">
                {props.materialsState === 'error' ? (
                  <><strong>资料加载失败</strong><button className="dw-btn" onClick={() => void onRefreshSpace()}>重新加载资料</button></>
                ) : <strong>正在加载资料…</strong>}
              </div>
            ) : searching ? (
              <div>
                <div className="material-section-heading">
                  <h4>搜索结果 ({filteredItems.length})</h4>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setKindFilter('');
                    }}
                  >
                    清除筛选
                  </button>
                </div>
                {filteredItems.length === 0 ? (
                  <p className="material-list-empty">没有找到匹配资料</p>
                ) : (
                  filteredItems.map((it) =>
                    renderItemRow(it, { showFolderChip: true, showTime: true, keyPrefix: 'search' })
                  )
                )}
              </div>
            ) : items.length === 0 && folders.length === 0 ? (
              <div className="space-blank my-auto">
                <span><FolderOpen size={20} /></span>
                <strong>还没有资料</strong>
                <p>拖拽任意格式文件到此处、点击 + 新建文档或文件夹；Agent 产出的文件与目录也会自动归档到这里。</p>
              </div>
            ) : (
              <div>
                {/* Top section: chronological recent updates (saved or edited) */}
                {recentItems.length > 0 && (
                  <section className="material-shortcuts" data-testid="space-recent-section" aria-label="最近更新">
                    <div className="material-section-title">
                      <Clock size={11} />
                      <span>最近更新 ({recentItems.length})</span>
                      {recentItems.length > 6 && (
                        <button
                          type="button"
                          onClick={() => setExpandedRecent((v) => !v)}
                          className="material-section-toggle"
                        >
                          {expandedRecent ? '收起' : `查看全部`}
                        </button>
                      )}
                    </div>
                    <div className={`material-recent-list ${expandedRecent ? 'expanded' : ''}`}>
                      {(expandedRecent ? recentItems : recentItems.slice(0, 6)).map((it) =>
                        renderItemRow(it, { showFolderChip: true, showTime: true, keyPrefix: 'recent' })
                      )}
                    </div>
                  </section>
                )}

                {/* Bottom section: drill-down document & folder manager */}
                <section
                  className={recentItems.length > 0 ? 'material-directory' : ''}
                  data-testid="space-manager-section"
                  aria-label="文档管理"
                >
                  <div className="material-section-heading">
                    <span className="material-root-select active">
                      <FolderOpen size={12} />
                      <span>文档管理</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMode('folder');
                        setDraftTitle('');
                      }}
                      title={effectiveActiveFolderId ? '在当前目录下新建子文件夹' : '在根目录新建文件夹'}
                    >
                      + 新建文件夹
                    </button>
                  </div>

                  {effectiveActiveFolderId && (
                    <div className="material-explorer-nav" data-testid="space-folder-nav">
                      <button
                        type="button"
                        onClick={() => {
                          const cur = folderById.get(effectiveActiveFolderId);
                          setActiveFolderId(cur?.parentFolderId ?? null);
                        }}
                        className="material-explorer-back"
                        aria-label="返回上一级文件夹"
                      >
                        <ArrowLeft size={12} />
                        <span>返回上级</span>
                      </button>
                      <div className="material-breadcrumbs" aria-label="当前文件夹路径">
                        <button
                          type="button"
                          onClick={() => setActiveFolderId(null)}
                          className="material-breadcrumb-btn"
                        >
                          根目录
                        </button>
                        {breadcrumbs.map((crumb, idx) => {
                          const isLast = idx === breadcrumbs.length - 1;
                          return (
                            <React.Fragment key={crumb.id}>
                              <span>/</span>
                              <button
                                type="button"
                                onClick={() => setActiveFolderId(crumb.id)}
                                className={`material-breadcrumb-btn ${isLast ? 'current' : ''}`}
                                title={crumb.title}
                              >
                                {crumb.title}
                              </button>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {currentChildFolders.map((fld) => renderFolderRow(fld))}
                  {currentFolderItems.map((it) =>
                    renderItemRow(it, { showFolderChip: false, showTime: true, keyPrefix: 'dir' })
                  )}

                  {currentChildFolders.length === 0 && currentFolderItems.length === 0 && (
                    <div className="material-folder-empty">
                      <span>{effectiveActiveFolderId ? '当前文件夹为空' : '根目录暂无未归档文件'}</span>
                      <div className="material-folder-empty-actions">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <Paperclip size={11} />
                          <span>上传文件</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCreateMode('document');
                            setDraftTitle('');
                            setDraftNote('');
                          }}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <FileText size={11} />
                          <span>新建文档</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCreateMode('folder');
                            setDraftTitle('');
                          }}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <Folder size={11} />
                          <span>新建文件夹</span>
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}

            <div className="mt-auto">
              <button type="button" onClick={() => setShowTrash(true)} className="material-trash">
                <Trash2 size={12} />
                <span>回收站{trash.length > 0 ? ` (${trash.length})` : ''}</span>
              </button>
            </div>
          </div>
        ) : tab === 'tasks' ? (
          <div className="task-overview">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="space-filters" style={{ margin: 0 }}>
                {([
                  ['active', '进行中'],
                  ['done', '已完成'],
                  ['all', '全部']
                ] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setTaskFilter(val)}
                    className={taskFilter === val ? 'active' : ''}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={onOpenCreateTask} className="dw-btn dw-btn-outline dw-btn-sm">
                <Plus size={12} />
                <span>指派任务</span>
              </button>
            </div>

            {filteredTasks.length === 0 ? (
              <div className="space-blank">
                <span><ListTodo size={20} /></span>
                <strong>暂无匹配的本对话任务</strong>
                <p>点击“指派任务”或在对话里和负责人约定分工即可立项执行。</p>
              </div>
            ) : (
              filteredTasks.map((t) => {
                const leadName = memberById.get(t.leadMemberId)?.name || t.leadMemberId;
                const runStatus = t.latestRun?.status;
                const stateClass =
                  runStatus === 'completed'
                    ? 'done'
                    : runStatus === 'waiting_user' ||
                        runStatus === 'timed_out' ||
                        runStatus === 'failed'
                      ? 'attention'
                      : runStatus === 'canceled' || (!runStatus && t.kind === 'scheduled' && !t.scheduleEnabled)
                        ? ''
                        : 'working';
                const statusLabel = !runStatus
                  ? t.kind === 'scheduled'
                    ? t.scheduleEnabled
                      ? '等待定时触发'
                      : '已暂停'
                    : '待启动'
                  : runStatus === 'completed'
                    ? t.kind === 'scheduled' && t.latestRun
                      ? `第 ${t.latestRun.runNumber} 期已完成`
                      : '已完成'
                    : runStatus === 'waiting_user'
                      ? '待你确认'
                      : runStatus === 'failed'
                        ? '执行失败'
                        : runStatus === 'timed_out'
                          ? '超时未完成'
                          : runStatus === 'canceled'
                            ? '已取消'
                            : '进行中';
                return (
                  <div key={t.id} className="task-group">
                    <div className="task-group-heading">
                      <button type="button" onClick={() => onOpenTask(t.id)} className="task-group-title">
                        <strong className="flex items-center gap-1">
                          {t.kind === 'scheduled' && <Clock size={12} />}
                          <span>{t.title}</span>
                        </strong>
                        <small>
                          {leadName} 负责{t.kind === 'scheduled' && t.cronExpr ? ` · ${t.cronExpr}` : ''}
                        </small>
                      </button>
                      <span className={`task-overview-state ${stateClass}`}>{statusLabel}</span>
                    </div>

                    {t.steps && t.steps.length > 0 && (
                      <div className="task-children">
                        {t.steps.map((st) => (
                          <div key={st.id} className="task-child">
                            <div className="task-child-open">
                              <span
                                className={`task-step-icon ${
                                  st.status === 'accepted'
                                    ? 'done'
                                    : st.status === 'running'
                                      ? 'working'
                                      : st.status === 'blocked' || st.status === 'failed' || st.status === 'timed_out'
                                        ? 'attention'
                                        : ''
                                }`}
                              >
                                •
                              </span>
                              <span>
                                <strong>{st.stepOrder}. {st.title}</strong>
                                <small>{memberById.get(st.assigneeMemberId)?.name || st.assigneeMemberId}</small>
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="task-artifacts">
                      {t.latestRun?.finalArtifactId && (
                        <button
                          type="button"
                          onClick={() => {
                            setDocEditing(false);
                            onSelectItem({ kind: 'document', id: t.latestRun!.finalArtifactId! });
                          }}
                          className="task-artifact"
                        >
                          <FileText size={13} />
                          <span>查看交付产物</span>
                          <small>正文</small>
                        </button>
                      )}
                      <button type="button" onClick={() => onOpenTask(t.id)} className="task-discuss" style={{ padding: '4px 2px' }}>
                        查看步骤详情 →
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (() => {
          const activeOwner = members.find((m) => m.id === thread?.activeOwnerMemberId) ?? null;
          const isLocalOwner = isLocalCodingMember(activeOwner);
          return (
          <div className="channel-resources">
            <div className="resource-section">
              <h3>
                <span>本机工作目录</span>
                <button type="button" onClick={() => void onChooseWorkspace()}>
                  {hasDesktopDialog ? (thread?.workspacePath ? '更换目录' : '选择目录') : '设置路径'}
                </button>
              </h3>
              <div className="resource-folder">
                <FolderOpen size={14} />
                <span className="flex-1 min-w-0 truncate">
                  {thread?.workspacePath || '尚未绑定本机工作目录'}
                </span>
                {hasDesktopDialog && (
                  <button
                    type="button"
                    onClick={() => {
                      setWsPathInput(thread?.workspacePath || '');
                      setEditingWsPath((v) => !v);
                    }}
                    className="text-[11px]"
                    style={{ color: '#4c70c4' }}
                  >
                    手动输入
                  </button>
                )}
              </div>
              {!isLocalOwner && (
                <small className="block text-[10.5px] mt-1.5" style={{ color: '#8795aa' }}>
                  提示：当前对接成员为远端/Web，本地目录仅本机编码成员（如 Codex / Claude）可直接读写。
                </small>
              )}

              {editingWsPath && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setEditingWsPath(false);
                    void onSaveWorkspacePath(wsPathInput.trim() || null);
                  }}
                  className="flex items-center gap-1.5 mt-2"
                >
                  <input
                    type="text"
                    value={wsPathInput}
                    onChange={(e) => setWsPathInput(e.target.value)}
                    placeholder="输入目录绝对路径"
                    className="dw-input"
                  />
                  <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                    确定
                  </button>
                </form>
              )}

              {thread?.workspacePath && (
                <div className="resource-group mt-2 p-2.5">
                  <div className="flex items-center justify-between text-[11px] mb-1.5" style={{ color: '#8391a7' }}>
                    <span className="truncate">/{wsSubpath}</span>
                    <div className="flex items-center gap-2">
                      {wsSubpath && (
                        <button
                          type="button"
                          onClick={() => {
                            const parts = wsSubpath.split('/').filter(Boolean);
                            parts.pop();
                            void loadWorkspaceFiles(parts.join('/'));
                          }}
                          className="underline"
                        >
                          上级目录
                        </button>
                      )}
                      <button type="button" onClick={() => void loadWorkspaceFiles(wsSubpath)} className="underline">
                        刷新
                      </button>
                    </div>
                  </div>
                  {wsError ? (
                    <div className="text-[11px]" style={{ color: '#b77824' }}>{wsError}</div>
                  ) : wsBusy ? (
                    <div className="text-[11px]" style={{ color: '#8391a7' }}>读取目录中…</div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                      {wsEntries.map((ent) => (
                        <div key={ent.relPath} className="material-row">
                          <button
                            type="button"
                            onClick={() => {
                              if (ent.kind === 'dir') {
                                void loadWorkspaceFiles(ent.relPath);
                              } else {
                                onQuoteToChat({
                                  id: ent.relPath,
                                  kind: 'workspace_file',
                                  title: ent.name,
                                  subLabel: formatBytes(ent.sizeBytes),
                                  snippet: `请查看文件 ${ent.relPath}`
                                });
                              }
                            }}
                            className="material-item-open"
                          >
                            {ent.kind === 'dir' ? <Folder size={13} /> : <File size={13} />}
                            <span className="material-item-title truncate">{ent.name}</span>
                          </button>
                          <span className="text-[10px] pr-2 self-center" style={{ color: '#94a1b5' }}>
                            {ent.kind === 'file' ? formatBytes(ent.sizeBytes) : '目录'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="resource-section">
              <h3>
                <span>DuolaBase 连接与凭证</span>
                <button type="button" onClick={() => onNavigatePage('connectors')}>
                  管理连接器
                </button>
              </h3>
              <div className="resource-group">
                <div className="resource-row">
                  <span className="connector-symbol">
                    <Plug size={15} />
                  </span>
                  <div className="resource-row-main">
                    <strong>DuolaBase MCP 网关</strong>
                    <small className={duolabaseStatus.enabled && duolabaseStatus.hasToken ? 'resource-ready' : ''}>
                      {!duolabaseStatus.enabled
                        ? '已暂停连接'
                        : duolabaseStatus.hasToken
                          ? `已连通 (${duolabaseStatus.endpoint})`
                          : '尚未配置访问令牌'}
                    </small>
                  </div>
                  <button
                    type="button"
                    aria-label="切换 DuolaBase 状态"
                    onClick={() => void onToggleDuolabase()}
                    className={`resource-toggle ${duolabaseStatus.enabled ? 'on' : ''}`}
                  >
                    <span />
                  </button>
                </div>
                {duolabaseStatus.enabled && duolabaseStatus.hasToken && (resBusy || resSummary) && (
                  <div className="px-3 pb-2.5 pt-1 border-t" style={{ borderColor: '#edf1f7' }}>
                    <div className="text-[11px]" style={{ color: '#6b7a90' }}>
                      {resBusy && !resSummary
                        ? '正在读取实时连接器与凭证统计…'
                        : resSummary
                          ? `已接入 ${resSummary.connectorCount} 个连接器 · ${resSummary.vaultCount ?? '—'} 条 Vault 凭证`
                          : null}
                    </div>
                    {resSummary && resSummary.activeConnectors.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {resSummary.activeConnectors.map((c) => (
                          <button
                            key={c.id || c.name}
                            type="button"
                            onClick={() => onNavigatePage('connectors')}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] hover:bg-[#f2f6ff]"
                            style={{ borderColor: '#e2e8f2', color: '#395175' }}
                            title={c.toolCount ? `${c.toolCount} 个可用工具` : undefined}
                          >
                            <Plug size={10} />
                            <span className="truncate max-w-[140px]">{c.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => onNavigatePage('connectors')} className="dw-btn dw-btn-outline dw-btn-sm flex-1">
                  <Plug size={12} />
                  <span>连接器</span>
                </button>
                <button type="button" onClick={() => onNavigatePage('vault')} className="dw-btn dw-btn-outline dw-btn-sm flex-1">
                  <KeyRound size={12} />
                  <span>Vault 凭证库</span>
                </button>
              </div>
            </div>

            <div className="resource-section">
              <h3>
                <span>成员与运行端 ({members.length})</span>
                <button type="button" onClick={() => void onRefreshMembers()} disabled={refreshingMembers}>
                  <RefreshCw size={11} className={refreshingMembers ? 'is-refreshing' : ''} />
                  <span>刷新</span>
                </button>
              </h3>
              <div className="resource-group p-2.5 flex flex-col gap-2">
                {members.map((m) => (
                  <div key={m.id} className="space-member" style={{ margin: '2px 0' }}>
                    <AgentAvatar small name={m.name} platformId={m.platformId} status={m.status} />
                    <div>
                      <strong>{m.name}</strong>
                      <small>{m.location === 'remote-bridge' ? '远端桥接' : m.location === 'webhook' ? 'Webhook Bot' : '本机接入'}</small>
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => onNavigatePage('members')} className="dw-btn dw-btn-ghost dw-btn-sm w-full justify-start">
                <Users size={12} />
                <span>查看完整成员与 Token 用量 →</span>
              </button>
            </div>
          </div>
          );
        })()}
      </div>
    </aside>
  );
}
