import React, { useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeft,
  ArrowUpRight,
  Bold,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Heading2,
  History,
  Italic,
  List,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Quote,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { Avatar, IconButton } from "./common.jsx";
import { agents, downloadText, feedbackStats } from "./model.mjs";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
];

function DraftEditor({ doc, save, original, editorRef }) {
  const editor = useEditor({
    extensions,
    content: original ? doc.original : doc.html,
    editable: !original,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "成果正文",
        "aria-multiline": "true",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => save(editor.getHTML()),
    onCreate: ({ editor }) => {
      editorRef.current = editor;
    },
    onDestroy: () => {
      editorRef.current = null;
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            heading: editor.isActive("heading"),
            list: editor.isActive("bulletList"),
            quote: editor.isActive("blockquote"),
          }
        : {},
  });
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
    ["撤销", Undo2, "undo", () => editor.chain().focus().undo().run()],
  ];
  return (
    <>
      <div className="format-bar">
        <span className="body-style">
          正文
          <ChevronDown size={12} />
        </span>
        <i />
        {commands.map(([label, Icon, key, fn]) => (
          <IconButton
            key={key}
            icon={Icon}
            label={label}
            active={state?.[key]}
            disabled={original || !editor}
            onMouseDown={(e) => e.preventDefault()}
            onClick={fn}
          />
        ))}
        <span className="format-mode">
          {original ? "只读原稿" : "可直接编辑"}
        </span>
      </div>
      <div className="document-scroll">
        <div className="document-paper">
          <span className="doc-eyebrow">
            {original ? "Agent 原始交付 · 只读" : "共同成果 / 工作稿"}
          </span>
          <EditorContent editor={editor} />
          <div className="source-callout">
            <BookOpen size={15} />
            <div>
              <strong>出处与查证材料</strong>
              <p>此文为交互样稿。来源面板用于演示，不代表核验了当日新闻。</p>
            </div>
          </div>
          <div className="paper-end">
            {original ? "这份原稿会始终保留" : "你的修改只保存在此浏览器"}
          </div>
        </div>
      </div>
    </>
  );
}

export default function DocumentPane({
  project,
  patch,
  selectedDoc,
  setSelectedDoc,
  tab,
  setTab,
  review,
  setReview,
  close,
  showSources,
  showToast,
  showModal,
  editorRef,
  storageError,
}) {
  const [original, setOriginal] = useState(false);
  const doc = project.docs.find((d) => d.id === selectedDoc) || project.docs[0];
  const stats = feedbackStats(project);
  function save(html) {
    patch((p) => ({
      ...p,
      docs: p.docs.map((d) => (d.id === doc.id ? { ...d, html } : d)),
    }));
  }
  function feedback(value) {
    patch((p) => ({
      ...p,
      docs: p.docs.map((d) =>
        d.id === doc.id
          ? { ...d, feedback: d.feedback === value ? null : value }
          : d,
      ),
    }));
    showToast("已更新本项目的示例反馈；复制和导出不会计入采纳");
  }
  function handback() {
    const html = editorRef.current?.getHTML() || doc.html;
    const text = editorRef.current?.getText() || "";
    showModal({
      type: "handback",
      title: "交回修改",
      docId: doc.id,
      html,
      text,
    });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        editorRef.current?.getText() || doc.title,
      );
      showToast("工作稿已复制；尚未标记为采用");
    } catch {
      showToast("浏览器未允许复制，可选中文稿复制或导出文本");
    }
  }
  return (
    <aside
      className={"document-pane" + (review ? " document-review" : "")}
      aria-label="项目资料"
    >
      <div className="pane-tabs">
        <div role="tablist" aria-label="项目资料标签">
          {["成果", "成员", "项目知识", "设置"].map((t) => (
            <button
              role="tab"
              aria-selected={tab === t}
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <IconButton
          icon={PanelRightClose}
          label="收起资料面板"
          onClick={close}
        />
      </div>
      {tab === "成果" ? (
        doc ? (
          <>
            <div className="doc-breadcrumb">
              <FileText size={16} />
              <span>今日内容包</span>
              <ChevronDown size={12} />
              <select
                aria-label="选择成稿"
                value={doc.id}
                onChange={(e) => {
                  setSelectedDoc(e.target.value);
                  setOriginal(false);
                }}
              >
                {project.docs.map((d, i) => (
                  <option key={d.id} value={d.id}>
                    0{i + 1} · {d.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="document-meta">
              <span className="save-status" role="status">
                <CheckCheck size={13} />
                {storageError
                  ? "保存失败，请立即导出"
                  : original
                    ? "原始交付"
                    : "已保存至此浏览器"}
              </span>
              <button
                className="text-button muted"
                onClick={() =>
                  showModal({
                    type: "history",
                    title: "版本与修改",
                    docId: doc.id,
                  })
                }
              >
                <History size={13} />
                版本 {doc.revision}
              </button>
              <div className="doc-actions">
                <IconButton icon={Copy} label="复制文稿" onClick={copy} />
                <IconButton
                  icon={Download}
                  label="导出文稿"
                  onClick={() => {
                    downloadText(
                      "示例工作稿-" + doc.title + ".txt",
                      editorRef.current?.getText() || doc.title,
                    );
                    showToast("已导出；不会改变采纳状态");
                  }}
                />
                <IconButton
                  icon={review ? Minimize2 : Maximize2}
                  label={review ? "退出专注审核" : "展开成果审核"}
                  onClick={() => setReview(!review)}
                />
              </div>
            </div>
            <div className="doc-version-strip">
              <span>
                {original ? "正在查看 Agent 原稿" : "工作稿与原始交付分别保留"}
              </span>
              <button onClick={() => setOriginal((v) => !v)}>
                {original ? <ArrowLeft size={12} /> : <RotateCcw size={12} />}{" "}
                {original ? "返回工作稿" : "查看原稿"}
              </button>
              <button onClick={showSources}>
                出处
                <ArrowUpRight size={12} />
              </button>
            </div>
            <DraftEditor
              key={project.id + doc.id + original}
              doc={doc}
              original={original}
              save={save}
              editorRef={editorRef}
            />
            <div className="review-bottom">
              <div className="adopt-row">
                <div>
                  <strong>这条成稿，你会用吗？</strong>
                  <small>
                    {doc.feedback === "adopted"
                      ? "已采用"
                      : doc.feedback === "discarded"
                        ? "已弃用"
                        : "尚未评价"}{" "}
                    · 本期采用 {stats.adopted}/{stats.evaluated} · 待评价{" "}
                    {stats.pending}
                  </small>
                </div>
                <button
                  className={
                    "adopt-button" +
                    (doc.feedback === "adopted" ? " selected" : "")
                  }
                  aria-pressed={doc.feedback === "adopted"}
                  onClick={() => feedback("adopted")}
                >
                  <Check size={14} />
                  采用
                </button>
                <button
                  className={
                    "discard-button" +
                    (doc.feedback === "discarded" ? " selected" : "")
                  }
                  aria-pressed={doc.feedback === "discarded"}
                  onClick={() => feedback("discarded")}
                >
                  <X size={14} />
                  弃用
                </button>
              </div>
              <div className="edit-feedback">
                <span>修改记录可查看，采用与否由你确认。</span>
                <button className="text-button" onClick={handback}>
                  交回 {project.writer} 修改
                  <ArrowUpRight size={13} />
                </button>
              </div>
              <div
                className={
                  "learning-rule" + (project.approved ? " approved" : "")
                }
              >
                <BookOpen size={16} />
                <div>
                  <strong>
                    {project.approved
                      ? "本项目规则已生效"
                      : "从改稿积累项目知识"}
                  </strong>
                  <p>
                    {project.approved
                      ? "开头先讲实操场景，少用新闻腔。"
                      : "示例建议：开头先讲实操场景，少用新闻腔。"}
                  </p>
                </div>
                <button
                  onClick={() =>
                    project.approved
                      ? setTab("项目知识")
                      : showModal({ type: "rule", title: "批准项目规则" })
                  }
                >
                  {project.approved ? "查看规则" : "查看建议"}
                  <ChevronDown size={12} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="pane-empty">
            <FileText size={30} />
            <h3>成果会放在这里</h3>
            <p>项目成员交付后，可直接打开编辑。</p>
          </div>
        )
      ) : tab === "成员" ? (
        <div className="pane-scroll">
          <h3>本项目成员</h3>
          <p className="muted">按能力分工，可以由同一成员兼任。</p>
          {["Grok", project.checker, project.writer]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((name) => (
              <div className="member-detail" key={name}>
                <Avatar name={name} />
                <div>
                  <strong>{agents[name].label}</strong>
                  <small>
                    {name === "Grok"
                      ? "热点发现"
                      : name === project.checker && name === project.writer
                        ? "资料查证、写作与编辑"
                        : name === project.checker
                          ? "资料查证"
                          : "写作与编辑"}
                  </small>
                </div>
                <span>示例就绪</span>
              </div>
            ))}
          <div className="stats-block">
            <h4>本期成果反馈</h4>
            <div>
              <strong>{stats.rate}</strong>
              <span>采用率 · 已评价 {stats.evaluated} 条</span>
            </div>
            <p>
              已采用 {stats.adopted} · 待评价 {stats.pending}
              。此页统计仅来自你对三份示例成稿的操作。
            </p>
          </div>
          <button
            className="button"
            onClick={() =>
              showModal({ type: "setup", title: "调整项目分工", editing: true })
            }
          >
            调整分工
          </button>
        </div>
      ) : tab === "项目知识" ? (
        <div className="pane-scroll">
          <div className="section-line">
            <h3>项目知识</h3>
            <span className="tag">仅本项目</span>
          </div>
          <p className="muted">规则影响之后的工作；归档只保存资料。</p>
          <h4>已生效规则</h4>
          <ul className="rule-list">
            {project.rules.map((r, i) => (
              <li key={i}>
                <Check size={14} />
                {r}
              </li>
            ))}
            {project.approved && (
              <li>
                <Check size={14} />
                开头先讲实操场景，少用新闻腔。
                <button
                  className="text-button"
                  onClick={() => {
                    patch((p) => ({ ...p, approved: false }));
                    showToast("示例规则已撤回");
                  }}
                >
                  撤回
                </button>
              </li>
            )}
          </ul>
          <button
            className="button"
            onClick={() => showModal({ type: "rules", title: "编辑项目规则" })}
          >
            编辑规则
          </button>
          <h4 className="spaced">成果归档</h4>
          {project.docs.map((d, i) => (
            <button
              className="archive-row"
              key={d.id}
              onClick={() => {
                setSelectedDoc(d.id);
                setTab("成果");
              }}
            >
              <FileText size={16} />
              <span>
                0{i + 1} {d.title}
              </span>
              <ChevronDown size={13} />
            </button>
          ))}
        </div>
      ) : (
        <div className="pane-scroll">
          <h3>项目设置</h3>
          <label className="field">
            关注主题
            <input
              value={project.topic}
              onChange={(e) => patch((p) => ({ ...p, topic: e.target.value }))}
            />
          </label>
          <div className="setting-row">
            <div>
              <strong>每天 08:00</strong>
              <small>北京时间 · Asia/Shanghai</small>
            </div>
            <button
              role="switch"
              aria-checked={project.schedule}
              aria-label="开启示例自动运行"
              className={"switch" + (project.schedule ? " on" : "")}
              onClick={() => {
                patch((p) => ({ ...p, schedule: !p.schedule }));
                showToast("只保存节奏设置，原型不会执行后台定时任务");
              }}
            >
              <span />
            </button>
          </div>
          <p className="subtle-note">
            演示开关不产生后台任务。正式版需先完成真实试跑再启用。
          </p>
          <div className="setting-row">
            <div>
              <strong>内容发布</strong>
              <small>审核后，你自己发布</small>
            </div>
            <span className="tag">不自动发布</span>
          </div>
          <button
            className="button"
            onClick={() =>
              showModal({ type: "setup", title: "调整项目分工", editing: true })
            }
          >
            调整成员与分工
          </button>
        </div>
      )}
    </aside>
  );
}
