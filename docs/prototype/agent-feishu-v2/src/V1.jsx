import React, { useState, useRef, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  FileText,
  Search,
  ArrowRight,
  Check,
  Plus,
  ChevronDown,
  BookOpen,
  Link2,
  AlertCircle,
  Copy,
  CheckCircle2,
} from "lucide-react";
import { Avatar, Badge, Modal, PageHeader, Empty } from "./common.jsx";
import {
  uid,
  now,
  modes,
  sanitizeHTML,
  htmlText,
  currentFeedback,
  pendingCount,
} from "./model.mjs";
import {
  sampleSections,
  criteriaList,
  extractGoalCriteria,
} from "./v1-data.mjs";

export function ReviewRecord({
  doc,
  project,
  members = [],
  compact = false,
  onRecheck,
}) {
  const [open, setOpen] = useState(false),
    [evidence, setEvidence] = useState(false);
  const checks = doc.reviewChecks || [],
    stale = doc.selfCheckRevision !== doc.revision;
  const ok = checks.filter((c) => c.pass).length,
    failed = checks.length - ok;
  const record = doc.record || {
    unique: 0,
    independent: 0,
    multiple: 0,
    corrections: 0,
    decisions: 0,
  };
  const pending = project ? pendingCount(project) : record.decisions;
  const reviewer = members.find((m) => m.id === doc.author)?.name || "成员";
  return (
    <div
      className={"v1-review-record" + (compact ? " compact" : "")}
      data-testid="review-record"
    >
      <button
        className={
          "v1-check-trigger" +
          (stale ? " historical" : failed ? " incomplete" : "")
        }
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {failed && !stale ? (
          <AlertCircle size={15} />
        ) : (
          <CheckCircle2 size={15} />
        )}
        {stale && checks.length
          ? "自查基于版本 " + doc.selfCheckRevision + " · 之后有你的修改"
          : doc.partial
            ? "部分交付 · 缺少成员交叉检查"
            : !checks.length
              ? "待自查"
              : failed
                ? "部分达标 · " + failed + " 项未达标"
                : "合格标准 " + ok + "/" + checks.length + " 符合"}{" "}
        <ChevronDown size={13} />
      </button>
      {stale && onRecheck && (
        <div className="v1-recheck-action">
          <button
            className="text-button"
            onClick={onRecheck}
            disabled={doc.recheckRequest?.status === "preview_pending"}
          >
            {doc.recheckRequest?.status === "preview_pending"
              ? "已提交复查演示"
              : "让 " + reviewer + " 按标准再查一次"}
          </button>
          <small>由你主动发起；原型不唤醒真实 Agent</small>
        </div>
      )}
      {!compact && (
        <button
          className="v1-record-line"
          onClick={() => setEvidence(!evidence)}
          aria-expanded={evidence}
        >
          本轮记录：独有发现 {record.unique} · 独立互证 {record.independent}
          （多处引用 {record.multiple}）
          {record.corrections > 0 ? " · 有据纠错 " + record.corrections : ""}
          {pending > 0 ? " · 待你决定 " + pending : ""} <span>查看依据</span>
        </button>
      )}
      {open && (
        <div className="v1-check-list">
          {doc.partial && (
            <p className="incomplete">
              仅收到部分成员的成果，未完成约定的交叉检查。
            </p>
          )}
          <small>
            {stale
              ? "以下为原版本的历史自查，不能代表当前稿件。"
              : "示例自查记录，不代表真实平台核验。"}
          </small>
          {checks.map((c, i) => (
            <section key={i}>
              <strong className={c.pass ? "" : "incomplete"}>
                {c.pass ? "符合" : "不符合"} · {c.title}
              </strong>
              <p>
                检查者：{c.by} · 对应段落：{c.paragraph}
              </p>
              <small>{c.evidence}</small>
            </section>
          ))}
          {!checks.length && <p>尚无自查结果。</p>}
        </div>
      )}
      {evidence && (
        <div className="v1-check-list">
          <strong>原始依据与来源关系 · 示例</strong>
          <p>
            多处引用仅表示出现于多个材料中；当前独立互证为
            0，未确认来源相互独立。
          </p>
          {(project.materials || []).map((m) => (
            <section key={m.id}>
              <strong>
                {m.id} · {m.title}
              </strong>
              <p>{m.body}</p>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function V1ProjectForm({
  project,
  members,
  onSave,
  onCancel,
  initialGoal = "",
  reference,
}) {
  const [step, setStep] = useState(1),
    [goal, setGoal] = useState(project?.goal || initialGoal),
    [mode, setMode] = useState(project?.mode || "parallel");
  const [delivery, setDelivery] = useState(project?.delivery || "final"),
    [selected, setSelected] = useState(
      project?.members ||
        ["grok", "dots"].filter((id) => members.some((m) => m.id === id)),
    );
  const [lead, setLead] = useState(project?.lead || "dots"),
    [criteria, setCriteria] = useState(() =>
      criteriaList(project?.criteria || "每条结论附来源\n缺少的信息写明缺口"),
    );
  const [scheduled, setScheduled] = useState(
      project?.schedule?.enabled || false,
    ),
    [times, setTimes] = useState(
      (project?.schedule?.times || ["06:00", "12:00", "19:00"]).join("、"),
    );
  const [timezone, setTimezone] = useState(
      project?.schedule?.timezone || "Asia/Shanghai",
    ),
    [error, setError] = useState(""),
    [suggestion, setSuggestion] = useState(false);
  const [materials, setMaterials] = useState(
      reference ? [reference] : project?.materials || [],
    ),
    [link, setLink] = useState("");
  const extractedGoal = useRef(project?.goal || "");
  const options = modes
    .filter((m) => m.id !== "relay")
    .sort(
      (a, b) =>
        ["parallel", "review", "solo"].indexOf(a.id) -
        ["parallel", "review", "solo"].indexOf(b.id),
    );
  const recommendation = /研究|调研|找|对比|评估/.test(goal)
    ? "parallel"
    : /方案|计划|决定|评审/.test(goal)
      ? "review"
      : "solo";
  function submit(e) {
    e.preventDefault();
    setError("");
    if (step === 1) {
      if (!goal.trim()) {
        setError("先写下目标");
        return;
      }
      if (!project) {
        setMode(recommendation);
      }
      if (extractedGoal.current !== goal) {
        setCriteria((current) => [
          ...new Set([...current, ...extractGoalCriteria(goal)]),
        ]);
        extractedGoal.current = goal;
      }
      setStep(2);
      return;
    }
    const chosen = selected.filter((id) =>
      members.some((m) => m.id === id && !m.paused),
    );
    if (
      !chosen.length ||
      ((delivery === "compare" || mode !== "solo") && chosen.length < 2)
    ) {
      setError("请选择足够的成员：并排提交或协作至少需要两位");
      return;
    }
    if (step === 2) {
      if (!criteria.some((c) => c.trim())) {
        setError("请保留至少一条合格标准");
        return;
      }
      setStep(3);
      return;
    }
    const clock = times.split(/[,，、\s]+/).filter(Boolean);
    if (
      scheduled &&
      (!clock.length || clock.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    ) {
      setError("请填写有效时间，例如 06:00、12:00、19:00");
      return;
    }
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
    } catch {
      setError("时区无效");
      return;
    }
    onSave(
      {
        name: project?.name || goal.trim().slice(0, 20),
        goal: goal.trim(),
        mode,
        delivery,
        members:
          mode === "solo" && delivery === "final" ? chosen.slice(0, 1) : chosen,
        lead:
          mode === "solo" && delivery === "final"
            ? chosen[0]
            : chosen.includes(lead)
              ? lead
              : chosen[0],
        criteria: criteriaList(criteria),
        materials,
        schedule: {
          enabled: scheduled,
          times: [...new Set(clock)].sort(),
          timezone,
        },
        assignments: {},
        permissions: {},
      },
      project?.status === "running" ? "next" : "now",
    );
  }
  return (
    <form className="project-form wizard v1-form" onSubmit={submit}>
      <div className="wizard-steps" aria-label={"第 " + step + " 步，共 3 步"}>
        {["说目标", "工作安排", "定节奏"].map((s, i) => (
          <span key={s} className={i + 1 === step ? "current" : ""}>
            <b>{i + 1}</b>
            {s}
          </span>
        ))}
      </div>
      {step === 1 ? (
        <>
          <label className="field">
            你想让团队做成什么？
            <textarea
              autoFocus
              rows={5}
              aria-label="项目目标"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：研究智能戒指有没有适合个人开发者的机会"
            />
          </label>
          <div className="v1-add-material">
            <label>
              添加资料链接
              <input
                aria-label="资料链接"
                placeholder="https://…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="button small"
              disabled={!/^https?:\/\//.test(link)}
              onClick={() => {
                setMaterials([
                  ...materials,
                  {
                    id: uid("material"),
                    title: link,
                    url: link,
                    type: "待查链接",
                    body: "用户提供，原型不会抓取",
                  },
                ]);
                setLink("");
              }}
            >
              添加链接
            </button>
            <label className="button small file-button">
              添加文件
              <input
                type="file"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setMaterials([
                    ...materials,
                    {
                      id: uid("material"),
                      title: file.name,
                      type: "本地资料",
                      body:
                        file.size < 200000 && /\.(txt|md)$/i.test(file.name)
                          ? await file.text()
                          : "仅保留示例文件信息，未上传。",
                    },
                  ]);
                }}
              />
            </label>
          </div>
          {materials.map((m) => (
            <p key={m.id} className="field-note">
              <FileText size={12} /> {m.title}
            </p>
          ))}
        </>
      ) : step === 2 ? (
        <>
          <p className="wizard-goal">{goal}</p>
          <fieldset>
            <legend>交付形式</legend>
            <div className="v1-delivery-options">
              {[
                ["final", "一份最终结果"],
                ["compare", "各自提交，并排对比"],
              ].map(([id, label]) => (
                <label key={id}>
                  <input
                    type="radio"
                    name="delivery"
                    checked={delivery === id}
                    onChange={() => setDelivery(id)}
                  />
                  <strong>{label}</strong>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="v1-output-preview">
            {delivery === "final"
              ? "你将收到：一份由 " +
                (members.find((m) => m.id === lead)?.name || "所选成员") +
                " 汇总的成果"
              : selected
                  .map((id) => members.find((m) => m.id === id)?.name)
                  .join("、") + " 各一份，并排显示"}
          </div>
          {delivery === "final" && (
            <fieldset>
              <legend>怎么做</legend>
              <div className="mode-options three-modes">
                {options.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    aria-pressed={mode === m.id}
                    className={
                      "mode-option " + (mode === m.id ? "selected" : "")
                    }
                    onClick={() => {
                      setMode(m.id);
                      if (m.id === "solo") {
                        setSelected(selected.slice(0, 1));
                        setLead(selected[0]);
                      }
                    }}
                  >
                    <span className="radio-dot" aria-hidden="true" />
                    <span>
                      <strong>{m.label}</strong>
                      <small>{m.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <p className="field-note">
            按目标类型给出的默认安排，可以修改；这是模板规则，未调用模型。
          </p>
          <fieldset>
            <legend>参与成员</legend>
            <div className="member-picker">
              {members.map((m) => (
                <label
                  key={m.id}
                  className={
                    "member-choice " +
                    (selected.includes(m.id) ? "selected" : "")
                  }
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    disabled={
                      m.paused || !["Grok Bot", "Dots"].includes(m.platform)
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, m.id]
                          : selected.filter((x) => x !== m.id),
                      )
                    }
                  />
                  <Avatar member={m} size={28} />
                  <span>
                    {m.name}
                    <small>
                      {m.about} · {m.id === "muse" ? "第二批" : "示例能力"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {delivery === "final" && mode !== "solo" && (
            <label className="field">
              汇总 / 检查成员
              <select
                aria-label="汇总成员"
                value={selected.includes(lead) ? lead : selected[0] || ""}
                onChange={(e) => setLead(e.target.value)}
              >
                {selected
                  .map((id) => members.find((m) => m.id === id))
                  .filter(Boolean)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <fieldset className="v1-criteria" aria-label="合格标准">
            <legend>合格标准</legend>
            {criteria.map((criterion, i) => (
              <div className="v1-criterion-row" key={i}>
                <input
                  aria-label={"合格标准 " + (i + 1)}
                  value={criterion}
                  onChange={(e) =>
                    setCriteria(
                      criteria.map((c, n) => (n === i ? e.target.value : c)),
                    )
                  }
                />
                <button
                  type="button"
                  className="button quiet"
                  aria-label={"删除标准 " + (i + 1)}
                  onClick={() =>
                    setCriteria(criteria.filter((_, n) => n !== i))
                  }
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() => setCriteria([...criteria, ""])}
            >
              <Plus size={14} />
              添加标准
            </button>
          </fieldset>
          <div>
            <button
              type="button"
              className="button small"
              onClick={() => setSuggestion(true)}
            >
              让团队安排
            </button>
            <small> 额外叫醒一位已选成员，费用以原平台为准</small>
          </div>
          {suggestion && (
            <div className="v1-inline-note">
              原型只演示等待状态，未发送请求。你可以直接使用当前安排；真实草案晚到只作为“稍后建议”。
            </div>
          )}
        </>
      ) : (
        <>
          <label className="choice-row">
            <input
              type="radio"
              name="cadence"
              checked={!scheduled}
              onChange={() => setScheduled(false)}
            />
            只做一次
          </label>
          <label className="choice-row">
            <input
              type="radio"
              name="cadence"
              checked={scheduled}
              onChange={() => setScheduled(true)}
            />
            定期做
          </label>
          {scheduled && (
            <>
              <label className="field">
                时间点
                <input
                  aria-label="运行时间"
                  value={times}
                  onChange={(e) => setTimes(e.target.value)}
                />
              </label>
              <label className="field">
                时区
                <input
                  aria-label="运行时区"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </>
          )}
          <p className="field-note">
            原型仅保存安排，开始后手动推进示例，不开启真实日程。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="button quiet"
          onClick={step === 1 ? onCancel : () => setStep(step - 1)}
        >
          {step === 1 ? "取消" : "上一步"}
        </button>
        <button className="button primary" type="submit">
          {step === 3 ? "开始" : step === 2 ? "下一步：定节奏" : "下一步"}
          <ArrowRight size={14} />
        </button>
      </div>
    </form>
  );
}

function ConnectionWizard({ member, onClose, onReady }) {
  const grok = member.platform === "Grok Bot",
    steps = grok
      ? ["命名", "连接", "接收任务", "测试"]
      : ["命名", "连接", "测试"];
  const [step, setStep] = useState(0),
    [delivered, setDelivered] = useState(false),
    [replied, setReplied] = useState(false),
    [subscribed, setSubscribed] = useState(false);
  const testing = step === steps.length - 1;
  return (
    <Modal title={member.name + " 接入向导 · 演示"} onClose={onClose} wide>
      <div className="wizard-steps">
        {steps.map((s, i) => (
          <span key={s} className={i === step ? "current" : ""}>
            <b>{i + 1}</b>
            {s}
          </span>
        ))}
      </div>
      <div className="v1-inline-note">
        这里只演示接入步骤。不会打开真实授权，也不收集配对码或密钥。
      </div>
      {step === 0 ? (
        <label className="field">
          成员备注
          <input value={member.name} readOnly />
          <small>备注可在成员页修改；账号身份不随备注改变。</small>
        </label>
      ) : !testing ? (
        <div className="v1-connect-instructions">
          <h3>
            {step === 1
              ? "连接你的 " + member.name
              : "创建只由 webhook 触发的 Routine"}
          </h3>
          <p>
            {step === 1
              ? "在原平台添加 Hub 连接，并在官方授权流程中完成配对。秘密参数不写进发给 Agent 的话。"
              : "原平台创建 Routine 后，在 Hub 接收通知地址与密钥。实际接入须在正式版本完成。示例值不可用。"}
          </p>
          <pre>
            {step === 1
              ? "请为我添加 Agent Hub 的连接，并按官方流程完成授权。"
              : "Webhook URL：示例（未配置）\n密钥：不在原型中输入"}
          </pre>
          {step === 1 && (
            <button
              className="button"
              onClick={() =>
                navigator.clipboard?.writeText(
                  "这是 Agent Hub 接入步骤的原型说明，不是真实授权请求。",
                )
              }
            >
              <Copy size={14} />
              复制示例说明
            </button>
          )}
          {grok && step === 1 && (
            <p className="field-note">
              插件授权范围以原平台实际说明为准；不要把网页登录当作工具已接通。
            </p>
          )}
        </div>
      ) : (
        <div className="v1-connect-tests">
          <h3>验证真实往返的界面示例</h3>
          {!grok && (
            <button className="button" onClick={() => setSubscribed(true)}>
              {subscribed ? "✓ 任务通知已开启（示例）" : "演示事件订阅成功"}
            </button>
          )}
          <button
            className="button"
            disabled={!grok && !subscribed}
            onClick={() => setDelivered(true)}
          >
            {delivered ? "✓ 已送达（示例）" : "演示通知已送达"}
          </button>
          <button
            className="button"
            disabled={!delivered}
            onClick={() => setReplied(true)}
          >
            {replied ? "✓ 已回复（示例）" : "演示 Agent 已回复"}
          </button>
          <p className="field-note">
            收到真实工具回执后，正式版才可显示“可接任务”。此处完成只更新演示状态。
          </p>
        </div>
      )}
      <div className="form-actions">
        <button
          className="button quiet"
          onClick={step ? () => setStep(step - 1) : onClose}
        >
          {step ? "上一步" : "取消"}
        </button>
        {testing ? (
          <button
            className="button primary"
            disabled={!replied}
            onClick={() => {
              onReady();
              onClose();
            }}
          >
            完成演示
          </button>
        ) : (
          <button className="button primary" onClick={() => setStep(step + 1)}>
            下一步
          </button>
        )}
      </div>
    </Modal>
  );
}

export function ComparisonPane({
  project,
  members,
  patch,
  onBack,
  notify,
  storageError,
}) {
  const draftRef = useRef(project.comparisonDraft || ""),
    save = useRef(patch);
  save.current = patch;
  const editor = useEditor({
    extensions: [StarterKit],
    content: project.comparisonDraft || "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "我的工作稿",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      draftRef.current = editor.getHTML();
      save.current((p) => ({ ...p, comparisonDraft: editor.getHTML() }));
    },
  });
  function adopt(d, i, text) {
    const key = d.id + ":" + i;
    if ((project.adoptedSections || []).includes(key)) return;
    editor
      .chain()
      .focus()
      .insertContent(
        "<p>" +
          text +
          "</p><p><small>[" +
          (members.find((m) => m.id === d.author)?.name || d.author) +
          " · " +
          sampleSections[i].title +
          "]</small></p>",
      )
      .run();
    patch((p) => ({
      ...p,
      comparisonDraft: editor.getHTML(),
      adoptedSections: [...(p.adoptedSections || []), key],
    }));
    notify("已按原文加入工作稿，保留来源标记");
  }
  return (
    <section className="v1-comparison">
      <header>
        <button className="button quiet" onClick={onBack}>
          ← 返回群聊
        </button>
        <div>
          <h2>各自提交，并排对比</h2>
          <p>成员独立完成，未进行整合 · 示例内容</p>
        </div>
      </header>
      <div className="v1-compare-scroll">
        <div className="v1-compare-columns">
          {project.docs.slice(-2).map((d, n) => (
            <article key={d.id}>
              <div className="v1-compare-author">
                <Avatar member={members.find((m) => m.id === d.author)} />
                <strong>{members.find((m) => m.id === d.author)?.name}</strong>
                <span>独立交付 {n === 0 ? "A" : "B"}</span>
              </div>
              <ReviewRecord
                doc={d}
                project={{ ...project, decisions: [] }}
                members={members}
                compact
              />
              {sampleSections.map((s, i) => {
                const key = d.id + ":" + i,
                  adopted = (project.adoptedSections || []).includes(key),
                  text = n === 0 ? s.a : s.b;
                return (
                  <section
                    className={
                      "v1-compare-section " + (adopted ? "adopted" : "")
                    }
                    key={s.title}
                  >
                    <h3>
                      {String(i + 1).padStart(2, "0")} · {s.title}
                    </h3>
                    <p>{text}</p>
                    <div>
                      <small>
                        [
                        {members.find((m) => m.id === d.author)?.name ||
                          d.author}{" "}
                        · {s.title}]
                      </small>
                      <button
                        className="text-button"
                        disabled={adopted}
                        onClick={() => adopt(d, i, text)}
                      >
                        {adopted ? "✓ 已加入工作稿" : "采用这段"}
                      </button>
                    </div>
                  </section>
                );
              })}
            </article>
          ))}
        </div>
        <section className="v1-working-draft">
          <header>
            <h3>我的工作稿</h3>
            <span>
              {storageError ? "未保存 · 仅保留在内存" : "本机已保存"} ·{" "}
              {(project.adoptedSections || []).length} 段
            </span>
          </header>
          <EditorContent editor={editor} />
          <p className="field-note">
            采用后原文和来源一起保留；你可以继续编辑。本机预览保存。
          </p>
        </section>
      </div>
    </section>
  );
}

export function V1ManagedPages({ state, project, actions }) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [status, setStatus] = useState("all"),
    [tab, setTab] = useState("rules"),
    [wizard, setWizard] = useState(null),
    [receipt, setReceipt] = useState(null);
  const { chooseProject, setModal, updateProject, setState, notify } = actions;
  const rows = state.projects.filter(
    (p) => filter === "all" || p.id === filter,
  );
  const matches = (s) => String(s).toLowerCase().includes(query.toLowerCase());
  function reuse(p, d) {
    setModal({
      type: "create",
      initialGoal: "基于「" + d.title + "」继续研究",
      reference: {
        id: uid("material"),
        title: d.title + " · 版本 " + d.revision,
        type: "引用成果",
        body: htmlText(d.html),
        version: d.revision,
        sourceDocument: d.id,
        sourceProject: p.id,
      },
    });
  }
  const filters = (
    <div className="page-toolbar">
      <label className="search page-search">
        <Search size={15} />
        <input
          aria-label="搜索当前页面"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称或正文"
        />
      </label>
      <select
        aria-label="筛选项目"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      >
        <option value="all">全部项目</option>
        {state.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
  if (state.page === "results")
    return (
      <div className="management-scroll">
        <div className="management-content">
          <PageHeader
            title="成果"
            description="把每一次交付留在这里，找到、改好，再用于下一次。"
            eyebrow="跨项目成果"
          />
          {filters}
          <div className="v1-result-filters">
            <label>
              状态{" "}
              <select
                aria-label="筛选成果状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">全部状态</option>
                <option value="pending">待审阅</option>
                <option value="adopted">已采用</option>
                <option value="partial">部分达标</option>
              </select>
            </label>
          </div>
          <div className="v1-results-table">
            <div className="v1-table-head">
              <span>成果名称</span>
              <span>项目 / 成员</span>
              <span>日期 / 版本</span>
              <span>状态</span>
              <span>继续使用</span>
            </div>
            {rows.flatMap((p) =>
              p.docs
                .filter((d) => matches(d.title + " " + htmlText(d.html)))
                .filter(
                  (d) =>
                    status === "all" ||
                    (status === "adopted" &&
                      currentFeedback(d) === "adopted") ||
                    (status === "pending" && !currentFeedback(d)) ||
                    (status === "partial" &&
                      d.reviewChecks?.some((c) => !c.pass)),
                )
                .map((d) => (
                  <div className="v1-result-row" key={d.id}>
                    <button onClick={() => chooseProject(p.id, true, d.id)}>
                      <FileText size={18} />
                      <strong>{d.title}</strong>
                    </button>
                    <span>
                      {p.name}
                      <small>
                        {state.members.find((m) => m.id === d.author)?.name}
                      </small>
                    </span>
                    <span>
                      {d.createdAt || "示例日期"}
                      <small>版本 {d.revision}</small>
                    </span>
                    <span>
                      {d.partial ? (
                        <Badge tone="red">部分交付</Badge>
                      ) : d.reviewChecks?.some((c) => !c.pass) ? (
                        <Badge tone="red">部分达标</Badge>
                      ) : currentFeedback(d) === "adopted" ? (
                        <Badge tone="green">已采用</Badge>
                      ) : (
                        <Badge>待审阅</Badge>
                      )}
                    </span>
                    <button className="text-button" onClick={() => reuse(p, d)}>
                      用于新任务
                      <ArrowRight size={12} />
                    </button>
                  </div>
                )),
            )}
          </div>
          {!rows.some((p) =>
            p.docs.some((d) => matches(d.title + " " + htmlText(d.html))),
          ) && (
            <Empty
              title="没有匹配的成果"
              description="换个关键词，或返回项目继续工作。"
            />
          )}
        </div>
      </div>
    );
  if (state.page === "members")
    return (
      <div className="management-scroll">
        <div className="management-content">
          <PageHeader
            title="成员"
            eyebrow="连接你的原生 Agent"
            description="Grok 与 Dot 优先；各自的能力和订阅继续保留。"
          >
            <button
              className="button primary"
              onClick={() => setModal({ type: "member" })}
            >
              <Plus size={15} />
              添加成员
            </button>
          </PageHeader>
          <div className="members-notice">
            <AlertCircle size={17} />
            <p>
              原型演示：卡片状态与回执均为示例，连接向导不执行真实授权，请勿填写密钥。
            </p>
          </div>
          <div className="members-grid">
            {state.members.map((m) => (
              <article className="member-card" key={m.id}>
                <header>
                  <Avatar member={m} size={42} />
                  <div>
                    <h2>{m.name}</h2>
                    <span>{m.platform}</span>
                  </div>
                  <Badge
                    tone={m.previewConnection === "ready" ? "blue" : "neutral"}
                  >
                    {m.previewConnection === "ready"
                      ? "可接任务 · 示例"
                      : "未连接"}
                  </Badge>
                </header>
                <p>{m.about} · 示例能力，以实际账号授权为准</p>
                <dl>
                  <div>
                    <dt>唤醒方式</dt>
                    <dd>{m.wake}</dd>
                  </div>
                  <div>
                    <dt>最近往返</dt>
                    <dd>
                      {m.previewConnection === "ready"
                        ? "仅有示例记录，无真实回执"
                        : "尚未验证"}
                    </dd>
                  </div>
                </dl>
                <footer>
                  <button
                    className="button small"
                    disabled={!["Grok Bot", "Dots"].includes(m.platform)}
                    onClick={() => setWizard(m)}
                  >
                    {m.id === "muse" ? "第二批接入" : "查看接入步骤"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setModal({ type: "member", memberId: m.id })}
                  >
                    修改备注
                  </button>
                </footer>
              </article>
            ))}
          </div>
          <p className="field-note v1-boundary">
            Hub 只约束经过 Hub 的操作；原平台工具和权限不受本界面控制。
          </p>
        </div>
        {wizard && (
          <ConnectionWizard
            member={wizard}
            onClose={() => setWizard(null)}
            onReady={() => {
              setState((s) => ({
                ...s,
                members: s.members.map((m) =>
                  m.id === wizard.id ? { ...m, previewConnection: "ready" } : m,
                ),
              }));
              notify("演示往返已完成，未连接真实平台");
            }}
          />
        )}
      </div>
    );
  return (
    <div className="management-scroll">
      <div className="management-content">
        <PageHeader
          title="知识库"
          eyebrow="让下一次少交代一次"
          description="规则影响做事方式，资料提供背景；范围和来处都留得住。"
        >
          <button
            className="button primary"
            onClick={() =>
              setModal({
                type: tab === "rules" ? "rule" : "material",
                projectId: filter === "all" ? project.id : filter,
              })
            }
          >
            <Plus size={15} />
            {tab === "rules" ? "添加规则" : "添加资料"}
          </button>
        </PageHeader>
        <div className="segmented">
          <button
            className={tab === "rules" ? "active" : ""}
            onClick={() => setTab("rules")}
          >
            规则
          </button>
          <button
            className={tab === "materials" ? "active" : ""}
            onClick={() => setTab("materials")}
          >
            资料
          </button>
        </div>
        {filters}
        {tab === "materials" ? (
          <div className="v1-materials">
            {rows.flatMap((p) =>
              p.materials
                .filter((m) => matches(m.title + " " + m.body))
                .map((m) => (
                  <button
                    key={m.id}
                    className="material-table-row"
                    onClick={() =>
                      setModal({ type: "material-detail", material: m })
                    }
                  >
                    <span>
                      <BookOpen size={17} />
                      <strong>{m.title}</strong>
                    </span>
                    <span>{p.name}</span>
                    <span>{m.type}</span>
                  </button>
                )),
            )}
          </div>
        ) : (
          <div className="v1-rules-table">
            {rows.flatMap((p) =>
              [...p.rules]
                .sort(
                  (a, b) =>
                    (b.status === "proposed") - (a.status === "proposed"),
                )
                .filter((r) => matches(r.title + " " + r.body))
                .map((r) => (
                  <article
                    className={
                      "v1-rule-row " +
                      (r.status === "proposed" ? "pending" : "")
                    }
                    key={p.id + ":" + r.id}
                  >
                    <div className="v1-rule-summary">
                      <strong>{r.title}</strong>
                      <span>{r.scope || "本项目"}</span>
                      <Badge
                        tone={r.status === "proposed" ? "amber" : "neutral"}
                      >
                        {
                          {
                            active: "生效中",
                            trial: "试行中",
                            proposed: "待确认",
                            revoked: "已撤回",
                            rejected: "未采用",
                            superseded: "保留旧版本",
                          }[r.status]
                        }
                      </Badge>
                      <small>
                        版本 {r.revision} · 已用于 {r.uses || 0} 轮
                      </small>
                    </div>
                    <p>{r.body}</p>
                    <small>来源：{r.evidence || "手动添加"}</small>
                    <div className="v1-rule-actions">
                      {r.status === "proposed" ? (
                        <>
                          <select
                            aria-label={"规则范围 " + r.title}
                            value={r.scope || "本项目"}
                            onChange={(e) =>
                              updateProject(p.id, (x) => ({
                                ...x,
                                rules: x.rules.map((z) =>
                                  z.id === r.id
                                    ? { ...z, scope: e.target.value }
                                    : z,
                                ),
                              }))
                            }
                          >
                            <option>本项目</option>
                            <option>同类项目</option>
                            <option>全部项目</option>
                          </select>
                          <button
                            className="button small primary"
                            onClick={() =>
                              actions.ruleAction(p.id, r.id, "active")
                            }
                          >
                            以后都这样
                          </button>
                          <button
                            className="text-button"
                            onClick={() =>
                              actions.ruleAction(p.id, r.id, "rejected")
                            }
                          >
                            只这次
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="text-button"
                            onClick={() => setReceipt(r)}
                          >
                            查看使用记录
                          </button>
                          {["active", "trial"].includes(r.status) && (
                            <button
                              className="text-button"
                              onClick={() =>
                                actions.ruleAction(p.id, r.id, "revoked")
                              }
                            >
                              撤回
                            </button>
                          )}
                        </>
                      )}
                      <button
                        className="text-button"
                        onClick={() =>
                          setModal({
                            type: "rule",
                            projectId: p.id,
                            ruleId: r.id,
                          })
                        }
                      >
                        {r.status === "proposed" ? "改措辞" : "修订"}
                      </button>
                    </div>
                  </article>
                )),
            )}
          </div>
        )}
      </div>
      {receipt && (
        <Modal title="规则使用记录" onClose={() => setReceipt(null)}>
          <h3>{receipt.title}</h3>
          <Badge tone="blue">{receipt.receipt || "未确认"}</Badge>
          <p>
            {receipt.receiptEvidence ||
              "只有示例规则，没有真实派发或检查记录。"}
          </p>
          <div className="v1-check-list">
            <strong>状态说明（非处理步骤）</strong>
            <p>本轮已带入：仅证明派发时携带指定规则版本。</p>
            <p>结果已符合：有程序检查或注明成员与段落的审阅记录。</p>
            <p>未确认 / 发现偏离：尚未检查，或发现结果偏离。</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function RunScenario({ project, patch, onNext }) {
  function resolve(action) {
    patch((p) => ({
      ...p,
      failure: false,
      failureHandled: true,
      partial: action === "partial",
      status: action === "cancel" ? "cancelled" : "running",
      demoStep: 2,
      messages: [
        ...p.messages,
        {
          id: uid(),
          type: "system",
          time: now(),
          text:
            action === "retry"
              ? "示例：只重试缺失成员，不重做已交付部分。"
              : action === "partial"
                ? "示例：接受已有材料，下一步交付会注明缺口。"
                : "Hub 已停止后续派发；原平台是否停止仍待确认。",
        },
      ],
    }));
  }
  return (
    <div className="v1-scenario">
      <label>
        演示场景
        <select
          aria-label="演示场景"
          value={project.demoScenario || "normal"}
          disabled={project.status === "running" || project.failure}
          onChange={(e) =>
            patch((p) => ({ ...p, demoScenario: e.target.value }))
          }
        >
          <option value="normal">正常交付</option>
          <option value="conflict">来源冲突</option>
          <option value="failure">成员失败</option>
          <option value="unmet">部分达标</option>
        </select>
      </label>
      {["running", "paused"].includes(project.status) && (
        <button
          className="text-button"
          onClick={() =>
            patch((p) => ({
              ...p,
              status: p.status === "paused" ? "running" : "paused",
            }))
          }
        >
          {project.status === "paused" ? "恢复" : "暂停"}
        </button>
      )}
      <button
        className="button small"
        disabled={project.status === "paused" || project.failure}
        onClick={onNext}
      >
        {project.status === "running" ? "演示下一步" : "开始演示"}
      </button>
      {project.failure && (
        <div className="v1-failure" role="alert">
          <strong>收到 1/2：一位已交付，另一位未响应 · 示例</strong>
          <div>
            <button onClick={() => resolve("retry")}>只重试未响应成员</button>
            <button onClick={() => resolve("partial")}>
              用已有结果成稿（标明缺口）
            </button>
            <button onClick={() => resolve("cancel")}>终止本次</button>
          </div>
        </div>
      )}
    </div>
  );
}
