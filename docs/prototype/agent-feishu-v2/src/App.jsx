import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  LayoutGrid,
  Layers,
  MessageCircle,
  MoreHorizontal,
  PanelRight,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { Avatar, IconButton, Modal } from "./common.jsx";
import Conversation from "./Conversation.jsx";
import DocumentPane from "./DocumentPane.jsx";
import {
  KnowledgePage,
  MembersPage,
  Recipes,
  RulesForm,
  SetupForm,
  Sources,
} from "./Pages.jsx";
import {
  initialState,
  loadState,
  makeProject,
  makeDocs,
  STORAGE_KEY,
} from "./model.mjs";

function App() {
  const [state, setState] = useState(loadState);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("成果");
  const [pane, setPane] = useState(true);
  const [review, setReview] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState("draft-1");
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [running, setRunning] = useState(null);
  const toastTimer = useRef(null),
    runTimers = useRef([]),
    editorRef = useRef(null);
  const project =
    state.projects.find((p) => p.id === state.selected) || state.projects[0];
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [state]);
  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
      runTimers.current.forEach(clearTimeout);
    },
    [],
  );
  const closeModal = useCallback(() => setModal(null), []);
  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3600);
  }, []);
  function patch(fn) {
    const id = project.id;
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) => (p.id === id ? fn(p) : p)),
    }));
  }
  function navigate(page) {
    setState((s) => ({ ...s, page }));
    setReview(false);
  }
  function selectProject(id, nextTab = "成果") {
    setState((s) => ({ ...s, page: "groups", selected: id }));
    setSelectedDoc("draft-1");
    setTab(nextTab);
    setPane(true);
    setReview(false);
  }
  function openDoc(id, focus = false) {
    setSelectedDoc(id);
    setTab("成果");
    setPane(true);
    setReview(focus);
  }
  function create(config, editing) {
    if (editing) {
      patch((p) => ({ ...p, ...config }));
      showToast("示例分工已保存");
    } else {
      const p = {
        ...makeProject(crypto.randomUUID(), config.name, "ready"),
        ...config,
      };
      setState((s) => ({
        ...s,
        projects: [...s.projects, p],
        selected: p.id,
        page: "groups",
      }));
      setTab("成果");
      setPane(false);
      setReview(false);
      showToast("项目群已创建，点击「演示接力」查看流程");
    }
    closeModal();
  }
  function runDemo() {
    if (running) return;
    const id = project.id;
    setRunning(id);
    patch((p) => ({ ...p, status: "running", stage: 0 }));
    [1, 2, 3].forEach((stage) => {
      const timer = setTimeout(() => {
        setState((s) => ({
          ...s,
          projects: s.projects.map((p) =>
            p.id === id
              ? {
                  ...p,
                  stage,
                  status: stage === 3 ? "complete" : "running",
                  docs: stage === 3 && !p.docs.length ? makeDocs() : p.docs,
                }
              : p,
          ),
        }));
        if (stage === 3) {
          setRunning(null);
          showToast("示例接力完成，打开成果开始审核");
        }
      }, stage * 1100);
      runTimers.current.push(timer);
    });
  }
  function pauseDemo() {
    runTimers.current.forEach(clearTimeout);
    runTimers.current = [];
    const id = running;
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, status: "ready" } : p,
      ),
    }));
    setRunning(null);
    showToast("演示已暂停，已有修改保留");
  }
  const nav = [
    ["groups", "项目群", MessageCircle],
    ["recipes", "配方", LayoutGrid],
    ["knowledge", "知识库", BookOpen],
    ["members", "成员", Users],
  ];
  const activeDoc =
    project.docs.find((d) => d.id === (modal?.docId || selectedDoc)) ||
    project.docs[0];
  return (
    <div className="app-shell">
      <aside className="workspace-sidebar">
        <div className="global-dock">
          <div className="brand-lockup">
            <div className="app-mark" title="Agent Hub"><Layers size={23} strokeWidth={1.8} /></div>
            <div><strong>Agent Hub</strong><small>你的 AI 协作空间</small></div>
          </div>
          <div className="workspace-label">个人工作空间 <span>LOCAL</span></div>
          <nav>
            {nav.map(([key, label, Icon]) => (
              <button
                key={key}
                className={state.page === key ? "dock-item active" : "dock-item"}
                onClick={() => navigate(key)}
                aria-label={label}
              >
                <Icon size={22} strokeWidth={1.7} />
                <span>{label}</span>
                {key === "groups" && <i className="dock-dot" />}
              </button>
            ))}
          </nav>
        </div>
        {state.page === "groups" && (
          <div className="project-sidebar">
            <div className="list-heading">
              <h1>我的项目</h1>
              <IconButton
                icon={Plus}
                label="新建项目群"
                onClick={() =>
                  setModal({ type: "setup", title: "用配方创建项目群" })
                }
              />
            </div>
            <label className="project-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索项目群"
                aria-label="搜索项目群"
              />
              <span>⌕</span>
            </label>
            <div className="list-filter">
              <span>
                全部项目 <small>{state.projects.length}</small>
              </span>
              <span>最近</span>
            </div>
            <div className="project-list">
              {state.projects
                .filter((p) => p.name.includes(query))
                .map((p) => (
                  <button
                    className={
                      "project-item" + (project.id === p.id ? " selected" : "")
                    }
                    key={p.id}
                    onClick={() => selectProject(p.id)}
                  >
                    <span
                      className={
                        "project-icon " + (p.id === "ideas" ? "teal" : "")
                      }
                    >
                      <MessageCircle size={20} />
                    </span>
                    <span className="project-item-copy">
                      <strong>{p.name}</strong>
                      <small>
                        {p.messages.at(-1)?.text ||
                          (p.status === "complete"
                            ? p.writer + "：成稿已交付"
                            : p.status === "idle"
                              ? "留住灵感，慢慢整理"
                              : "配方已就绪，等待试跑")}
                      </small>
                    </span>
                    <time>{p.status === "complete" ? "08:06" : "刚刚"}</time>
                  </button>
                ))}
              {!state.projects.some((p) => p.name.includes(query)) && (
                <p className="no-results">没有匹配的项目</p>
              )}
            </div>
            <button
              className="sidebar-recipe"
              onClick={() => navigate("recipes")}
            >
              <LayoutGrid size={17} />
              <span>
                试试一个工作配方<small>从目标开始，安排 Agent</small>
              </span>
              <ChevronDown size={13} />
            </button>
          </div>
        )}
        <div className="workspace-bottom">
          <button className="team-shortcut" onClick={() => navigate("members")}>
            <span className="avatar-stack"><Avatar name="Grok" size={27} /><Avatar name="Perplexity" size={27} /><Avatar name="Dot" size={27} /></span>
            <span>查看我的团队 <ArrowRight size={13} /></span>
          </button>
          <div className="workspace-profile"><Avatar name="User" size={32} /><div><strong>我的工作空间</strong><small>本地版 · 交互预览</small></div>
            <IconButton icon={Settings} label="原型设置" onClick={() => setModal({ type: "settings", title: "原型设置" })} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <div className="window-bar">
          <div>
            <span className="window-app">工作空间</span>
            <span className="window-divider">/</span>
            <span>
              {state.page === "groups"
                ? project.name
                : nav.find((n) => n[0] === state.page)?.[1]}
            </span>
          </div>
          <span className="prototype-badge">
            <i />
            设计预览 · 示例数据
          </span>
          <button
            className="text-button"
            onClick={() =>
              setModal({ type: "help", title: "关于这版交互原型" })
            }
          >
            使用说明
          </button>
        </div>
        {storageError && (
          <div className="storage-alert" role="alert">
            浏览器无法保存修改，请立即导出文稿。
          </div>
        )}
        {state.page === "groups" ? (
          <>
            <header className="group-heading">
              {review && (
                <IconButton
                  icon={ArrowLeft}
                  label="返回群聊"
                  onClick={() => setReview(false)}
                />
              )}
              <span className="group-icon"><Layers size={24} strokeWidth={1.5} /></span>
              <div className="group-title">
                <h2>{project.name}</h2>
                <span>
                  {project.status === "idle"
                    ? "灵感与资料"
                    : `Grok · ${project.checker} · ${project.writer}`}
                  <i />
                  仅你可见
                </span>
              </div>
              <div className="group-actions">
                {running === project.id ? (
                  <button className="button small" onClick={pauseDemo}>
                    <Pause size={14} />
                    暂停演示
                  </button>
                ) : (
                  project.status !== "idle" && (
                    <button
                      className="button small"
                      disabled={!!running}
                      onClick={runDemo}
                    >
                      <Play size={13} />
                      演示接力
                    </button>
                  )
                )}
                <IconButton
                  icon={Users}
                  label="查看项目成员"
                  onClick={() => {
                    setTab("成员");
                    setPane(true);
                  }}
                />
                <IconButton
                  icon={PanelRight}
                  label={pane ? "切换资料面板" : "打开资料面板"}
                  active={pane}
                  onClick={() => {
                    setPane((v) => !v);
                    setReview(false);
                  }}
                />
                <IconButton
                  icon={MoreHorizontal}
                  label="项目设置"
                  onClick={() => {
                    setTab("设置");
                    setPane(true);
                  }}
                />
              </div>
            </header>
            <div
              className={
                "work-area" +
                (review ? " review-mode" : "") +
                (!pane ? " pane-closed" : "")
              }
            >
              {review ? (
                <div className="review-context" key="review-context">
                  <button
                    className="back-to-chat"
                    onClick={() => setReview(false)}
                  >
                    <ArrowLeft size={15} />
                    返回项目群
                  </button>
                  <div className="review-context-title">
                    <span className="eyebrow">本次交付</span>
                    <h3>今日内容包</h3>
                    <p>逐条审核，让成果更接近你的表达。</p>
                  </div>
                  {project.docs.map((d, i) => (
                    <button
                      key={d.id}
                      className={
                        "review-doc-link" +
                        (selectedDoc === d.id ? " active" : "")
                      }
                      onClick={() => setSelectedDoc(d.id)}
                    >
                      <span>0{i + 1}</span>
                      <strong>{d.title}</strong>
                      {d.feedback && <Check size={13} />}
                    </button>
                  ))}
                  <div className="review-context-bottom">
                    <Avatar name={project.writer} size={25} />
                    <span>{project.writer} 交付 · 保留原稿</span>
                  </div>
                </div>
              ) : (
                <Conversation
                  key={"conversation:" + project.id}
                  project={project}
                  patch={patch}
                  openDoc={openDoc}
                  showSources={() =>
                    setModal({ type: "sources", title: "候选选题与来源" })
                  }
                  showToast={showToast}
                  running={running === project.id}
                />
              )}
              {pane && (
                <DocumentPane
                  key={"document:" + project.id}
                  project={project}
                  patch={patch}
                  selectedDoc={selectedDoc}
                  setSelectedDoc={setSelectedDoc}
                  tab={tab}
                  setTab={setTab}
                  review={review}
                  setReview={setReview}
                  close={() => {
                    setPane(false);
                    setReview(false);
                  }}
                  showSources={() =>
                    setModal({ type: "sources", title: "候选选题与来源" })
                  }
                  showToast={showToast}
                  showModal={setModal}
                  editorRef={editorRef}
                  storageError={storageError}
                />
              )}
            </div>
          </>
        ) : state.page === "recipes" ? (
          <Recipes
            setup={() => setModal({ type: "setup", title: "用配方创建项目群" })}
          />
        ) : state.page === "knowledge" ? (
          <KnowledgePage
            projects={state.projects}
            openProject={selectProject}
          />
        ) : (
          <MembersPage showModal={setModal} />
        )}
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <Modal
          title={modal.title}
          onClose={closeModal}
          wide={modal.type === "sources"}
        >
          {modal.type === "setup" ? (
            <SetupForm
              project={modal.editing ? project : null}
              editing={modal.editing}
              onSubmit={(c) => create(c, modal.editing)}
              showToast={showToast}
            />
          ) : modal.type === "sources" ? (
            <Sources />
          ) : modal.type === "rules" ? (
            <RulesForm
              project={project}
              save={(rules) => {
                patch((p) => ({ ...p, rules }));
                closeModal();
                showToast("项目规则已保存");
              }}
            />
          ) : modal.type === "rule" ? (
            <>
              <p className="dialog-intro">
                将示例建议加入本项目。不会修改全局知识或真实 Agent。
              </p>
              <blockquote className="approval-quote">
                开头先讲实操场景，少用新闻腔。
              </blockquote>
              <dl>
                <dt>应用范围</dt>
                <dd>{project.name}</dd>
                <dt>来源</dt>
                <dd>演示改稿建议，尚未使用模型自动提炼</dd>
                <dt>撤回方式</dt>
                <dd>项目知识 → 撤回</dd>
              </dl>
              <div className="dialog-actions">
                <button className="button" onClick={closeModal}>
                  暂不加入
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    patch((p) => ({ ...p, approved: true }));
                    closeModal();
                    showToast("示例规则已批准，可在项目知识中撤回");
                  }}
                >
                  批准加入本项目
                </button>
              </div>
            </>
          ) : modal.type === "history" ? (
            <>
              <p className="dialog-intro">
                原稿始终保留。每次交回修改保存一个工作稿快照。
              </p>
              <div className="version-row">
                <span>Agent 原始交付</span>
                <span>版本 1 · 只读保留</span>
              </div>
              {activeDoc?.history.map((h, i) => (
                <div className="version-row" key={i}>
                  <span>工作稿快照 · 版本 {h.revision}</span>
                  <span>{h.at}</span>
                  <button
                    className="text-button"
                    onClick={() => {
                      const text = new DOMParser().parseFromString(
                        h.html,
                        "text/html",
                      ).body.textContent;
                      setModal({
                        type: "version",
                        title: "工作稿快照 · 版本 " + h.revision,
                        text,
                      });
                    }}
                  >
                    查看
                  </button>
                </div>
              ))}
              {!activeDoc?.history.length && (
                <p className="muted">
                  暂无交回修改快照；当前编辑已保存到浏览器。
                </p>
              )}
            </>
          ) : modal.type === "version" ? (
            <pre className="version-text">{modal.text}</pre>
          ) : modal.type === "handback" ? (
            <Handback
              onSend={(text) => {
                patch((p) => ({
                  ...p,
                  composer: "",
                  docs: p.docs.map((d) =>
                    d.id === modal.docId
                      ? {
                          ...d,
                          html: modal.html,
                          revision: d.revision + 1,
                          history: [
                            {
                              revision: d.revision,
                              html: modal.html,
                              at: new Date().toLocaleTimeString("zh-CN", {
                                hour: "2-digit",
                                minute: "2-digit",
                              }),
                            },
                            ...d.history,
                          ].slice(0, 8),
                        }
                      : d,
                  ),
                  messages: [
                    ...p.messages,
                    {
                      id: crypto.randomUUID(),
                      text: `@${p.writer} ${text}`,
                      time: "刚刚",
                      attachment: activeDoc?.title + " · 当前工作稿",
                      draftSnapshot: modal.html,
                    },
                  ],
                }));
                closeModal();
                setReview(false);
                showToast(
                  "修改要求及完整工作稿已附在示例消息里，未调用真实 Agent",
                );
              }}
            />
          ) : modal.type === "connection" ? (
            <>
              <p>正式版将在原产品中完成本人授权，再验证任务往返。</p>
              <div className="connection-preview">
                <Avatar name={modal.agent} size={46} />
                <strong>{modal.agent}</strong>
                <span>原型不会打开登录页或读取账号资料</span>
              </div>
              <button
                className="button primary"
                onClick={() => {
                  closeModal();
                  showToast("已查看连接流程，真实连接仍待联测");
                }}
              >
                知道了
              </button>
            </>
          ) : modal.type === "settings" ? (
            <>
              <p>本原型只在浏览器保存示例项目、消息、工作稿与反馈。</p>
              <p className="muted">
                重置只清除此原型数据，请先导出想保留的示例稿。
              </p>
              <div className="dialog-actions">
                <button className="button" onClick={closeModal}>
                  保留数据
                </button>
                <button
                  className="button danger"
                  onClick={() => {
                    runTimers.current.forEach(clearTimeout);
                    setRunning(null);
                    setState(initialState());
                    setReview(false);
                    setPane(true);
                    setTab("成果");
                    closeModal();
                    showToast("原型示例数据已重置");
                  }}
                >
                  重置示例数据
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                这是可操作的界面原型：能发示例消息、切换项目、编辑成稿、导出、评价和批准项目规则。
              </p>
              <ol>
                <li>左侧选项目，中间看成员交接。</li>
                <li>右侧直接改稿，点击展开按钮进入专注审核。</li>
                <li>在「配方」中组队，创建新项目群并演示接力。</li>
              </ol>
              <p className="muted">
                全部 Agent
                身份、任务和新闻均为示例。原型不调用真实平台，不自动发布，不影响现有软件和登录状态。成员图形为示意标识。
              </p>
              <a
                className="text-button"
                href="../../../collab/codex/2026-10-28-Agent飞书产品细化与原型.md"
                target="_blank"
              >
                查看细化方案 ↗
              </a>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function Handback({ onSend }) {
  const [text, setText] = useState(
    "开头换成一个实操场景，保留来源和其他部分。",
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend(text);
      }}
    >
      <p className="dialog-intro">
        当前工作稿全文会随要求一起交回。本原型只保存示例消息。
      </p>
      <label className="field">
        修改要求
        <textarea
          required
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button className="button primary" disabled={!text.trim()}>
          保存交回消息
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}

createRoot(document.getElementById("root")).render(<App />);
