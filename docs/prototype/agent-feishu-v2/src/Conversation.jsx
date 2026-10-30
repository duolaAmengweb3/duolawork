import React, { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Paperclip,
  Type,
  Bold,
  Italic,
  List,
  Check,
  CheckCheck,
  FileText,
  BookOpen,
  ChevronRight,
  GitBranch,
  Play,
  Pause,
  X,
  Plus,
  Users,
  Clock3,
  CircleDot,
  MessageCircle,
} from "lucide-react";
import { Avatar, Badge, IconButton, Empty } from "./common.jsx";
import {
  modes,
  planSteps,
  pendingCount,
  currentFeedback,
  sanitizeHTML,
} from "./model.mjs";
import { ReviewRecord, RunScenario } from "./V1.jsx";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
];
function Composer({ project, patch, members, onSend, onAttach, onReference }) {
  const [format, setFormat] = useState(false);
  const send = useRef(onSend);
  send.current = onSend;
  const editor = useEditor({
    extensions,
    content: project.composerHtml || "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "项目消息",
        "data-placeholder": "发消息，或指定成员提出要求…",
        spellcheck: "false",
      },
      handleKeyDown: (view, event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !event.isComposing &&
          !view.composing
        ) {
          event.preventDefault();
          send.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) =>
      patch((p) => ({
        ...p,
        composer: editor.getText(),
        composerHtml: editor.getHTML(),
      })),
  });
  useEffect(() => {
    if (!project.composer && editor?.getText()) editor.commands.clearContent();
  }, [project.composer, editor]);
  return (
    <div className="composer-wrap">
      <div className={`composer ${!project.composer ? "is-empty" : ""}`}>
        {project.composerTarget && (
          <div className="recipient-strip">
            <AtSign size={13} />
            <span>
              {members.find((m) => m.id === project.composerTarget)?.name}
            </span>
            <button
              aria-label="取消指定成员"
              onClick={() => patch((p) => ({ ...p, composerTarget: "" }))}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {format && (
          <div className="composer-format">
            {[
              [Bold, "加粗", () => editor.chain().focus().toggleBold().run()],
              [
                Italic,
                "斜体",
                () => editor.chain().focus().toggleItalic().run(),
              ],
              [
                List,
                "列表",
                () => editor.chain().focus().toggleBulletList().run(),
              ],
            ].map(([Icon, label, fn]) => (
              <IconButton
                key={label}
                icon={Icon}
                label={`消息${label}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={fn}
              />
            ))}
          </div>
        )}
        <EditorContent editor={editor} />
        <div className="composer-tools">
          <div>
            <button className="text-button" onClick={onReference}>
              <Plus size={13} />
              引用成果
            </button>
            <IconButton
              icon={Paperclip}
              label="添加项目资料"
              onClick={onAttach}
            />
            <label className="recipient-select">
              <AtSign size={17} />
              <select
                aria-label="指定消息接收成员"
                value={project.composerTarget}
                onChange={(e) =>
                  patch((p) => ({ ...p, composerTarget: e.target.value }))
                }
              >
                <option value="">指定成员</option>
                {project.members
                  .map((id) => members.find((m) => m.id === id))
                  .filter(Boolean)
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name}
                      {m.paused ? "（已暂停）" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <IconButton
              icon={Type}
              label="消息格式"
              active={format}
              onClick={() => setFormat((v) => !v)}
            />
          </div>
          <div>
            <span className="keyboard-hint">⌘ Enter 发送</span>
            <button
              aria-label="发送消息"
              className="send-button"
              disabled={!project.composer.trim()}
              onClick={onSend}
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
export default function Conversation({
  project,
  members,
  patch,
  onSend,
  openDoc,
  onPlan,
  onDecision,
  onAttach,
  onReference,
  onEvidence,
  onDemo,
  onPause,
}) {
  const scroll = useRef(null);
  const [unread, setUnread] = useState(false);
  const previousLength = useRef(project.messages.length);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, []);
  useEffect(() => {
    const el = scroll.current;
    if (project.messages.length > previousLength.current) {
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 180)
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else setUnread(true);
    }
    previousLength.current = project.messages.length;
  }, [project.messages.length]);
  const steps = planSteps(project, members);
  return (
    <section className="conversation" aria-label="项目群聊">
      <button className="goal-line" onClick={onPlan}>
        <span className="goal-label">
          <GitBranch size={15} />
          {modes.find((m) => m.id === project.mode)?.short}
        </span>
        <span className="goal-text">{project.goal}</span>
        <ChevronRight size={15} />
      </button>
      {project.mode === "parallel" && project.messages.length > 0 && (
        <div className="phase-summary">
          <span>
            <strong>
              {project.status === "review" ? "独立研究已汇合" : "独立研究阶段"}
            </strong>
            <small title="正式接入时，Hub 不向其他独立分支下发本分支结论；原平台记忆不受 Hub 控制。当前为示例。">
              互不可见 · 示例
            </small>
          </span>
          <span>
            {project.decisions.filter((d) => d.status === "pending").length}{" "}
            项分歧待处理<button onClick={onEvidence}>查看依据</button>
          </span>
        </div>
      )}
      <RunScenario project={project} patch={patch} onNext={onDemo} />
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 60)
            setUnread(false);
        }}
      >
        {project.messages.length ? (
          <>
            <div className="day-divider">
              <span>本轮协作 · 示例记录</span>
            </div>
            {project.messages.map((msg) => {
              const m = members.find((m) => m.id === msg.author);
              const deliveryDocs = msg.documentIds
                ? project.docs.filter((d) => msg.documentIds.includes(d.id))
                : project.docs;
              if (msg.type === "system")
                return (
                  <div className="system-event" key={msg.id}>
                    <CircleDot size={13} />
                    <span>{msg.text}</span>
                    <time>{msg.time}</time>
                  </div>
                );
              if (msg.type === "handoff")
                return (
                  <details className="handoff" key={msg.id}>
                    <summary>
                      <div className="handoff-avatars">
                        <Avatar member={m} size={26} />
                        <ArrowRight size={12} />
                        <Avatar
                          member={members.find((m) => m.id === msg.to)}
                          size={26}
                        />
                      </div>
                      <div>
                        <strong>{msg.text}</strong>
                        <span>
                          研究材料 →{" "}
                          {members.find((m) => m.id === msg.to)?.name} ·
                          查看交接依据
                        </span>
                      </div>
                      <ChevronRight size={15} />
                    </summary>
                    <p>{msg.detail}</p>
                  </details>
                );
              return (
                <div
                  className={`message ${msg.author === "me" ? "own" : ""}`}
                  key={msg.id}
                >
                  <Avatar member={m} />
                  <div className="message-main">
                    <div className="message-meta">
                      <strong>
                        {msg.author === "me" ? "我" : m?.name || "成员"}
                      </strong>
                      <time>{msg.time}</time>
                      {msg.target && (
                        <span>
                          → {members.find((m) => m.id === msg.target)?.name}
                        </span>
                      )}
                      {msg.local && <Badge>已保留在预览</Badge>}
                    </div>
                    {msg.type === "delivery" ? (
                      <div className="delivery-card">
                        <header>
                          <span className="document-symbol">
                            <FileText size={21} />
                          </span>
                          <div>
                            <strong>{msg.text}</strong>
                            <span>
                              {deliveryDocs.length} 份成果 · 保留依据与未确认项
                            </span>
                          </div>
                        </header>
                        {deliveryDocs[0] && (
                          <ReviewRecord
                            doc={deliveryDocs.at(-1)}
                            project={project}
                            members={members}
                          />
                        )}
                        <div className="delivery-list">
                          {deliveryDocs.map((d, i) => (
                            <button key={d.id} onClick={() => openDoc(d.id)}>
                              <span>{String(i + 1).padStart(2, "0")}</span>
                              <strong>{d.title}</strong>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                        <footer>
                          <button
                            className="button primary"
                            onClick={() => openDoc(deliveryDocs[0]?.id)}
                          >
                            审阅成果 <ArrowRight size={15} />
                          </button>
                          {pendingCount(project) > 0 && (
                            <button
                              className="text-button"
                              onClick={onDecision}
                            >
                              {pendingCount(project)} 项待决定
                            </button>
                          )}
                        </footer>
                      </div>
                    ) : msg.html ? (
                      <div
                        className="message-bubble rich-message"
                        dangerouslySetInnerHTML={{
                          __html: sanitizeHTML(msg.html),
                        }}
                      />
                    ) : (
                      <div className="message-bubble">{msg.text}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <div className="project-welcome">
            <span className="welcome-symbol">
              <MessageCircle size={27} />
            </span>
            <h2>让团队围绕目标开始工作</h2>
            <p>{project.goal}</p>
            <div className="welcome-plan">
              {steps.map((s, i) => (
                <div key={`${s.member?.id}:${i}`}>
                  <Avatar member={s.member} size={28} />
                  <span>
                    <strong>{s.member?.name}</strong>
                    <small>{s.title}</small>
                  </span>
                  <Badge>
                    {project.mode === "parallel" && s.phase === 1
                      ? "同时开展"
                      : `环节 ${s.phase}`}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="button-row">
              <button className="button primary" onClick={onDemo}>
                <Play size={15} />
                演示这份安排
              </button>
              <button className="button" onClick={onPlan}>
                调整工作安排
              </button>
            </div>
            <span className="muted preview-note">
              演示只推进示例状态，不调用真实 Agent。
            </span>
          </div>
        )}
      </div>
      {unread && (
        <button
          className="new-message"
          onClick={() => {
            scroll.current?.scrollTo({
              top: scroll.current.scrollHeight,
              behavior: "smooth",
            });
            setUnread(false);
          }}
        >
          查看新消息 ↓
        </button>
      )}
      <Composer
        key={project.id}
        project={project}
        patch={patch}
        members={members}
        onSend={onSend}
        onAttach={onAttach}
        onReference={onReference}
      />
    </section>
  );
}
export function Overview({
  project,
  members,
  tab,
  setTab,
  openDoc,
  onClose,
  onMaterial,
  onKnowledge,
  onMembers,
}) {
  const [preview, setPreview] = useState(null);
  const doc = project.docs.find((d) => d.id === preview) || project.docs[0];
  return (
    <aside className="overview">
      <header className="overview-tabs">
        <div role="tablist" aria-label="项目侧栏">
          {[
            ["results", "成果"],
            ["materials", "资料"],
            ["members", "成员"],
            ["evidence", "依据"],
          ].map(([id, label]) => (
            <button
              role="tab"
              aria-selected={tab === id}
              key={id}
              className={tab === id ? "selected" : ""}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "results" && <span>{project.docs.length}</span>}
            </button>
          ))}
        </div>
        <IconButton icon={X} label="关闭成果与资料" onClick={onClose} />
      </header>
      <div className="overview-scroll">
        {tab === "evidence" ? (
          <div className="evidence-drawer">
            <h3>独立材料与分歧</h3>
            <p className="field-note">
              当前为示例材料。相同来源的一致不计作互证，不展示模型自报置信度。
            </p>
            {project.decisions.flatMap((d) =>
              (d.positions || []).map((p, i) => (
                <section key={`${d.id}:${i}`}>
                  <Avatar member={members.find((m) => m.id === p.member)} />
                  <strong>
                    {members.find((m) => m.id === p.member)?.name}
                  </strong>
                  <p>{p.text}</p>
                  <p className="muted">{p.evidence}</p>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer">
                      查看引用来源 ↗
                    </a>
                  )}
                  <Badge>同一来源 · 示例</Badge>
                </section>
              )),
            )}
          </div>
        ) : tab === "results" ? (
          project.docs.length ? (
            <>
              <div className="results-list">
                {project.docs.map((d) => (
                  <button
                    key={d.id}
                    className={`result-item ${doc?.id === d.id ? "selected" : ""}`}
                    onClick={() => setPreview(d.id)}
                    onDoubleClick={() => openDoc(d.id)}
                  >
                    <FileText size={20} />
                    <div>
                      <strong>{d.title}</strong>
                      <small>
                        {members.find((m) => m.id === d.author)?.name} ·{" "}
                        {currentFeedback(d) === "adopted"
                          ? "已采用"
                          : currentFeedback(d) === "rejected"
                            ? "已弃用"
                            : "待审阅"}
                      </small>
                    </div>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              {doc && (
                <div className="result-preview">
                  <span className="eyebrow">内容预览</span>
                  <h3>{doc.title}</h3>
                  <p>
                    {new DOMParser()
                      .parseFromString(doc.html, "text/html")
                      .body.querySelector("p")?.textContent ||
                      "打开审阅查看完整内容。"}
                  </p>
                  <button className="button" onClick={() => openDoc(doc.id)}>
                    打开审阅 <ArrowRight size={15} />
                  </button>
                  <div className="preview-evidence">
                    <BookOpen size={14} />
                    {doc.sourceIds.length} 份来源材料 · 可查看
                  </div>
                </div>
              )}
            </>
          ) : (
            <Empty
              icon={FileText}
              title="成果会留在这里"
              description="成员交付之后，可以阅读、编辑和交回修改。"
            />
          )
        ) : tab === "materials" ? (
          <div className="material-list">
            {project.materials.length ? (
              project.materials.map((m) => (
                <button key={m.id} onClick={() => onMaterial(m)}>
                  <BookOpen size={18} />
                  <span>
                    <strong>{m.title}</strong>
                    <small>{m.type}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <Empty
                title="还没有资料"
                description="从消息框的附件入口添加共同背景。"
              />
            )}
          </div>
        ) : (
          <div className="member-overview">
            {planSteps(project, members).map((s, i) => (
              <div key={i}>
                <Avatar member={s.member} />
                <span>
                  <strong>{s.member?.name}</strong>
                  <p>{s.title}</p>
                  <small>{s.permission}</small>
                  <small>{s.member?.wake} · 示例成员</small>
                </span>
              </div>
            ))}
            <button className="text-button" onClick={onMembers}>
              管理成员 <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
      <button className="overview-foot" onClick={onKnowledge}>
        <BookOpen size={17} />
        <span>
          项目资料与规则
          <small>
            {
              project.rules.filter(
                (r) => r.status === "active" || r.status === "trial",
              ).length
            }{" "}
            条使用中 ·{" "}
            {project.rules.filter((r) => r.status === "proposed").length}{" "}
            条待确认
          </small>
        </span>
        <ChevronRight size={16} />
      </button>
    </aside>
  );
}
