import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Layers,
  MessageCircle,
  Inbox,
  BookOpen,
  Users,
  Settings,
  Plus,
  Search,
  ArrowLeft,
  ArrowRight,
  FileText,
  PanelRight,
  SlidersHorizontal,
  ChevronDown,
  Clock3,
  Check,
  Menu,
  X,
  Folder,
  Play,
  Pause,
  CircleHelp,
} from "lucide-react";
import { Avatar, IconButton, Badge, Modal, Empty } from "./common.jsx";
import Conversation, { Overview } from "./Conversation.jsx";
import DocumentPane from "./DocumentPane.jsx";
import {
  ManagementPage,
  ProjectForm,
  RuleForm,
  MemberForm,
  MaterialForm,
  RunDetails,
} from "./Pages.jsx";
import {
  loadState,
  STORAGE_KEY,
  makeProject,
  makeDoc,
  uid,
  now,
  modes,
  pendingCount,
  currentFeedback,
  escapeHTML,
  planSteps,
} from "./model.mjs";

import { ComparisonPane } from "./V1.jsx";
import { advancePreview } from "./v1-data.mjs";

function App() {
  const [state, setState] = useState(loadState);
  const [query, setQuery] = useState("");
  const [side, setSide] = useState("results");
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 1380);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const toastTimer = useRef(null);
  const project =
    state.projects.find((p) => p.id === state.projectId) || state.projects[0];
  const members = state.members;
  const currentDoc =
    project.docs.find((d) => d.id === project.selectedDoc) || project.docs[0];
  const totalPending = state.projects.reduce((n, p) => n + pendingCount(p), 0);
  const closeModal = useCallback(() => setModal(null), []);
  const notify = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4600);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [state]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const updateProject = useCallback(
    (id, fn) =>
      setState((s) => ({
        ...s,
        projects: s.projects.map((p) => (p.id === id ? fn(p) : p)),
      })),
    [],
  );
  const patch = (fn) => updateProject(project.id, fn);
  const updateDoc = (projectId, docId, fn) =>
    updateProject(projectId, (p) => {
      const before = p.docs.find((d) => d.id === docId);
      if (!before) return p;
      const after = fn(before);
      const markup =
        before.html !== after.html
          ? new DOMParser().parseFromString(after.html, "text/html")
          : null;
      return {
        ...p,
        docs: p.docs.map((d) => (d.id === docId ? after : d)),
        decisions: markup
          ? p.decisions.map((d) => {
              if (d.docId !== docId) return d;
              const node = [...markup.querySelectorAll("hub-decision")].find(
                (el) => el.getAttribute("data-id") === d.id,
              );
              const selectedText = node?.getAttribute("data-selected") || null;
              return {
                ...d,
                status: selectedText ? "resolved" : "pending",
                selectedText,
                choice: node?.getAttribute("data-choice") || null,
              };
            })
          : p.decisions,
      };
    });
  const navigate = (page) => {
    setState((s) => ({ ...s, page, review: false }));
    setSidebarOpen(false);
  };
  function chooseProject(id, review = false, docId) {
    setState((s) => ({
      ...s,
      projectId: id,
      page: "projects",
      review,
      projects: docId
        ? s.projects.map((p) =>
            p.id === id ? { ...p, selectedDoc: docId } : p,
          )
        : s.projects,
    }));
    setSidebarOpen(false);
  }
  function openDecision(projectId, decision) {
    chooseProject(projectId, true, decision.docId);
    updateProject(projectId, (p) => ({
      ...p,
      focusDecision: decision.id,
      docs: p.docs.map((d) =>
        d.id === decision.docId && !d.html.includes(`data-id="${decision.id}"`)
          ? {
              ...d,
              history: [
                ...d.history,
                {
                  html: d.html,
                  revision: d.revision,
                  time: now(),
                  label: "恢复决策位置前的工作稿",
                },
              ],
              html: `${d.html}<hub-decision data-id="${decision.id}"></hub-decision>`,
              revision: d.revision + 1,
            }
          : d,
      ),
    }));
  }
  function chooseInlineDecision(decisionId, choice, text, remember) {
    patch((p) => {
      const decision = p.decisions.find((d) => d.id === decisionId);
      const ruleId = remember ? uid("rule") : decision?.rememberedRuleId;
      return {
        ...p,
        decisions: p.decisions.map((d) =>
          d.id === decisionId
            ? {
                ...d,
                status: choice ? "resolved" : "pending",
                choice,
                selectedText: text,
                rememberedRuleId: ruleId,
              }
            : d,
        ),
        rules: [
          ...p.rules.map((r) =>
            !choice && r.id === ruleId ? { ...r, status: "revoked" } : r,
          ),
          ...(remember
            ? [
                {
                  id: ruleId,
                  title: decision.title,
                  body: text,
                  status: "active",
                  revision: 1,
                  scope: "本项目",
                  type: "guidance",
                  checks: "guidance",
                  evidence: `用户在「${currentDoc.title}」中明确选择了同类问题以后这样处理。`,
                },
              ]
            : []),
        ],
        messages: [
          ...p.messages,
          {
            id: uid(),
            type: "system",
            time: now(),
            text: choice
              ? `已在成果中决定：${choice}。`
              : "已撤回稿件中的决定，重新保留分歧。",
          },
        ],
      };
    });
  }
  function applySuggestion(docId, action) {
    patch((p) => {
      const doc = p.docs.find((d) => d.id === docId),
        suggestion = doc?.suggestion;
      if (!suggestion) return p;
      const ruleId = suggestion.ruleId || uid("rule");
      return {
        ...p,
        docs: p.docs.map((d) =>
          d.id === docId
            ? {
                ...d,
                suggestion: {
                  ...suggestion,
                  ruleId,
                  status:
                    action === "accept"
                      ? "accepted"
                      : action === "undo"
                        ? "pending"
                        : "dismissed",
                },
              }
            : d,
        ),
        rules:
          action === "accept"
            ? [
                ...p.rules.filter((r) => r.id !== ruleId),
                {
                  id: ruleId,
                  title: suggestion.text.slice(0, 40),
                  body: suggestion.text,
                  status: "active",
                  revision: 1,
                  type: "style",
                  checks: "guidance",
                  scope: "本项目",
                  evidence: `用户确认的稿件旁建议；「${doc.title}」版本 ${suggestion.revision}。示例归纳。`,
                },
              ]
            : action === "undo"
              ? p.rules.map((r) =>
                  r.id === ruleId ? { ...r, status: "revoked" } : r,
                )
              : p.rules,
      };
    });
  }
  const openDoc = (id) => chooseProject(project.id, true, id);
  function ensureSaved() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      setStorageError(true);
      notify("本机存储失败，请先导出工作区；修改要求尚未提交。");
      return false;
    }
  }
  function saveProject(config, when) {
    if (modal?.type === "plan") {
      patch((p) => ({
        ...p,
        ...(when === "next" && p.status === "running"
          ? { pendingPlan: config }
          : { ...config, planVersion: p.planVersion + 1 }),
        messages: [
          ...p.messages,
          {
            id: uid(),
            type: "system",
            time: now(),
            text:
              when === "next" && p.status === "running"
                ? "新工作安排已保留，下一轮使用。"
                : "工作安排已更新，已有成果保留。",
          },
        ],
      }));
      notify("工作安排已保留在此预览");
    } else {
      const p = makeProject({
        ...config,
        status: "running",
        demoStep: 1,
        messages: [
          {
            id: uid(),
            type: "system",
            time: now(),
            text: "示例运行开始，成员按所选方式协作；未调用真实 Agent。",
          },
        ],
      });
      setState((s) => ({
        ...s,
        projects: [...s.projects, p],
        projectId: p.id,
        page: "projects",
        review: false,
      }));
      setSideOpen(true);
      setSide("members");
      notify("项目已创建，可以查看安排或演示协作过程");
    }
    setModal(null);
  }
  function sendMessage() {
    if (!project.composer.trim() || !ensureSaved()) return;
    const text = project.composer.trim(),
      target = project.composerTarget;
    patch((p) => ({
      ...p,
      composer: "",
      composerHtml: "",
      messages: [
        ...p.messages,
        {
          id: uid(),
          author: "me",
          time: now(),
          text,
          html: p.composerHtml,
          target,
          local: true,
        },
      ],
    }));
    notify(
      target
        ? "定向要求已保留在预览，未发送给真实 Agent"
        : "消息已保留在此预览",
    );
  }
  function demoNext() {
    if (project.status === "paused") {
      notify("本轮已暂停，请先恢复");
      return;
    }
    patch((p) => advancePreview(p));
  }
  function decide(projectId, decisionId, choice) {
    updateProject(projectId, (p) => ({
      ...p,
      decisions: p.decisions.map((d) =>
        d.id === decisionId
          ? {
              ...d,
              status: choice === "再补充证据" ? "waiting" : "resolved",
              choice,
              decidedAt: now(),
            }
          : d,
      ),
      messages: [
        ...p.messages,
        {
          id: uid(),
          type: "system",
          time: now(),
          text: `已记录决定：${choice}${choice === "再补充证据" ? "。补查要求已列入预览，等待真实接入。" : "。"}`,
        },
      ],
    }));
    notify("决定已记录，可在项目中查看");
  }
  function saveRule(data) {
    const target = modal.projectId || project.id;
    updateProject(target, (p) => {
      const old = p.rules.find((r) => r.id === modal.ruleId);
      const revision = old ? old.revision + 1 : 1;
      if (old && ["active", "trial", "superseded"].includes(old.status)) {
        return {
          ...p,
          rules: [
            ...p.rules,
            {
              id: uid("rule"),
              ...data,
              status: "proposed",
              revision,
              scope: "本项目",
              baseRuleId: old.id,
              previousBody: old.body,
            },
          ],
        };
      }
      return {
        ...p,
        rules: old
          ? p.rules.map((r) =>
              r.id === old.id
                ? { ...r, ...data, revision, status: "proposed" }
                : r,
            )
          : [
              ...p.rules,
              {
                id: uid("rule"),
                ...data,
                status: "proposed",
                revision,
                scope: "本项目",
              },
            ],
      };
    });
    closeModal();
    notify("已保存为待批准规则，正在使用的版本保持不变");
  }
  function ruleAction(projectId, ruleId, action) {
    const p = state.projects.find((p) => p.id === projectId),
      r = p.rules.find((r) => r.id === ruleId);
    if (
      action === "trial" &&
      p.rules.some(
        (x) => x.id !== ruleId && x.status === "trial" && x.type === r.type,
      )
    ) {
      notify("同类规则已有试行，请先完成复查");
      return;
    }
    updateProject(projectId, (p) => ({
      ...p,
      rules: p.rules.map((x) => {
        if (x.id === ruleId) return { ...x, status: action, reviewedAt: now() };
        if (x.id === r.baseRuleId && action === "trial")
          return {
            ...x,
            status: "superseded",
            supersededBy: ruleId,
            priorStatus: x.status,
          };
        if (
          x.id === r.baseRuleId &&
          action === "revoked" &&
          x.supersededBy === ruleId
        )
          return {
            ...x,
            status: x.priorStatus || "active",
            supersededBy: null,
          };
        return x;
      }),
      messages: [
        ...p.messages,
        {
          id: uid(),
          type: "system",
          time: now(),
          text: `规则「${r.title}」${{ trial: "已批准试行，仅影响下一轮。", active: "已确认保留。", revoked: "已撤回，不再用于新任务。", rejected: "未采用。" }[action]}`,
        },
      ],
    }));
    notify(
      action === "trial"
        ? "试行范围已保留；真实执行与验证待接入"
        : "规则状态已更新",
    );
  }
  function requestRevision(docId) {
    const d = project.docs.find((d) => d.id === docId);
    if (!d.requestDraft.trim() || !ensureSaved()) return;
    const request = {
      id: uid("request"),
      member: d.requestMember,
      instruction: d.requestDraft.trim(),
      html: d.html,
      baseRevision: d.revision,
      time: now(),
      status: "recorded",
    };
    patch((p) => ({
      ...p,
      docs: p.docs.map((x) =>
        x.id === d.id
          ? { ...x, requestDraft: "", requests: [...x.requests, request] }
          : x,
      ),
      messages: [
        ...p.messages,
        {
          id: uid(),
          author: "me",
          target: request.member,
          time: now(),
          text: `请修改「${d.title}」：${request.instruction}`,
          docId,
          local: true,
        },
      ],
    }));
    notify("修改要求与完整工作稿已保留，未发送给真实 Agent");
  }
  function loadCandidate(docId) {
    updateDoc(project.id, docId, (d) => {
      const r = d.requests.at(-1);
      if (!r || d.candidate) return d;
      return {
        ...d,
        candidate: {
          id: uid("candidate"),
          author: r.member,
          baseRevision: r.baseRevision,
          baseHTML: r.html,
          html: `${r.html}<h2>示例修订说明</h2><p>${escapeHTML(r.instruction)}</p><p>这段示例回复用于验证预览与应用操作，不代表模型实际完成了改写。</p>`,
          time: now(),
        },
      };
    });
    notify("已载入示例回复；当前工作稿没有被覆盖");
  }
  const actions = {
    notify,
    setModal,
    chooseProject,
    decide,
    ruleAction,
    updateProject,
    setState,
    navigate,
    openDecision,
  };
  const nav = [
    ["projects", "项目", MessageCircle],
    ["results", "成果", FileText],
    ["decisions", "待我决定", Inbox],
    ["knowledge", "知识库", BookOpen],
    ["members", "成员", Users],
  ];
  return (
    <div
      className={`app-shell ${state.page === "projects" ? "with-projects" : ""} ${state.review ? "review-mode" : ""}`}
    >
      <div className="preview-bar">
        <span>
          <span className="preview-dot" />
          Agent Hub v1 <span className="preview-separator">/</span> 可点击原型 ·
          示例数据 · 未连接真实 Agent
        </span>
        <button onClick={() => setModal({ type: "about" })}>
          查看说明 <CircleHelp size={13} />
        </button>
      </div>
      <div className="app-body">
        <nav className="global-rail" aria-label="主导航">
          <button
            className="brand"
            aria-label="Agent Hub 首页"
            onClick={() => navigate("projects")}
          >
            <Layers size={25} />
          </button>
          <div className="rail-nav">
            {nav.map(([id, label, Icon]) => (
              <button
                key={id}
                className={`rail-item ${state.page === id ? "active" : ""}`}
                onClick={() => navigate(id)}
                aria-label={label}
                aria-current={state.page === id ? "page" : undefined}
              >
                <span className="rail-icon">
                  <Icon size={23} strokeWidth={1.7} />
                  {id === "decisions" && totalPending > 0 && <i />}
                </span>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="rail-bottom">
            <button
              className={`rail-item ${state.page === "settings" ? "active" : ""}`}
              onClick={() => navigate("settings")}
              aria-label="设置"
            >
              <Settings size={22} />
              <span>设置</span>
            </button>
            <span className="profile" title="个人工作区">
              D
            </span>
          </div>
        </nav>
        {state.page === "projects" && (
          <>
            <aside
              className={`project-list ${sidebarOpen ? "mobile-open" : ""}`}
            >
              {state.review ? (
                <>
                  <button
                    className="back-link"
                    onClick={() => chooseProject(project.id)}
                  >
                    <ArrowLeft size={17} />
                    返回群聊
                  </button>
                  <div className="review-project">
                    <span className="eyebrow">当前项目</span>
                    <h2>{project.name}</h2>
                  </div>
                  <div className="list-label">
                    成果 <span>{project.docs.length}</span>
                  </div>
                  <div className="list-scroll">
                    {project.docs.map((d, i) => (
                      <button
                        key={d.id}
                        className={`doc-nav ${d.id === currentDoc?.id ? "selected" : ""}`}
                        onClick={() => {
                          patch((p) => ({ ...p, selectedDoc: d.id }));
                          setSidebarOpen(false);
                        }}
                      >
                        <span className="doc-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span>
                          <strong>{d.title}</strong>
                          <small>
                            {currentFeedback(d) === "adopted"
                              ? "已采用"
                              : currentFeedback(d) === "rejected"
                                ? "已弃用"
                                : "待审阅"}
                            {d.candidate ? " · 有新版本" : ""}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="list-heading">
                    <h1>项目</h1>
                    <IconButton
                      icon={Plus}
                      label="新建项目"
                      onClick={() => setModal({ type: "create" })}
                    />
                  </div>
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label="搜索项目"
                      placeholder="搜索项目"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <div className="list-label">
                    我的工作空间 <span>{state.projects.length}</span>
                  </div>
                  <div className="list-scroll">
                    {state.projects
                      .filter((p) =>
                        `${p.name} ${p.goal}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((p) => (
                        <div
                          key={p.id}
                          className={`project-item ${p.id === project.id ? "selected" : ""}`}
                        >
                          <button
                            className="project-hit"
                            onClick={() => chooseProject(p.id)}
                          >
                            <span className="project-icon">
                              <Folder size={18} />
                            </span>
                            <strong>{p.name}</strong>
                            <small>
                              {p.status === "running"
                                ? "示例运行中"
                                : p.status === "paused"
                                  ? "已暂停"
                                  : p.docs.length
                                    ? `${p.docs.filter((d) => !currentFeedback(d)).length} 份成果待评价`
                                    : "准备工作安排"}
                            </small>
                          </button>
                          {p.docs.length > 0 && (
                            <button
                              className="project-review"
                              onClick={() => chooseProject(p.id, true)}
                              aria-label={`审阅${p.name}成果`}
                            >
                              审阅成果 <ArrowRight size={13} />
                            </button>
                          )}
                        </div>
                      ))}
                    {!state.projects.some((p) =>
                      `${p.name} ${p.goal}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    ) && <p className="muted search-empty">没有匹配的项目</p>}
                  </div>
                </>
              )}
              <button
                className="sidebar-foot"
                onClick={() => {
                  navigate("knowledge");
                }}
              >
                <BookOpen size={17} />
                <span>
                  资料与规则
                  <small>
                    {
                      project.rules.filter((r) => r.status === "proposed")
                        .length
                    }{" "}
                    条待确认
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            </aside>
            {sidebarOpen && (
              <button
                className="drawer-scrim"
                aria-label="收起项目列表"
                onClick={() => setSidebarOpen(false)}
              />
            )}
          </>
        )}
        <main className="main-workspace">
          {storageError && (
            <div className="storage-error" role="alert">
              本机保存失败，当前修改仍在内存中。请在设置中导出工作区，暂勿关闭页面。
            </div>
          )}
          {state.page === "projects" ? (
            state.review && currentDoc ? (
              project.delivery === "compare" ? (
                <ComparisonPane
                  storageError={storageError}
                  project={project}
                  members={members}
                  patch={patch}
                  onBack={() => chooseProject(project.id)}
                  notify={notify}
                />
              ) : (
                <DocumentPane
                  key={`${project.id}:${currentDoc.id}`}
                  project={project}
                  doc={currentDoc}
                  members={members}
                  updateDoc={(fn) => updateDoc(project.id, currentDoc.id, fn)}
                  requestRevision={() => requestRevision(currentDoc.id)}
                  loadCandidate={() => loadCandidate(currentDoc.id)}
                  notify={notify}
                  storageError={storageError}
                  openSidebar={() => setSidebarOpen(true)}
                  onDecision={chooseInlineDecision}
                  onSuggestion={(action) =>
                    applySuggestion(currentDoc.id, action)
                  }
                  focusDecision={project.focusDecision}
                />
              )
            ) : (
              <>
                <header className="workspace-header">
                  <div className="header-title">
                    <IconButton
                      icon={Menu}
                      label="展开项目列表"
                      className="icon-button mobile-menu"
                      onClick={() => setSidebarOpen(true)}
                    />
                    <span className="project-header-icon">
                      <Folder size={20} />
                    </span>
                    <h2>{project.name}</h2>
                    <button
                      className="v1-header-mode"
                      onClick={() => setModal({ type: "plan" })}
                    >
                      {project.delivery === "compare"
                        ? "各自提交"
                        : modes.find((m) => m.id === project.mode)?.short}
                    </button>
                    <span className="v1-header-status">
                      {{
                        review: "待审阅",
                        running: "进行中",
                        paused: "已暂停",
                        needs_attention: "需要处理",
                        idle: "未开始",
                        terminated: "已终止",
                      }[project.status] || "待安排"}
                    </span>
                    <div className="member-stack">
                      {project.members.slice(0, 4).map((id) => (
                        <Avatar
                          key={id}
                          member={members.find((m) => m.id === id)}
                          size={25}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="header-actions">
                    <button
                      className="v1-header-pending text-button"
                      onClick={() => navigate("decisions")}
                    >
                      {pendingCount(project)} 项待决定
                    </button>
                    <button
                      className="button quiet"
                      onClick={() => setModal({ type: "plan" })}
                    >
                      <SlidersHorizontal size={16} />
                      <span>工作安排</span>
                    </button>
                    <IconButton
                      icon={Clock3}
                      label="查看运行记录"
                      onClick={() => setModal({ type: "run" })}
                    />
                    <IconButton
                      icon={PanelRight}
                      label={sideOpen ? "收起成果与资料" : "展开成果与资料"}
                      active={sideOpen}
                      onClick={() => setSideOpen((v) => !v)}
                    />
                  </div>
                </header>
                <div className="group-layout">
                  <Conversation
                    onEvidence={() => {
                      setSide("evidence");
                      setSideOpen(true);
                    }}
                    key={project.id}
                    project={project}
                    members={members}
                    patch={patch}
                    onSend={sendMessage}
                    openDoc={openDoc}
                    onPlan={() => setModal({ type: "plan" })}
                    onDecision={() => navigate("decisions")}
                    onAttach={() => setModal({ type: "material" })}
                    onReference={() => setModal({ type: "reference" })}
                    onDemo={demoNext}
                    onPause={() =>
                      patch((p) => ({
                        ...p,
                        status: p.status === "paused" ? "running" : "paused",
                      }))
                    }
                  />
                  {sideOpen && (
                    <Overview
                      project={project}
                      members={members}
                      tab={side}
                      setTab={setSide}
                      openDoc={openDoc}
                      onClose={() => setSideOpen(false)}
                      onMaterial={(m) =>
                        setModal({ type: "material-detail", material: m })
                      }
                      onKnowledge={() => navigate("knowledge")}
                      onMembers={() => navigate("members")}
                    />
                  )}
                </div>
              </>
            )
          ) : (
            <ManagementPage
              key={state.page}
              state={state}
              project={project}
              actions={actions}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <Modal
          title={
            {
              create: "从一个目标开始",
              plan: "工作安排",
              rule: "规则与改进",
              member: modal.memberId ? "编辑成员" : "添加成员",
              material: "添加项目资料",
              "material-detail": "项目资料",
              run: "运行记录",
              about: "关于这版预览",
              reference: "引用已有成果",
            }[modal.type]
          }
          description={
            modal.type === "create"
              ? "告诉团队要拿到什么，再选择合适的协作方式。"
              : ["rule", "material"].includes(modal.type)
                ? `范围：${state.projects.find((p) => p.id === (modal.projectId || project.id))?.name} · 仅当前项目`
                : undefined
          }
          onClose={closeModal}
          wide={["create", "plan", "run"].includes(modal.type)}
        >
          {["create", "plan"].includes(modal.type) && (
            <ProjectForm
              initialGoal={modal.initialGoal}
              reference={modal.reference}
              project={modal.type === "plan" ? project : null}
              members={members}
              onSave={saveProject}
              onCancel={closeModal}
            />
          )}
          {modal.type === "rule" && (
            <RuleForm
              rule={state.projects
                .find((p) => p.id === (modal.projectId || project.id))
                ?.rules.find((r) => r.id === modal.ruleId)}
              onSave={saveRule}
              onCancel={closeModal}
            />
          )}
          {modal.type === "member" && (
            <MemberForm
              member={members.find((m) => m.id === modal.memberId)}
              onSave={(data) => {
                setState((s) => ({
                  ...s,
                  members: modal.memberId
                    ? s.members.map((m) =>
                        m.id === modal.memberId ? { ...m, ...data } : m,
                      )
                    : [
                        ...s.members,
                        {
                          id: uid("member"),
                          ...data,
                          owner: "我",
                          paused: false,
                          initial: data.name.slice(0, 1).toUpperCase(),
                          color: "#5B6EB2",
                          wake: "待配置",
                        },
                      ],
                }));
                closeModal();
                notify("成员信息已保留，尚未连接真实平台");
              }}
              onCancel={closeModal}
            />
          )}
          {modal.type === "reference" && (
            <div className="v1-reference-list">
              {state.projects.flatMap((p) =>
                p.docs.map((d) => (
                  <button
                    className="material-table-row"
                    key={d.id}
                    onClick={() => {
                      patch((x) => ({
                        ...x,
                        materials: [
                          ...x.materials,
                          {
                            id: uid("material"),
                            title: d.title + " · 版本 " + d.revision,
                            type: "引用成果",
                            body: d.html.replace(/<[^>]*>/g, " "),
                            sourceDocument: d.id,
                            version: d.revision,
                          },
                        ],
                      }));
                      closeModal();
                      notify("已引用指定工作稿版本，未发送给真实 Agent");
                    }}
                  >
                    <FileText size={16} />
                    <span>
                      {d.title}
                      <small>
                        {p.name} · 版本 {d.revision}
                      </small>
                    </span>
                    <Plus size={14} />
                  </button>
                )),
              )}
            </div>
          )}
          {modal.type === "material" && (
            <MaterialForm
              onSave={(data) => {
                updateProject(modal.projectId || project.id, (p) => ({
                  ...p,
                  materials: [...p.materials, { id: uid("material"), ...data }],
                }));
                closeModal();
                notify("资料已保留在本项目预览");
              }}
              onCancel={closeModal}
            />
          )}
          {modal.type === "material-detail" && (
            <div className="material-content">
              <Badge>{modal.material.type}</Badge>
              <h3>{modal.material.title}</h3>
              <p>{modal.material.body}</p>
              {modal.material.url && (
                <a href={modal.material.url} target="_blank" rel="noreferrer">
                  打开原始链接 ↗
                </a>
              )}
            </div>
          )}
          {modal.type === "run" && (
            <RunDetails
              project={project}
              members={members}
              onDemo={demoNext}
              onClose={closeModal}
            />
          )}
          {modal.type === "about" && (
            <div className="about-preview">
              <Layers size={38} />
              <h3>Agent Hub 2.0</h3>
              <p>目标驱动的 Agent 协作空间。</p>
              <p>
                这一版用于验证视觉与操作体验。项目、稿件、成员、决定和规则是示例数据，修改只保存在当前浏览器；没有连接真实账号、启动外部任务或修改你的原软件。
              </p>
              <p>
                可以新建项目、切换四种工作方式、编辑成果、交回修改、预览候选版本、处理决定和试行规则。
              </p>
              <a
                href="https://github.com/duolaAmengweb3/agent-hub/issues/9"
                target="_blank"
                rel="noreferrer"
              >
                查看 2.0 方案与评审 ↗
              </a>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
