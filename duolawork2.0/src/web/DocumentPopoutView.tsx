import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Columns2,
  Copy,
  Download,
  Eye,
  File,
  FileText,
  History,
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
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import type { ArtifactRecord, ArtifactVersionRecord } from '../shared/types.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './components/ui/menu.js';
import { RichTextFileViewer, detectTextFileFormat } from './RichFileViewer.js';
import {
  broadcastSpaceSync,
  getPopoutDesktopBridge,
  type PopoutTarget
} from './lib/popout.js';
import { extractMarkdownHeadings, MarkdownView } from './markdown.js';

function estimateReadingMeta(text: string): { chars: number; minutes: number } {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, '');
  const chars = clean.length;
  const minutes = Math.max(1, Math.round(chars / 420));
  return { chars, minutes };
}

export function DocumentPopoutView({ target }: { target: PopoutTarget }): React.JSX.Element {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dw2_theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [pinned, setPinned] = useState<boolean>(false);
  const [wide, setWide] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(15.5);
  const [tocOpen, setTocOpen] = useState<boolean>(true);
  const [activeHeadingId, setActiveHeadingId] = useState<string>('');

  // Document state
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactVersionRecord[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [docMode, setDocMode] = useState<'read' | 'split' | 'edit'>('read');
  const [saving, setSaving] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');
  const [remoteUpdateVersion, setRemoteUpdateVersion] = useState<number | null>(null);
  const [copiedDoc, setCopiedDoc] = useState<boolean>(false);

  // File state
  const [fileText, setFileText] = useState<string>('');
  const [fileZoom, setFileZoom] = useState<number>(100);

  const isDesktop = Boolean(getPopoutDesktopBridge()?.isDesktop);
  const isDirty = target.kind === 'document' && artifact !== null && draft !== artifact.content;
  const isDirtyRef = useRef(isDirty);
  const docModeRef = useRef(docMode);
  const readerScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    docModeRef.current = docMode;
  }, [isDirty, docMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('dw2_theme', dark ? 'dark' : 'light');
    } catch {
      // ignore storage errors
    }
  }, [dark]);

  const displayTitle = artifact?.title || target.title || (target.kind === 'document' ? '文档阅读器' : '文件预览');

  useEffect(() => {
    document.title = `${displayTitle} · DuolaWork`;
  }, [displayTitle]);

  const loadDocument = useCallback(
    async (silent = false) => {
      if (target.kind !== 'document') return;
      if (!silent) {
        setLoading(true);
        setLoadError('');
      }
      try {
        const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(target.id)}`);
        if (!res.ok) throw new Error('无法读取文档内容，请确认登录状态或文档是否存在');
        const data = await res.json();
        const nextArt: ArtifactRecord = data.artifact;
        setArtifact(nextArt);
        setVersions(data.versions || []);
        setDraft(nextArt.content || '');
        setRemoteUpdateVersion(null);
      } catch (err) {
        if (!silent) setLoadError((err as Error).message || '读取文档失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [target.id, target.kind]
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
      if (!res.ok) throw new Error('无法读取文件内容');
      const txt = await res.text();
      setFileText(txt);
    } catch (err) {
      setLoadError((err as Error).message || '读取文件失败');
    } finally {
      setLoading(false);
    }
  }, [target.id, target.kind, target.previewKind]);

  useEffect(() => {
    if (target.kind === 'document') {
      void loadDocument();
    } else {
      void loadFile();
    }
  }, [target.kind, loadDocument, loadFile]);

  // Live SSE sync for document updates from Agent or Main Window
  useEffect(() => {
    if (target.kind !== 'document') return;
    const es = new EventSource('/api/v2/events');
    const onSpaceEvent = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data);
        const artId = parsed?.artifactId || parsed?.artifact?.id || parsed?.itemId;
        if (artId && artId !== target.id) return;
        const nextVer = parsed?.artifact?.headVersion || parsed?.version;
        if (isDirtyRef.current || docModeRef.current !== 'read') {
          setRemoteUpdateVersion(typeof nextVer === 'number' ? nextVer : Date.now());
        } else {
          void loadDocument(true);
        }
      } catch {
        // ignore malformed SSE
      }
    };
    es.addEventListener('artifact.updated', onSpaceEvent);
    es.addEventListener('space.updated', onSpaceEvent);
    return () => {
      es.close();
    };
  }, [target.id, target.kind, loadDocument]);

  const handleSave = useCallback(async () => {
    if (target.kind !== 'document' || !artifact || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(artifact.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBaseVersion: artifact.headVersion,
          content: draft
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message || '保存文档失败');
        return;
      }
      const data = await res.json();
      setArtifact(data.artifact);
      setVersions(data.versions || []);
      setDraft(data.artifact.content || '');
      setRemoteUpdateVersion(null);
      broadcastSpaceSync({
        type: 'artifact_saved',
        artifactId: data.artifact.id,
        threadId: data.artifact.sourceThreadId || target.threadId,
        headVersion: data.artifact.headVersion
      });
      toast.success(
        data.conflict
          ? `检测到并发修改，已另存为冲突分支 v${data.artifact.headVersion}`
          : `已保存为 v${data.artifact.headVersion}`
      );
    } finally {
      setSaving(false);
    }
  }, [artifact, draft, saving, target.kind, target.threadId]);

  // Cmd/Ctrl+S keyboard shortcut to save
  useEffect(() => {
    if (target.kind !== 'document') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isDirtyRef.current) void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave, target.kind]);

  const handleCopyContent = () => {
    const payload = target.kind === 'document' ? draft : fileText;
    if (!payload) return;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopiedDoc(true);
      toast.success('已复制全文到剪贴板');
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

  const handleTogglePin = async () => {
    const next = !pinned;
    const res = await getPopoutDesktopBridge()?.setAlwaysOnTop?.(next);
    if (res?.ok) {
      setPinned(next);
      toast.success(next ? '已将阅读窗口置顶' : '已取消窗口置顶');
    }
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
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toaster position="bottom-right" theme={dark ? 'dark' : 'light'} richColors closeButton />

      {/* Top Reader Chrome */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-sidebar px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-xs/5">
            {target.kind === 'document' ? <FileText size={15} /> : <File size={15} />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="m-0 max-w-[36vw] truncate text-[14px] font-semibold text-foreground">
                {displayTitle}
              </h1>
              {artifact && (
                <Badge variant="outline" size="sm" className="font-mono text-[10px]">
                  v{artifact.headVersion}
                </Badge>
              )}
              {isDirty && (
                <Badge variant="warning" size="sm" className="text-[10px]">
                  未保存
                </Badge>
              )}
            </div>
            {readingMeta && (
              <div className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                {readingMeta.chars.toLocaleString()} 字 · 预计阅读 {readingMeta.minutes} 分钟
              </div>
            )}
          </div>
        </div>

        {/* Center Mode Switcher for Documents */}
        {target.kind === 'document' && (
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {([
              ['read', '阅读', Eye],
              ['split', '分屏', Columns2],
              ['edit', '编辑', Pencil]
            ] as const).map(([val, label, Icon]) => {
              const active = docMode === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDocMode(val)}
                  className={
                    active
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

        {/* Right Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          {headings.length >= 2 && docMode !== 'edit' && (
            <Button
              variant={tocOpen ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setTocOpen((v) => !v)}
              title="切换目录大纲"
            >
              <ListTree size={13} />
              <span>目录</span>
            </Button>
          )}

          {(target.kind === 'document' || isMarkdownFile) && docMode === 'read' && (
            <>
              <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
                <button
                  type="button"
                  onClick={() => setFontSize((s) => Math.max(13, s - 1))}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="缩小字号"
                  aria-label="缩小字号"
                >
                  <Minus size={11} />
                </button>
                <span className="px-1.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                  {Math.round(fontSize)}
                </span>
                <button
                  type="button"
                  onClick={() => setFontSize((s) => Math.min(20, s + 1))}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="放大字号"
                  aria-label="放大字号"
                >
                  <Plus size={11} />
                </button>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setWide((v) => !v)}
                title={wide ? '切换为舒适版宽' : '切换为宽屏阅读'}
                aria-label={wide ? '切换为舒适版宽' : '切换为宽屏阅读'}
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
                title="缩小图片"
              >
                <ZoomOut size={12} />
              </button>
              <button
                type="button"
                onClick={() => setFileZoom(100)}
                className="px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground tabular-nums"
                title="重置 100%"
              >
                {fileZoom}%
              </button>
              <button
                type="button"
                onClick={() => setFileZoom((z) => Math.min(250, z + 25))}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="放大图片"
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
                    <span>版本 ({versions.length})</span>
                  </Button>
                }
              />
              <MenuPopup align="end" className="max-h-64 w-60 overflow-y-auto coss-scroll">
                {versions.map((ver) => (
                  <MenuItem
                    key={ver.id}
                    onClick={() => {
                      setDraft(ver.content);
                      toast.info(`已切换到 v${ver.version} 预览`);
                    }}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="font-medium text-foreground">
                      v{ver.version} · {ver.branchKind === 'conflict_branch' ? '冲突保留稿' : '主稿'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(ver.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}

          {(target.kind === 'document' || target.previewKind === 'text') && (
            <Button variant="outline" size="xs" onClick={handleCopyContent}>
              {copiedDoc ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedDoc ? '已复制' : '复制'}</span>
            </Button>
          )}

          <Button variant="outline" size="xs" onClick={handleExport}>
            <Download size={12} />
            <span>{target.kind === 'document' ? '导出' : '下载'}</span>
          </Button>

          {target.kind === 'document' && (isDirty || docMode !== 'read') && (
            <Button size="xs" disabled={!isDirty || saving} loading={saving} onClick={() => void handleSave()}>
              <Save size={12} />
              <span>{saving ? '保存中…' : '保存'}</span>
            </Button>
          )}

          {isDesktop && (
            <Button
              variant={pinned ? 'secondary' : 'ghost'}
              size="icon-xs"
              onClick={() => void handleTogglePin()}
              title={pinned ? '取消窗口置顶' : '窗口置顶'}
              aria-label={pinned ? '取消窗口置顶' : '窗口置顶'}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setDark((v) => !v)}
            title={dark ? '切换到浅色模式' : '切换到深色模式'}
            aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
          >
            {dark ? <Sun size={13} /> : <Moon size={13} />}
          </Button>
        </div>
      </header>

      {/* Non-destructive remote update banner when editing */}
      {remoteUpdateVersion !== null && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-info/8 px-4 py-2 text-xs text-info-foreground">
          <span>检测到主窗口或 Agent 已更新此文档，点击右侧按钮可载入最新版本。</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="xs" onClick={() => void loadDocument(true)}>
              <RefreshCw size={11} />
              <span>载入最新</span>
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setRemoteUpdateVersion(null)}>
              稍后
            </Button>
          </div>
        </div>
      )}

      {/* Main Content Stage */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Collapsible Outline Sidebar (TOC) */}
        {showTocPanel && (
          <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar/60 md:flex">
            <div className="border-b border-border/70 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              目录大纲 ({headings.length})
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5 coss-scroll" aria-label="文档目录">
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

        {/* Document / File Canvas */}
        <main className="min-w-0 flex-1 overflow-hidden bg-background">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              正在加载内容…
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="m-0 text-sm text-destructive-foreground">{loadError}</p>
              <Button variant="outline" size="sm" onClick={() => void (target.kind === 'document' ? loadDocument() : loadFile())}>
                重新加载
              </Button>
            </div>
          ) : target.kind === 'document' ? (
            docMode === 'edit' ? (
              <div className="mx-auto flex h-full w-full max-w-[960px] flex-col p-5 sm:p-8">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="独立窗口文档编辑器"
                  className="h-full w-full flex-1 resize-none rounded-xl border border-border bg-card p-5 font-mono text-[13.5px] leading-relaxed text-foreground focus:border-ring focus:outline-none coss-scroll"
                />
              </div>
            ) : docMode === 'split' ? (
              <div className="grid h-full grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
                <div className="flex h-full min-h-0 flex-col p-4">
                  <div className="mb-2 font-mono text-[11px] text-muted-foreground">Markdown 源码</div>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label="分屏 Markdown 编辑器"
                    className="h-full w-full flex-1 resize-none rounded-xl border border-border bg-card p-4 font-mono text-[13px] leading-relaxed text-foreground focus:border-ring focus:outline-none coss-scroll"
                  />
                </div>
                <div
                  className="h-full min-h-0 overflow-y-auto px-7 py-6 coss-scroll"
                  style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
                >
                  <MarkdownView text={draft || '(空文档)'} className="dw-reader-prose" />
                </div>
              </div>
            ) : (
              <div
                ref={readerScrollRef}
                className="h-full overflow-y-auto px-6 py-8 sm:px-12 sm:py-10 coss-scroll"
                style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
              >
                <article className={`mx-auto w-full ${wide ? 'max-w-[1080px]' : 'max-w-[780px]'}`}>
                  <MarkdownView text={draft || '(空文档)'} className="dw-reader-prose" />
                </article>
              </div>
            )
          ) : target.previewKind === 'image' ? (
            <div className="flex h-full w-full items-center justify-center overflow-auto bg-muted/25 p-8 coss-scroll">
              <img
                src={`/api/v2/space/files/${encodeURIComponent(target.id)}`}
                alt={displayTitle}
                style={{ width: fileZoom === 100 ? 'auto' : `${fileZoom}%`, maxWidth: fileZoom === 100 ? '100%' : 'none' }}
                className="max-h-full rounded-xl border border-border bg-card object-contain shadow-sm"
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
            <div className="flex h-full items-center justify-center p-8">
              <audio src={`/api/v2/space/files/${encodeURIComponent(target.id)}`} controls className="w-full max-w-lg" />
            </div>
          ) : (
            <div
              className="h-full overflow-y-auto px-6 py-7 sm:px-10 sm:py-9 coss-scroll"
              style={{ '--dw-reader-size': `${fontSize}px` } as React.CSSProperties}
            >
              <div className={`mx-auto w-full ${wide || !isMarkdownFile ? 'max-w-[1120px]' : 'max-w-[780px]'}`}>
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
