import React, { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  RotateCcw,
  Bold,
  Italic,
  List,
  Undo2,
  FileText,
  BookOpen,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DecisionNode,
  DecisionContext,
} from "../../docs/prototype/agent-feishu-v2/src/DecisionBlock.jsx";
import { api, command, memberName } from "./api.mjs";
export const renderHTML = (body = "", format = "markdown") =>
  DOMPurify.sanitize(
    format === "html"
      ? body
      : format === "text"
        ? "<p>" +
          String(body)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll("\n", "<br>") +
          "</p>"
        : marked.parse(body),
    {
      ADD_TAGS: ["hub-decision"],
      ADD_ATTR: ["data-id", "data-selected", "data-choice"],
    },
  );
import { CheckSummary } from "./SelfCheck.jsx";
export default function Document({
  documentId,
  project,
  members,
  onBack,
  onChange,
  notify,
}) {
  const [doc, setDoc] = useState(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("读取中"),
    [panel, setPanel] = useState(""),
    [request, setRequest] = useState(""),
    [compare, setCompare] = useState(false),
    [original, setOriginal] = useState(false),
    [workingChecks, setWorkingChecks] = useState(null),
    [versions, setVersions] = useState([]),
    [receipt, setReceipt] = useState(null),
    [actionBusy, setActionBusy] = useState(false),
    [loadedContent, setLoadedContent] = useState(null);
  const latest = useRef(null),
    timer = useRef(null),
    pending = useRef(null),
    dirty = useRef(false),
    chain = useRef(Promise.resolve()),
    editSerial = useRef(0);
  const decisions = (project.decisions || [])
    .filter((d) => d.documentId === documentId)
    .map((d) => ({
      ...d,
      positions: (d.options || []).map((o, i) => ({
        member: o.memberId || project.project.arrangement?.members[i],
        label: o.label,
        text: o.text,
        evidence: o.evidence || d.description,
      })),
      conditional: d.conditional || d.options?.map((o) => o.text).join("；"),
    }));
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      DecisionNode,
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "成果正文",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      if (original) return;
      const html = editor.getHTML();
      dirty.current = true;
      pending.current = { html, serial: ++editSerial.current };
      setSaved("保存中");
      try {
        localStorage.setItem(
          "agent-hub-unsaved-" + documentId,
          JSON.stringify({
            body: html,
            base: latest.current?.workingVersionId,
          }),
        );
      } catch {}
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save().catch(() => {}), 650);
    },
  });
  const selected = useEditorState({
    editor,
    selector: ({ editor }) => !editor?.state.selection.empty,
  });
  async function load() {
    try {
      const d = await api("/v2/document?id=" + documentId);
      latest.current = d;
      setDoc(d);
      let html = renderHTML(d.working.body, d.working.format);
      for (const decision of decisions)
        if (!html.includes(`data-id="${decision.id}"`))
          html += `<hub-decision data-id="${decision.id}"></hub-decision>`;
      let recovered;
      try {
        recovered = JSON.parse(
          localStorage.getItem("agent-hub-unsaved-" + documentId),
        );
      } catch {}
      if (recovered) {
        dirty.current = true;
        pending.current = {
          html: recovered.body,
          serial: ++editSerial.current,
        };
        html = recovered.body;
        setSaved("发现未保存稿");
        if (recovered.base !== d.workingVersionId)
          setError(
            "存在未保存修改，服务器版本也有变化。保留了你的本机稿，请核对后保存。",
          );
      } else setSaved("已保存");
      setLoadedContent({ html });
      if (!recovered) setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (editor && doc && loadedContent) {
      try {
        editor.commands.setContent(loadedContent.html, { emitUpdate: false });
      } catch (e) {
        setError(e.message);
      }
    }
  }, [editor, loadedContent, !!doc]);
  useEffect(() => {
    if (editor) load();
    return () => clearTimeout(timer.current);
  }, [documentId, editor]);
  useEffect(() => {
    const remote = project.documents.find((d) => d.id === documentId);
    if (
      !remote ||
      !latest.current ||
      remote.revision === latest.current.revision
    )
      return;
    api("/v2/document?id=" + documentId)
      .then((fresh) => {
        if (!latest.current) return;
        if (fresh.workingVersionId === latest.current.workingVersionId) {
          latest.current = { ...fresh, working: latest.current.working };
          setDoc(latest.current);
        } else if (!dirty.current) load();
        else setError("服务器稿件有更新，保留了你的未保存修改。请核对版本。");
      })
      .catch((e) => setError(e.message));
  }, [project.documents, documentId]);
  function save() {
    clearTimeout(timer.current);
    const snapshot = pending.current;
    if (!snapshot || !latest.current) return chain.current;
    pending.current = null;
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        try {
          const updated = await command("document.edit", {
            documentId,
            revision: latest.current.revision,
            body: snapshot.html,
            format: "html",
          });
          latest.current = {
            ...latest.current,
            ...updated,
            working: {
              ...latest.current.working,
              id: updated.workingVersionId,
              body: snapshot.html,
              format: "html",
            },
          };
          setDoc(latest.current);
          if (editSerial.current === snapshot.serial) {
            dirty.current = false;
            localStorage.removeItem("agent-hub-unsaved-" + documentId);
            setSaved("已保存");
          }
          setError("");
          onChange();
        } catch (e) {
          pending.current = pending.current || snapshot;
          setSaved("未保存");
          setError(
            e.status === 409
              ? "服务器已有新版本，你的修改已保留。请查看版本，核对后再保存。"
              : e.message,
          );
          throw e;
        }
      });
    return chain.current;
  }
  async function action(fn, anchorId) {
    const scroller = document.querySelector(".doc-scroll");
    const find = () =>
      [...document.querySelectorAll(".decision-inline")].find(
        (el) => el.dataset.decisionId === anchorId,
      );
    const anchorTop = anchorId ? find()?.getBoundingClientRect().top : null;
    if (actionBusy) return;
    setActionBusy(true);
    editor?.setEditable(false);
    try {
      await save();
      await fn(latest.current);
      await load();
      onChange();
      if (anchorTop !== null && anchorTop !== undefined)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const node = find();
            if (!node || !scroller) return;
            const desired =
              scroller.scrollTop + node.getBoundingClientRect().top - anchorTop;
            const buffer = scroller.querySelector(".v1-reading-buffer"),
              max = scroller.scrollHeight - scroller.clientHeight;
            if (buffer && desired > max)
              buffer.style.height = buffer.offsetHeight + desired - max + "px";
            scroller.scrollTop = desired;
          }),
        );
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy(false);
      editor?.setEditable(!original);
    }
  }
  async function choose(id, choice, text, remember) {
    await action(async (d) => {
      await command("decision.choose", {
        decisionId: id,
        revision: d.revision,
        text,
        undo: !choice,
      });
      if (remember)
        await command("knowledge.write", {
          projectId: d.scopeId,
          title: "来自你的决定",
          body: text,
          approved: true,
        });
    }, id);
  }
  async function openPanel(name) {
    setPanel(name);
    if (name === "versions") {
      const v = await api(
        "/v2/records?kind=document_version&parentId=" +
          documentId +
          "&order=recent",
      );
      setVersions(v.items);
    }
    if (name === "sources" && doc?.parentId)
      setReceipt(await api("/v2/run?id=" + doc.parentId));
  }
  if (!doc)
    return (
      <div className="empty">
        <FileText size={24} />
        <p>{error || "正在读取成果…"}</p>
      </div>
    );
  const criteria = project.project.arrangement?.criteria || [];
  const record = doc.record || {},
    pendingCount = decisions.filter((d) => d.status === "pending").length;
  return (
    <section className="review">
      <div className="doc-top">
        <Button
          variant="ghost"
          size="icon"
          onClick={async () => {
            try {
              await save();
              onBack();
            } catch {}
          }}
          aria-label="返回项目"
        >
          <ArrowLeft size={18} />
        </Button>
        <span className="font-semibold">
          {original ? "原始交付" : "工作稿"}
        </span>
        <Button variant="ghost" onClick={() => openPanel("versions")}>
          版本记录
          <ChevronDown size={14} />
        </Button>
        <div className="right">
          <Button variant="ghost" onClick={() => openPanel("sources")}>
            <BookOpen size={15} />
            出处
          </Button>
          <small className={saved === "未保存" ? "state-red" : ""}>
            {saved}
          </small>
          <Button
            variant="ghost"
            size="icon"
            aria-label="复制稿件"
            onClick={() => {
              navigator.clipboard.writeText(editor.getText());
              notify("已复制正文");
            }}
          >
            <Copy size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="导出稿件"
            onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(
                new Blob([editor.getHTML()], { type: "text/html" }),
              );
              a.download = doc.title + ".html";
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}
          >
            <Download size={16} />
          </Button>
        </div>
      </div>
      {error && (
        <div className="alert-bar" role="alert">
          <AlertCircle size={16} />
          {error}
          <Button
            size="sm"
            variant="outline"
            onClick={() => save().catch(() => {})}
          >
            重试保存
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (
                !window.confirm(
                  "已保留服务器现有版本。确认把当前本机修改另存为新的工作稿版本？",
                )
              )
                return;
              try {
                const fresh = await api("/v2/document?id=" + documentId);
                latest.current = fresh;
                pending.current = {
                  html: editor.getHTML(),
                  serial: ++editSerial.current,
                };
                await save();
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            保留本机稿为新版本
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openPanel("versions")}
          >
            查看服务器版本
          </Button>
        </div>
      )}
      {doc.candidateVersionId && (
        <div className="status-line">
          成员已返回候选稿，未覆盖你的工作稿。
          <Button variant="link" size="sm" onClick={() => setCompare(true)}>
            比较候选版本
          </Button>
        </div>
      )}
      {selected && !original && (
        <div className="flex gap-1 border-b px-10 py-2">
          {[
            [Bold, "加粗", () => editor.chain().focus().toggleBold().run()],
            [Italic, "斜体", () => editor.chain().focus().toggleItalic().run()],
            [
              List,
              "列表",
              () => editor.chain().focus().toggleBulletList().run(),
            ],
            [Undo2, "撤销", () => editor.chain().focus().undo().run()],
          ].map(([Icon, name, fn]) => (
            <Button
              key={name}
              variant="ghost"
              size="sm"
              onMouseDown={(e) => e.preventDefault()}
              onClick={fn}
            >
              <Icon size={15} />
              {name}
            </Button>
          ))}
        </div>
      )}
      <div className="doc-scroll document-scroll">
        <article className="doc-paper">
          <small>
            {memberName(members, doc.memberId)} 的交付 · {project.project.name}
          </small>
          <h1>{doc.title}</h1>
          <CheckSummary
            doc={
              original
                ? { ...doc, workingVersionId: doc.originalVersionId }
                : doc
            }
            criteria={criteria}
            members={members}
          />
          {doc.selfCheckVersionId !== doc.workingVersionId && !original && (
            <Button
              variant="link"
              className="p-0"
              onClick={() =>
                action((d) =>
                  command("document.recheck", {
                    documentId,
                    revision: d.revision,
                  }),
                )
              }
            >
              让 {memberName(members, doc.memberId)} 按标准再查一次
            </Button>
          )}
          <div className="record">
            <button onClick={() => openPanel("evidence")}>
              {record.unique ||
              record.independent ||
              record.corrections ||
              pendingCount ? (
                <>
                  本轮记录：独有发现 {record.unique || 0} · 独立互证{" "}
                  {record.independent || 0}（多处引用 {record.multiple || 0}）
                  {record.corrections
                    ? ` · 有据纠错 ${record.corrections}`
                    : ""}
                  {pendingCount ? ` · 待你决定 ${pendingCount}` : ""}
                </>
              ) : (
                "本轮没有记录到额外贡献"
              )}{" "}
              · <span className="text-primary">查看依据</span>
            </button>
          </div>
          <DecisionContext.Provider
            value={{
              persistSelection: true,
              project: { decisions },
              members: members.map((m) => ({
                ...m,
                initial: m.name.slice(0, 1),
                color: m.platformId === "grok-bot" ? "#27313e" : "#237c6d",
              })),
              storageError: saved === "未保存" || actionBusy,
              onChoose: choose,
            }}
          >
            <EditorContent editor={editor} />
          </DecisionContext.Provider>
          {doc.fileIds?.length > 0 && (
            <section className="mt-6 border-t py-4">
              <h3>交付附件</h3>
              {doc.fileIds.map((id) => (
                <a
                  className="block text-primary py-2"
                  href={"/api/v2/files/" + id}
                  download
                  key={id}
                >
                  下载完整附件 ↗
                </a>
              ))}
            </section>
          )}
          {project.knowledge
            .filter(
              (k) => k.status === "pending" && k.documentId === documentId,
            )
            .slice(0, 1)
            .map((k) => (
              <aside className="connect-box" key={k.id}>
                <small>{memberName(members, k.author)} 从你的修改中总结</small>
                <p>{k.body}</p>
                <div className="flex gap-2 mt-3">
                  <Button
                    size="sm"
                    onClick={() =>
                      action(() =>
                        command("knowledge.review", {
                          knowledgeId: k.id,
                          revision: k.revision,
                          status: "approved",
                        }),
                      )
                    }
                  >
                    以后都这样
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      action(() =>
                        command("knowledge.review", {
                          knowledgeId: k.id,
                          revision: k.revision,
                          status: "rejected",
                        }),
                      )
                    }
                  >
                    只这次
                  </Button>
                </div>
              </aside>
            ))}
          <div className="mt-10 text-xs text-muted-foreground">
            —— 成果正文结束 ——
          </div>
        </article>
        <div className="v1-reading-buffer" aria-hidden="true" />
      </div>
      <footer className="doc-actions">
        <small>原稿与人工工作稿分别保留</small>
        <Button
          disabled={!doc.deliverable || actionBusy}
          onClick={() =>
            action(() =>
              command("feedback.set", { documentId, value: "adopted" }),
            )
          }
        >
          <Check size={15} />
          采用成果
        </Button>
        <Button
          disabled={!doc.deliverable || actionBusy}
          variant="outline"
          onClick={() =>
            action(() =>
              command("feedback.set", { documentId, value: "discarded" }),
            )
          }
        >
          弃用
        </Button>
        <Button variant="outline" onClick={() => setPanel("revise")}>
          <RotateCcw size={15} />让 {memberName(members, doc.memberId)} 改
        </Button>
      </footer>
      <Dialog open={!!panel} onOpenChange={(v) => !v && setPanel("")}>
        <DialogContent className="max-h-[82vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {
                {
                  sources: "出处与规则",
                  versions: "原稿与版本",
                  revise: "交回修改",
                  evidence: "本轮依据",
                }[panel]
              }
            </DialogTitle>
            <DialogDescription>
              保留来源和版本，已带入规则不代表已经遵守。
            </DialogDescription>
          </DialogHeader>
          {panel === "revise" ? (
            <>
              <Textarea
                autoFocus
                aria-label="修改要求"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="希望怎样修改？"
                rows={5}
              />
              <small>
                携带完整工作稿和基准版本；返回候选稿，由你决定是否应用。
              </small>
              <Button
                disabled={!request.trim()}
                onClick={() =>
                  action(async (d) => {
                    await command("document.revise", {
                      documentId,
                      revision: d.revision,
                      memberId:
                        d.memberId === "owner"
                          ? project.project.arrangement?.lead
                          : d.memberId,
                      instruction: request,
                    });
                    setPanel("");
                    notify("已交回原成员修改");
                  })
                }
              >
                提交修改要求
              </Button>
            </>
          ) : panel === "versions" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (!original && dirty.current) {
                    setError("请先保存工作稿");
                    return;
                  }
                  setOriginal(!original);
                  editor.setEditable(original);
                  editor.commands.setContent(
                    renderHTML(
                      original ? doc.working.body : doc.original.body,
                      original ? doc.working.format : doc.original.format,
                    ),
                    { emitUpdate: false },
                  );
                  setPanel("");
                }}
              >
                {original ? "返回工作稿" : "查看原始交付"}
              </Button>
              {versions.map((v) => (
                <details className="source-row" key={v.id}>
                  <summary>
                    {v.type === "human" ? "人工修改" : "成员交付"} ·{" "}
                    {v.createdAt}
                  </summary>
                  <div className="whitespace-pre-wrap text-sm">{v.body}</div>
                </details>
              ))}
            </>
          ) : panel === "sources" ? (
            <>
              {doc.sources.map((s, i) => (
                <div className="source-row" key={i}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title || s.url}
                  </a>
                  <small className="block">
                    {s.publishedAt
                      ? "原发布时间：" + s.publishedAt
                      : "来源未提供原发布时间"}
                  </small>
                </div>
              ))}
              <h3 className="font-semibold mt-5">本轮规则</h3>
              {receipt?.run.knowledge.map((k) => (
                <div className="source-row" key={k.id}>
                  <strong>{k.title}</strong>
                  <p>{k.body}</p>
                  <small>
                    版本 {k.revision} · 本轮已带入 ·{" "}
                    {doc.ruleReceipts?.find(
                      (r) => r.ruleId === k.id && r.revision === k.revision,
                    )?.followed === true
                      ? "成员核对符合（见段落）"
                      : doc.ruleReceipts?.find(
                            (r) =>
                              r.ruleId === k.id && r.revision === k.revision,
                          )?.followed === false
                        ? "成员核对未符合"
                        : "结果未确认"}
                  </small>
                  {doc.ruleReceipts
                    ?.filter(
                      (r) => r.ruleId === k.id && r.revision === k.revision,
                    )
                    .map((r, i) => (
                      <p key={i}>
                        {r.reason} · 对应：{r.paragraph} · 检查者：
                        {memberName(members, r.checkedBy)}
                      </p>
                    ))}
                </div>
              ))}
            </>
          ) : (
            <div className="space-y-4 text-sm">
              {doc.sourceEvidence?.claims?.map((c) => (
                <div className="source-row" key={c.id}>
                  <strong>{memberName(members, c.memberId)}</strong>
                  <p>{c.text}</p>
                  {c.sourceUrls.map((url) => (
                    <a
                      className="block"
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {url}
                    </a>
                  ))}
                  <small>
                    {doc.sourceEvidence.dispositions.find(
                      (d) => d.claimId === c.id,
                    )?.reason || "原始论断，保留待核对"}
                  </small>
                </div>
              ))}
              {!doc.sourceEvidence && <p>尚无结构化依据记录。</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={compare} onOpenChange={setCompare}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>候选与当前工作稿</DialogTitle>
            <DialogDescription>
              应用前仍会检查版本；不会自动覆盖人工修改。
            </DialogDescription>
          </DialogHeader>
          <div className="compare-grid">
            <article>
              <h2>当前工作稿</h2>
              <div className="compare-text">{editor?.getText()}</div>
            </article>
            <article>
              <h2>候选稿</h2>
              <div className="compare-text">
                {doc.candidate?.body || "正在读取候选版本"}
              </div>
            </article>
          </div>
          <Button
            onClick={() =>
              action(async (d) => {
                await command("document.apply_candidate", {
                  documentId,
                  revision: d.revision,
                });
                setCompare(false);
              })
            }
          >
            应用此版本（保留旧稿）
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
