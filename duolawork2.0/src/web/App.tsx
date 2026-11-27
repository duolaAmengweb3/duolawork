import { readableTurnFailure } from '../shared/turn-timeout.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUp,
  AtSign,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  FolderArchive,
  FolderOpen,
  ImagePlus,
  KeyRound,
  Link2,
  ListTodo,
  Menu,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  Search,
  Square,
  Sun,
  Trash2,
  Users,
  X
} from 'lucide-react';
import {
  isLocalCodingMember,
  type ArtifactRecord,
  type ArtifactVersionRecord,
  type ClarificationCardData,
  type DuolaBasePublicStatus,
  type ExecutionNodeRecord,
  type HandoffNoticeMeta,
  type MemberRecord,
  type SpaceFolderRecord,
  type SpaceItemKind,
  type SpaceItemView,
  type StepReviewRecord,
  type StepSubmissionRecord,
  type TaskRecord,
  type TaskRunRecord,
  type TaskStepRecord,
  type ThreadMessageRecord,
  type ThreadRecord,
  type ToolTraceItem,
  type TurnActivity,
  type TurnPhase
} from '../shared/types.js';
import { ColumnDivider, WorkbenchColumns } from './WorkbenchColumns.js';
import { AgentAvatar, BrandLogo } from './AgentAvatar.js';
import {
  CollaborationSpacePanel,
  type SpaceReferenceChip,
  type SpaceTaskSummary,
  type WorkbenchNavPage
} from './CollaborationSpacePanel.js';
import { ConnectorsPage } from './ConnectorsPage.js';
import {
  MarkdownView,
  type MarkdownImageActions,
  type MarkdownSpaceResolver
} from './markdown.js';
import { MembersUsagePage } from './MembersUsagePage.js';
import { SchedulesPage } from './SchedulesPage.js';
import { VaultPage } from './VaultPage.js';

interface TaskWithLatestRun extends TaskRecord {
  latestRun: TaskRunRecord | null;
}

interface ThreadSpaceData {
  folders: SpaceFolderRecord[];
  items: SpaceItemView[];
  trash: SpaceItemView[];
  tasks: SpaceTaskSummary[];
}
const emptySpace: ThreadSpaceData = { folders: [], items: [], trash: [], tasks: [] };

interface EnrichedStep extends TaskStepRecord {
  submissions: StepSubmissionRecord[];
  reviews: StepReviewRecord[];
}

type MainViewMode = 'thread' | 'task' | 'archive' | WorkbenchNavPage;

interface DesktopBridge {
  isDesktop?: boolean;
  chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
  setTheme?: (theme: 'light' | 'dark') => Promise<unknown>;
}

const workspaceToolLabels: Record<string, string> = {
  connector_list: '查看连接', connector_discover: '查找工具', connector_check: '检查连接',
  connector_call: '调用服务', vault_list: '查看凭证', vault_http_proxy: '请求服务',
  experience_suggest: '查找经验', memory_recall: '查找记忆', experience_read: '读取经验',
  space_list_materials: '查看资料', space_read_material: '读取资料', space_create_folder: '新建目录',
  space_save_file: '保存文件', space_save_document: '保存文档', space_save_link: '保存链接',
  space_move_item: '移动资料', space_upload_to_connector: '上传文件', chat_attach_image: '添加图片'
};

function formatToolTraceRow(item: ToolTraceItem) {
  const name = item.name.trim();
  const summary = item.summary?.trim() || '';
  const raw = summary && summary !== name ? name + ' — ' + summary : name;
  let label = '调用工具';
  let detail = summary || name;
  const toolKey = name.replace(/^Run\s+/i, '').replace(/^mcp[_:]+/i, '').replace(/^(?:duolabase|duolawork-space)[_:]+/i, '');
  if (Object.hasOwn(workspaceToolLabels, toolKey)) {
    label = workspaceToolLabels[toolKey];
    detail = summary;
  } else if (/ on Web$/i.test(name) || /^(websearch|google_web_search|联网检索)$/i.test(name)) {
    label = '搜索网页';
    detail = summary || name.replace(/ on Web$/i, '');
  } else if (/^(File |read(?:_file)?$|view_file$|读取文件$)/i.test(name)) {
    label = '读取文件';
    detail = summary || name.replace(/^File /, '');
  } else if (/^(edit|write|replace|apply_patch|编辑文件|写入文件)/i.test(name)) {
    label = '编辑文件';
  } else if (/^(grep|rg|find|fd)\b/i.test(name)) {
    label = '检索文件';
  } else if (/^(imageGeneration|生成图片)$/i.test(name)) {
    label = '生成图片';
  } else if (/^(执行命令|exec_command|run_shell_command|python3?|node|bash|sh|zsh|curl|git|npm|pnpm|yarn|ls|cat|sed|awk|mkdir|rm|cp|mv)\b/i.test(name) || name === '执行命令') {
    label = '执行命令';
  }
  if (detail === label || (detail === name && label !== '调用工具' && !/\s/.test(name))) detail = '';
  if (label === '调用工具' && !summary) detail = detail.replace(/^Run mcp_/, '').replace(/^duolawork-space_space_/, 'space_');
  if ((label === '读取文件' || label === '编辑文件') && detail.length > 56 && detail.includes('/')) {
    detail = '…/' + detail.split('/').filter(Boolean).slice(-2).join('/');
  }
  return { label, detail, raw };
}

function ToolTraceRow({ item }: { item: ToolTraceItem }) {
  const [open, setOpen] = useState(false);
  const row = formatToolTraceRow(item);
  const state = item.status === 'error' ? '未完成' : item.status === 'running' ? '进行中' : '已完成';
  const contents = <>
    <span className="turn-tool-mark" role="img" aria-label={state}>
      {item.status === 'done' ? <Check size={13} /> : item.status === 'error' ? <X size={12} /> : <Clock size={12} />}
    </span>
    <strong className="turn-tool-label">{row.label}</strong>
    {row.detail && <span className="turn-tool-detail">{row.detail}</span>}
  </>;
  return <div className={`turn-tool-item status-${item.status}`}>
    {row.detail || row.raw !== row.label ? <>
      <button type="button" className="turn-tool-row" aria-expanded={open} title={row.raw} onClick={() => setOpen(!open)}>
        {contents}
      </button>
      {open && <div className="turn-tool-full">{row.raw}</div>}
    </> : <div className="turn-tool-row">{contents}</div>}
  </div>;
}

const phaseLabels: Record<TurnPhase, string> = {
  processing: '正在处理', thinking: '正在思考', executing: '正在执行',
  writing: '正在回复', queued: '正在排队', waiting_reply: '等待回复', reconnecting: '正在重连执行节点'
};

function executionLabel(tool?: ToolTraceItem): string {
  switch (tool?.name.toLowerCase()) {
    case '执行命令': case 'bash': case 'run_shell_command': return '正在执行命令';
    case '编辑文件': case 'edit': case 'write': case 'write_file': return '正在编辑文件';
    case 'read': case 'read_file': return '正在读取文件';
    case '联网检索': case 'websearch': case 'google_web_search': return '正在搜索';
    case 'imagegeneration': return '正在生成图片';
    default: return phaseLabels.executing;
  }
}

function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { duolaworkDesktop?: DesktopBridge }).duolaworkDesktop;
  return b && b.isDesktop ? b : null;
}

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(max-width: 768px)').matches || window.innerWidth <= 768;
  }
  return window.innerWidth <= 768;
}

function isSameSpaceSelection(
  a: { kind: SpaceItemKind; id: string } | null,
  b: { kind: SpaceItemKind; id: string } | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}

function makeClientRequestId(threadId: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `msgreq:${threadId}:${rand}`;
}

const DEFAULT_DB_STATUS: DuolaBasePublicStatus = {
  enabled: true,
  endpoint: 'https://duolabase.manyaitool.com/mcp',
  hasToken: false,
  tokenSource: 'none',
  consoleUrl: 'https://duolabase.manyaitool.com'
};

export function App(): React.JSX.Element {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dw2-theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [nodes, setNodes] = useState<ExecutionNodeRecord[]>([]);
  const [authState, setAuthState] = useState<{
    checked: boolean;
    authRequired: boolean;
    authenticated: boolean;
  }>({ checked: false, authRequired: false, authenticated: true });
  const [authTab, setAuthTab] = useState<'password' | 'code'>('password');
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authCode, setAuthCode] = useState<string>('');
  const [authError, setAuthError] = useState<string>('');
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [threadSearch, setThreadSearch] = useState<string>('');
  const [tasks, setTasks] = useState<TaskWithLatestRun[]>([]);
  const [duolabaseStatus, setDuolabaseStatus] = useState<DuolaBasePublicStatus>(DEFAULT_DB_STATUS);
  const [archivesOpen, setArchivesOpen] = useState<boolean>(false);
  const [archives, setArchives] = useState<Array<{ id: string; name: string }>>([]);
  const [cloudMode, setCloudMode] = useState(false);
  const [buildId, setBuildId] = useState<string>('dev');
  const [hasDesktopDialog, setHasDesktopDialog] = useState<boolean>(() => Boolean(getDesktopBridge()));
  const [refreshingMembers, setRefreshingMembers] = useState<boolean>(false);

  // Unified center navigation: conversation, task detail, archive, or management pages
  const [viewMode, setViewMode] = useState<MainViewMode>('thread');
  const [activeThreadId, setActiveThreadId] = useState<string>('');
  const [messagesThreadId, setMessagesThreadId] = useState<string>('');
  const [messages, setMessages] = useState<ThreadMessageRecord[]>([]);
  const [streamingDeltas, setStreamingDeltas] = useState<Record<string, string>>({});
  const [streamingTools, setStreamingTools] = useState<Record<string, ToolTraceItem[]>>({});
  const toolEventCount = useRef(0);
  const toolSnapshots = useRef<Record<string, ToolTraceItem[]>>({});
  const [streamingActivity, setStreamingActivity] = useState<Record<string, TurnActivity>>({});
  const [resumingMessage, setResumingMessage] = useState<string | null>(null);
  const [streamDisconnected, setStreamDisconnected] = useState(!navigator.onLine);
  const [expandedToolMsgIds, setExpandedToolMsgIds] = useState<Record<string, boolean>>({});
  const [expandedHandoffIds, setExpandedHandoffIds] = useState<Record<string, boolean>>({});
  const [pendingHandoffPreviews, setPendingHandoffPreviews] = useState<
    Record<string, { meta?: HandoffNoticeMeta; state: 'loading' | 'ready' | 'error' }>
  >({});
  const [copiedHandoffId, setCopiedHandoffId] = useState<string | null>(null);
  const [showAllQuickMembers, setShowAllQuickMembers] = useState<boolean>(false);
  const [inputDrafts, setInputDrafts] = useState<Record<string, string>>({});
  const [draftRefsByThread, setDraftRefsByThread] = useState<Record<string, SpaceReferenceChip[]>>({});
  const [sendingByThread, setSendingByThread] = useState<Record<string, boolean>>({});
  const [clarifySelections, setClarifySelections] = useState<Record<string, Record<string, string[]>>>({});
  const [clarifyNotes, setClarifyNotes] = useState<Record<string, string>>({});
  const [editingThreadTitle, setEditingThreadTitle] = useState<boolean>(false);
  const [threadTitleDraft, setThreadTitleDraft] = useState<string>('');
  const [editingWorkspace, setEditingWorkspace] = useState<boolean>(false);
  const [workspaceDraft, setWorkspaceDraft] = useState<string>('');
  const [chatNotice, setChatNotice] = useState<string>('');
  const [undoArchiveThread, setUndoArchiveThread] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);

  // Read-only archive viewer state
  const [activeArchiveId, setActiveArchiveId] = useState<string>('');
  const [archiveLoading, setArchiveLoading] = useState<boolean>(false);
  const [archiveDetail, setArchiveDetail] = useState<{
    archive: { id: string; name: string; topic?: string | null };
    messages: Array<{ id: string; authorName: string; body: string; createdAt: string }>;
    note?: string;
  } | null>(null);

  // Custom popover states
  const [ownerMenuOpen, setOwnerMenuOpen] = useState<boolean>(false);
  const [taskModalOpen, setTaskModalOpen] = useState<boolean>(false);
  const [leadMenuOpen, setLeadMenuOpen] = useState<boolean>(false);
  const [stepWorkerMenuIdx, setStepWorkerMenuIdx] = useState<number | null>(null);

  // Task detail state
  const requestedRunRef = useRef<string | undefined>(undefined);
  const [activeTaskId, setActiveTaskId] = useState<string>('');
  const [taskDetail, setTaskDetail] = useState<{
    task: TaskRecord;
    runs: TaskRunRecord[];
    activeRun: TaskRunRecord | null;
    steps: EnrichedStep[];
  } | null>(null);

  // Multi-tab Collaboration Space state (closed by default on mobile viewports <= 768px so chat & send button stay unobstructed!)
  const [spaceOpen, setSpaceOpen] = useState<boolean>(() => !isMobileViewport());
  const [wideSpace, setWideSpace] = useState<boolean>(false);
  const [spaceTab, setSpaceTab] = useState<'documents' | 'tasks' | 'resources'>('documents');
  const [spaceSelection, updateSpaceSelection] = useState<{ kind: SpaceItemKind; id: string } | null>(null);
  const [spaceData, setSpaceData] = useState<{ threadId: string; data: ThreadSpaceData } | null>(null);
  const [spaceLoadError, setSpaceLoadError] = useState('');
  const [threadLoadError, setThreadLoadError] = useState('');
  const spaceRequest = useRef(0);
  const threadRequest = useRef(0);
  const spaceThreadId = (viewMode === 'task' ? taskDetail?.task.sourceThreadId : activeThreadId) || '';
  const requestedSpaceThread = useRef(spaceThreadId);
  useLayoutEffect(() => {
    requestedSpaceThread.current = spaceThreadId;
  }, [spaceThreadId]);
  const hasLoadedSpace = spaceData?.threadId === spaceThreadId;
  const materialsState = hasLoadedSpace ? 'ready' : spaceThreadId && spaceLoadError === spaceThreadId ? 'error' : 'loading';
  const { folders: spaceFolders, items: spaceItems, trash: spaceTrash, tasks: spaceTasks } =
    (hasLoadedSpace && spaceData?.data) || emptySpace;

  // Active document editor state
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactVersionRecord[]>([]);
  const [docDraft, setDocDraft] = useState<string>('');
  const [docEditing, setDocEditing] = useState<boolean>(false);
  const [docNotice, setDocNotice] = useState<string>('');

  const documentEditingRef = useRef(false);
  documentEditingRef.current = docEditing;
  const selectionRef = useRef(spaceSelection);
  const loadedDocument = useRef<string | null>(null);
  const documentRequest = useRef(0);
  const taskRequest = useRef(0);
  const setSpaceSelection = useCallback((next: typeof spaceSelection) => {
    if (
      isSameSpaceSelection(selectionRef.current, next) &&
      (!next || next.kind !== 'document' || loadedDocument.current === next.id)
    ) {
      return;
    }
    loadedDocument.current = null;
    documentRequest.current++;
    selectionRef.current = next;
    updateSpaceSelection(next);
    setArtifact(null);
    setVersions([]);
    setDocDraft('');
    setDocNotice('');
    setDocEditing(false);
  }, []);

  // Inline create-task state inside conversation
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');
  const [newTaskKind, setNewTaskKind] = useState<'once' | 'scheduled'>('once');
  const [newTaskCron, setNewTaskCron] = useState<string>('0 8,20 * * *');
  const [newTaskStartNow, setNewTaskStartNow] = useState<boolean>(false);
  const [newTaskLeadId, setNewTaskLeadId] = useState<string>('');
  const [newTaskSteps, setNewTaskSteps] = useState<
    Array<{ title: string; assigneeMemberId: string; brief: string; dependsOnPrev: boolean }>
  >([
    { title: '执行调研与产出初稿', assigneeMemberId: '', brief: '产出初稿供审阅', dependsOnPrev: false }
  ]);
  const [waitingReplies, setWaitingReplies] = useState<Record<string,string>>({});
  const updateWaitingReply = (runId: string, reply: string) => setWaitingReplies(old => ({...old,[runId]:reply}));
  const [draftImagesByThread, setDraftImagesByThread] = useState<
    Record<string, Array<{ id: string; name: string; url: string }>>
  >({});
  const [uploadingChatImages, setUploadingChatImages] = useState<boolean>(false);
  const [spaceFocusFolderReq, setSpaceFocusFolderReq] = useState<{
    folderId: string | null;
    seq: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileRef = useRef<HTMLInputElement | null>(null);
  const composerImageRef = useRef<HTMLInputElement | null>(null);
  const activeThreadIdRef = useRef<string>('');
  const deletingTaskIdRef = useRef<string | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const chatNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClientReqByThreadRef = useRef<Record<string, { key: string; text: string }>>({});
  const lastSseEventIdRef = useRef<string>('');
  const sseBootIdRef = useRef<string | null>(null);
  const sseBuildIdRef = useRef<string | null>(null);
  const sseHadDisconnectRef = useRef<boolean>(false);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
    if (activeThreadId) {
      try { sessionStorage.setItem('dw2-thread', activeThreadId); } catch { /* Storage is optional. */ }
    }
  }, [activeThreadId]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const handleMq = (ev: MediaQueryListEvent) => {
      if (ev.matches) {
        setSpaceOpen(false);
      }
    };
    mq.addEventListener?.('change', handleMq);
    return () => mq.removeEventListener?.('change', handleMq);
  }, []);

  const showChatNotice = useCallback(
    (msg: string, undoThread?: { id: string; title: string } | null) => {
      if (chatNoticeTimerRef.current) clearTimeout(chatNoticeTimerRef.current);
      setChatNotice(msg);
      setUndoArchiveThread(undoThread ?? null);
      if (msg) {
        chatNoticeTimerRef.current = setTimeout(() => {
          setChatNotice('');
          setUndoArchiveThread(null);
        }, undoThread ? 5500 : 3200);
      }
    },
    []
  );

  const resetTransientMenus = useCallback(() => {
    setTaskModalOpen(false);
    setEditingThreadTitle(false);
    setEditingWorkspace(false);
    setOwnerMenuOpen(false);
    setLeadMenuOpen(false);
    setStepWorkerMenuIdx(null);
    setConfirmDeleteTaskId(null);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('dw2-theme', dark ? 'dark' : 'light');
    } catch {
      // ignore storage errors
    }
    const bridge = getDesktopBridge();
    if (bridge?.setTheme) {
      void bridge.setTheme(dark ? 'dark' : 'light').catch(() => {});
    } else if (authState.checked && authState.authenticated && !cloudMode) {
      void fetch('/api/v2/desktop/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: dark ? 'dark' : 'light' })
      }).catch(() => {});
    }
  }, [dark, cloudMode, authState.checked, authState.authenticated]);

  const memberById = useMemo(() => {
    const map = new Map<string, MemberRecord>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  );

  const visibleThreads = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const owner = memberById.get(t.activeOwnerMemberId)?.name || '';
      return t.title.toLowerCase().includes(q) || owner.toLowerCase().includes(q);
    });
  }, [threads, threadSearch, memberById]);

  const loadBootstrap = useCallback(async (preserveSelection = true) => {
    const res = await fetch('/api/v2/bootstrap');
    if (res.status === 401) {
      setAuthState({ checked: true, authRequired: true, authenticated: false });
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    setAuthState({
      checked: true,
      authRequired: Boolean(data.auth?.authRequired),
      authenticated: data.auth?.authenticated !== false
    });
    setCloudMode(data.cloudMode === true);
    setMembers(data.members || []);
    setNodes(data.nodes || []);
    setThreads(data.threads || []);
    setTasks(data.tasks || []);
    if (data.duolabase) {
      setDuolabaseStatus({ ...DEFAULT_DB_STATUS, ...data.duolabase });
    }
    setArchives(data.archives || []);
    if (data.buildInfo?.id) {
      setBuildId(String(data.buildInfo.id));
    }
    setHasDesktopDialog(Boolean(data.hasDesktopDialog || getDesktopBridge()));

    const activeThreads: ThreadRecord[] = data.threads || [];
    let savedId: string | null = null;
    try { savedId = sessionStorage.getItem('dw2-thread'); } catch { /* Fall back to the first conversation. */ }
    const initialId = activeThreads.find(thread => thread.id === savedId)?.id || activeThreads[0]?.id || '';
    setActiveThreadId(prev => preserveSelection && prev ? prev : initialId);
    if (data.members?.length > 0 && !newTaskLeadId) {
      setNewTaskLeadId(data.members[0].id);
      setNewTaskSteps((prev) =>
        prev.map((s) => ({ ...s, assigneeMemberId: s.assigneeMemberId || data.members[0].id }))
      );
    }
  }, [newTaskLeadId]);

  const loadSpace = useCallback(async (threadId: string) => {
    if (!threadId || threadId !== requestedSpaceThread.current) return;
    const request = ++spaceRequest.current;
    setSpaceLoadError('');
    const current = () => request === spaceRequest.current && threadId === requestedSpaceThread.current;
    try {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(threadId)}/space`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!current()) return;
      setSpaceData({
        threadId,
        data: { folders: data.folders || [], items: data.items || [], trash: data.trash || [], tasks: data.tasks || [] }
      });
    } catch {
      if (current()) setSpaceLoadError(threadId);
    }
  }, []);

  useEffect(() => {
    if (spaceThreadId && (viewMode === 'thread' || viewMode === 'task')) void loadSpace(spaceThreadId);
  }, [spaceThreadId, viewMode, loadSpace]);

  const loadThread = useCallback(
    async (threadId: string) => {
      if (!threadId) return;
      const request = ++threadRequest.current;
      const toolsAtRequest = toolEventCount.current;
      setThreadLoadError('');
      const current = () => request === threadRequest.current && activeThreadIdRef.current === threadId;
      let data;
      try {
        const res = await fetch(`/api/v2/threads/${encodeURIComponent(threadId)}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(String(res.status));
        data = await res.json();
      } catch {
        if (current()) setThreadLoadError(threadId);
        return;
      }
      if (!current()) return;
      const nextMsgs: ThreadMessageRecord[] = data.messages || [];
      setMessagesThreadId(threadId);
      setMessages(nextMsgs);
      setStreamingActivity((prev) => {
        const next: Record<string, TurnActivity> = {};
        for (const msg of nextMsgs) {
          const recent = prev[msg.id];
          if (msg.turnStatus === 'running' && recent && recent.revision > (msg.activity?.revision ?? 0)) next[msg.id] = recent;
        }
        return next;
      });
      setPendingHandoffPreviews({});
      setStreamingDeltas((prev) => {
        const next: Record<string, string> = {};
        for (const msg of nextMsgs) {
          if (msg.turnStatus === 'running' && prev[msg.id]) {
            next[msg.id] = prev[msg.id];
          }
        }
        return next;
      });
      const snapshots: Record<string, ToolTraceItem[]> = {};
      for (const msg of nextMsgs) {
        if (msg.turnStatus === 'running') {
          snapshots[msg.id] = (toolsAtRequest !== toolEventCount.current && toolSnapshots.current[msg.id]) || msg.toolTrace || [];
        }
      }
      toolSnapshots.current = snapshots;
      setStreamingTools(snapshots);
    },
    []
  );

  const visibleMessages = useMemo(
    () => {
      if (messagesThreadId !== activeThreadId) return [];
      const latest = new Map<string, string>();
      const scheduled = new Set(tasks.filter(t => t.kind === 'scheduled').map(t => t.id));
      const key = (card: NonNullable<ThreadMessageRecord['taskCard']>) =>
        scheduled.has(card.taskId) ? card.taskId + '/' + (card.runId ?? 'schedule') : card.taskId;
      for (const m of messages) if (m.taskCard) latest.set(key(m.taskCard), m.id);
      return messages.filter(m => m.authorKind !== 'task_receipt' && (!m.taskCard || latest.get(key(m.taskCard)) === m.id));
    },
    [messagesThreadId, activeThreadId, messages, tasks]
  );

  const lastConversationTurn = visibleMessages.findLast(m => m.authorKind === 'user' || m.authorKind === 'agent');
  const waitingForTurn = visibleMessages.some(message => message.turnStatus === 'running');
  useEffect(() => {
    if (!streamDisconnected || !waitingForTurn || viewMode !== 'thread' || !activeThreadId) return;
    // A proxy can block SSE while ordinary HTTP is already available.
    let pending = false;
    const timer = window.setInterval(async () => {
      if (pending || !navigator.onLine || document.hidden) return;
      pending = true;
      try { await loadThread(activeThreadId); } finally { pending = false; }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [streamDisconnected, waitingForTurn, viewMode, activeThreadId, loadThread]);

  // Historical replies can contain internal sync diagnostics with a guessed sender.
  // Only attribute a supplemental delivery to the authors of replies actually included.
  const crossAgentLateReplies = useMemo(() => {
    const bySeq = new Map(visibleMessages.map((m) => [m.seq, m]));
    const deliveries = new Map<string, ThreadMessageRecord[]>();
    for (const reply of visibleMessages) {
      const meta = reply.handoffMeta;
      if (reply.authorKind !== 'agent' || reply.authorId !== meta?.toMemberId ||
          meta.status !== 'delivered' || meta.reason !== 'late_arrival') {
        continue;
      }
      const included: ThreadMessageRecord[] = [];
      for (const seq of meta.lateArrivalSeqs ?? []) {
        const source = bySeq.get(seq);
        if (seq >= (meta.includedFromSeq ?? Infinity) && seq <= (meta.includedToSeq ?? -Infinity) &&
            source?.authorKind === 'agent' && source.authorId !== reply.authorId) {
          included.push(source);
        }
      }
      if (included.length) deliveries.set(reply.id, included);
    }
    return deliveries;
  }, [visibleMessages]);

  useEffect(() => {
    if (viewMode !== 'thread' || !messagesScrollRef.current) return;
    const el = messagesScrollRef.current;
    el.scrollTop = el.scrollHeight;
  }, [viewMode, activeThreadId, visibleMessages.length]);

  useEffect(() => {
    if (viewMode !== 'thread' || !messagesScrollRef.current) return;
    const el = messagesScrollRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [viewMode, streamingDeltas]);

  const loadArtifactDetail = useCallback(async (artifactId: string, refresh = false) => {
    const selected = selectionRef.current;
    if (selected?.kind !== 'document' || selected.id !== artifactId) return;
    if (refresh && loadedDocument.current !== artifactId) return;
    const request = ++documentRequest.current;
    try {
      const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(artifactId)}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (request !== documentRequest.current || (refresh && documentEditingRef.current)) return;
      if (data.artifact?.id !== artifactId) throw new Error();
      loadedDocument.current = artifactId;
      setArtifact(data.artifact);
      setVersions(data.versions || []);
      setDocDraft(data.artifact.content);
      setDocNotice('');
    } catch {
      if (request === documentRequest.current) setDocNotice('文稿加载失败，请返回列表重新打开');
    }
  }, []);

  const loadArchiveDetail = useCallback(async (channelId: string) => {
    if (!channelId) return;
    setArchiveLoading(true);
    try {
      const res = await fetch(`/api/v2/legacy-archives/${encodeURIComponent(channelId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setArchiveDetail(data);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  const loadTaskDetail = useCallback(async (taskId: string, runId?: string) => {
    if (!taskId) return;
    const request = ++taskRequest.current;
    const q = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}${q}`);
    if (!res.ok) return;
    const data = await res.json();
    if (request !== taskRequest.current) return;
    setTaskDetail({
      task: data.task,
      runs: data.runs || [],
      activeRun: data.activeRun || null,
      steps: data.steps || []
    });
    if (data.task?.sourceThreadId) {
      void loadSpace(data.task.sourceThreadId);
    }
  }, [loadSpace]);

  const taskArtifactId = taskDetail?.activeRun?.finalArtifactId;
  useEffect(() => {
    if (viewMode !== 'task' || taskDetail?.task.id !== activeTaskId) return;
    setSpaceSelection(taskArtifactId ? { kind: 'document', id: taskArtifactId } : null);
    if (taskArtifactId && !isMobileViewport()) setSpaceOpen(true);
  }, [viewMode, activeTaskId, taskDetail?.task.id, taskArtifactId, setSpaceSelection]);

  useEffect(() => {
    let disposed = false;
    let retry: number;
    const initialize = async () => {
      try {
        const response = await fetch('/api/v2/auth/status');
        if (!response.ok) throw new Error();
        const status = await response.json();
        if (disposed) return;
        if (status.authRequired && !status.authenticated) {
          setAuthState({checked:true, authRequired:true, authenticated:false});
        } else await loadBootstrap(false);
      } catch {
        if (!disposed) retry = window.setTimeout(initialize, 2500);
      }
    };
    void initialize();
    return () => { disposed = true; window.clearTimeout(retry); };
  }, []);

  useEffect(() => {
    if (viewMode === 'thread' && activeThreadId) {
      void loadThread(activeThreadId);
    }
  }, [viewMode, activeThreadId, loadThread]);

  useEffect(() => {
    if (viewMode === 'task' && activeTaskId) {
      void loadTaskDetail(activeTaskId, requestedRunRef.current);
      requestedRunRef.current = undefined;
    }
  }, [viewMode, activeTaskId, loadTaskDetail]);

  useEffect(() => {
    if (viewMode === 'archive' && activeArchiveId) {
      void loadArchiveDetail(activeArchiveId);
    }
  }, [viewMode, activeArchiveId, loadArchiveDetail]);

  useEffect(() => {
    if (spaceSelection?.kind === 'document' && spaceSelection.id) {
      void loadArtifactDetail(spaceSelection.id);
    }
  }, [spaceSelection, loadArtifactDetail]);

  const liveViewRef = useRef({
    viewMode,
    activeThreadId,
    activeTaskId,
    activeRunId: taskDetail?.activeRun?.id,
    spaceSelection,
    loadBootstrap,
    loadSpace,
    loadThread,
    loadTaskDetail,
    loadArtifactDetail
  });

  useEffect(() => {
    liveViewRef.current = {
      viewMode,
      activeThreadId,
      activeTaskId,
      activeRunId: taskDetail?.activeRun?.id,
      spaceSelection,
      loadBootstrap,
      loadSpace,
      loadThread,
      loadTaskDetail,
      loadArtifactDetail
    };
  }, [
    viewMode,
    activeThreadId,
    activeTaskId,
    taskDetail?.activeRun?.id,
    spaceSelection,
    loadBootstrap,
    loadSpace,
    loadThread,
    loadTaskDetail,
    loadArtifactDetail
  ]);

  useEffect(() => {
    if (!authState.checked || (authState.authRequired && !authState.authenticated)) return;

    const syncAllActiveViews = () => {
      const cur = liveViewRef.current;
      void cur.loadBootstrap(true);
      if (cur.viewMode === 'thread' && cur.activeThreadId) {
        void cur.loadThread(cur.activeThreadId);
        void cur.loadSpace(cur.activeThreadId);
      } else if (cur.viewMode === 'task' && cur.activeTaskId) {
        void cur.loadTaskDetail(cur.activeTaskId, cur.activeRunId);
      }
      if (!documentEditingRef.current && cur.spaceSelection?.kind === 'document' && cur.spaceSelection.id) {
        void cur.loadArtifactDetail(cur.spaceSelection.id, true);
      }
    };

    const sseUrl = lastSseEventIdRef.current
      ? `/api/v2/events?lastEventId=${encodeURIComponent(lastSseEventIdRef.current)}`
      : '/api/v2/events';
    const es = new EventSource(sseUrl);

    es.onmessage = (ev) => {
      if (ev.lastEventId) {
        lastSseEventIdRef.current = ev.lastEventId;
      }
      try {
        const parsed = JSON.parse(ev.data);
        const cur = liveViewRef.current;

        if (parsed.type === 'auth.revoked') {
          es.close();
          setAuthState({ checked: true, authRequired: true, authenticated: false });
          return;
        }
        if (parsed.type === 'connected') {
          setStreamDisconnected(false);
          const nextBootId = typeof parsed.bootId === 'string' ? parsed.bootId : null;
          const nextBuildId = typeof parsed.buildId === 'string' ? parsed.buildId : null;
          if (
            nextBuildId &&
            nextBuildId !== 'dev' &&
            sseBuildIdRef.current &&
            sseBuildIdRef.current !== nextBuildId
          ) {
            window.location.reload();
            return;
          }
          if (nextBuildId) {
            sseBuildIdRef.current = nextBuildId;
          }
          const bootChanged = Boolean(
            sseBootIdRef.current && nextBootId && sseBootIdRef.current !== nextBootId
          );
          if (bootChanged) setStreamingActivity({});
          if (bootChanged || sseHadDisconnectRef.current) {
            syncAllActiveViews();
          }
          if (nextBootId) {
            sseBootIdRef.current = nextBootId;
          }
          sseHadDisconnectRef.current = false;
          return;
        }
        if (parsed.type === 'sync.full_refresh') {
          syncAllActiveViews();
          return;
        }
        if (parsed.type === 'nodes.updated' && Array.isArray(parsed.payload)) {
          setNodes(parsed.payload as ExecutionNodeRecord[]);
          return;
        }
        if (parsed.type === 'thread.delta') {
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId && parsed.payload?.messageId) {
            const msgId = String(parsed.payload.messageId);
            const chunk = String(parsed.payload.text || '');
            if (chunk) {
              setStreamingDeltas((prev) => ({ ...prev, [msgId]: (prev[msgId] || '') + chunk }));
            }
          }
          return;
        }
        if (parsed.type === 'thread.activity') {
          const { messageId, activity } = parsed.payload ?? {};
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId && messageId && activity) {
            setStreamingActivity(prev => ({ ...prev, [messageId]: activity }));
          }
          return;
        }
        if (parsed.type === 'thread.tool') {
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId && parsed.payload?.messageId) {
            const msgId = String(parsed.payload.messageId);
            let trace: ToolTraceItem[];
            if (Array.isArray(parsed.payload.toolTrace)) {
              trace = parsed.payload.toolTrace;
            } else {
              const { index, item } = parsed.payload;
              const prior = toolSnapshots.current[msgId];
              if (!prior || !Number.isInteger(index) || index < 0 || index > prior.length || !item) {
                void cur.loadThread(cur.activeThreadId);
                return;
              }
              trace = prior.slice();
              trace[index] = item;
            }
            toolEventCount.current++;
            toolSnapshots.current = { ...toolSnapshots.current, [msgId]: trace };
            setStreamingTools(toolSnapshots.current);
          }
          return;
        }
        if (parsed.type === 'thread.space_updated') {
          if (parsed.threadId === cur.activeThreadId) {
            void cur.loadSpace(cur.activeThreadId);
          }
          return;
        }
        if (parsed.type?.startsWith('thread.')) {
          if (parsed.type === 'thread.message_updated' && parsed.payload?.turnStatus === 'failed' &&
              parsed.threadId === cur.activeThreadId && cur.viewMode === 'thread') {
            showChatNotice(readableTurnFailure(parsed.payload.body || '暂时未能收到回复'));
          }
          void cur.loadBootstrap(true);
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId) {
            void cur.loadThread(cur.activeThreadId);
          }
        } else if (parsed.type === 'task.deleted') {
          void cur.loadBootstrap(true);
          if (parsed.taskId === cur.activeTaskId) {
            setTaskDetail(null);
            setActiveTaskId('');
            if (cur.viewMode === 'task') {
              setViewMode(parsed.threadId ? 'thread' : 'schedules');
            }
          }
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId) {
            void cur.loadThread(cur.activeThreadId);
          }
        } else if (parsed.type?.startsWith('task.')) {
          void cur.loadBootstrap(true);
          if (
            cur.viewMode === 'task' &&
            parsed.taskId === cur.activeTaskId &&
            deletingTaskIdRef.current !== parsed.taskId
          ) {
            void cur.loadTaskDetail(cur.activeTaskId, cur.activeRunId);
          }
          if (cur.viewMode === 'thread' && parsed.threadId === cur.activeThreadId) {
            void cur.loadThread(cur.activeThreadId);
          }
        }
      } catch {
        // ignore heartbeat
      }
    };

    es.onerror = () => {
      setStreamDisconnected(true);
      sseHadDisconnectRef.current = true;
      void fetch('/api/v2/auth/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((st) => {
          if (st && st.authRequired && !st.authenticated) {
            es.close();
            setAuthState({ checked: true, authRequired: true, authenticated: false });
          }
        })
        .catch(() => {});
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncAllActiveViews();
      }
    };
    const handleOnline = () => {
      setStreamDisconnected(es.readyState !== EventSource.OPEN);
      syncAllActiveViews();
    };
    const handleOffline = () => setStreamDisconnected(true);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      es.close();
    };
  }, [authState.checked, authState.authRequired, authState.authenticated]);

  const handleCloudLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthSubmitting(true);
    try {
      const endpoint = authTab === 'password' ? '/api/v2/auth/login' : '/api/v2/auth/magic-login';
      const payload = authTab === 'password' ? { password: authPassword } : { code: authCode };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(data.message || '登录失败，请检查输入');
        return;
      }
      setAuthPassword('');
      setAuthCode('');
      setAuthState({ checked: true, authRequired: true, authenticated: true });
      await loadBootstrap(false);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleCloudLogout = async () => {
    await fetch('/api/v2/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthState({ checked: true, authRequired: true, authenticated: false });
  };

  const handleCreateThread = async (preferredMemberId?: string) => {
    const defaultOwner = preferredMemberId || activeThread?.activeOwnerMemberId || members[0]?.id || '';
    const ownerName = memberById.get(defaultOwner)?.name;
    const res = await fetch('/api/v2/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: preferredMemberId && ownerName ? `与 ${ownerName} 对话` : `新对话 ${threads.length + 1}`,
        activeOwnerMemberId: defaultOwner
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showChatNotice(err.message || '新建对话失败');
      return;
    }
    const data = await res.json();
    resetTransientMenus();
    await loadBootstrap(true);
    setViewMode('thread');
    setSpaceSelection(null);
    setSpaceTab('documents');
    setMessagesThreadId(data.thread.id);
    setMessages([]);
    setActiveThreadId(data.thread.id);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleTogglePinThread = async (thread: ThreadRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !thread.pinnedAt })
    });
    if (res.ok) {
      await loadBootstrap(true);
    }
  };

  const handleArchiveThread = async (thread: ThreadRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(thread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showChatNotice(err.message || '归档对话失败');
      return;
    }
    if (activeThreadId === thread.id) {
      const remaining = threads.filter((x) => x.id !== thread.id);
      setActiveThreadId(remaining[0]?.id || '');
      resetTransientMenus();
    }
    await loadBootstrap(false);
    showChatNotice(`已归档对话「${thread.title}」`, { id: thread.id, title: thread.title });
  };

  const handleRestoreArchivedThread = async (threadId: string) => {
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    });
    if (!res.ok) {
      showChatNotice('恢复对话失败');
      return;
    }
    await loadBootstrap(true);
    setActiveThreadId(threadId);
    setViewMode('thread');
    showChatNotice('已恢复对话');
  };

  const handleSwitchOwner = async (memberId: string) => {
    setOwnerMenuOpen(false);
    setEditingWorkspace(false);
    if (!activeThreadId || activeThread?.activeOwnerMemberId === memberId) return;
    const targetThreadId = activeThreadId;
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(targetThreadId)}/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showChatNotice(err.message || '切换对接成员失败');
      return;
    }
    const data = await res.json();
    if (activeThreadIdRef.current === targetThreadId) {
      setPendingHandoffPreviews({});
      setMessagesThreadId(targetThreadId);
      setMessages(data.messages || []);
    }
    await loadBootstrap(true);
  };

  const submitMessageToThread = async (
    targetThreadId: string,
    text: string,
    opts?: {
      clarifyReply?: { messageId: string; summary: string };
      restoreOnFail?: () => void;
    }
  ) => {
    if (!targetThreadId || !text.trim() || sendingByThread[targetThreadId]) return;
    const prevPending = pendingClientReqByThreadRef.current[targetThreadId];
    const idempotencyKey =
      prevPending && prevPending.text === text
        ? prevPending.key
        : makeClientRequestId(targetThreadId);
    pendingClientReqByThreadRef.current[targetThreadId] = { key: idempotencyKey, text };

    setSendingByThread((prev) => ({ ...prev, [targetThreadId]: true }));
    try {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(targetThreadId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
        body: JSON.stringify({
          body: text,
          idempotencyKey,
          ...(opts?.clarifyReply ? { clarifyReply: opts.clarifyReply } : {})
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.persistedUserMessageId) {
          delete pendingClientReqByThreadRef.current[targetThreadId];
          showChatNotice(readableTurnFailure(data.message || data.error || '发送失败，请检查成员状态后重试'));
          if (activeThreadIdRef.current === targetThreadId) {
            await loadThread(targetThreadId);
          }
        } else {
          opts?.restoreOnFail?.();
          showChatNotice(data.message || data.error || '消息未能送达服务端，草稿已保留，可直接重试');
        }
        return;
      }
      delete pendingClientReqByThreadRef.current[targetThreadId];
      if (activeThreadIdRef.current === targetThreadId) {
        if (res.status === 202) await loadThread(targetThreadId);
        if (data.messages) {
          setMessagesThreadId(targetThreadId);
          setMessages(data.messages);
          setStreamingDeltas({});
        }
        if (data.artifact && selectionRef.current?.id === data.artifact.id && !documentEditingRef.current) {
          void loadArtifactDetail(data.artifact.id, true);
        }
      }
      await loadBootstrap(true);
    } catch {
      opts?.restoreOnFail?.();
      showChatNotice('网络异常，草稿与资料引用已保留，恢复网络后可直接重试');
    } finally {
      setSendingByThread((prev) => ({ ...prev, [targetThreadId]: false }));
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const targetThreadId = activeThreadId;
    if (!targetThreadId || sendingByThread[targetThreadId] || visibleMessages.some(m => m.turnStatus === 'running')) return;
    const rawDraftValue = inputDrafts[targetThreadId] || '';
    const rawText = rawDraftValue.trim();
    const savedRefs = draftRefsByThread[targetThreadId] || [];
    const savedImages = draftImagesByThread[targetThreadId] || [];
    if (!rawText && savedRefs.length === 0 && savedImages.length === 0) return;

    const refPrefix =
      savedRefs.length > 0
        ? `[引用资料] ${savedRefs.map((r) => r.snippet).join('；')}${rawText || savedImages.length > 0 ? '\n\n' : ''}`
        : '';
    const imageBlock =
      savedImages.length > 0
        ? savedImages.map((img) => `![${img.name}](${img.url})`).join('\n')
        : '';
    const text = [
      refPrefix ? refPrefix.trimEnd() : '',
      rawText,
      imageBlock
    ]
      .filter(Boolean)
      .join('\n\n');

    const restoreUnconfirmedDraft = () => {
      setInputDrafts((prev) => ({
        ...prev,
        [targetThreadId]: prev[targetThreadId] ? prev[targetThreadId] : rawDraftValue
      }));
      setDraftRefsByThread((prev) => ({
        ...prev,
        [targetThreadId]:
          prev[targetThreadId] && prev[targetThreadId].length > 0 ? prev[targetThreadId] : savedRefs
      }));
      setDraftImagesByThread((prev) => ({
        ...prev,
        [targetThreadId]:
          prev[targetThreadId] && prev[targetThreadId].length > 0 ? prev[targetThreadId] : savedImages
      }));
    };

    setInputDrafts((prev) => ({ ...prev, [targetThreadId]: '' }));
    setDraftRefsByThread((prev) => ({ ...prev, [targetThreadId]: [] }));
    setDraftImagesByThread((prev) => ({ ...prev, [targetThreadId]: [] }));
    await submitMessageToThread(targetThreadId, text, {
      restoreOnFail: restoreUnconfirmedDraft
    });
  };

  const getSelectedOptionsForClarifyQuestion = (
    messageId: string,
    q: ClarificationCardData['questions'][number]
  ): string[] => {
    const chosen = clarifySelections[messageId]?.[q.id];
    if (chosen && chosen.length > 0) return chosen;
    return q.options.length > 0 ? [q.options[0]] : [];
  };

  const handleToggleClarifyOption = (
    messageId: string,
    q: ClarificationCardData['questions'][number],
    option: string
  ) => {
    setClarifySelections((prev) => {
      const msgMap = prev[messageId] || {};
      const current = msgMap[q.id] ?? (q.options.length > 0 ? [q.options[0]] : []);
      let next: string[];
      if (q.multiSelect) {
        next = current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option];
        if (next.length === 0) next = [option];
      } else {
        next = [option];
      }
      return {
        ...prev,
        [messageId]: {
          ...msgMap,
          [q.id]: next
        }
      };
    });
  };

  const handleConfirmClarificationCard = async (
    msg: ThreadMessageRecord,
    useDefaults: boolean
  ) => {
    if (!msg.clarificationCard || sendingByThread[msg.threadId]) return;
    const card = msg.clarificationCard;
    const note = (clarifyNotes[msg.id] || '').trim();
    const answerLines: string[] = [];
    const summaryParts: string[] = [];

    card.questions.forEach((q, idx) => {
      const picked = useDefaults
        ? q.options.length > 0
          ? [q.options[0]]
          : []
        : getSelectedOptionsForClarifyQuestion(msg.id, q);
      const valText = picked.length > 0 ? picked.join('、') : '按合理默认处理';
      answerLines.push(`${idx + 1}. ${q.question}：${valText}`);
      summaryParts.push(valText);
    });

    if (note) {
      answerLines.push(`补充说明：${note}`);
      summaryParts.push(note);
    }

    const header = useDefaults
      ? '【已确认需求：按默认推荐方案立即立项派发任务】'
      : '【已确认需求：请按以下确认项立即立项派发任务】';
    const fullText = `${header}\n${answerLines.join('\n')}`;
    const shortSummary = summaryParts.join(' · ').slice(0, 140);

    await submitMessageToThread(msg.threadId, fullText, {
      clarifyReply: {
        messageId: msg.id,
        summary: shortSummary
      }
    });
  };

  const continueTurn = async (message: ThreadMessageRecord) => {
    if (resumingMessage) return;
    setResumingMessage(message.id);
    try {
      const res = await fetch(`/api/v2/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.id)}/continue`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error();
      const result = await res.json();
      if (activeThreadIdRef.current !== message.threadId) return;
      await loadThread(message.threadId);
      const notices: Record<string, string> = {
        completed: '已找回原回复', waiting: '原任务仍在执行，收到回复后会自动显示',
        stopping: '执行节点正在停止原任务，结束后可以继续',
        unreachable: '暂时连不上原执行节点。可以等待重连，也可以切换在线成员后继续',
        unavailable: '当前成员离线，恢复后可继续，也可以切换成员',
        superseded: '这段对话已经有了新的处理记录',
        busy: '这段对话还有任务正在执行'
      };
      if (notices[result.status]) showChatNotice(notices[result.status]);
    } catch {
      showChatNotice('暂时连不上工作台。恢复连接后可以再次点继续。');
    } finally { setResumingMessage(null); }
  };

  const handleAbortTurn = async () => {
    const targetThreadId = activeThreadId;
    if (!targetThreadId) return;
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(targetThreadId)}/abort`, {
      method: 'POST'
    });
    if (res.ok) {
      const data = await res.json();
      if (activeThreadIdRef.current === targetThreadId && data.messages) {
        setMessagesThreadId(targetThreadId);
        setMessages(data.messages);
      }
      setStreamingDeltas({});
    }
    setSendingByThread((prev) => ({ ...prev, [targetThreadId]: false }));
  };

  const handleSaveThreadTitle = async () => {
    if (!activeThread) return;
    const trimmed = threadTitleDraft.trim();
    setEditingThreadTitle(false);
    if (!trimmed || trimmed === activeThread.title) return;
    const res = await fetch(`/api/v2/threads/${encodeURIComponent(activeThread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed })
    });
    if (res.ok) {
      await loadBootstrap(true);
    }
  };

  const handleChooseThreadWorkspace = async () => {
    if (!activeThread) return;
    try {
      const bridge = getDesktopBridge();
      if (bridge?.chooseDirectory) {
        const picked = await bridge.chooseDirectory(activeThread.workspacePath || undefined);
        if (picked) {
          const localNode = nodes.find((n) => n.kind === 'local' && n.status === 'online') ?? nodes.find((n) => n.kind === 'local');
          await fetch(`/api/v2/threads/${encodeURIComponent(activeThread.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspacePath: picked,
              ...(localNode ? { workspaceNodeId: localNode.id } : {})
            })
          });
          await loadBootstrap(true);
        }
        return;
      }

      const res = await fetch('/api/v2/desktop/choose-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultPath: activeThread.workspacePath || undefined })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.path) {
          await fetch(`/api/v2/threads/${encodeURIComponent(activeThread.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspacePath: data.path })
          });
          await loadBootstrap(true);
          return;
        }
      }
    } catch {
      // Fallback to inline path input
    }
    setWorkspaceDraft(activeThread.workspacePath || '');
    setEditingWorkspace((v) => !v);
  };

  const handleSaveWorkspaceDraft = async () => {
    if (!activeThread) return;
    await fetch(`/api/v2/threads/${encodeURIComponent(activeThread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspaceDraft.trim() || null })
    });
    setEditingWorkspace(false);
    await loadBootstrap(true);
  };

  const handleRefreshMembers = async () => {
    setRefreshingMembers(true);
    try {
      const res = await fetch('/api/v2/members/refresh-health', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.members)) setMembers(data.members);
      }
    } finally {
      setRefreshingMembers(false);
    }
  };

  const handleCopyArtifact = async () => {
    if (!docDraft) return;
    try {
      await navigator.clipboard.writeText(docDraft);
      setDocNotice('已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = docDraft;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setDocNotice('已复制文本');
    }
    setTimeout(() => setDocNotice(''), 2500);
  };

  const handleExportArtifact = () => {
    const filename = artifact?.title || 'duolawork-artifact.md';
    const blob = new Blob([docDraft], { type: 'text/markdown;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    setDocNotice(`已导出 ${a.download}`);
    setTimeout(() => setDocNotice(''), 2500);
  };

  const handleSaveArtifact = async () => {
    const selected = selectionRef.current;
    if (!artifact || selected?.kind !== 'document' || selected.id !== artifact.id) return;
    const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(artifact.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBaseVersion: artifact.headVersion,
        content: docDraft
      })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!isSameSpaceSelection(selectionRef.current, selected)) return;
    documentRequest.current++;
    setArtifact(data.artifact);
    setVersions(data.versions || []);
    setDocDraft(data.artifact.content);
    setDocEditing(false);
    if (activeThreadId) {
      void loadSpace(activeThreadId);
    }
    setDocNotice(data.conflict ? '检测到版本冲突，已另存为冲突分支版本' : `已保存为 v${data.artifact.headVersion}`);
    setTimeout(() => setDocNotice(''), 3000);
  };

  const handleQuoteToChat = (ref: SpaceReferenceChip) => {
    const targetId = activeThreadId || taskDetail?.task.sourceThreadId || '';
    if (!targetId) return;
    setViewMode('thread');
    setActiveThreadId(targetId);
    if (isMobileViewport()) {
      setSpaceOpen(false);
    }
    setDraftRefsByThread((prev) => {
      const existing = prev[targetId] || [];
      if (existing.some((x) => x.kind === ref.kind && x.id === ref.id)) return prev;
      return { ...prev, [targetId]: [...existing, ref] };
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const uploadChatImages = async (files: File[]) => {
    const targetThreadId = activeThreadId;
    if (!targetThreadId || files.length === 0) return;
    const imageFiles = files.filter(
      (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name)
    );
    if (imageFiles.length === 0) {
      await uploadFilesToThreadSpace(files);
      return;
    }
    setUploadingChatImages(true);
    const added: Array<{ id: string; name: string; url: string }> = [];
    const failedNames: string[] = [];
    try {
      for (const file of imageFiles) {
        if (file.size > 16 * 1024 * 1024) {
          failedNames.push(`${file.name}(超16MiB)`);
          continue;
        }
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取失败'));
            reader.readAsDataURL(file);
          });
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const res = await fetch(`/api/v2/threads/${encodeURIComponent(targetThreadId)}/chat-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: file.name || `image-${Date.now()}.png`,
              mimeType: file.type || 'image/png',
              dataBase64: base64
            })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.image?.id && data.image?.url) {
              added.push({ id: data.image.id, name: data.image.name, url: data.image.url });
            }
          } else {
            failedNames.push(file.name);
          }
        } catch {
          failedNames.push(file.name);
        }
      }
      if (added.length > 0) {
        setDraftImagesByThread((prev) => ({
          ...prev,
          [targetThreadId]: [...(prev[targetThreadId] || []), ...added]
        }));
        setTimeout(() => inputRef.current?.focus(), 40);
      }
      if (failedNames.length > 0) {
        showChatNotice(`部分图片添加失败：${failedNames.join('、')}`);
      }
    } finally {
      setUploadingChatImages(false);
    }
  };

  const chatImageActions = useMemo<MarkdownImageActions>(
    () => ({
      onSaveToSpace: async (src: string, alt: string) => {
        if (!activeThreadId) return 'error';
        try {
          const res = await fetch(
            `/api/v2/threads/${encodeURIComponent(activeThreadId)}/space/import-image`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ src, name: alt || undefined })
            }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showChatNotice(err.message || err.error || '保存到资料区失败');
            return 'error';
          }
          const data = await res.json();
          await loadSpace(activeThreadId);
          setSpaceOpen(true);
          setSpaceTab('documents');
          showChatNotice(
            data.alreadyInSpace
              ? '该图片已在右侧资料区中'
              : `已保存到资料区：${data.file?.name || alt || '图片'}`
          );
          return data.alreadyInSpace ? 'already' : 'saved';
        } catch {
          showChatNotice('保存到资料区失败');
          return 'error';
        }
      },
      onOpenInSpace: (fileId: string) => {
        setSpaceOpen(true);
        setSpaceTab('documents');
        setSpaceSelection({ kind: 'file', id: fileId });
      },
      onDownloadLocal: (src: string, alt: string) => {
        const href = src.startsWith('/api/v2/')
          ? `${src}${src.includes('?') ? '&' : '?'}download=1`
          : `/api/v2/media/download?url=${encodeURIComponent(src)}${alt ? `&name=${encodeURIComponent(alt)}` : ''}`;
        const a = document.createElement('a');
        a.href = href;
        a.download = alt || 'image';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showChatNotice('已开始下载图片到本地');
      }
    }),
    [activeThreadId, loadSpace, setSpaceSelection, showChatNotice]
  );

  const chatSpaceResolver = useMemo<MarkdownSpaceResolver>(() => {
    const folderById = new Map(spaceFolders.map((f) => [f.id, f]));
    const folderPathById = new Map<string, string>();
    for (const f of spaceFolders) {
      const parts: string[] = [];
      const seen = new Set<string>();
      let cur: SpaceFolderRecord | undefined = f;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur.title);
        cur = cur.parentFolderId ? folderById.get(cur.parentFolderId) : undefined;
      }
      folderPathById.set(f.id, parts.join('/'));
    }
    return {
      folders: spaceFolders.map((f) => ({
        id: f.id,
        title: f.title,
        path: folderPathById.get(f.id) || f.title
      })),
      items: spaceItems.map((it) => ({
        kind: it.kind,
        id: it.id,
        title: it.title,
        folderPath: it.folderId ? folderPathById.get(it.folderId) || '' : '',
        previewKind: it.previewKind,
        url: it.url
      })),
      onOpenItem: (it) => {
        setSpaceOpen(true);
        setSpaceTab('documents');
        setSpaceSelection({ kind: it.kind, id: it.id });
      },
      onOpenFolder: (folderId) => {
        setSpaceOpen(true);
        setSpaceTab('documents');
        setSpaceSelection(null);
        setSpaceFocusFolderReq({ folderId, seq: Date.now() });
      }
    };
  }, [spaceFolders, spaceItems, setSpaceSelection]);

  const uploadFilesToThreadSpace = async (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    let uploaded = 0;
    const failedNames: string[] = [];
    for (const file of files) {
      if (file.size > 16 * 1024 * 1024) {
        failedNames.push(`${file.name}(超16MiB)`);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('读取失败'));
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        const res = await fetch(`/api/v2/threads/${encodeURIComponent(activeThreadId)}/space/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64: base64
          })
        });
        if (res.ok) {
          uploaded += 1;
        } else {
          failedNames.push(file.name);
        }
      } catch {
        failedNames.push(file.name);
      }
    }
    if (uploaded > 0) {
      setSpaceOpen(true);
      setSpaceTab('documents');
      await loadSpace(activeThreadId);
    }
    if (failedNames.length > 0 && uploaded === 0) {
      showChatNotice(`上传失败：${failedNames.join('、')}`);
    } else if (failedNames.length > 0) {
      showChatNotice(`已上传 ${uploaded} 份，失败：${failedNames.join('、')}`);
    } else if (uploaded > 0) {
      showChatNotice(`已上传 ${uploaded} 份文件到协作空间`);
    }
  };

  const handleSaveWorkspacePath = async (nextPath: string | null) => {
    if (!activeThread) return;
    await fetch(`/api/v2/threads/${encodeURIComponent(activeThread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: nextPath })
    });
    await loadBootstrap(true);
  };

  const handleSendArtifactBackToOriginChat = async () => {
    const selected = selectionRef.current;
    if (!artifact || selected?.kind !== 'document' || selected.id !== artifact.id) return;
    let latestArt = artifact;
    if (docEditing && docDraft !== artifact.content) {
      const res = await fetch(`/api/v2/artifacts/${encodeURIComponent(artifact.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBaseVersion: artifact.headVersion,
          content: docDraft
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (!isSameSpaceSelection(selectionRef.current, selected)) return;
        documentRequest.current++;
        latestArt = data.artifact;
        setArtifact(data.artifact);
        setVersions(data.versions || []);
      }
    }
    const originThreadId = latestArt.sourceThreadId;
    setDocEditing(false);
    setViewMode('thread');
    setActiveThreadId(originThreadId);
    setInputDrafts((prev) => ({
      ...prev,
      [originThreadId]: `请按《${latestArt.title}》(v${latestArt.headVersion}) 的最新修改继续调整`
    }));
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const handleSubmitNewTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeThreadId || !newTaskTitle.trim()) return;
    const leadId = newTaskLeadId || activeThread?.activeOwnerMemberId || members[0]?.id || '';
    const stepsPayload = newTaskSteps.map((s, idx) => ({
      stepOrder: idx + 1,
      title: s.title.trim() || `步骤 ${idx + 1}`,
      assigneeMemberId: s.assigneeMemberId || leadId,
      dependsOnOrders: s.dependsOnPrev && idx > 0 ? [idx] : [],
      brief: s.brief.trim() || s.title.trim(),
      acceptanceCriteria: '交付内容清晰准确并通过负责人核验'
    }));

    const res = await fetch('/api/v2/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceThreadId: activeThreadId,
        title: newTaskTitle.trim(),
        kind: newTaskKind,
        cronExpr: newTaskKind === 'scheduled' ? newTaskCron.trim() : null,
        startImmediately: newTaskKind === 'scheduled' ? newTaskStartNow : true,
        leadMemberId: leadId,
        spec: {
          goal: newTaskTitle.trim(),
          steps: stepsPayload
        }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showChatNotice(data.message || data.error || '创建任务失败，请检查配置');
      return;
    }
    setTaskModalOpen(false);
    setNewTaskTitle('');
    setNewTaskStartNow(false);
    await loadBootstrap(true);
    await loadThread(activeThreadId);
    if (data.task?.id) {
      setActiveTaskId(data.task.id);
      setViewMode('task');
    }
  };

  const handlePauseTask = async (taskId: string, paused: boolean) => {
    try {
      const response = await fetch('/api/v2/tasks/' + encodeURIComponent(taskId) + '/pause', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused })
      });
      if (!response.ok) throw new Error();
      await loadBootstrap(true);
      if (viewMode === 'task') await loadTaskDetail(taskId);
    } catch {
      showChatNotice('未能更新任务状态，请稍后再试');
    }
  };

  const handleToggleScheduleById = async (taskId: string, enabled: boolean) => {
    const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) {
      showChatNotice('更新定时启停状态失败');
      return;
    }
    if (viewMode === 'task' && activeTaskId === taskId) {
      await loadTaskDetail(taskId, taskDetail?.activeRun?.id);
    }
    await loadBootstrap(true);
  };

  const handleRunTaskNowById = async (taskId: string, retryFromRunId?: string) => {
    const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}/run` + (retryFromRunId ? '?retryFromRunId=' + encodeURIComponent(retryFromRunId) : ''), {
      method: 'POST'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showChatNotice(data.message || data.error || '触发任务失败');
      return;
    }
    if (viewMode === 'task' && activeTaskId === taskId) {
      await loadTaskDetail(taskId, data.run?.id);
    }
    await loadBootstrap(true);
    showChatNotice('已触发新一轮任务执行');
  };

  const handleCancelRun = async (runId: string) => {
    const res = await fetch(`/api/v2/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showChatNotice(err.message || '停止任务失败');
      return;
    }
    if (viewMode === 'task' && activeTaskId) {
      await loadTaskDetail(activeTaskId, runId);
    }
    await loadBootstrap(true);
    showChatNotice('已停止本轮执行');
  };

  const handleDeleteTask = async (taskId: string) => {
    deletingTaskIdRef.current = taskId;
    try {
      const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showChatNotice(err.message || '删除任务失败');
        return;
      }
      const data = await res.json().catch(() => ({}));
      setConfirmDeleteTaskId(null);
      if (viewMode === 'task' && activeTaskId === taskId) {
        setTaskDetail(null);
        setActiveTaskId('');
        if (data.sourceThreadId) {
          setActiveThreadId(data.sourceThreadId);
          setViewMode('thread');
        } else {
          setViewMode('schedules');
        }
      }
      await loadBootstrap(true);
      if (activeThreadId) {
        await loadSpace(activeThreadId);
      }
      showChatNotice('已删除任务');
    } finally {
      if (deletingTaskIdRef.current === taskId) {
        deletingTaskIdRef.current = null;
      }
    }
  };

  const handleSyncProtocolMemory = async (): Promise<{ version: string; memberCount: number } | null> => {
    const res = await fetch('/api/v2/members/sync-protocol-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'ui_manual_sync' })
    });
    if (!res.ok) {
      showChatNotice('触发全员协作记忆更新失败');
      return null;
    }
    const data = await res.json();
    return { version: String(data.version || ''), memberCount: Number(data.memberCount || members.length) };
  };

  const handleReplyWaitingRun = async (runId: string) => {
    const waitingReplyText = waitingReplies[runId] ?? '';
    if (!waitingReplyText.trim()) return;
    const res = await fetch(`/api/v2/runs/${encodeURIComponent(runId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: waitingReplyText.trim() })
    });
    if (!res.ok) return;
    updateWaitingReply(runId, '');
    if (viewMode === 'task' && activeTaskId) {
      await loadTaskDetail(activeTaskId, runId);
    }
    if (activeThreadId) {
      await loadThread(activeThreadId);
    }
  };

  const handleToggleDuolabase = async () => {
    const res = await fetch('/api/v2/settings/duolabase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !duolabaseStatus.enabled })
    });
    if (!res.ok) return;
    const data = await res.json();
    setDuolabaseStatus({ ...DEFAULT_DB_STATUS, ...data });
  };

  const sending = Boolean(activeThreadId && sendingByThread[activeThreadId]);
  const currentOwner = activeThread ? memberById.get(activeThread.activeOwnerMemberId) : null;
  const showWorkspaceBinding = isLocalCodingMember(currentOwner) || Boolean(activeThread?.workspacePath);
  const hasRunningTurn = sending || waitingForTurn;
  const ownerStatus = currentOwner?.status ?? 'ready';
  const ownerStatusClass =
    ownerStatus === 'ready'
      ? 'connected'
      : ownerStatus === 'busy'
        ? 'working'
        : ownerStatus === 'auth_required'
          ? 'waiting'
          : 'offline';
  const ownerStatusLabel =
    ownerStatus === 'ready'
      ? (currentOwner?.config.hubTransport === 'grok-webhook' ? '按需投递' : '在线')
      : ownerStatus === 'busy'
        ? '执行中'
        : ownerStatus === 'auth_required'
          ? '待授权'
          : '离线';
  const spaceThread = threads.find((t) => t.id === spaceThreadId) ?? null;
  const showRightSpace = spaceOpen && (viewMode === 'thread' || viewMode === 'task');
  const activeRefs = activeThread ? draftRefsByThread[activeThread.id] || [] : [];
  const activeDraft = activeThread ? inputDrafts[activeThread.id] || '' : '';

  const renderRightSpace = () =>
    showRightSpace ? (
      <CollaborationSpacePanel
        thread={spaceThread}
        materialsState={materialsState}
        members={members}
        duolabaseStatus={duolabaseStatus}
        hasDesktopDialog={hasDesktopDialog}
        refreshingMembers={refreshingMembers}
        wideSpace={wideSpace}
        onToggleWide={() => setWideSpace((w) => !w)}
        onCloseSpace={() => setSpaceOpen(false)}
        tab={spaceTab}
        onTabChange={setSpaceTab}
        selection={spaceSelection}
        onSelectItem={setSpaceSelection}
        focusFolderRequest={spaceFocusFolderReq}
        folders={spaceFolders}
        items={spaceItems}
        trash={spaceTrash}
        threadTasks={spaceTasks}
        artifact={artifact}
        versions={versions}
        docEditing={docEditing}
        setDocEditing={setDocEditing}
        docDraft={docDraft}
        setDocDraft={setDocDraft}
        docNotice={docNotice}
        onSaveArtifact={handleSaveArtifact}
        onCopyArtifact={handleCopyArtifact}
        onExportArtifact={handleExportArtifact}
        onSendArtifactBackToOriginChat={handleSendArtifactBackToOriginChat}
        onSelectVersion={(content) => setDocDraft(content)}
        onRefreshSpace={() => loadSpace(spaceThread?.id || activeThreadId)}
        onQuoteToChat={handleQuoteToChat}
        onOpenTask={(tid) => {
          setActiveTaskId(tid);
          setViewMode('task');
        }}
        onOpenCreateTask={() => {
          if (spaceThread) {
            setActiveThreadId(spaceThread.id);
            setViewMode('thread');
            setNewTaskLeadId(spaceThread.activeOwnerMemberId);
            setTaskModalOpen(true);
          }
        }}
        onChooseWorkspace={handleChooseThreadWorkspace}
        onSaveWorkspacePath={handleSaveWorkspacePath}
        onRefreshMembers={handleRefreshMembers}
        onToggleDuolabase={handleToggleDuolabase}
        onNavigatePage={(page) => setViewMode(page)}
        onFocusChat={() => {
          if (spaceThread) {
            setActiveThreadId(spaceThread.id);
          }
          setViewMode('thread');
          setTimeout(() => inputRef.current?.focus(), 40);
        }}
        onNotify={(msg) => {
          setDocNotice(msg);
          setTimeout(() => setDocNotice(''), 3000);
        }}
      />
    ) : null;

  const handleToggleHandoffInspector = useCallback(
    async (keyId: string, meta: HandoffNoticeMeta) => {
      const nextOpen = !expandedHandoffIds[keyId];
      setExpandedHandoffIds((prev) => ({ ...prev, [keyId]: nextOpen }));
      if (!nextOpen || meta.status !== 'pending' || !activeThreadId) return;
      const existing = pendingHandoffPreviews[keyId];
      if (existing && (existing.state === 'loading' || existing.state === 'ready')) return;

      setPendingHandoffPreviews((prev) => ({ ...prev, [keyId]: { state: 'loading' } }));
      try {
        const res = await fetch(
          `/api/v2/threads/${encodeURIComponent(activeThreadId)}/handoff-preview?memberId=${encodeURIComponent(meta.toMemberId)}`
        );
        if (!res.ok) throw new Error('preview failed');
        const data = (await res.json()) as { meta: HandoffNoticeMeta };
        setPendingHandoffPreviews((prev) => ({
          ...prev,
          [keyId]: { state: 'ready', meta: data.meta }
        }));
      } catch {
        setPendingHandoffPreviews((prev) => ({ ...prev, [keyId]: { state: 'error' } }));
      }
    },
    [expandedHandoffIds, activeThreadId, pendingHandoffPreviews]
  );

  const handleCopyHandoffPreview = useCallback(async (keyId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopiedHandoffId(keyId);
    setTimeout(() => setCopiedHandoffId((cur) => (cur === keyId ? null : cur)), 2000);
  }, []);

  const renderHandoffDivider = (keyId: string, meta: HandoffNoticeMeta, lateReplies?: ThreadMessageRecord[]) => {
    const isPending = meta.status === 'pending';
    const loadedPending = isPending ? pendingHandoffPreviews[keyId] : undefined;
    const detailMeta = loadedPending?.meta ?? meta;
    const sourceIds = lateReplies
      ? [...new Set(lateReplies.map((reply) => reply.authorId))]
      : meta.fromMemberId ? [meta.fromMemberId] : [];
    const lateSeqs = lateReplies?.map((reply) => reply.seq) ?? detailMeta.lateArrivalSeqs ?? [];
    const toMember = memberById.get(detailMeta.toMemberId);
    const expanded = Boolean(expandedHandoffIds[keyId]);

    const fmtSize = (bytes?: number) => {
      if (!bytes || bytes <= 0) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    };

    const statusLabel = isPending
      ? '上下文交接待处理'
      : lateReplies ? '已补交跨成员回复' : '上下文已交接';

    const statsSummary = lateReplies ? `· ${lateReplies.length} 条`
      : detailMeta.handoffBytes !== undefined
        ? `· ${detailMeta.strategy === 'full_thread_summary' ? '完整' : '增量'} · ${detailMeta.includedCount ?? 0} 条 · ${fmtSize(detailMeta.handoffBytes)}`
        : isPending
          ? '· 点击预览'
          : '';

    const ratioPct =
      detailMeta.budgetBytes && detailMeta.budgetBytes > 0 && detailMeta.handoffBytes !== undefined
        ? Math.min(100, Math.round((detailMeta.handoffBytes / detailMeta.budgetBytes) * 100))
        : 0;

    return (
      <div key={keyId} className={`handoff-divider-wrap ${isPending ? 'is-pending' : 'is-delivered'}`}>
        <div className="handoff-divider-row">
          <span className="handoff-divider-line" aria-hidden="true" />
          <button
            type="button"
            className="handoff-divider-pill"
            onClick={() => void handleToggleHandoffInspector(keyId, meta)}
            aria-expanded={expanded}
          >
            <ArrowLeftRight size={13} className="handoff-icon" />
            <span className="handoff-status-text">{statusLabel}</span>
            {sourceIds.map((id) => {
              const member = memberById.get(id);
              return (
                <span key={id} className="handoff-member-chip">
                  <AgentAvatar small id={id} name={member?.name ?? id} platformId={member?.platformId} />
                  <span>{member?.name ?? id}</span>
                </span>
              );
            })}
            {sourceIds.length > 0 && <span className="handoff-arrow" aria-hidden="true">→</span>}
            <span className="handoff-member-chip handoff-member-target">
              <AgentAvatar
                small
                id={toMember?.id || detailMeta.toMemberId}
                name={toMember?.name || detailMeta.toMemberId}
                platformId={toMember?.platformId}
              />
              <span>{toMember?.name || detailMeta.toMemberId}</span>
            </span>
            {statsSummary && <span className="handoff-meta-brief">{statsSummary}</span>}
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <span className="handoff-divider-line" aria-hidden="true" />
        </div>

        {expanded && (
          <div className="handoff-inspector-card" role="region" aria-label="上下文交接详情">
            {loadedPending?.state === 'loading' ? (
              <div className="handoff-inspector-loading">正在计算即将交接的上下文范围…</div>
            ) : loadedPending?.state === 'error' ? (
              <div className="handoff-inspector-loading">暂无法加载上下文预览</div>
            ) : (
              <>
                <div className="handoff-inspector-head">
                  <div className="handoff-inspector-badges">
                    <span className="handoff-badge">
                      {detailMeta.strategy === 'full_thread_summary' ? '完整上下文模式' : '增量同步模式'}
                    </span>
                    <span className="handoff-badge is-subtle">
                      {lateReplies ? '跨成员补交' : '成员切换交接'}
                    </span>
                    {isPending && <span className="handoff-badge is-pending">待发送下条消息时触发</span>}
                  </div>
                  <div className="handoff-inspector-budget">
                    <span>
                      已占 {fmtSize(detailMeta.handoffBytes)} / 上限 {fmtSize(detailMeta.budgetBytes)}
                    </span>
                  </div>
                </div>

                {detailMeta.budgetBytes ? (
                  <div className="handoff-budget-bar" aria-hidden="true">
                    <div
                      className={`handoff-budget-fill ${ratioPct >= 78 ? 'is-high' : ''}`}
                      style={{ width: `${ratioPct}%` }}
                    />
                  </div>
                ) : null}

                <div className="handoff-chip-list">
                  <span className="handoff-chip">
                    {(detailMeta.includedCount ?? 0) > 0
                      ? `已带入 ${detailMeta.includedCount} 条消息${
                          detailMeta.includedFromSeq !== null && detailMeta.includedFromSeq !== undefined
                            ? ` (#${detailMeta.includedFromSeq}..#${detailMeta.includedToSeq})`
                            : ''
                        }`
                      : '无新增历史消息'}
                  </span>
                  {detailMeta.hasAnchor && <span className="handoff-chip is-accent">初始目标已锚定</span>}
                  {detailMeta.hasArtifact && (
                    <span className="handoff-chip is-accent">
                      关联文稿《{detailMeta.artifactTitle || '未命名'}》v{detailMeta.artifactVersion ?? 1}
                    </span>
                  )}
                  {(detailMeta.taskCount ?? 0) > 0 && (
                    <span className="handoff-chip">关联任务 {detailMeta.taskCount} 项</span>
                  )}
                  {(detailMeta.omittedCount ?? 0) > 0 && (
                    <span className="handoff-chip is-warn">
                      早期折叠 {detailMeta.omittedCount} 条 (#{detailMeta.omittedFromSeq}..#{detailMeta.omittedToSeq})
                    </span>
                  )}
                  {(detailMeta.truncatedSeqs?.length ?? 0) > 0 && (
                    <span className="handoff-chip is-warn">
                      超长保留首尾 (#{detailMeta.truncatedSeqs!.join(', #')})
                    </span>
                  )}
                  {lateSeqs.length > 0 && (
                    <span className="handoff-chip is-accent">
                      补交迟到回复 (#{lateSeqs.join(', #')})
                    </span>
                  )}
                </div>

                <div className="handoff-preview-box">
                  <div className="handoff-preview-bar">
                    <span>{isPending ? '预计传递上下文内容（脱敏预览）' : '本次实际传递上下文快照（已脱敏）'}</span>
                    {detailMeta.previewText && (
                      <button
                        type="button"
                        className="handoff-copy-btn"
                        onClick={() => void handleCopyHandoffPreview(keyId, detailMeta.previewText || '')}
                      >
                        {copiedHandoffId === keyId ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedHandoffId === keyId ? '已复制' : '复制内容'}</span>
                      </button>
                    )}
                  </div>
                  <pre className="handoff-preview-code">
                    {detailMeta.previewText
                      ? detailMeta.previewText
                      : '（当前无新增上下文需要附加，直接承接原对话继续交流。）'}
                  </pre>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  if (authState.authRequired && !authState.authenticated) {
    return (
      <div data-build-id={buildId} className="cloud-auth-screen">
        <form className="cloud-auth-card" onSubmit={(e) => void handleCloudLogin(e)}>
          <div className="flex items-center gap-3">
            <BrandLogo size={38} />
            <div>
              <h1 className="text-base font-semibold m-0">DuolaWork 云端工作台</h1>
              <p className="text-xs m-0" style={{ color: '#6b7a90' }}>
                请先验证身份，跨设备访问你的对话与定时任务
              </p>
            </div>
          </div>
          <div className="cloud-auth-tabs">
            <button
              type="button"
              className={authTab === 'password' ? 'active' : ''}
              onClick={() => {
                setAuthTab('password');
                setAuthError('');
              }}
            >
              管理员密码
            </button>
            <button
              type="button"
              className={authTab === 'code' ? 'active' : ''}
              onClick={() => {
                setAuthTab('code');
                setAuthError('');
              }}
            >
              一次性配对码
            </button>
          </div>
          {authTab === 'password' ? (
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="输入工作台管理员密码"
              autoFocus
              className="dw-input"
            />
          ) : (
            <input
              type="text"
              inputMode="numeric"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="输入 6 位一次性登录码"
              autoFocus
              className="dw-input"
            />
          )}
          {authError && (
            <p className="text-xs m-0" style={{ color: '#be4343' }}>
              {authError}
            </p>
          )}
          <button
            type="submit"
            disabled={authSubmitting || (authTab === 'password' ? !authPassword.trim() : !authCode.trim())}
            className="dw-btn dw-btn-primary w-full justify-center"
          >
            {authSubmitting ? '验证中…' : '进入工作台'}
          </button>
        </form>
      </div>
    );
  }

  const mobileNavigation = (
    <button
      type="button"
      onClick={() => setMobileSidebarOpen(true)}
      className="dw-btn dw-btn-ghost dw-btn-icon mobile-nav-trigger"
      aria-label="打开侧边导航"
      aria-controls="workbench-sidebar"
      aria-expanded={mobileSidebarOpen}
    >
      <Menu size={18} />
    </button>
  );

  return (
    <WorkbenchColumns
      spaceVisible={showRightSpace && (viewMode === 'thread' ? Boolean(activeThread) : Boolean(taskDetail))}
      wideSpace={wideSpace}
      leaveWideSpace={() => setWideSpace(false)}
      data-build-id={buildId}
      className={`communication${mobileSidebarOpen ? ' mobile-sidebar-open' : ''}`}
      onClick={() => {
        setOwnerMenuOpen(false);
        setLeadMenuOpen(false);
        setStepWorkerMenuIdx(null);
      }}
    >
      {/* Left Sidebar: Exact 1.9.6 DuolaWork Brand + Nav + Spacious Conversations */}
      <aside id="workbench-sidebar" className="comm-sidebar">
        <div className="comm-brand">
          <div className="comm-brand-id">
            <BrandLogo size={38} loop />
            <strong>
              DuolaWork<small>一起沟通，一起完成</small>
            </strong>
          </div>
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className="comm-theme-toggle"
            aria-label="切换深浅主题"
            title={dark ? '切换到浅色模式' : '切换到深色模式'}
          >
            {dark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>

        <div className="comm-search">
          <Search size={15} />
          <input
            type="text"
            value={threadSearch}
            onChange={(e) => setThreadSearch(e.target.value)}
            placeholder="搜索对话…"
            aria-label="搜索对话"
          />
          {threadSearch && (
            <button type="button" onClick={() => setThreadSearch('')} aria-label="清空搜索">
              <X size={13} />
            </button>
          )}
        </div>

        <button
          type="button"
          className={`nav-home ${viewMode === 'members' ? 'selected' : ''}`}
          onClick={() => {
            setViewMode('members');
            setMobileSidebarOpen(false);
          }}
        >
          <Users size={17} />
          成员与用量
          <span>{members.length}</span>
        </button>
        <button
          type="button"
          className={`nav-home ${viewMode === 'connectors' ? 'selected' : ''}`}
          onClick={() => {
            setViewMode('connectors');
            setMobileSidebarOpen(false);
          }}
        >
          <Plug size={17} />
          连接器
          <span style={{ color: duolabaseStatus.enabled && duolabaseStatus.hasToken ? '#4ea98c' : '#97a1b2' }}>
            {duolabaseStatus.enabled && duolabaseStatus.hasToken ? '●' : ''}
          </span>
        </button>
        <button
          type="button"
          className={`nav-home ${viewMode === 'vault' ? 'selected' : ''}`}
          onClick={() => {
            setViewMode('vault');
            setMobileSidebarOpen(false);
          }}
        >
          <KeyRound size={17} />
          Vault 凭证库
        </button>
        <button
          type="button"
          className={`nav-home ${viewMode === 'schedules' ? 'selected' : ''}`}
          onClick={() => {
            setViewMode('schedules');
            setMobileSidebarOpen(false);
          }}
        >
          <Clock size={17} />
          定时任务
          {tasks.length > 0 && <span>{tasks.length}</span>}
        </button>

        <div className="sidebar-caption">
          <span>对话</span>
          <button
            type="button"
            aria-label="新对话"
            title="新建对话"
            onClick={() => void handleCreateThread()}
          >
            <Plus size={17} />
          </button>
        </div>

        <div className="channel-list">
          {visibleThreads.map((t) => {
            const owner = memberById.get(t.activeOwnerMemberId);
            const ownerName = owner?.name || t.activeOwnerMemberId;
            const selected = viewMode === 'thread' && activeThreadId === t.id;
            return (
              <div key={t.id} className={`channel-row ${selected ? 'selected' : ''}`}>
                <button
                  type="button"
                  onClick={() => {
                    resetTransientMenus();
                    setViewMode('thread');
                    setSpaceSelection(null);
                    setActiveThreadId(t.id);
                    setMobileSidebarOpen(false);
                  }}
                  className="channel-open-btn"
                >
                  <AgentAvatar
                    small
                    name={ownerName}
                    platformId={owner?.platformId}
                    status={owner?.status}
                  />
                  <span className="channel-copy">
                    {t.title}
                    <small>
                      {ownerName} · {new Date(t.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(e) => void handleTogglePinThread(t, e)}
                  className={`channel-pin-btn ${t.pinnedAt ? 'is-pinned' : ''}`}
                  aria-label={t.pinnedAt ? '取消置顶对话' : '置顶对话'}
                  title={t.pinnedAt ? '取消置顶' : '置顶对话'}
                >
                  {t.pinnedAt ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
                <button
                  type="button"
                  onClick={(e) => void handleArchiveThread(t, e)}
                  className="channel-archive-btn"
                  aria-label="归档对话"
                  title="归档对话"
                >
                  <Archive size={12} />
                </button>
              </div>
            );
          })}
          {visibleThreads.length === 0 && (
            <p className="sidebar-empty">没有匹配的对话，清空搜索可查看全部。</p>
          )}
        </div>

        <div className="sidebar-footer">
          <button type="button" onClick={() => setArchivesOpen((o) => !o)}>
            <span className="inline-flex items-center gap-1.5" style={{ marginLeft: 0 }}>
              {archivesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <FolderArchive size={12} />
              <span>历史归档 ({archives.length})</span>
            </span>
          </button>
          {archivesOpen && (
            <div className="mb-2 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
              {archives.length === 0 ? (
                <small style={{ color: '#9aa4b7' }}>暂无旧版只读归档记录</small>
              ) : (
                archives.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      setActiveArchiveId(a.id);
                      setViewMode('archive');
                    }}
                    className="text-left px-1.5 py-1 rounded text-[11px] truncate hover:bg-[#eef0f5]"
                    style={{
                      color: viewMode === 'archive' && activeArchiveId === a.id ? '#355cc9' : '#6c7c93'
                    }}
                  >
                    {a.name}
                  </button>
                ))
              )}
            </div>
          )}
          <div>
            <i />{cloudMode ? '云端工作区' : '本机工作区'}<span title={buildId}>{cloudMode ? '云端版' : '本地版'}</span>
          </div>
        </div>
      </aside>
      <ColumnDivider side="sidebar" />
      {mobileSidebarOpen && (
        <div
          className="mobile-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Main Column */}
      <main
        className="comm-main"
        onDragOver={(e) => {
          if (viewMode === 'thread' && activeThreadId && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          if (viewMode === 'thread' && activeThreadId && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            const dropped = Array.from(e.dataTransfer.files);
            const allImages = dropped.every(
              (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name)
            );
            if (allImages) {
              void uploadChatImages(dropped);
            } else {
              void uploadFilesToThreadSpace(dropped);
            }
          }
        }}
      >
        {(viewMode !== 'thread' || !activeThread) && (
          <div className="mobile-nav-bar">{mobileNavigation}</div>
        )}
        {chatNotice && (
          <div className="comm-toast" role="status">
            <Check size={15} />
            <span>{chatNotice}</span>
            {undoArchiveThread && (
              <button
                type="button"
                onClick={() => {
                  const tid = undoArchiveThread.id;
                  setUndoArchiveThread(null);
                  setChatNotice('');
                  void handleRestoreArchivedThread(tid);
                }}
                className="font-semibold underline ml-1"
              >
                撤销
              </button>
            )}
          </div>
        )}

        {viewMode === 'members' ? (
          <MembersUsagePage
            members={members}
            nodes={nodes}
            authRequired={authState.authRequired}
            onLogout={handleCloudLogout}
            refreshingMembers={refreshingMembers}
            onRefreshMembers={handleRefreshMembers}
            onReloadBootstrap={() => loadBootstrap(true)}
            onStartChatWithMember={(memberId) => handleCreateThread(memberId)}
            onSyncProtocolMemory={handleSyncProtocolMemory}
          />
        ) : viewMode === 'connectors' ? (
          <ConnectorsPage
            duolabaseStatus={duolabaseStatus}
            onToggleDuolabase={handleToggleDuolabase}
            onReloadStatus={() => loadBootstrap(true)}
          />
        ) : viewMode === 'vault' ? (
          <VaultPage duolabaseStatus={duolabaseStatus} />
        ) : viewMode === 'schedules' ? (
          <SchedulesPage
            tasks={tasks}
            members={members}
            threads={threads}
            onOpenTask={(tid) => {
              setActiveTaskId(tid);
              setViewMode('task');
            }}
            onOpenThread={(tid) => {
              setActiveThreadId(tid);
              setViewMode('thread');
            }}
            onToggleSchedule={(tid, enabled) => handleToggleScheduleById(tid, enabled)}
            onRunTaskNow={handleRunTaskNowById}
            onCancelRun={(rid) => handleCancelRun(rid)}
            onDeleteTask={(tid) => handleDeleteTask(tid)}
            onRefresh={() => loadBootstrap(true)}
          />
        ) : viewMode === 'thread' && activeThread ? (
          <>
            <header className="comm-header">
              <div>
                {mobileNavigation}
                <AgentAvatar
                  small
                  name={currentOwner?.name || activeThread.activeOwnerMemberId}
                  platformId={currentOwner?.platformId}
                />
                <div>
                  {editingThreadTitle ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleSaveThreadTitle();
                      }}
                    >
                      <input
                        type="text"
                        value={threadTitleDraft}
                        onChange={(e) => setThreadTitleDraft(e.target.value)}
                        onBlur={() => void handleSaveThreadTitle()}
                        autoFocus
                        className="dw-input"
                        style={{ height: 30, width: 260, fontSize: 15, fontWeight: 600 }}
                      />
                    </form>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <h1>{activeThread.title}</h1>
                      <button
                        type="button"
                        onClick={() => {
                          setThreadTitleDraft(activeThread.title);
                          setEditingThreadTitle(true);
                        }}
                        className="p-1 opacity-55 hover:opacity-100"
                        aria-label="重命名对话"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  )}
                  <p className="flex items-center gap-2">
                    <span>{currentOwner?.name || activeThread.activeOwnerMemberId}</span>
                    <span className={`inline-availability ${ownerStatusClass}`}>
                      {ownerStatusLabel}
                    </span>
                    {showWorkspaceBinding && (
                      <button
                        type="button"
                        onClick={() => void handleChooseThreadWorkspace()}
                        className="inline-flex items-center gap-1 hover:underline truncate max-w-[260px]"
                        title={activeThread.workspacePath || '点击绑定本机项目目录'}
                      >
                        <FolderOpen size={11} />
                        <span className="truncate">
                          {activeThread.workspacePath ? activeThread.workspacePath : '绑定工作目录'}
                        </span>
                      </button>
                    )}
                  </p>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewTaskLeadId(activeThread.activeOwnerMemberId);
                    setTaskModalOpen((v) => !v);
                  }}
                  className="dw-btn dw-btn-ghost dw-btn-sm"
                >
                  <ListTodo size={15} />
                  <span>指派任务</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSpaceOpen((v) => !v)}
                  className="dw-btn dw-btn-ghost dw-btn-icon"
                  aria-label={spaceOpen ? '隐藏协作空间' : '展开协作空间'}
                  title={spaceOpen ? '收起协作空间' : '展开协作空间'}
                >
                  {spaceOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
                </button>
              </div>
            </header>

            {editingWorkspace && showWorkspaceBinding && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSaveWorkspaceDraft();
                }}
                className="px-7 py-2.5 border-b flex items-center gap-2 dw-inline-panel"
              >
                <input
                  type="text"
                  value={workspaceDraft}
                  onChange={(e) => setWorkspaceDraft(e.target.value)}
                  placeholder="输入本机工作目录绝对路径"
                  className="dw-input"
                />
                <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                  保存目录
                </button>
                <button type="button" onClick={() => setEditingWorkspace(false)} className="dw-btn dw-btn-outline dw-btn-sm">
                  取消
                </button>
              </form>
            )}

            <div className="comm-body">
              <section className="conversation-column">
                {taskModalOpen && (
                  <form
                    onSubmit={handleSubmitNewTask}
                    onClick={(e) => e.stopPropagation()}
                    className="mx-7 mt-3 p-4 rounded-xl border flex flex-col gap-3 text-xs dw-inline-panel"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[13px]">在本对话立项派单</span>
                      <div className="connector-categories">
                        <button
                          type="button"
                          aria-pressed={newTaskKind === 'once'}
                          onClick={() => setNewTaskKind('once')}
                        >
                          单次任务
                        </button>
                        <button
                          type="button"
                          aria-pressed={newTaskKind === 'scheduled'}
                          onClick={() => setNewTaskKind('scheduled')}
                        >
                          定时任务
                        </button>
                      </div>
                    </div>

                    <input
                      type="text"
                      required
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="任务名称与目标（例如：整理竞品动态并生成分析简报）"
                      className="dw-input"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setLeadMenuOpen((o) => !o)}
                          className="dw-btn dw-btn-outline dw-btn-sm"
                        >
                          <span>负责人：{memberById.get(newTaskLeadId)?.name || '选择'}</span>
                          <ChevronDown size={12} />
                        </button>
                        {leadMenuOpen && (
                          <div className="chat-context-menu absolute left-0 top-full mt-1">
                            {members.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => {
                                  setNewTaskLeadId(m.id);
                                  setLeadMenuOpen(false);
                                }}
                              >
                                <AgentAvatar small name={m.name} platformId={m.platformId} />
                                <span className="flex-1 text-left">{m.name}</span>
                                {newTaskLeadId === m.id && <Check size={12} />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {newTaskKind === 'scheduled' && (
                        <>
                          <input
                            type="text"
                            value={newTaskCron}
                            onChange={(e) => setNewTaskCron(e.target.value)}
                            placeholder="Cron 表达式 (如 0 8,20 * * *)"
                            className="dw-input"
                            style={{ width: 200 }}
                          />
                          <button
                            type="button"
                            aria-pressed={newTaskStartNow}
                            onClick={() => setNewTaskStartNow((v) => !v)}
                            className={`dw-btn dw-btn-sm ${newTaskStartNow ? 'dw-btn-primary' : 'dw-btn-outline'}`}
                          >
                            {newTaskStartNow && <Check size={12} />}
                            <span>创建后立即执行一次</span>
                          </button>
                        </>
                      )}
                    </div>

                    <div className="flex flex-col gap-2">
                      {newTaskSteps.map((st, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="text-[11px] w-5" style={{ color: '#8d99ae' }}>
                            #{idx + 1}
                          </span>
                          <input
                            type="text"
                            value={st.title}
                            onChange={(e) =>
                              setNewTaskSteps((arr) =>
                                arr.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x))
                              )
                            }
                            placeholder="分工项说明"
                            className="dw-input"
                          />
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setStepWorkerMenuIdx(stepWorkerMenuIdx === idx ? null : idx)}
                              className="dw-btn dw-btn-outline dw-btn-sm"
                            >
                              <span>{memberById.get(st.assigneeMemberId)?.name || '指派人'}</span>
                              <ChevronDown size={11} />
                            </button>
                            {stepWorkerMenuIdx === idx && (
                              <div className="chat-context-menu absolute right-0 top-full mt-1">
                                {members.map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => {
                                      setNewTaskSteps((arr) =>
                                        arr.map((x, i) => (i === idx ? { ...x, assigneeMemberId: m.id } : x))
                                      );
                                      setStepWorkerMenuIdx(null);
                                    }}
                                  >
                                    <AgentAvatar small name={m.name} platformId={m.platformId} />
                                    <span className="flex-1 text-left">{m.name}</span>
                                    {st.assigneeMemberId === m.id && <Check size={12} />}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          {newTaskSteps.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                setNewTaskSteps((arr) => arr.filter((_, i) => i !== idx));
                                setStepWorkerMenuIdx(null);
                              }}
                              className="dw-btn dw-btn-ghost dw-btn-icon"
                              aria-label="移除该步骤"
                              title="移除步骤"
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      ))}

                      <div className="flex items-center justify-between pt-1">
                        <button
                          type="button"
                          onClick={() =>
                            setNewTaskSteps((arr) => [
                              ...arr,
                              {
                                title: `步骤 ${arr.length + 1}`,
                                assigneeMemberId: members[0]?.id || '',
                                brief: '',
                                dependsOnPrev: true
                              }
                            ])
                          }
                          className="underline text-xs"
                          style={{ color: '#5373c0' }}
                        >
                          + 添加下一步分工
                        </button>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setTaskModalOpen(false)} className="dw-btn dw-btn-outline dw-btn-sm">
                            取消
                          </button>
                          <button type="submit" className="dw-btn dw-btn-primary dw-btn-sm">
                            确认立项
                          </button>
                        </div>
                      </div>
                    </div>
                  </form>
                )}

                <div ref={messagesScrollRef} className="messages-scroll">
                  {messagesThreadId !== activeThread.id ? (
                    <div className="channel-intro" role="status">
                      {threadLoadError === activeThread.id ? (
                        <><p>对话加载失败</p><button className="dw-btn" onClick={() => void loadThread(activeThread.id)}>重新加载对话</button></>
                      ) : <p>正在加载对话…</p>}
                    </div>
                  ) : visibleMessages.length === 0 ? (
                    <div className="channel-intro">
                      <AgentAvatar
                        name={currentOwner?.name || '负责人'}
                        platformId={currentOwner?.platformId}
                      />
                      <h2>{activeThread.title}</h2>
                      <p>
                        直接提问、讨论或拖入资料，当前由 {currentOwner?.name || '负责人'} 对接处理；点下方任意成员头像即可切换对接人。
                      </p>
                    </div>
                  ) : (
                    visibleMessages.map((m) => {
                      if (m.authorKind === 'switch_notice') {
                        if (m.handoffMeta) {
                          return m.handoffMeta.fromMemberId === m.handoffMeta.toMemberId
                            ? null : renderHandoffDivider(m.id, m.handoffMeta);
                        }
                        const legacyTargetName = m.body.replace(/^已切换至\s*/, '').trim();
                        const legacyMember = members.find((mem) => mem.name === legacyTargetName);
                        return (
                          <div key={m.id} className="handoff-divider-wrap is-delivered">
                            <div className="handoff-divider-row">
                              <span className="handoff-divider-line" aria-hidden="true" />
                              <span className="handoff-divider-pill is-static">
                                <ArrowLeftRight size={13} className="handoff-icon" />
                                <span>{m.body}</span>
                                {legacyMember && (
                                  <span className="handoff-member-chip handoff-member-target">
                                    <AgentAvatar
                                      small
                                      id={legacyMember.id}
                                      name={legacyMember.name}
                                      platformId={legacyMember.platformId}
                                    />
                                  </span>
                                )}
                              </span>
                              <span className="handoff-divider-line" aria-hidden="true" />
                            </div>
                          </div>
                        );
                      }

                      if (m.authorKind === 'system_task_card' && m.taskCard) {
                        const task = tasks.find(task => task.id === m.taskCard!.taskId);
                        if (!task) return null;
                        const run = task.latestRun;
                        const paused = task.status === 'paused';
                        const canPause = task.kind === 'scheduled' || run?.status === 'running' || run?.status === 'paused';
                        const requester = run?.returnMemberId && memberById.get(run.returnMemberId);
                        const returnStatus = requester && run?.status === 'completed' && (
                          run.returnTurnStatus === 'completed' ? requester.name + ' 已跟进'
                          : run.returnTurnStatus === 'failed' || run.returnTurnStatus === 'canceled' ? requester.name + ' 跟进中断'
                          : run.returnTurnStatus ? requester.name + ' 正在接手' : '等待 ' + requester.name + ' 接手'
                        );
                        const event = m.taskCard;
                        const scheduleEntry = task.kind === 'scheduled' && !event.runId;
                        const pastRun = event.runId && event.runId !== run?.id;
                        const status = scheduleEntry ? (paused ? '已暂停' : '按计划执行')
                          : pastRun ? (event.kind === 'delivered' ? '本期已交付' : event.kind === 'failed' ? '执行中断' : '查看本期记录')
                          : paused
                          ? run?.status === 'running' ? '当前步骤结束后暂停' : '已暂停'
                          : run?.status === 'running' ? '执行中'
                          : run?.status === 'waiting_user' ? '等你回复'
                          : run?.status === 'waiting_node_online' ? '等待成员上线'
                          : run?.status === 'failed' || run?.status === 'timed_out' ? '执行中断'
                          : run?.status === 'canceled' ? '已停止'
                          : scheduleEntry ? '按计划执行'
                          : run?.status === 'completed' ? (returnStatus || '已交付') : '待启动';
                        return (
                          <div key={m.id} className="chat-message chat-task-row">
                            <span aria-hidden="true" className="chat-face agent-avatar chat-card-spacer" />
                            <div className="message-content chat-task-status">
                              <button type="button" className="chat-task-title" onClick={() => {
                                setActiveTaskId(task.id);
                                setViewMode('task');
                                requestedRunRef.current = event.runId;
                              }}>{event.runId && task.kind === 'scheduled' ? m.body : task.title}</button>
                              {event.kind === 'waiting_user' && run && run.id === event.runId && run.status === 'waiting_user' && (
                                <form onSubmit={e => { e.preventDefault(); void handleReplyWaitingRun(run.id); }}>
                                  <label>{run.waitingQuestion}<input className="dw-input" value={waitingReplies[run.id] ?? ''} onChange={e=>updateWaitingReply(run.id,e.target.value)} placeholder="回复任务负责人" /></label>
                                  <button type="submit" disabled={!waitingReplies[run.id]?.trim()}>答复并继续</button>
                                </form>
                              )}
                               {event.kind === 'delivered' && m.artifactRefs?.[0] ? (
                                <button className="chat-task-delivery" type="button" title="打开本期交付文档" onClick={() => {
                                  setDocEditing(false);
                                  setSpaceTab('documents');
                                  setSpaceSelection({kind:'document', id:m.artifactRefs![0]});
                                  setSpaceOpen(true);
                                }}>{status}</button>
                              ) : <span className="chat-task-state" role="status">{status}</span>}
                              {canPause && !pastRun && (!event.runId || run?.status === 'running' || paused) && <button type="button" className="chat-task-control"
                                aria-label={paused ? '继续任务' : '暂停任务'} title={paused ? '继续任务' : '暂停任务'}
                                onClick={() => void handlePauseTask(task.id, !paused)}>
                                {paused ? <Play size={14} /> : <Pause size={14} />}
                              </button>}
                            </div>
                          </div>
                        );
                      }

                      const lateReplies = crossAgentLateReplies.get(m.id);
                      const isUser = m.authorKind === 'user';
                      const authorMember = !isUser ? memberById.get(m.authorId) : undefined;
                      const senderName = isUser ? '你' : authorMember?.name || m.authorId;
                      const running = !isUser && m.turnStatus === 'running';
                      const trace = (running && streamingTools[m.id]) || m.toolTrace || [];
                      const activeTool = trace.findLast(t => t.status === 'running');
                      const recent = streamingActivity[m.id];
                      const activity = recent && recent.revision > (m.activity?.revision ?? 0) ? recent : m.activity;
                      const phase = activity?.phase ?? (activeTool ? 'executing' : streamingDeltas[m.id] ? 'writing' : 'processing');
                      const waitingReceipt = running && m.body === '执行结束，等待回执';
                      const reconnecting = running && m.body === '正在恢复执行连接';
                      const statusText = streamDisconnected ? '正在重新连接' : reconnecting ? '正在找回执行进度'
                        : waitingReceipt ? '执行结束，等待回执'
                        : phase === 'executing' ? executionLabel(activeTool) : phaseLabels[phase];
                      const displayBody = running
                        ? streamingDeltas[m.id] || (waitingReceipt || reconnecting || m.body === '正在处理…' ? '' : m.body)
                        : m.turnStatus === 'failed' ? readableTurnFailure(m.body) : m.body;

                      return (
                        <React.Fragment key={m.id}>
                          {lateReplies && m.handoffMeta && renderHandoffDivider(`${m.id}-handoff`, m.handoffMeta, lateReplies)}
                          <article
                            className={`chat-message ${isUser ? 'owner-message' : ''}`}
                          >
                          <AgentAvatar
                            id={isUser ? 'owner' : m.authorId}
                            name={senderName}
                            platformId={authorMember?.platformId}
                          />
                          <div className="message-content">
                            <header>
                              <strong>{senderName}</strong>
                              {running ? (
                                <span className="turn-activity" role="status">
                                  {statusText}<span className="turn-activity-dots" aria-hidden="true"><i /><i /><i /></span>
                                </span>
                              ) : (
                                <time>{m.turnStatus === 'canceled' ? '已停止' : new Date(m.createdAt).toLocaleTimeString('zh-CN', {
                                  hour: '2-digit', minute: '2-digit'
                                })}</time>
                              )}
                            </header>
                            {!isUser &&
                              (() => {
                                if (trace.length === 0) return null;
                                const isRunningTurn = m.turnStatus === 'running';
                                const userExpanded = expandedToolMsgIds[m.id];
                                const activeItem = activeTool ?? trace[trace.length - 1];
                                const activeRow = formatToolTraceRow(activeItem);
                                const showFullList = userExpanded === true;
                                const showCompactLive = isRunningTurn && userExpanded === undefined;
                                const showList = showFullList || showCompactLive;
                                const visibleItems = showFullList
                                  ? trace
                                  : showCompactLive
                                    ? trace.slice(-3)
                                    : [];
                                const hiddenLiveCount = showCompactLive
                                  ? Math.max(0, trace.length - visibleItems.length)
                                  : 0;
                                const doneCount = trace.filter((t) => t.status === 'done').length;
                                return (
                                  <div className={`turn-tool-trace ${isRunningTurn ? 'is-running' : ''}`}>
                                    <button
                                      type="button"
                                      className="turn-tool-summary"
                                      aria-expanded={showFullList}
                                      title={activeRow.raw}
                                      onClick={() =>
                                        setExpandedToolMsgIds((prev) => ({
                                          ...prev,
                                          [m.id]: prev[m.id] === undefined ? true : !prev[m.id]
                                        }))
                                      }
                                    >
                                      <span className="turn-tool-chevron">
                                        {showFullList ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                      </span>
                                      <span className="turn-tool-summary-text">
                                        {isRunningTurn
                                          ? '操作记录'
                                          : `${m.turnStatus === 'failed' || m.turnStatus === 'canceled' ? '已记录' : '已执行'} ${trace.length} 项操作`}
                                      </span>
                                      {isRunningTurn && (
                                        <span className="turn-tool-counter">{doneCount}/{trace.length}</span>
                                      )}
                                    </button>
                                    {showList && visibleItems.length > 0 && (
                                      <div className="turn-tool-list">
                                        {hiddenLiveCount > 0 && (
                                          <button
                                            type="button"
                                            className="turn-tool-more-btn"
                                            onClick={() =>
                                              setExpandedToolMsgIds((prev) => ({ ...prev, [m.id]: true }))
                                            }
                                          >
                                            展开前面已完成的 {hiddenLiveCount} 步…
                                          </button>
                                        )}
                                        {visibleItems.map((item, idx) =>
                                          <ToolTraceRow key={item.id || `${item.name}-${idx}`} item={item} />
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            {displayBody && (
                              <div className="message-markdown">
                                <MarkdownView text={displayBody} imageActions={chatImageActions} spaceResolver={chatSpaceResolver} />
                              </div>
                            )}
                            {['failed', 'canceled'].includes(m.turnStatus) && m.id === lastConversationTurn?.id && !isUser && !m.continuedByMessageId && !hasRunningTurn && (
                              <button type="button" className="turn-materials-link turn-resume" disabled={Boolean(resumingMessage)}
                                onClick={() => void continueTurn(m)}>
                                <Play size={13} />{resumingMessage === m.id ? '正在核对进度…' : '继续处理'}
                              </button>
                            )}
                            {m.turnStatus === 'failed' && spaceItems.length > 0 && (
                              <button type="button" className="turn-materials-link" onClick={() => {
                                setSpaceSelection(null);
                                setSpaceTab('documents');
                                setSpaceOpen(true);
                              }}>
                                <FolderOpen size={14} />查看对话资料
                              </button>
                            )}
                            {!isUser && m.clarificationCard && (() => {
                              const card = m.clarificationCard;
                              const targetMem = card.targetMemberName
                                ? members.find(
                                    (mem) =>
                                      mem.name.toLowerCase() === card.targetMemberName!.toLowerCase() ||
                                      mem.id === card.targetMemberName
                                  )
                                : undefined;
                              return (
                                <div
                                  className={`clarify-card ${card.answered ? 'is-answered' : ''}`}
                                  data-testid="clarification-card"
                                >
                                  <div className="clarify-card-head">
                                    <div className="clarify-card-title">
                                      <ListTodo size={14} />
                                      <strong>{card.title || '派单前需求确认'}</strong>
                                    </div>
                                    {card.targetMemberName && (
                                      <span
                                        className={`clarify-target-pill ${
                                          targetMem && targetMem.status !== 'ready' && targetMem.status !== 'busy'
                                            ? 'is-warn'
                                            : ''
                                        }`}
                                      >
                                        拟指派：{targetMem ? targetMem.name : card.targetMemberName}
                                        {targetMem && targetMem.status !== 'ready' && targetMem.status !== 'busy'
                                          ? '（当前离线）'
                                          : ''}
                                      </span>
                                    )}
                                  </div>
                                  {card.summary && <p className="clarify-card-summary">{card.summary}</p>}
                                  {card.answered ? (
                                    <div className="clarify-answered-bar">
                                      <CheckCircle2 size={14} />
                                      <span>已确认：{card.answeredSummary || '已提交确认并派单'}</span>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="clarify-questions">
                                        {card.questions.map((q, qIdx) => {
                                          const selectedOpts = getSelectedOptionsForClarifyQuestion(m.id, q);
                                          return (
                                            <div key={q.id} className="clarify-question-block">
                                              <div className="clarify-question-label">
                                                <span>
                                                  {qIdx + 1}. {q.question}
                                                </span>
                                                {q.multiSelect && <small>可多选</small>}
                                              </div>
                                              {q.options.length > 0 && (
                                                <div className="clarify-options">
                                                  {q.options.map((opt, optIdx) => {
                                                    const isSelected = selectedOpts.includes(opt);
                                                    return (
                                                      <button
                                                        key={`${q.id}-${optIdx}`}
                                                        type="button"
                                                        aria-pressed={isSelected}
                                                        onClick={() => handleToggleClarifyOption(m.id, q, opt)}
                                                        className={`clarify-option-btn ${isSelected ? 'is-selected' : ''}`}
                                                      >
                                                        {isSelected && <Check size={11} />}
                                                        <span>{opt}</span>
                                                      </button>
                                                    );
                                                  })}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <input
                                        type="text"
                                        value={clarifyNotes[m.id] || ''}
                                        onChange={(e) =>
                                          setClarifyNotes((prev) => ({ ...prev, [m.id]: e.target.value }))
                                        }
                                        placeholder="补充说明、时间范围或更换执行人（选填）…"
                                        className="dw-input clarify-note-input"
                                      />
                                      <div className="clarify-actions">
                                        <button
                                          type="button"
                                          disabled={sending}
                                          onClick={() => void handleConfirmClarificationCard(m, false)}
                                          className="dw-btn dw-btn-primary dw-btn-sm"
                                        >
                                          <Check size={13} />
                                          <span>确认并派发任务</span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={sending}
                                          onClick={() => void handleConfirmClarificationCard(m, true)}
                                          className="dw-btn dw-btn-outline dw-btn-sm"
                                        >
                                          <Play size={12} />
                                          <span>按默认推荐直接派发</span>
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </article>
                        </React.Fragment>
                      );
                    })
                  )}
                </div>

                {/* Exact 1.9.6 Chat Composer */}
                <form className="chat-composer" onSubmit={handleSendMessage}>
                  {activeRefs.length > 0 && (
                    <div className="composer-references">
                      {activeRefs.map((ref) => {
                        const RefIcon = ref.kind === 'link' ? Link2 : ref.kind === 'document' ? FileText : FolderOpen;
                        return (
                          <span key={`${ref.kind}:${ref.id}`} className="space-reference">
                            <button type="button" onClick={() => setSpaceOpen(true)}>
                              <RefIcon size={11} />
                              <span>{ref.title}</span>
                              {ref.subLabel && <small>{ref.subLabel}</small>}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDraftRefsByThread((prev) => ({
                                  ...prev,
                                  [activeThread.id]: (prev[activeThread.id] || []).filter(
                                    (x) => !(x.kind === ref.kind && x.id === ref.id)
                                  )
                                }))
                              }
                              aria-label={`移除引用 ${ref.title}`}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="composer-recipient">
                    <MessageSquare size={13} />
                    <span className="composer-recipient-label">
                      当前对话由 {currentOwner?.name || activeThread.activeOwnerMemberId} 承接
                    </span>
                  </div>

                  {members.length > 0 &&
                    (() => {
                      const collapsible = members.length > 7;
                      let displayedMembers = members;
                      if (collapsible && !showAllQuickMembers) {
                        const activeIdx = members.findIndex(
                          (m) => m.id === activeThread.activeOwnerMemberId
                        );
                        if (activeIdx >= 6) {
                          displayedMembers = [...members.slice(0, 5), members[activeIdx]];
                        } else {
                          displayedMembers = members.slice(0, 6);
                        }
                      }
                      return (
                        <div className="composer-quick-mentions" role="group" aria-label="切换当前对接成员">
                          {displayedMembers.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              aria-pressed={m.id === activeThread.activeOwnerMemberId}
                              onClick={() => void handleSwitchOwner(m.id)}
                              title={`由 ${m.name} 接手当前对话`}
                            >
                              <AgentAvatar small name={m.name} platformId={m.platformId} />
                              <span>{m.name}</span>
                            </button>
                          ))}
                          {collapsible && (
                            <button
                              type="button"
                              className="quick-members-toggle"
                              onClick={() => setShowAllQuickMembers((v) => !v)}
                            >
                              <span>{showAllQuickMembers ? '收起' : `全部 ${members.length} 位`}</span>
                              <ChevronDown
                                size={11}
                                style={showAllQuickMembers ? { transform: 'rotate(180deg)' } : undefined}
                              />
                            </button>
                          )}
                        </div>
                      );
                    })()}

                  {(draftImagesByThread[activeThread.id] || []).length > 0 && (
                    <div className="composer-image-strip" data-testid="composer-image-strip">
                      {(draftImagesByThread[activeThread.id] || []).map((img) => (
                        <div key={img.id} className="composer-image-thumb">
                          <img src={img.url} alt={img.name} />
                          <span title={img.name}>{img.name}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setDraftImagesByThread((prev) => ({
                                ...prev,
                                [activeThread.id]: (prev[activeThread.id] || []).filter((x) => x.id !== img.id)
                              }))
                            }
                            aria-label={`移除图片 ${img.name}`}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <textarea
                    ref={inputRef}
                    value={activeDraft}
                    onChange={(e) =>
                      setInputDrafts((prev) => ({ ...prev, [activeThread.id]: e.target.value }))
                    }
                    onPaste={(e) => {
                      const files = [...(e.clipboardData?.files || [])].filter((f) =>
                        f.type.startsWith('image/')
                      );
                      if (!files.length) return;
                      e.preventDefault();
                      void uploadChatImages(files);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setOwnerMenuOpen(false);
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void handleSendMessage();
                      }
                    }}
                    placeholder={`发消息给 ${currentOwner?.name || '负责人'}（支持粘贴或拖拽图片）…`}
                  />

                  <div className="composer-toolbar">
                    <div onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={composerImageRef}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(e) => {
                          const list = Array.from(e.target.files || []);
                          e.target.value = '';
                          void uploadChatImages(list);
                        }}
                      />
                      <input
                        ref={composerFileRef}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          const list = Array.from(e.target.files || []);
                          e.target.value = '';
                          void uploadFilesToThreadSpace(list);
                        }}
                      />
                      <button
                        type="button"
                        disabled={uploadingChatImages}
                        onClick={() => composerImageRef.current?.click()}
                        className="dw-btn dw-btn-ghost dw-btn-icon"
                        aria-label="发送图片"
                        title={uploadingChatImages ? '图片上传中…' : '添加图片到对话'}
                      >
                        <ImagePlus size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => composerFileRef.current?.click()}
                        className="dw-btn dw-btn-ghost dw-btn-icon"
                        aria-label="上传文件到协作空间"
                        title="上传任意格式文件到资料区"
                      >
                        <Paperclip size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setOwnerMenuOpen((o) => !o)}
                        className="dw-btn dw-btn-ghost dw-btn-icon"
                        aria-label="切换对接成员"
                        title="切换成员"
                      >
                        <AtSign size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSpaceOpen(true);
                          setSpaceTab('documents');
                        }}
                        className="dw-btn dw-btn-ghost dw-btn-icon"
                        aria-label="打开协作资料"
                        title="打开协作资料"
                      >
                        <FileText size={16} />
                      </button>
                      {ownerMenuOpen && (
                        <div className="mention-picker" aria-label="选择对接成员">
                          {members.map((m) => (
                            <button key={m.id} type="button" onClick={() => void handleSwitchOwner(m.id)}>
                              <AgentAvatar small name={m.name} platformId={m.platformId} />
                              <span>
                                {m.name}
                                {m.id === activeThread.activeOwnerMemberId && <small>当前负责人</small>}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      <small>Enter 发送 · Shift + Enter 换行</small>
                    </div>

                    <div className="flex items-center gap-2">
                      {hasRunningTurn && (
                        <button type="button" onClick={() => void handleAbortTurn()} className="dw-btn dw-btn-outline dw-btn-sm">
                          <Square size={11} />
                          <span>停止</span>
                        </button>
                      )}
                      <button
                        type="submit"
                        aria-label="发送消息"
                        disabled={
                          hasRunningTurn ||
                          (!activeDraft.trim() &&
                            activeRefs.length === 0 &&
                            (draftImagesByThread[activeThread.id] || []).length === 0)
                        }
                        className="dw-send-btn"
                      >
                        <ArrowUp size={17} />
                      </button>
                    </div>
                  </div>
                </form>

                <footer className="chat-bottom-note">
                  <span>{streamDisconnected ? '正在重新连接' : cloudMode ? '云端工作区已同步' : '本机工作区已同步'}</span>
                  <span>原生 Agent 协同执行</span>
                </footer>
              </section>

              {showRightSpace && <ColumnDivider side="space" />}
              {renderRightSpace()}
            </div>
          </>
        ) : viewMode === 'archive' ? (
          <>
            <header className="comm-header">
              <div>
                <button
                  type="button"
                  onClick={() => setViewMode('thread')}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                >
                  <ArrowLeft size={13} />
                  <span>返回对话</span>
                </button>
                <div>
                  <h1>{archiveDetail?.archive.name || '历史归档（只读）'}</h1>
                  <p>
                    1.x 只读历史归档记录 · 不触发当前模型派单
                    {archiveDetail?.note ? ` · ${archiveDetail.note}` : ''}
                  </p>
                </div>
              </div>
            </header>
            <div className="messages-scroll">
              {archiveLoading ? (
                <p className="space-muted text-center py-10">正在加载只读历史记录…</p>
              ) : !archiveDetail || archiveDetail.messages.length === 0 ? (
                <p className="space-muted text-center py-10">该历史归档暂无可展示消息</p>
              ) : (
                archiveDetail.messages.map((msg) => (
                  <article key={msg.id} className="chat-message">
                    <AgentAvatar name={msg.authorName} />
                    <div className="message-content">
                      <header>
                        <strong>{msg.authorName}</strong>
                        <time>
                          {msg.createdAt
                            ? new Date(msg.createdAt).toLocaleString('zh-CN', {
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                              })
                            : ''}
                        </time>
                      </header>
                      <div className="message-markdown">
                        <MarkdownView text={msg.body} />
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </>
        ) : taskDetail ? (
          <>
            <header className="comm-header">
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('thread');
                    setActiveThreadId(taskDetail.task.sourceThreadId);
                  }}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                >
                  <ArrowLeft size={13} />
                  <span>返回原对话</span>
                </button>
                <div>
                  <h1>{taskDetail.task.title}</h1>
                  <p>
                    负责人：
                    {(() => {
                      const effectiveLeadId =
                        taskDetail.activeRun?.leadMemberId || taskDetail.task.leadMemberId;
                      return memberById.get(effectiveLeadId)?.name || effectiveLeadId;
                    })()}
                    {taskDetail.task.kind === 'scheduled' && taskDetail.task.cronExpr
                      ? ` · 定时规则：${taskDetail.task.cronExpr} (${taskDetail.task.timezone})`
                      : ' · 单次任务'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {taskDetail.activeRun?.status === 'running' && (
                  <button
                    type="button"
                    onClick={() => void handleCancelRun(taskDetail.activeRun!.id)}
                    className="dw-btn dw-btn-outline dw-btn-sm"
                  >
                    <Square size={11} />
                    <span>停止执行</span>
                  </button>
                )}
                {taskDetail.task.status === 'active' && (!taskDetail.runs.length || (taskDetail.task.kind === 'once' && ['failed','timed_out'].includes(taskDetail.runs[0].status)) || (taskDetail.task.kind === 'scheduled' && !taskDetail.runs.some(run => ['running','waiting_user','waiting_node_online','paused'].includes(run.status)))) && <button
                  type="button"
                  onClick={() => void handleRunTaskNowById(taskDetail.task.id, taskDetail.task.kind === 'once' ? taskDetail.runs[0]?.id : undefined)}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                >
                  <Play size={12} />
                  <span>{taskDetail.task.kind === 'once' && taskDetail.runs.length ? '重新运行整项任务' : '立即执行一次'}</span>
                </button>}
                {(taskDetail.task.kind === 'scheduled' || taskDetail.activeRun?.status === 'running' || taskDetail.task.status === 'paused') && (
                  <button
                    type="button"
                    onClick={() => void handlePauseTask(taskDetail.task.id, taskDetail.task.status !== 'paused')}
                    className="dw-btn dw-btn-outline dw-btn-sm"
                  >
                    {taskDetail.task.scheduleEnabled ? <Pause size={12} /> : <Play size={12} />}
                    <span>{taskDetail.task.status === 'paused' ? '继续任务' : '暂停任务'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (confirmDeleteTaskId === taskDetail.task.id) {
                      void handleDeleteTask(taskDetail.task.id);
                    } else {
                      setConfirmDeleteTaskId(taskDetail.task.id);
                    }
                  }}
                  className="dw-btn dw-btn-outline dw-btn-sm"
                  style={
                    confirmDeleteTaskId === taskDetail.task.id
                      ? { borderColor: '#be4343', color: '#be4343' }
                      : { color: '#9c524a' }
                  }
                >
                  <Trash2 size={12} />
                  <span>{confirmDeleteTaskId === taskDetail.task.id ? '确认删除？' : '删除任务'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSpaceOpen((v) => !v)}
                  className="dw-btn dw-btn-ghost dw-btn-icon"
                  aria-label={spaceOpen ? '隐藏协作空间' : '展开协作空间'}
                >
                  {spaceOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
                </button>
              </div>
            </header>

            <div className="comm-body">
              <section className="conversation-column">
                {taskDetail.runs.length > 1 && (
                  <div className="connector-categories px-8 pt-4">
                    {taskDetail.runs.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={taskDetail.activeRun?.id === r.id}
                        onClick={() => void loadTaskDetail(taskDetail.task.id, r.id)}
                      >
                        第 {r.runNumber} 期 (
                        {r.status === 'completed'
                          ? '已完成'
                          : r.status === 'failed'
                            ? '失败'
                            : r.status === 'timed_out'
                              ? '超时'
                              : r.status === 'canceled'
                                ? '已取消'
                                : r.status === 'paused' ? '已暂停' : r.status === 'waiting_user'
                                  ? '待确认'
                                  : '进行中'}
                        )
                      </button>
                    ))}
                  </div>
                )}

                {taskDetail.activeRun?.status === 'waiting_user' && (
                  <form className="mx-7 mt-4" onSubmit={e => {
                    e.preventDefault();
                    void handleReplyWaitingRun(taskDetail.activeRun!.id);
                  }}>
                    <label>{taskDetail.activeRun.waitingQuestion}
                      <input className="dw-input" value={waitingReplies[taskDetail.activeRun.id] ?? ''} onChange={e => updateWaitingReply(taskDetail.activeRun!.id,e.target.value)} placeholder="回复任务负责人" />
                    </label>
                    <button className="dw-btn dw-btn-primary dw-btn-sm" disabled={!waitingReplies[taskDetail.activeRun.id]?.trim()}>答复并继续</button>
                  </form>
                )}
                {taskDetail.activeRun?.summary &&
                  (taskDetail.activeRun.status === 'failed' ||
                    taskDetail.activeRun.status === 'timed_out' ||
                    taskDetail.activeRun.status === 'canceled') && (
                    <div className="services-error mx-7 mt-4">
                      {taskDetail.activeRun.summary}
                    </div>
                  )}

                <div className="messages-scroll">
                  {taskDetail.steps.map((step) => {
                    const assignee = memberById.get(step.assigneeMemberId);
                    const assigneeName = assignee?.name || step.assigneeMemberId;
                    const latestSub = step.submissions[0];
                    const latestRev = step.reviews[0];
                    return (
                      <div key={step.id} className="task-panel">
                        <h3>
                          <span className="inline-flex items-center gap-2">
                            <AgentAvatar small name={assigneeName} platformId={assignee?.platformId} />
                            <span>{step.stepOrder}. {step.title}</span>
                          </span>
                          <span className={`delivery-badge ${step.status === 'accepted' ? 'accepted' : ''}`}>
                            {step.status === 'accepted'
                              ? '已通过'
                              : step.status === 'changes_requested'
                                ? '修改中'
                                : step.status === 'failed'
                                  ? '执行失败'
                                  : step.status === 'canceled'
                                    ? '已取消'
                                    : step.status === 'timed_out'
                                      ? '执行超时'
                                      : step.status === 'blocked'
                                        ? '待确认'
                                        : step.status === 'submitted'
                                          ? '待核验'
                                          : step.status === 'running'
                                            ? '进行中'
                                            : '待开始'}
                          </span>
                        </h3>
                        <p className="mt-2" style={{ fontSize: 12, color: '#7d8ca3' }}>
                          执行人：{assigneeName}
                        </p>
                        {latestSub && (
                          <div className="mt-2 p-3 rounded-lg dw-inline-subtle">
                            <MarkdownView text={latestSub.summary} />
                          </div>
                        )}
                        {latestRev && (
                          <p className="mt-2" style={{ fontSize: 12, color: '#6b7e9a' }}>
                            负责人意见：{latestRev.comments}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {showRightSpace && <ColumnDivider side="space" />}
              {renderRightSpace()}
            </div>
          </>
        ) : null}
      </main>
    </WorkbenchColumns>
  );
}
