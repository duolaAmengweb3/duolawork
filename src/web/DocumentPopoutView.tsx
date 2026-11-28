import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Columns2,
  Copy,
  Download,
  Eye,
  File,
  FileText,
  History,
  Image as ImageIcon,
  ListTree,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Save,
  Sun,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import type { ArtifactRecord, ArtifactVersionRecord, SpaceItemView } from '../shared/types.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './components/ui/menu.js';
import { RichTextFileViewer, detectTextFileFormat } from './RichFileViewer.js';
import {
  buildPopoutPath,
  broadcastSpaceSync,
  getPopoutDesktopBridge,
  popoutTabKey,
  type PopoutTarget
} from './lib/popout.js';
import { extractMarkdownHeadings, MarkdownView } from './markdown.js';

import { subscribeReaderUpdates } from './lib/reader-sync.js';
import { useI18n } from './lib/i18n.js';
import { detectPreviewKind } from '../shared/file-format.js';

function currentTarget(tab: PopoutTarget): PopoutTarget {
  if (tab.kind !== 'file' || !tab.title) return tab;
  return {...tab, previewKind: detectPreviewKind(tab.title, tab.mimeType || '')};
}

interface TabMeta {
  title?: string;
  version?: number;
  dirty?: boolean;
}

function estimateReadingMeta(text: string): { chars: number; minutes: number } {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, '');
  const chars = clean.length;
  return { chars, minutes: Math.max(1, Math.round(chars / 420)) };
}

function tabIcon(t: PopoutTarget): React.ComponentType<{ size?: number; className?: string }> {
  if (t.kind === 'document') return FileText;
  if (t.previewKind === 'image') return ImageIcon;
  return File;
}

const TABS_STORAGE_KEY = 'dw2_reader_open_tabs_v1';

function loadInitialTabs(initialTarget: PopoutTarget): PopoutTarget[] {
  try {
    const raw = sessionStorage.getItem(TABS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (x): x is PopoutTarget =>
            x && (x.kind === 'document' || x.kind === 'file') && typeof x.id === 'string' && x.id.length > 0
        );
        const key = popoutTabKey(initialTarget);
        const exists = valid.some((x) => popoutTabKey(x) === key);
        return exists
          ? valid.map((x) => (popoutTabKey(x) === key ? { ...x, ...initialTarget } : x))
          : [...valid, initialTarget];
      }
    }
  } catch {
    // ignore corrupted session storage
  }
  return [initialTarget];
}

function ReaderTabPane({
  target,
  active,
  paperTheme,
  fontSize,
  wide,
  tocOpen,
  pinned,
  isDesktop,
  onSetPaperTheme,
  onSetFontSize,
  onToggleWide,
  onToggleToc,
  onTogglePin,
  onMetaChange
}: {
  target: PopoutTarget;
  active: boolean;
  paperTheme: 'light' | 'sepia' | 'dark';
  fontSize: number;
  wide: boolean;
  tocOpen: boolean;
  pinned: boolean;
  isDesktop: boolean;
  onSetPaperTheme: (t: 'light' | 'sepia' | 'dark') => void;
  onSetFontSize: React.Dispatch<React.SetStateAction<number>>;
  onToggleWide: () => void;
  onToggleToc: () => void;
  onTogglePin: () => void;
  onMetaChange: (key: string, meta: TabMeta) => void;
}): React.JSX.Element {
  const { locale, t, L } = useI18n();
  const tabKey = popoutTabKey(target);
  const [activeHeadingId, setActiveHeadingId] = useState<string>('');
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactVersionRecord[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [docMode, setDocMode] = useState<'read' | 'split' | 'edit'>('read');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState('');
  const savePending = useRef(false);
  const documentRead = useRef(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');
  const [remoteUpdateVersion, setRemoteUpdateVersion] = useState<number | null>(null);
  const [copiedDoc, setCopiedDoc] = useState<boolean>(false);
  const [fileText, setFileText] = useState<string>('');
  const [fileZoom, setFileZoom] = useState<number>(100);

  const isDirty = target.kind === 'document' && artifact !== null && draft !== artifact.content;
  const isDirtyRef = useRef(isDirty);
  const latest = useRef({artifact, draft});
  const imageViewport = useRef<HTMLDivElement>(null);
  const [imageSize, setImageSize] = useState({width: 0, height: 0});
  const [viewportSize, setViewportSize] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    const viewport = imageViewport.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const {width, height} = entry.contentRect;
      if (width && height) setViewportSize({width, height});
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [loading, target.previewKind]);
  const fit = imageSize.width && imageSize.height && viewportSize.width
    ? Math.min(1, viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
    : 1;
  const paneRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    isDirtyRef.current = isDirty;
    latest.current = {artifact, draft};
  }, [isDirty, artifact, draft]);

  const displayTitle =
    artifact?.title || target.title || (target.kind === 'document' ? L('文档阅读器', 'Document Reader') : L('文件预览', 'File Preview'));

  useLayoutEffect(() => {
    onMetaChange(tabKey, {
      title: displayTitle,
      version: artifact?.headVersion,
      dirty: isDirty
    });
  }, [tabKey, displayTitle, artifact?.headVersion, isDirty, onMetaChange]);

  const loadDocument = useCallback(
    async (mode: 'open' | 'sync' | 'replace' = 'open') => {
      if (target.kind !== 'document') return;
      const request = ++documentRead.current;
      const atStart = latest.current;
      if (mode === 'open') setLoading(true);
      try {
        const res = await fetch('/api/v2/artifacts/' + encodeURIComponent(target.id), {
          signal: AbortSignal.timeout(25000)
        });
        if (!res.ok) throw new Error(L('暂时无法读取文档，请重试', 'Unable to load document. Retry shortly.'));
        const data = await res.json();
        if (request !== documentRead.current) return;
        const next: ArtifactRecord = data.artifact;
        const current = latest.current;
        setVersions(data.versions || []);
        setLoadError('');
        if (current.artifact && (isDirtyRef.current || savePending.current) &&
            !(mode === 'replace' && current.draft === atStart.draft)) {
          if (next.headVersion !== current.artifact.headVersion) setRemoteUpdateVersion(next.headVersion);
          return;
        }
        setArtifact(next);
        setDraft(next.content);
        setRemoteUpdateVersion(null);
      } catch {
        if (request === documentRead.current && !latest.current.artifact) setLoadError(L('暂时无法读取文档，请重试', 'Unable to load document. Retry shortly.'));
        else if (mode === 'replace') toast.error(L('暂时无法读取最新版本，请重试', 'Unable to load latest version.'));
      } finally {
        if (request === documentRead.current) setLoading(false);
      }
    },
    [target.id, target.kind, L]
  );

  const loadFile = useCallback(async () => {
    if (target.kind !== 'file') return;
    if (target.previewKind !== 'text') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch(`/api/v2/space/files/${encodeURIComponent(target.id)}`);
      if (!res.ok) throw new Error(L('无法读取文件内容', 'Unable to read file contents'));
      setFileText(await res.text());
    } catch (err) {
      setLoadError((err as Error).message || L('读取文件失败', 'Failed to read file'));
    } finally {
      setLoading(false);
    }
  }, [target.id, target.kind, target.previewKind, L]);

  useEffect(() => {
    if (target.kind === 'document') void loadDocument();
    else void loadFile();
  }, [target.kind, loadDocument, loadFile]);

  useEffect(() => {
    if (target.kind !== 'document') return;
    return subscribeReaderUpdates(threadId => {
      if (!threadId || !target.threadId || threadId === target.threadId) void loadDocument('sync');
    });
  }, [target.id, target.kind, target.threadId, loadDocument]);

  const handleSave = useCallback(async () => {
    if (target.kind !== 'document' || !artifact || savePending.current) return;
    savePending.current = true;
    setSaveError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(artifact.id)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBaseVersion: artifact.headVersion,
          content: draft
        })
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      documentRead.current++;
      const editedAfterSubmit = latest.current.draft !== draft;
      if (!data.conflict || !editedAfterSubmit) setArtifact(data.artifact);
      setVersions(data.versions || []);
      setDraft(current => current === draft ? data.artifact.content : current);
      setRemoteUpdateVersion(data.conflict && editedAfterSubmit ? data.artifact.headVersion : null);
      broadcastSpaceSync({
        type: 'artifact_saved',
        artifactId: data.artifact.id,
        threadId: data.artifact.sourceThreadId || target.threadId,
        headVersion: data.artifact.headVersion
      });
      toast.success(
        data.conflict
          ? L(`检测到并发修改，已另存为冲突分支 v${data.savedVersion.version}`, `Concurrent edit detected; saved branch v${data.savedVersion.version}`)
          : L(`已保存为 v${data.artifact.headVersion}`, `Saved v${data.artifact.headVersion}`)
      );
      void loadDocument('sync');
    } catch {
      setSaveError(L('保存失败，草稿已保留。请检查连接后再次保存。', 'Save failed. Your draft is preserved; check connection and retry.'));
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }, [artifact, draft, target.kind, target.threadId, loadDocument, L]);

  useEffect(() => {
    if (!active || target.kind !== 'document') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isDirtyRef.current) void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, handleSave, target.kind]);

  const handleCopyContent = () => {
    const payload = target.kind === 'document' ? draft : fileText;
    if (!payload) return;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopiedDoc(true);
      toast.success(L('已复制全文到剪贴板', 'Copied full text to clipboard'));
      setTimeout(() => setCopiedDoc(false), 1800);
    });
  };

  const handleExport = () => {
    if (target.kind === 'file') {
      const a = document.createElement('a');
      a.href = `/api/v2/space/files/${encodeURIComponent(target.id)}?download=1`;
      a.download = displayTitle;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = displayTitle.endsWith('.md') ? displayTitle : `${displayTitle}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const isMarkdownFile = useMemo(
    () =>
      target.kind === 'file' &&
      target.previewKind === 'text' &&
      detectTextFileFormat(displayTitle, target.mimeType).format === 'markdown',
    [displayTitle, target.kind, target.mimeType, target.previewKind]
  );

  const markdownSource = target.kind === 'document' ? draft : isMarkdownFile ? fileText : '';
  const headings = useMemo(
    () => (markdownSource ? extractMarkdownHeadings(markdownSource) : []),
    [markdownSource]
  );
  const showTocPanel = tocOpen && headings.length >= 2 && docMode !== 'edit';
  const readingMeta = useMemo(
    () => (markdownSource ? estimateReadingMeta(markdownSource) : null),
    [markdownSource]
  );

  const jumpToHeading = (id: string) => {
    setActiveHeadingId(id);
    const el = paneRef.current?.querySelector(`[id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div ref={paneRef} className={active ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-sidebar/80 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="m-0 max-w-[30vw] truncate text-[13.5px] font-semibold text-foreground">
            {displayTitle}
          </h1>
          {artifact && (
            <Badge variant="outline" size="sm" className="font-mono text-[10px]">
              v{artifact.headVersion}
            </Badge>
          )}
          {isDirty && (
            <Badge variant="warning" size="sm" className="text-[10px]">
              {L('未保存', 'Unsaved')}
            </Badge>
          )}
          {readingMeta && (
            <span className="hidden font-mono text-[11px] text-muted-foreground tabular-nums lg:inline">
              · {readingMeta.chars.toLocaleString()} {L('字', 'chars')} · {readingMeta.minutes} {L('分钟', 'min read')}
            </span>
          )}
        </div>

        {target.kind === 'document' && (
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {([
              ['read', t('readerModeRead'), Eye],
              ['split', t('readerModeSplit'), Columns2],
              ['edit', t('readerModeEdit'), Pencil]
            ] as const).map(([val, label, Icon]) => {
              const isMode = docMode === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDocMode(val)}
                  className={
                    isMode
                      ? 'inline-flex items-center gap-1 rounded-md bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-xs/5 ring-1 ring-border/70'
                      : 'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                  }
                >
                  <Icon size={12} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {headings.length >= 2 && docMode !== 'edit' && (
            <Button
              variant={tocOpen ? 'secondary' : 'ghost'}
              size="xs"
              onClick={onToggleToc}
              title={L('切换目录大纲', 'Toggle outline')}
            >
              <ListTree size={13} />
              <span>{t('readerToc')}</span>
            </Button>
          )}

          {(target.kind === 'document' || isMarkdownFile) && docMode === 'read' && (
            <>
              <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
                <button
                  type="button"
                  onClick={() => onSetFontSize((s) => Math.max(13, s - 1))}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={L('缩小字号', 'Decrease font size')}
                  aria-label={L('缩小字号', 'Decrease font size')}
                >
                  <Minus size={11} />
                </button>
                <span className="px-1.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                  {Math.round(fontSize)}
                </span>
                <button
                  type="button"
                  onClick={() => onSetFontSize((s) => Math.min(22, s + 1))}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={L('放大字号', 'Increase font size')}
                  aria-label={L('放大字号', 'Increase font size')}
                >
                  <Plus size={11} />
                </button>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onToggleWide}
                title={wide ? L('切换为舒适版宽', 'Reading width') : L('切换为宽屏阅读', 'Wide width')}
                aria-label={wide ? L('切换为舒适版宽', 'Reading width') : L('切换为宽屏阅读', 'Wide width')}
              >
                {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </Button>
            </>
          )}

          {target.kind === 'file' && target.previewKind === 'image' && (
            <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-1 py-0.5">
              <button
                type="button"
                onClick={() => setFileZoom((z) => Math.max(25, z - 25))}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title={L('缩小图片', 'Zoom out')}
              >
                <ZoomOut size={12} />
              </button>
              <button
                type="button"
                onClick={() => setFileZoom(100)}
                className="px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground tabular-nums"
              >
                {fileZoom}%
              </button>
              <button
                type="button"
                onClick={() => setFileZoom((z) => Math.min(250, z + 25))}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title={L('放大图片', 'Zoom in')}
              >
                <ZoomIn size={12} />
              </button>
            </div>
          )}

          {target.kind === 'document' && versions.length > 0 && (
            <Menu>
              <MenuTrigger
                render={
                  <Button variant="outline" size="xs">
                    <History size={12} />
                    <span>{t('readerVersions', { n: versions.length })}</span>
                  </Button>
                }
              />
              <MenuPopup align="end" className="max-h-64 w-60 overflow-y-auto coss-scroll">
                {versions.map((ver) => (
                  <MenuItem
                    key={ver.id}
                    onClick={() => {
                      setDraft(ver.content);
                      toast.info(L(`已切换到 v${ver.version} 预览`, `Previewing v${ver.version}`));
                    }}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="font-medium text-foreground">
                      v{ver.version} · {ver.branchKind === 'conflict_branch' ? L('冲突保留稿', 'Conflict branch') : L('主稿', 'Main')}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(ver.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}
                    </span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}

          {(target.kind === 'document' || target.previewKind === 'text') && (
            <Button variant="outline" size="xs" onClick={handleCopyContent}>
              {copiedDoc ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedDoc ? t('readerCopied') : t('readerCopy')}</span>
            </Button>
          )}

          <Button variant="outline" size="xs" onClick={handleExport}>
            <Download size={12} />
            <span>{target.kind === 'document' ? t('readerExport') : t('readerDownload')}</span>
          </Button>

          {target.kind === 'document' && (isDirty || docMode !== 'read') && (
            <Button size="xs" disabled={!isDirty || saving} loading={saving} onClick={() => void handleSave()}>
              <Save size={12} />
              <span>{saving ? t('readerSaving') : t('readerSave')}</span>
            </Button>
          )}

          {isDesktop && (
            <Button
              variant={pinned ? 'secondary' : 'ghost'}
              size="icon-xs"
              onClick={onTogglePin}
              title={pinned ? L('取消窗口置顶', 'Unpin window') : L('窗口置顶', 'Pin window on top')}
              aria-label={pinned ? L('取消窗口置顶', 'Unpin window') : L('窗口置顶', 'Pin window on top')}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </Button>
          )}

          <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
            {([
              ['light', t('readerLight'), Sun],
              ['sepia', t('readerSepia'), null],
              ['dark', t('readerDark'), Moon]
            ] as const).map(([val, label, Icon]) => {
              const isTheme = paperTheme === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => onSetPaperTheme(val)}
                  title={L(`切换为${label}纸张`, `Switch to ${label} paper`)}
                  aria-label={L(`切换为${label}模式`, `Switch to ${label} theme`)}
                  className={
                    isTheme
                      ? 'inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-medium text-foreground'
                      : 'inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground'
                  }
                >
                  {Icon ? (
                    <Icon size={11.5} />
                  ) : (
                    <span className="size-2.5 rounded-full border border-amber-700/40 bg-[#f3e6c8]" />
                  )}
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {saveError && <p role="alert" className="px-4 py-2 text-xs text-destructive-foreground">{saveError}</p>}
      {remoteUpdateVersion !== null && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-info/8 px-4 py-2 text-xs text-info-foreground">
          <span>{L('检测到主窗口或 Agent 已更新此文档，点击右侧按钮可载入最新版本。', 'Updated by main window or agent. Load the latest version on the right.')}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="xs" onClick={() => {
              if (!isDirty || window.confirm(L('载入最新版本会替换当前草稿，继续吗？', 'Loading the latest version will replace your draft. Continue?'))) void loadDocument('replace');
            }}>
              <RefreshCw size={11} />
              <span>{L('载入最新', 'Load Latest')}</span>
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setRemoteUpdateVersion(null)}>
              {L('稍后', 'Later')}
            </Button>
          </div>
        </div>
      )}

      {/* Body Stage */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showTocPanel && (
          <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-sidebar/60 md:flex">
            <div className="border-b border-border/70 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {L(`目录大纲 (${headings.length})`, `Outline (${headings.length})`)}
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5 coss-scroll" aria-label={L('文档目录', 'Table of contents')}>
              {headings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => jumpToHeading(h.id)}
                  style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                  className={`block w-full truncate rounded-md py-1.5 pr-2 text-left text-xs transition-colors ${
                    activeHeadingId === h.id
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  }`}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          </aside>
        )}

        <main className="min-w-0 flex-1 overflow-hidden bg-background">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {L('正在加载内容…', 'Loading content…')}
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="m-0 text-sm text-destructive-foreground">{loadError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void (target.kind === 'document' ? loadDocument() : loadFile())}
              >
                {L('重新加载', 'Reload')}
              </Button>
            </div>
          ) : target.kind === 'document' ? (
            docMode === 'edit' ? (
              <div className="mx-auto flex h-full w-full max-w-[960px] flex-col p-5 sm:p-8">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={L('独立窗口文档编辑器', 'Popout document editor')}
                  className="h-full w-full flex-1 resize-none rounded-xl border border-border bg-card p-5 font-mono text-[13.5px] leading-relaxed text-foreground focus:border-ring focus:outline-none coss-scroll"
                />
              </div>
            ) : docMode === 'split' ? (
              <div className="grid h-full grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
                <div className="flex h-full min-h-0 flex-col p-4">
                  <div className="mb-2 font-mono text-[11px] text-muted-foreground">{L('Markdown 源码', 'Markdown Source')}</div>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={L('分屏 Markdown 编辑器', 'Split Markdown editor')}
                    className="h-full w-full flex-1 resize-none rounded-xl border border-border bg-card p-4 font-mono text-[13px] leading-relaxed text-foreground focus:border-ring focus:outline-none coss-scroll"
                  />
                </div>
                <div
                  className="dw-reader-canvas h-full min-h-0 overflow-y-auto px-5 py-5 coss-scroll"
                  style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
                >
                  <div className="dw-reader-paper px-7 py-8">
                    <MarkdownView text={draft || L('(空文档)', '(Empty document)')} className="dw-reader-prose" />
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="dw-reader-canvas h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8 coss-scroll"
                style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
              >
                <article
                  className={`dw-reader-paper mx-auto w-full px-7 py-8 sm:px-14 sm:py-12 ${
                    wide ? 'max-w-[1080px]' : 'max-w-[820px]'
                  }`}
                >
                  <MarkdownView text={draft || L('(空文档)', '(Empty document)')} className="dw-reader-prose" />
                </article>
              </div>
            )
          ) : target.previewKind === 'image' ? (
            <div ref={imageViewport} className="dw-reader-canvas flex h-full w-full overflow-auto p-8 coss-scroll">
              <img
                src={`/api/v2/space/files/${encodeURIComponent(target.id)}`}
                alt={displayTitle}
                onLoad={event => {
                  const img = event.currentTarget;
                  setImageSize({width: img.naturalWidth, height: img.naturalHeight});
                }}
                style={{width: imageSize.width ? imageSize.width * fit * fileZoom / 100 : undefined}}
                className="m-auto h-auto max-w-none flex-none self-start rounded-xl object-contain shadow-sm"
              />
            </div>
          ) : target.previewKind === 'pdf' ? (
            <iframe
              src={`/api/v2/space/files/${encodeURIComponent(target.id)}`}
              title={displayTitle}
              className="h-full w-full border-0"
            />
          ) : target.previewKind === 'video' ? (
            <div className="flex h-full items-center justify-center bg-black/90 p-6">
              <video
                src={`/api/v2/space/files/${encodeURIComponent(target.id)}`}
                controls
                className="max-h-full max-w-full rounded-lg"
              />
            </div>
          ) : target.previewKind === 'audio' ? (
            <div className="dw-reader-canvas flex h-full items-center justify-center p-8">
              <audio
                src={`/api/v2/space/files/${encodeURIComponent(target.id)}`}
                controls
                className="w-full max-w-lg"
              />
            </div>
          ) : target.previewKind === 'binary' ? (
            <div className="dw-reader-canvas flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <File size={32} className="text-muted-foreground" />
              <div className="text-sm font-semibold text-foreground">{displayTitle}</div>
              <p className="m-0 max-w-sm text-xs text-muted-foreground">
                {L('该格式文件保留原件，可点击右上角「下载」后用本机应用打开。', 'Download the original file in the top-right to open it with a local app.')}
              </p>
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download size={13} />
                <span>{L('下载原件', 'Download')}</span>
              </Button>
            </div>
          ) : (
            <div
              className="dw-reader-canvas h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8 coss-scroll"
              style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
            >
              <div
                className={`dw-reader-paper mx-auto w-full px-7 py-8 sm:px-12 sm:py-10 ${
                  wide || !isMarkdownFile ? 'max-w-[1120px]' : 'max-w-[820px]'
                }`}
              >
                <RichTextFileViewer
                  title={displayTitle}
                  mimeType={target.mimeType}
                  content={fileText}
                  readerStyle
                />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export function DocumentPopoutView({ target }: { target: PopoutTarget }): React.JSX.Element {
  const { locale, toggleLocale, t, L } = useI18n();
  const [tabs, setTabs] = useState<PopoutTarget[]>(() => loadInitialTabs(target).map(currentTarget));
  const [activeKey, setActiveKey] = useState<string>(() => popoutTabKey(target));
  const [metaByKey, setMetaByKey] = useState<Record<string, TabMeta>>({});
  const [paperTheme, setPaperTheme] = useState<'light' | 'sepia' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('dw2_reader_theme');
      if (saved === 'light' || saved === 'sepia' || saved === 'dark') return saved;
      return localStorage.getItem('dw2_theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [pinned, setPinned] = useState<boolean>(false);
  const [wide, setWide] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const [tocOpen, setTocOpen] = useState<boolean>(true);
  const [spaceItems, setSpaceItems] = useState<SpaceItemView[]>([]);
  const [pickerLoading, setPickerLoading] = useState<boolean>(false);

  const dark = paperTheme === 'dark';
  const isDesktop = Boolean(getPopoutDesktopBridge()?.isDesktop);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('dw2_reader_theme', paperTheme);
    } catch {
      // ignore
    }
  }, [dark, paperTheme]);

  useEffect(() => {
    try {
      sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // ignore
    }
  }, [tabs]);

  const activeTab = useMemo(
    () => tabs.find((t) => popoutTabKey(t) === activeKey) ?? tabs[0] ?? null,
    [tabs, activeKey]
  );

  useEffect(() => {
    const title = (activeTab && (metaByKey[popoutTabKey(activeTab)]?.title || activeTab.title)) || L('阅读器', 'Reader');
    document.title = `${title} · DuolaWork`;
  }, [activeTab, metaByKey, L]);

  const openOrFocusTab = useCallback((incoming: PopoutTarget) => {
    const next = currentTarget(incoming);
    const k = popoutTabKey(next);
    setTabs((prev) => {
      const exists = prev.some((t) => popoutTabKey(t) === k);
      if (exists) {
        return prev.map((t) => (popoutTabKey(t) === k ? { ...t, ...next } : t));
      }
      return [...prev, next];
    });
    setActiveKey(k);
  }, []);

  useLayoutEffect(() => {
    if (activeTab) window.history.replaceState(null, '', buildPopoutPath(activeTab));
  }, [activeTab]);

  const dirty = tabs.some(tab => metaByKey[popoutTabKey(tab)]?.dirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!tabs.length) window.close();
  }, [tabs.length]);

  const closeTab = useCallback((key: string) => {
    if (metaByKey[key]?.dirty && !window.confirm(L('这份文档有未保存的修改。放弃修改并关闭标签？', 'Unsaved changes in this document. Discard and close tab?'))) return;
    const index = tabs.findIndex(tab => popoutTabKey(tab) === key);
    if (index < 0) return;
    const remaining = tabs.filter(tab => popoutTabKey(tab) !== key);
    setTabs(remaining);
    if (activeKey === key && remaining.length) setActiveKey(popoutTabKey(remaining[Math.min(index, remaining.length - 1)]));
  }, [tabs, activeKey, metaByKey, L]);

  // Receive new tabs from Main Window via Electron IPC & Web BroadcastChannel
  useEffect(() => {
    const unsubIpc = getPopoutDesktopBridge()?.onReaderOpenTab?.((incoming) => {
      if (incoming && (incoming.kind === 'document' || incoming.kind === 'file') && incoming.id) {
        openOrFocusTab(incoming);
      }
    });

    let ch: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        ch = new BroadcastChannel('dw2-reader-tabs');
        ch.onmessage = (ev) => {
          if (ev.data?.type === 'open_tab' && ev.data?.target?.id) {
            openOrFocusTab(ev.data.target);
            ch?.postMessage({ type: 'open_tab_ack', reqId: ev.data.reqId });
            window.focus();
          }
        };
      } catch {
        // ignore unsupported BroadcastChannel
      }
    }

    return () => {
      unsubIpc?.();
      ch?.close();
    };
  }, [openOrFocusTab]);

  // Keyboard shortcuts: Cmd/Ctrl+W close tab, Cmd/Ctrl+1..9 switch tab
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'w' && tabs.length) {
        e.preventDefault();
        closeTab(activeKey);
        return;
      }
      const num = Number(e.key);
      if (num >= 1 && num <= 9 && tabs[num - 1]) {
        e.preventDefault();
        setActiveKey(popoutTabKey(tabs[num - 1]));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeKey, closeTab, tabs]);

  const handleMetaChange = useCallback((key: string, meta: TabMeta) => {
    setMetaByKey((prev) => {
      const cur = prev[key];
      if (cur?.title === meta.title && cur?.version === meta.version && cur?.dirty === meta.dirty) {
        return prev;
      }
      return { ...prev, [key]: meta };
    });
  }, []);

  const handleTogglePin = async () => {
    const next = !pinned;
    const res = await getPopoutDesktopBridge()?.setAlwaysOnTop?.(next);
    if (res?.ok) {
      setPinned(next);
      toast.success(next ? L('已将阅读窗口置顶', 'Reader window pinned on top') : L('已取消窗口置顶', 'Unpinned reader window'));
    }
  };

  const loadThreadSpaceItems = async () => {
    const tid = activeTab?.threadId || target.threadId;
    if (!tid) return;
    setPickerLoading(true);
    try {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(tid)}/space`);
      if (!res.ok) return;
      const data = await res.json();
      const list: SpaceItemView[] = Array.isArray(data?.items) ? data.items : [];
      setSpaceItems(list.filter((it) => it.kind === 'document' || it.kind === 'file'));
    } finally {
      setPickerLoading(false);
    }
  };

  return (
    <div
      className={`dw-reader-shell flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground ${
        paperTheme === 'sepia' ? 'is-sepia' : ''
      }`}
    >
      <Toaster position="bottom-right" theme={dark ? 'dark' : 'light'} richColors closeButton />

      {/* Multi-Tab Strip */}
      <div
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/55 px-2"
        role="tablist"
        aria-label={t('readerTabList')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto coss-scroll">
          {tabs.map((tab) => {
            const k = popoutTabKey(tab);
            const isSelected = k === activeKey;
            const meta = metaByKey[k];
            const label = meta?.title || tab.title || tab.id;
            const Icon = tabIcon(tab);
            return (
              <div
                key={k}
                role="tab"
                aria-selected={isSelected}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(k);
                  }
                }}
                className={`group flex h-8 max-w-[210px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
                  isSelected
                    ? 'border-border bg-background font-medium text-foreground shadow-xs/5'
                    : 'border-transparent bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveKey(k)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={label}
                >
                  <Icon size={12.5} className="shrink-0 opacity-75" />
                  <span className="truncate">{label}</span>
                  {meta?.dirty && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-amber-500"
                      title={L('有未保存的修改', 'Unsaved changes')}
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(k);
                  }}
                  aria-label={L(`关闭标签 ${label}`, `Close tab ${label}`)}
                  title={L('关闭标签页', 'Close tab')}
                  className={`flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground ${
                    isSelected ? 'opacity-75 hover:opacity-100' : 'opacity-0 group-hover:opacity-80'
                  }`}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        {(activeTab?.threadId || target.threadId) && (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void loadThreadSpaceItems()}
                  aria-label={t('readerAddTab')}
                  title={t('readerAddTab')}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Plus size={14} />
                </Button>
              }
            />
            <MenuPopup align="end" className="max-h-72 w-72 overflow-y-auto coss-scroll">
              {pickerLoading ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {L('读取资料列表中…', 'Loading materials…')}
                </div>
              ) : spaceItems.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {L('当前对话暂无其他可打开的资料', 'No other materials in this thread')}
                </div>
              ) : (
                spaceItems.map((it) => {
                  const Icon = it.kind === 'document' ? FileText : it.previewKind === 'image' ? ImageIcon : File;
                  const alreadyOpen = tabs.some((t) => popoutTabKey(t) === `${it.kind}:${it.id}`);
                  return (
                    <MenuItem
                      key={`${it.kind}:${it.id}`}
                      onClick={() =>
                        openOrFocusTab({
                          kind: it.kind === 'document' ? 'document' : 'file',
                          id: it.id,
                          threadId: activeTab?.threadId || target.threadId,
                          title: it.title,
                          mimeType: it.mimeType,
                          previewKind: it.previewKind
                        })
                      }
                    >
                      <Icon size={13} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{it.title}</span>
                      {alreadyOpen && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">{L('已打开', 'Open')}</span>
                      )}
                    </MenuItem>
                  );
                })
              )}
            </MenuPopup>
          </Menu>
        )}

        <Button
          variant="ghost"
          size="xs"
          onClick={toggleLocale}
          aria-label={L('切换语言', 'Switch language')}
          title="中 / EN"
          className="h-6 shrink-0 px-1.5 font-mono text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          {locale === 'zh' ? 'EN' : '中'}
        </Button>
      </div>

      {/* Keep-alive Tab Panes */}
      {tabs.length === 0 ? (
        <div className="dw-reader-canvas flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>{L('所有标签页已关闭', 'All tabs closed')}</span>
          <Button variant="outline" size="xs" onClick={() => openOrFocusTab(target)}>
            {L('重新打开文档', 'Reopen document')}
          </Button>
        </div>
      ) : (
        tabs.map((tab) => {
          const k = popoutTabKey(tab);
          return (
            <ReaderTabPane
              key={k}
              target={tab}
              active={k === activeKey}
              paperTheme={paperTheme}
              fontSize={fontSize}
              wide={wide}
              tocOpen={tocOpen}
              pinned={pinned}
              isDesktop={isDesktop}
              onSetPaperTheme={setPaperTheme}
              onSetFontSize={setFontSize}
              onToggleWide={() => setWide((v) => !v)}
              onToggleToc={() => setTocOpen((v) => !v)}
              onTogglePin={() => void handleTogglePin()}
              onMetaChange={handleMetaChange}
            />
          );
        })
      )}
    </div>
  );
}
