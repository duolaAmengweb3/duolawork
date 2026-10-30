import React, { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  FileText,
  ChevronDown,
  BookOpen,
  History,
  Check,
  Copy,
  Download,
  Bold,
  Italic,
  List,
  Quote,
  Heading2,
  Undo2,
  Redo2,
  RotateCcw,
  X,
  Menu,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Clock3,
  GitCompareArrows,
  PanelRightClose,
  AlertCircle,
} from "lucide-react";
import { Avatar, IconButton, Badge, Modal } from "./common.jsx";
import { DecisionContext, DecisionNode } from "./DecisionBlock.jsx";
import {
  downloadText,
  htmlText,
  sanitizeHTML,
  currentFeedback,
  now,
  uid,
} from "./model.mjs";
import { ReviewRecord } from "./V1.jsx";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
  DecisionNode,
];
function SafeContent({ html }) {
  return (
    <div
      className="rendered-document"
      dangerouslySetInnerHTML={{ __html: sanitizeHTML(html) }}
    />
  );
}
export default function DocumentPane({
  project,
  doc,
  members,
  updateDoc,
  requestRevision,
  loadCandidate,
  notify,
  storageError,
  openSidebar,
  onDecision,
  onSuggestion,
  focusDecision,
}) {
  const [panel, setPanel] = useState(null),
    [original, setOriginal] = useState(false),
    [compare, setCompare] = useState(null),
    [replaceConfirmed, setReplaceConfirmed] = useState(false),
    [feedback, setFeedback] = useState(null),
    [reason, setReason] = useState("");
  const save = useRef(updateDoc);
  save.current = updateDoc;
  const scroll = useRef(null),
    scrollTimer = useRef(null),
    savedScroll = useRef(doc.scroll || 0);
  const editor = useEditor({
    extensions,
    content: sanitizeHTML(doc.html),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "成果正文",
        "aria-multiline": "true",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) =>
      save.current((d) => ({
        ...d,
        html: editor.getHTML(),
        revision: d.revision + 1,
      })),
  });
  const selection = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            selected: !editor.state.selection.empty,
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            heading: editor.isActive("heading", { level: 2 }),
            list: editor.isActive("bulletList"),
            quote: editor.isActive("blockquote"),
          }
        : {},
  });
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = savedScroll.current;
    return () => clearTimeout(scrollTimer.current);
  }, []);
  useEffect(() => {
    if (focusDecision && editor) {
      const frame = requestAnimationFrame(() =>
        scroll.current
          ?.querySelector(`[data-decision-id="${focusDecision}"]`)
          ?.scrollIntoView({ block: "center" }),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [focusDecision, editor]);
  useEffect(() => {
    if (doc.suggestion?.status === "accepted" && panel === "learning") {
      const timer = setTimeout(() => setPanel(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [doc.suggestion?.status, panel]);
  const last = doc.requests.at(-1),
    candidate = doc.candidate,
    conflict = !!candidate && candidate.baseRevision !== doc.revision;
  const chosen = members.find((m) => m.id === doc.requestMember);
  const togglePanel = (next) => setPanel((p) => (p === next ? null : next));
  const commands = [
    [
      "标题",
      Heading2,
      "heading",
      () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    ],
    ["加粗", Bold, "bold", () => editor.chain().focus().toggleBold().run()],
    [
      "斜体",
      Italic,
      "italic",
      () => editor.chain().focus().toggleItalic().run(),
    ],
    [
      "列表",
      List,
      "list",
      () => editor.chain().focus().toggleBulletList().run(),
    ],
    [
      "引用",
      Quote,
      "quote",
      () => editor.chain().focus().toggleBlockquote().run(),
    ],
    ["撤销", Undo2, null, () => editor.chain().focus().undo().run()],
    ["重做", Redo2, null, () => editor.chain().focus().redo().run()],
  ];
  function previewCandidate() {
    setCompare({ revision: doc.revision, kind: "candidate" });
    setReplaceConfirmed(false);
  }
  function applyCandidate() {
    if (!candidate) return;
    if (compare.revision !== doc.revision) {
      setCompare({ ...compare, revision: doc.revision });
      setReplaceConfirmed(false);
      notify("工作稿有新修改，请重新检查对比");
      return;
    }
    if (conflict && !replaceConfirmed) return;
    const html = candidate.html;
    updateDoc((d) => ({
      ...d,
      history: [
        ...d.history,
        {
          html: d.html,
          revision: d.revision,
          time: now(),
          label: "应用候选前的工作稿",
        },
      ],
      html,
      revision: d.revision + 1,
      candidate: null,
    }));
    editor.commands.setContent(sanitizeHTML(html), { emitUpdate: false });
    setCompare(null);
    setOriginal(false);
    notify("候选版本已应用，之前的工作稿保留在版本历史");
  }
  function requestRecheck() {
    if (storageError || doc.recheckRequest?.status === "preview_pending")
      return;
    updateDoc((d) => ({
      ...d,
      recheckRequest: {
        id: uid("recheck"),
        status: "preview_pending",
        author: d.author,
        baseRevision: d.revision,
        html: d.html,
        checks: structuredClone(d.reviewChecks || []),
        time: now(),
      },
    }));
    notify("复查要求已保留在原型，未唤醒真实 Agent。可演示返回以检查交互。");
  }
  function previewRecheckReturn() {
    updateDoc((d) => {
      const request = d.recheckRequest;
      if (request?.status !== "preview_pending") return d;
      return {
        ...d,
        initialReview: d.initialReview || {
          checks: d.reviewChecks,
          revision: d.selfCheckRevision,
        },
        selfCheckRevision: request.baseRevision,
        reviewChecks: request.checks.map((c) => ({
          ...c,
          evidence:
            "复查返回演示：沿用所选标准的示例结果，未执行真实内容核验。",
        })),
        recheckRequest: { ...request, status: "preview_returned" },
      };
    });
    notify("复查返回演示已展示；结果只对应提交时的版本，不修改正文。");
  }
  return (
    <section className={`review-layout ${panel ? "context-open" : ""}`}>
      <div className="document-workspace">
        <header className="document-header">
          <div>
            <IconButton
              icon={Menu}
              label="展开成果列表"
              className="icon-button mobile-menu"
              onClick={openSidebar}
            />
            <FileText size={18} />
            <strong>{original ? "原始交付" : "工作稿"}</strong>
            <button
              className={`version-button ${panel === "versions" ? "active" : ""}`}
              onClick={() => togglePanel("versions")}
            >
              版本 {doc.revision} <ChevronDown size={13} />
            </button>
          </div>
          <div>
            <button
              className="button quiet"
              onClick={() => togglePanel("sources")}
            >
              <BookOpen size={15} />
              出处
            </button>
            <span className={`saved-state ${storageError ? "error" : ""}`}>
              {storageError ? <AlertCircle size={14} /> : <Check size={14} />}
              <span>{storageError ? "未保存" : "本机已保留"}</span>
            </span>
            <IconButton
              icon={Copy}
              label="复制稿件"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    htmlText(original ? doc.original : doc.html),
                  );
                  notify("已复制正文；采用状态不变");
                } catch {
                  notify("浏览器未允许复制，请选中正文复制");
                }
              }}
            />
            <IconButton
              icon={Download}
              label="导出稿件"
              onClick={() => {
                downloadText(
                  `${doc.title}.html`,
                  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${doc.title.replaceAll("<", "&lt;")}</title><body>${sanitizeHTML(original ? doc.original : doc.html)}</body></html>`,
                  "text/html;charset=utf-8",
                );
                notify("已导出当前稿件");
              }}
            />
          </div>
        </header>
        <div
          className={
            "format-bar " + (selection?.selected ? "v1-format-visible" : "")
          }
        >
          <button
            className="text-style"
            disabled={original}
            onClick={() => editor.chain().focus().setParagraph().run()}
          >
            正文 <ChevronDown size={13} />
          </button>
          <i />
          {commands.map(([label, Icon, key, fn]) => (
            <IconButton
              key={label}
              icon={Icon}
              label={label}
              active={key && selection?.[key]}
              disabled={original || !editor}
              onMouseDown={(e) => e.preventDefault()}
              onClick={fn}
            />
          ))}
          <span>{original ? "原稿只读" : "可直接编辑"}</span>
        </div>
        {candidate && (
          <div className="candidate-notice">
            <span>
              <GitCompareArrows size={15} />
              有一个候选版本{conflict ? " · 你的工作稿已有后续修改" : ""}
            </span>
            <button onClick={previewCandidate}>
              预览并对比 <ArrowRight size={14} />
            </button>
          </div>
        )}
        {original && (
          <div className="original-banner">
            正在查看原始交付，工作稿的修改仍然保留。
            <button onClick={() => setOriginal(false)}>返回工作稿</button>
          </div>
        )}
        {!original && doc.recheckRequest?.status === "preview_pending" && (
          <div className="candidate-notice v1-recheck-notice" role="status">
            <span>
              复查演示 · 版本 {doc.recheckRequest.baseRevision} · 未发送给真实
              Agent
            </span>
            <button onClick={previewRecheckReturn}>
              演示复查返回 <ArrowRight size={14} />
            </button>
          </div>
        )}
        <div
          className="document-scroll"
          ref={scroll}
          onScroll={(e) => {
            savedScroll.current = e.currentTarget.scrollTop;
            clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(
              () =>
                save.current((d) => ({ ...d, scroll: savedScroll.current })),
              160,
            );
          }}
        >
          <article className="document-paper">
            <div className="document-byline">
              <Avatar
                member={members.find((m) => m.id === doc.author)}
                size={22}
              />
              <span>
                {members.find((m) => m.id === doc.author)?.name} 的交付
              </span>
              <span>·</span>
              <span>{project.name}</span>
            </div>
            <h1 className="v1-document-title">{doc.title}</h1>
            <ReviewRecord
              doc={
                original
                  ? {
                      ...doc,
                      revision: 1,
                      selfCheckRevision: 1,
                      reviewChecks:
                        doc.initialReview?.checks || doc.reviewChecks,
                    }
                  : doc
              }
              project={project}
              members={members}
              onRecheck={
                !original && !storageError ? requestRecheck : undefined
              }
            />
            <div style={{ display: original ? "none" : undefined }}>
              <DecisionContext.Provider
                value={{ project, members, storageError, onChoose: onDecision }}
              >
                <EditorContent editor={editor} />
              </DecisionContext.Provider>
            </div>
            {original && <SafeContent html={doc.original} />}
            <button
              className="paper-sources"
              onClick={() => setPanel("sources")}
            >
              <BookOpen size={15} />
              来源材料 {doc.sourceIds.length}
              <ChevronDown size={13} />
            </button>
            <div className="paper-end">—— 成果正文结束 ——</div>
            {doc.revision > 1 && !doc.suggestion && (
              <button
                className="text-button learning-demo"
                onClick={() => {
                  updateDoc((d) => ({
                    ...d,
                    suggestion: {
                      status: "pending",
                      text: "开头先说具体做法，再解释判断依据。",
                      revision: d.revision,
                      html: d.html,
                    },
                  }));
                  setPanel("learning");
                }}
              >
                演示改稿建议（未调用模型）
              </button>
            )}
            {doc.suggestion?.status === "pending" && (
              <button
                className="text-button"
                onClick={() => setPanel("learning")}
              >
                查看稿件旁的规则建议
              </button>
            )}
          </article>
          <div className="v1-reading-buffer" aria-hidden="true" />
        </div>
        <footer className="document-actions">
          <span className="feedback-state">
            {currentFeedback(doc) ? (
              <CheckCheck size={19} />
            ) : (
              <Clock3 size={19} />
            )}
            <span>
              {currentFeedback(doc) === "adopted"
                ? "已采用"
                : currentFeedback(doc) === "rejected"
                  ? "已弃用"
                  : "待评价"}
              <small>
                {currentFeedback(doc)
                  ? "反馈关联此次工作稿"
                  : doc.feedback
                    ? `版本 ${doc.evaluatedRevision} 已评价，当前稿有更新`
                    : "你的判断会留在项目里"}
              </small>
            </span>
          </span>
          <div>
            <button
              className={`button ${currentFeedback(doc) === "adopted" ? "success" : "primary"}`}
              onClick={() => {
                setFeedback("adopted");
                setReason(doc.feedbackReason || "");
              }}
            >
              <Check size={16} />
              采用成果
            </button>
            <button
              className="button"
              onClick={() => {
                setFeedback("rejected");
                setReason(doc.feedbackReason || "");
              }}
            >
              <X size={15} />
              弃用
            </button>
            <button
              className={`button ${panel === "request" ? "selected" : ""}`}
              onClick={() => {
                setOriginal(false);
                togglePanel("request");
              }}
            >
              <RotateCcw size={16} />
              {"让 " + (chosen?.name || "成员") + " 改"}
            </button>
          </div>
        </footer>
      </div>
      {panel && (
        <aside className="review-context">
          <header>
            <h3>
              {
                {
                  request: "交回修改",
                  sources: "出处与材料",
                  versions: "原稿与版本",
                  learning: "从这次修改里学习",
                }[panel]
              }
            </h3>
            <IconButton
              icon={X}
              label="关闭审阅侧栏"
              onClick={() => setPanel(null)}
            />
          </header>
          <div className="context-scroll">
            {panel === "learning" ? (
              <div className="learning-note">
                <Badge>示例建议 · 版本 {doc.suggestion?.revision}</Badge>
                <p>
                  {members.find((m) => m.id === project.lead)?.name}{" "}
                  从你的修改里总结：
                </p>
                {doc.suggestion?.editing ? (
                  <textarea
                    aria-label="建议措辞"
                    rows={4}
                    value={doc.suggestion.text}
                    onChange={(e) =>
                      updateDoc((d) => ({
                        ...d,
                        suggestion: { ...d.suggestion, text: e.target.value },
                      }))
                    }
                  />
                ) : (
                  <strong>「{doc.suggestion?.text}」</strong>
                )}
                {doc.suggestion?.status === "accepted" ? (
                  <p className="learning-accepted">
                    ✓ 已记住，只用于本项目{" "}
                    <button onClick={() => onSuggestion("undo")}>撤回</button>
                  </p>
                ) : (
                  <>
                    <div className="learning-actions">
                      <button
                        className="button primary small"
                        disabled={storageError || !doc.suggestion?.text.trim()}
                        onClick={() => onSuggestion("accept")}
                      >
                        以后都这样
                      </button>
                      <button
                        className="button small"
                        onClick={() => {
                          onSuggestion("dismiss");
                          setPanel(null);
                        }}
                      >
                        只这次
                      </button>
                    </div>
                    <button
                      className="text-button"
                      onClick={() =>
                        updateDoc((d) => ({
                          ...d,
                          suggestion: {
                            ...d.suggestion,
                            editing: !d.suggestion.editing,
                          },
                        }))
                      }
                    >
                      {doc.suggestion?.editing ? "完成措辞修改" : "改一下措辞"}
                    </button>
                  </>
                )}
                <p className="field-note">
                  此处手动加载示例，不是模型归纳。正式接入后由整合成员在停止编辑
                  10 分钟后返回；不会每改一个字就提示。
                </p>
              </div>
            ) : panel === "request" ? (
              <>
                <div className="context-doc">
                  <FileText size={23} />
                  <span>
                    <strong>{doc.title}</strong>
                    <small>当前工作稿 · 版本 {doc.revision}</small>
                  </span>
                </div>
                <label className="field">
                  接收成员
                  <select
                    value={doc.requestMember}
                    onChange={(e) =>
                      updateDoc((d) => ({
                        ...d,
                        requestMember: e.target.value,
                      }))
                    }
                  >
                    {project.members
                      .map((id) => members.find((m) => m.id === id))
                      .filter(Boolean)
                      .map((m) => (
                        <option key={m.id} value={m.id} disabled={m.paused}>
                          {m.name}
                          {m.paused ? "（已暂停）" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  修改要求
                  <textarea
                    aria-label="修改要求"
                    placeholder="哪里需要调整？写下具体要求…"
                    value={doc.requestDraft}
                    onChange={(e) =>
                      updateDoc((d) => ({ ...d, requestDraft: e.target.value }))
                    }
                    rows={7}
                  />
                </label>
                <p className="field-note">
                  完整工作稿会与要求一起保留。新回复先预览，不覆盖你的修改。
                </p>
                <button
                  className="button primary full"
                  disabled={
                    !doc.requestDraft.trim() ||
                    storageError ||
                    chosen?.paused ||
                    !project.members.includes(doc.requestMember)
                  }
                  onClick={requestRevision}
                >
                  提交修改要求 <ArrowRight size={15} />
                </button>
                <button
                  className="button quiet full"
                  onClick={() => setPanel(null)}
                >
                  取消，保留草稿
                </button>
                {last && (
                  <div className="revision-record">
                    <span className="eyebrow">最近修改请求</span>
                    <p>{last.instruction}</p>
                    <span className="muted">
                      {members.find((m) => m.id === last.member)?.name} ·
                      基于版本 {last.baseRevision}
                    </span>
                    <Badge>已保留在预览</Badge>
                    {!candidate ? (
                      <button className="text-button" onClick={loadCandidate}>
                        演示候选版本返回 <ArrowRight size={14} />
                      </button>
                    ) : (
                      <button
                        className="text-button"
                        onClick={previewCandidate}
                      >
                        比较候选版本 <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}
                <div className="context-tip">
                  <BookOpen size={16} />
                  <p>这份成果的来源与取舍可以从顶部「出处」查看。</p>
                </div>
              </>
            ) : panel === "sources" ? (
              <>
                <p className="field-note">
                  当前是交互样稿。下列材料用于说明稿件与依据的关系。
                </p>
                {project.materials
                  .filter((m) => doc.sourceIds.includes(m.id))
                  .map((m, i) => (
                    <details className="source-detail" key={m.id}>
                      <summary>
                        <span className="source-number">{i + 1}</span>
                        <strong>{m.title}</strong>
                        <ChevronDown size={14} />
                      </summary>
                      <p>{m.body}</p>
                      {m.url && (
                        <a href={m.url} target="_blank" rel="noreferrer">
                          打开原文 <ArrowUpRight size={13} />
                        </a>
                      )}
                    </details>
                  ))}
                {!project.materials.some((m) =>
                  doc.sourceIds.includes(m.id),
                ) && <p className="muted">这份预览产物尚未关联来源材料。</p>}
              </>
            ) : (
              <>
                <button
                  className={`version-row ${original ? "selected" : ""}`}
                  onClick={() => setOriginal(true)}
                >
                  <History size={18} />
                  <span>
                    <strong>原始交付</strong>
                    <small>始终保留 · 只读</small>
                  </span>
                </button>
                <button
                  className={`version-row ${!original ? "selected" : ""}`}
                  onClick={() => setOriginal(false)}
                >
                  <FileText size={18} />
                  <span>
                    <strong>当前工作稿</strong>
                    <small>版本 {doc.revision} · 本机编辑</small>
                  </span>
                </button>
                {candidate && (
                  <button className="version-row" onClick={previewCandidate}>
                    <GitCompareArrows size={18} />
                    <span>
                      <strong>候选版本</strong>
                      <small>未应用 · 需要你查看</small>
                    </span>
                  </button>
                )}
                {doc.history
                  .slice()
                  .reverse()
                  .map((h, i) => (
                    <button
                      className="version-row"
                      key={`${h.revision}:${i}`}
                      onClick={() =>
                        setCompare({
                          kind: "history",
                          history: h,
                          revision: doc.revision,
                        })
                      }
                    >
                      <History size={17} />
                      <span>
                        <strong>工作稿版本 {h.revision}</strong>
                        <small>
                          {h.label} · {h.time}
                        </small>
                      </span>
                    </button>
                  ))}
              </>
            )}
          </div>
        </aside>
      )}
      {compare && (
        <Modal
          wide
          title={compare.kind === "history" ? "历史工作稿" : "比较候选版本"}
          description={
            compare.kind === "history"
              ? "恢复时会把当前稿也保留为历史。"
              : "按整段展示版本。当前工作稿不会自动改变。"
          }
          onClose={() => setCompare(null)}
        >
          {compare.kind === "history" ? (
            <>
              <div className="history-preview">
                <SafeContent html={compare.history.html} />
              </div>
              <div className="form-actions">
                <button className="button" onClick={() => setCompare(null)}>
                  关闭
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    const html = compare.history.html;
                    updateDoc((d) => ({
                      ...d,
                      history: [
                        ...d.history,
                        {
                          html: d.html,
                          revision: d.revision,
                          time: now(),
                          label: "恢复历史前的工作稿",
                        },
                      ],
                      html,
                      revision: d.revision + 1,
                    }));
                    editor.commands.setContent(sanitizeHTML(html), {
                      emitUpdate: false,
                    });
                    setCompare(null);
                    setOriginal(false);
                    notify("已恢复，之前的工作稿仍在历史中");
                  }}
                >
                  恢复到工作稿
                </button>
              </div>
            </>
          ) : (
            candidate && (
              <>
                <div className="compare-grid">
                  <section>
                    <h4>
                      发送时的工作稿 <Badge>v{candidate.baseRevision}</Badge>
                    </h4>
                    <SafeContent html={candidate.baseHTML} />
                  </section>
                  <section>
                    <h4>
                      你的当前工作稿 <Badge>v{doc.revision}</Badge>
                    </h4>
                    <SafeContent html={doc.html} />
                  </section>
                  <section>
                    <h4>
                      候选回复 <Badge tone="blue">待应用</Badge>
                    </h4>
                    <SafeContent html={candidate.html} />
                  </section>
                </div>
                {conflict && (
                  <label className="conflict-confirm">
                    <input
                      type="checkbox"
                      checked={replaceConfirmed}
                      onChange={(e) => setReplaceConfirmed(e.target.checked)}
                    />
                    <span>
                      我已看过差异：应用候选替换当前稿，当前稿保留到历史；不自动合并。
                    </span>
                  </label>
                )}
                <div className="form-actions">
                  <button className="button" onClick={() => setCompare(null)}>
                    保留当前稿
                  </button>
                  <button
                    className="button primary"
                    disabled={storageError || (conflict && !replaceConfirmed)}
                    onClick={applyCandidate}
                  >
                    应用此版本
                  </button>
                </div>
              </>
            )
          )}
        </Modal>
      )}
      {feedback && (
        <Modal
          title={feedback === "adopted" ? "采用这份成果" : "弃用这份成果"}
          description={`记录对工作稿版本 ${doc.revision} 的评价，不会执行对外发布。`}
          onClose={() => setFeedback(null)}
        >
          <label className="field">
            原因（选填）
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                feedback === "adopted"
                  ? "哪些地方对你有用？"
                  : "哪里不符合你的需要？"
              }
              rows={4}
            />
          </label>
          <div className="form-actions">
            {doc.feedback && (
              <button
                className="text-button"
                onClick={() => {
                  updateDoc((d) => ({
                    ...d,
                    feedback: null,
                    feedbackReason: "",
                  }));
                  setFeedback(null);
                }}
              >
                撤销原评价
              </button>
            )}
            <button className="button" onClick={() => setFeedback(null)}>
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                updateDoc((d) => ({
                  ...d,
                  feedback,
                  feedbackReason: reason,
                  evaluatedRevision: d.revision,
                  evaluatedHTML: d.html,
                }));
                setFeedback(null);
                notify("评价已记录，复制和导出不影响评价");
              }}
            >
              确认{feedback === "adopted" ? "采用" : "弃用"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
