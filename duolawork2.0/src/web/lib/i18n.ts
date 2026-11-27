import { useCallback, useSyncExternalStore } from 'react';

export type Locale = 'zh' | 'en';

const LOCALE_STORAGE_KEY = 'dw_locale';
const listeners = new Set<() => void>();

function readLocaleSnapshot(): Locale {
  if (typeof window === 'undefined') return 'zh';
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // ignore storage fallback
  }
  return 'zh';
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key === LOCALE_STORAGE_KEY) {
      listeners.forEach((fn) => fn());
    }
  });
}

export function setAppLocale(next: Locale): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore storage fallback
    }
  }
  listeners.forEach((fn) => fn());
}

const DICT = {
  zh: {
    brandSubtitle: '多 Agent 协作台',
    toggleTheme: '切换深浅主题',
    searchThreads: '搜索对话…',
    navMembers: '成员与用量',
    navConnectors: '连接器',
    navVault: 'Vault 凭证库',
    navSchedules: '定时任务',
    sidebarThreads: '对话',
    newThreadAria: '新对话',
    newThreadTitle: '新建对话',
    sidebarEmpty: '没有匹配的对话，清空搜索可查看全部。',
    legacyArchives: '历史归档 ({n})',
    legacyArchivesEmpty: '暂无旧版只读归档记录',
    modeCloud: '云端工作区',
    modeLocal: '本机工作区',
    badgeCloud: '云端版',
    badgeLocal: '本地版',
    assignTask: '指派任务',
    assignTaskHint: '说清要做什么，由 Agent 理解并自动立项',
    taskOnce: '一次性',
    taskScheduled: '循环定时',
    presetTrackTitle: '竞品/行业周期追踪',
    presetTrackPrompt: '每周追踪目标竞品与行业关键动态，整理结构化 CSV 数据表与简报摘要（没写频率时先向我确认具体时间）。',
    presetRepoTitle: '仓库巡检与周度复盘',
    presetRepoPrompt: '每周检查当前工作区代码变更、测试健康度与待办风险，输出周度技术复盘与改进清单。',
    presetReviewTitle: '方案双人质询复核',
    presetReviewPrompt: '针对当前文档方案做一次跨成员核查：列出关键风险点、可简化项，并输出修订版本。',
    bindWorkspace: '绑定工作目录',
    bindFolderBtn: '绑定本地文件夹',
    discoverShortcutBtn: '发现本机 Agent',
    hideSpace: '隐藏协作空间',
    expandSpace: '展开协作空间',
    welcomeSubtitle: '自带订阅的多 Agent 桌面协作台 · 文档、代码与定时任务同桌交付',
    scenarioSpecTitle: '方案定稿 → 切人写代码',
    scenarioSpecDesc: '先与当前成员聊清方案并定稿 Markdown，再切换 Codex 基于定稿开独立分支写代码跑测试。',
    scenarioSpecPrompt: '请先帮我梳理这份需求的系统方案和模块边界，并在右侧生成结构化 Markdown 设计文档；定稿后我再切换编码成员推进实现。',
    scenarioScheduleTitle: '定时调研 + CSV 数据表',
    scenarioScheduleDesc: '一句话下达周期追踪，支持多 Agent 接力抓取、清洗 CSV 报表并由负责人自动验收。',
    scenarioFolderTitle: '本地文件夹协作审阅',
    scenarioFolderDesc: '将本地项目资料夹直接交给当前对话，随时阅读、对比与修改目录内的文档和代码。',
    scenarioFolderBoundPrompt: '请结合当前已绑定的本地工作目录，列出关键文档与源码结构，并给出优先处理建议。',
    currentHandler: '当前对话由 {name} 承接',
    sendPlaceholder: '发消息给 {name}（支持粘贴或拖拽图片）…',
    discoverTitle: '本机 Agent 一键发现',
    discoverDesc: '自动探测本机已安装的 Codex、Claude Code 与 Gemini CLI，零配置复用你已有的官方订阅。',
    discoverCloudNote: '当前为云端控制面模式：请通过下方「执行节点」配对你的本机桌面端，即可远程调用本机 CLI 与本地目录。',
    discoverReady: '已就绪',
    discoverNeedsLogin: '需先登录',
    discoverNotInstalled: '未安装',
    discoverConnected: '已接入',
    discoverActivate: '一键接入',
    discoverRefresh: '重新扫描',
    discoverReactivate: '同步状态',
    membersPageTitle: '成员与用量统计',
    membersPageDesc: '统一管理本机与远端 Agent 成员、跨机执行节点与实时 Token 消耗流水。',
    readerTabList: '已打开的文档标签页',
    readerAddTab: '打开更多资料标签',
    readerModeRead: '阅读',
    readerModeSplit: '分屏',
    readerModeEdit: '编辑',
    readerToc: '目录',
    readerVersions: '版本 ({n})',
    readerCopy: '复制',
    readerCopied: '已复制',
    readerExport: '导出',
    readerDownload: '下载',
    readerSave: '保存',
    readerSaving: '保存中…',
    readerLight: '浅色',
    readerSepia: '护眼',
    readerDark: '深色'
  },
  en: {
    brandSubtitle: 'Multi-Model Cowork',
    toggleTheme: 'Toggle light/dark theme',
    searchThreads: 'Search threads…',
    navMembers: 'Members & Usage',
    navConnectors: 'Connectors',
    navVault: 'Vault Secrets',
    navSchedules: 'Schedules',
    sidebarThreads: 'Threads',
    newThreadAria: 'New Thread',
    newThreadTitle: 'New Thread',
    sidebarEmpty: 'No matching threads.',
    legacyArchives: 'Legacy Archives ({n})',
    legacyArchivesEmpty: 'No legacy read-only archives',
    modeCloud: 'Cloud Control Plane',
    modeLocal: 'Local Workspace',
    badgeCloud: 'Cloud',
    badgeLocal: 'Local-First',
    assignTask: 'Assign Task',
    assignTaskHint: 'Describe what needs to be done; the lead agent will plan and verify it',
    taskOnce: 'One-off',
    taskScheduled: 'Scheduled',
    presetTrackTitle: 'Weekly Competitor & CSV Tracker',
    presetTrackPrompt: 'Track key competitor updates every week and deliver a structured CSV dataset plus executive brief.',
    presetRepoTitle: 'Repo Health & Weekly Review',
    presetRepoPrompt: 'Audit recent repository changes, test health, and open risks every week into a concise review doc.',
    presetReviewTitle: 'Two-Agent Spec Review',
    presetReviewPrompt: 'Run an independent adversarial review on the current design doc, listing key risks and proposed edits.',
    bindWorkspace: 'Bind Workspace',
    bindFolderBtn: 'Bind Local Folder',
    discoverShortcutBtn: 'Discover Local Agents',
    hideSpace: 'Hide Space',
    expandSpace: 'Show Space',
    welcomeSubtitle: 'The Multi-Model Cowork Workbench for Your Own Subscriptions — docs, code & scheduled runs on one desk',
    scenarioSpecTitle: 'Spec First → Hand Off to Code',
    scenarioSpecDesc: 'Draft and refine a structured Markdown spec first, then switch to Codex with bounded delta handoff to build and test.',
    scenarioSpecPrompt: 'Help me draft a clear technical specification and implementation plan in the right-hand Collaboration Space so we can hand it off to a coding agent next.',
    scenarioScheduleTitle: 'Scheduled Research + CSV Brief',
    scenarioScheduleDesc: 'Delegate recurring tracking in plain language with multi-agent handoffs and automatic lead verification.',
    scenarioFolderTitle: 'Local Folder Cowork & Review',
    scenarioFolderDesc: 'Bind a local project directory directly so agents can inspect docs, CSVs, and code side-by-side.',
    scenarioFolderBoundPrompt: 'Inspect the bound local workspace folder, summarize key docs and code structure, and suggest next steps.',
    currentHandler: 'Handled by {name}',
    sendPlaceholder: 'Message {name} (paste or drop images)…',
    discoverTitle: 'Auto-Discover Local Agents (BYOS)',
    discoverDesc: 'Detect Codex, Claude Code, and Gemini CLIs on this machine to reuse your existing subscriptions with zero credit tax.',
    discoverCloudNote: 'Running in Cloud Control Plane mode: pair a local desktop execution node below to access your local CLIs and folders.',
    discoverReady: 'Ready',
    discoverNeedsLogin: 'Login Needed',
    discoverNotInstalled: 'Not Installed',
    discoverConnected: 'Connected',
    discoverActivate: 'Activate',
    discoverRefresh: 'Rescan',
    discoverReactivate: 'Sync',
    membersPageTitle: 'Members & Usage',
    membersPageDesc: 'Manage local BYOS CLIs, cloud execution nodes, and three-tier token telemetry.',
    readerTabList: 'Open Document Tabs',
    readerAddTab: 'Open More Materials',
    readerModeRead: 'Read',
    readerModeSplit: 'Split',
    readerModeEdit: 'Edit',
    readerToc: 'Outline',
    readerVersions: 'Versions ({n})',
    readerCopy: 'Copy',
    readerCopied: 'Copied',
    readerExport: 'Export',
    readerDownload: 'Download',
    readerSave: 'Save',
    readerSaving: 'Saving…',
    readerLight: 'Light',
    readerSepia: 'Sepia',
    readerDark: 'Dark'
  }
} as const;

export type I18nKey = keyof typeof DICT.zh;

function formatTemplate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_all, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export function useI18n(): {
  locale: Locale;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  t: (key: I18nKey, vars?: Record<string, string | number>) => string;
} {
  const locale = useSyncExternalStore<Locale>(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    readLocaleSnapshot,
    () => 'zh'
  );

  const toggleLocale = useCallback(() => {
    setAppLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale]);

  const t = useCallback(
    (key: I18nKey, vars?: Record<string, string | number>) => {
      const table = DICT[locale] ?? DICT.zh;
      return formatTemplate(table[key] ?? DICT.zh[key], vars);
    },
    [locale]
  );

  return { locale, setLocale: setAppLocale, toggleLocale, t };
}
