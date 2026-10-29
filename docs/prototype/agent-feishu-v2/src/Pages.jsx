import React, { useState } from "react";
import {
  Plus,
  Search,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  GitBranch,
  UserRound,
  Route,
  ShieldCheck,
  Check,
  Clock3,
  BookOpen,
  FileText,
  Users,
  Pause,
  Play,
  SlidersHorizontal,
  ExternalLink,
  Download,
  Info,
  CircleDot,
  X,
  Inbox,
  Lightbulb,
} from "lucide-react";
import { Avatar, Badge, Empty, PageHeader, Modal } from "./common.jsx";
import {
  modes,
  makeProject,
  planSteps,
  pendingCount,
  downloadText,
  now,
  uid,
} from "./model.mjs";
const ruleNames = {
  active: "已生效",
  trial: "试行中",
  proposed: "待批准",
  revoked: "已撤回",
  rejected: "未采用",
  superseded: "保留旧版本",
};
const modeIcons = {
  parallel: GitBranch,
  solo: UserRound,
  relay: Route,
  review: ShieldCheck,
};
export function ProjectForm({ project, members, onSave, onCancel }) {
  const [form, setForm] = useState(() =>
    project
      ? {
          name: project.name,
          goal: project.goal,
          mode: project.mode,
          members: [...project.members],
          lead: project.lead,
          criteria: project.criteria,
          allowEmpty: project.allowEmpty,
          assignments: { ...project.assignments },
          permissions: { ...project.permissions },
          schedule: { ...project.schedule },
        }
      : {
          name: "",
          goal: "",
          mode: "parallel",
          members: members
            .filter((m) => !m.paused)
            .slice(0, 3)
            .map((m) => m.id),
          lead: members.find((m) => m.id === "dots")?.id || members[0]?.id,
          criteria:
            "保留原始依据、明确取舍和未确认项；交付可以继续使用的成果。",
          allowEmpty: true,
          assignments: {},
          permissions: {},
          schedule: {
            enabled: false,
            times: ["06:00", "12:00", "19:00"],
            timezone: "Asia/Shanghai",
          },
        },
  );
  const [when, setWhen] = useState("next"),
    [error, setError] = useState(""),
    [templates, setTemplates] = useState(false),
    [times, setTimes] = useState(form.schedule.times.join("、"));
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  function submit(e) {
    e.preventDefault();
    setError("");
    if (!form.name.trim() || !form.goal.trim() || !form.criteria.trim()) {
      setError("请填写项目名称、目标和交付标准，不能只输入空格");
      return;
    }
    const selected = form.members.filter((id) =>
      members.some((m) => m.id === id && !m.paused),
    );
    if (selected.length < (form.mode === "solo" ? 1 : 2)) {
      setError(
        form.mode === "solo"
          ? "请选择一位可参与成员"
          : "此工作方式至少需要两位可参与成员",
      );
      return;
    }
    const clock = times.split(/[,，、\s]+/).filter(Boolean);
    if (
      form.schedule.enabled &&
      (!clock.length || clock.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    ) {
      setError("时间请填写为 06:00、12:00、19:00");
      return;
    }
    onSave(
      {
        ...form,
        name: form.name.trim(),
        goal: form.goal.trim(),
        members: selected,
        lead: selected.includes(form.lead) ? form.lead : selected[0],
        schedule: { ...form.schedule, times: [...new Set(clock)].sort() },
      },
      when,
    );
  }
  return (
    <form className="project-form" onSubmit={submit}>
      <div className="form-row">
        <label className="field grow">
          项目名称
          <input
            required
            maxLength={60}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="例如：每周产品观察"
          />
        </label>
        {!project && (
          <button
            type="button"
            className="button template-toggle"
            onClick={() => setTemplates((v) => !v)}
          >
            <BookOpen size={15} />
            从模板开始
            <ChevronDown size={13} />
          </button>
        )}
      </div>
      {templates && (
        <div className="template-options">
          {[
            [
              "AI 用例研究",
              "找到值得动手试的 AI 用例，保留实践步骤与原始出处。",
              "parallel",
            ],
            [
              "产品方案比较",
              "比较两个产品方向，给出选择依据、反例和验证办法。",
              "review",
            ],
            [
              "整理个人材料",
              "整理已有材料，形成清晰、可以继续使用的文档。",
              "solo",
            ],
          ].map(([name, goal, mode]) => (
            <button
              type="button"
              key={name}
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  name,
                  goal,
                  mode,
                  members:
                    mode === "solo" ? [f.lead || members[0].id] : f.members,
                }));
                setTemplates(false);
              }}
            >
              {name}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      )}
      <label className="field">
        希望团队帮你达成什么？
        <textarea
          required
          maxLength={4000}
          rows={3}
          value={form.goal}
          onChange={(e) => set("goal", e.target.value)}
          placeholder="描述目的、使用场景，以及你希望得到的结果。"
        />
      </label>
      <fieldset>
        <legend>选择工作方式</legend>
        <div className="mode-options">
          {modes.map((m) => {
            const Icon = modeIcons[m.id];
            return (
              <button
                type="button"
                aria-pressed={form.mode === m.id}
                className={`mode-option ${form.mode === m.id ? "selected" : ""}`}
                key={m.id}
                onClick={() => {
                  set("mode", m.id);
                  if (m.id === "solo")
                    set("members", [
                      form.members.includes(form.lead)
                        ? form.lead
                        : form.members[0] || members[0]?.id,
                    ]);
                }}
              >
                <Icon size={19} />
                <span>
                  <strong>{m.label}</strong>
                  <small>{m.description}</small>
                </span>
                <span className="radio-dot" />
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          参与成员 <small>职责只属于这个项目</small>
        </legend>
        <div className="member-picker">
          {members.map((m) => (
            <label
              key={m.id}
              className={`member-choice ${form.members.includes(m.id) ? "selected" : ""}`}
            >
              <input
                type="checkbox"
                checked={form.members.includes(m.id)}
                disabled={m.paused}
                onChange={(e) =>
                  set(
                    "members",
                    e.target.checked
                      ? form.mode === "solo"
                        ? [m.id]
                        : [...form.members, m.id]
                      : form.members.filter((id) => id !== m.id),
                  )
                }
              />
              <Avatar member={m} size={26} />
              <span>{m.name}</span>
              {m.paused && <small>已暂停</small>}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-row">
        <label className="field grow">
          {form.mode === "solo" ? "交付责任人" : "牵头与整合"}
          <select
            value={
              form.members.includes(form.lead)
                ? form.lead
                : form.members[0] || ""
            }
            onChange={(e) => set("lead", e.target.value)}
          >
            {form.members
              .map((id) => members.find((m) => m.id === id))
              .filter(Boolean)
              .map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <div className="form-info">
          <Info size={16} />
          <span>选择依据是任务需要。成员不按品牌固定成岗位。</span>
        </div>
      </div>
      <label className="field">
        怎样算交付到位？
        <textarea
          required
          maxLength={4000}
          rows={2}
          value={form.criteria}
          onChange={(e) => set("criteria", e.target.value)}
        />
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={form.allowEmpty}
          onChange={(e) => set("allowEmpty", e.target.checked)}
        />
        <span>
          允许“没有符合条件的结果”
          <small>仍需提供实际搜集范围和证据，不能用访问失败代替空结果。</small>
        </span>
      </label>
      <details className="schedule-form">
        <summary>
          <Users size={16} />
          项目内分工与授权
          <ChevronDown size={14} />
        </summary>
        <p className="field-note">
          默认只读取材料、准备成果。职责和资料更新权限仅属于本项目，不改变成员的账号身份。
        </p>
        {form.members
          .map((id) => members.find((m) => m.id === id))
          .filter(Boolean)
          .map((member) => (
            <div className="assignment-row" key={member.id}>
              <div className="assignment-member">
                <Avatar member={member} size={26} />
                <strong>{member.name}</strong>
              </div>
              <label className="field">
                本轮负责什么
                <input
                  aria-label={`${member.name}的项目分工`}
                  value={form.assignments[member.id] || ""}
                  placeholder={
                    planSteps({ ...form, assignments: {} }, members).find(
                      (s) => s.member?.id === member.id,
                    )?.title || "负责完整交付"
                  }
                  onChange={(e) =>
                    set("assignments", {
                      ...form.assignments,
                      [member.id]: e.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                允许的操作
                <select
                  aria-label={`${member.name}的项目授权`}
                  value={form.permissions[member.id] || "prepare"}
                  onChange={(e) =>
                    set("permissions", {
                      ...form.permissions,
                      [member.id]: e.target.value,
                    })
                  }
                >
                  <option value="prepare">读取材料、准备成果</option>
                  <option value="project">准备成果、更新本项目资料</option>
                </select>
              </label>
            </div>
          ))}
        <p className="field-note">
          对外发布、扩大权限和批准规则需另行确认。这份预览只保留约定，不授予真实平台操作权限。
        </p>
      </details>
      <details className="schedule-form">
        <summary>
          <Clock3 size={16} />
          日程与工作节奏{" "}
          <Badge>{form.schedule.enabled ? "定时安排" : "按需开始"}</Badge>
          <ChevronDown size={14} />
        </summary>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.schedule.enabled}
            onChange={(e) =>
              set("schedule", { ...form.schedule, enabled: e.target.checked })
            }
          />
          <span>
            保存定时安排<small>预览仅保存配置，不会触发后台任务。</small>
          </span>
        </label>
        {form.schedule.enabled && (
          <div className="form-row">
            <label className="field grow">
              时间点
              <input
                value={times}
                onChange={(e) => setTimes(e.target.value)}
                placeholder="06:00、12:00、19:00"
              />
            </label>
            <label className="field">
              时区
              <select
                value={form.schedule.timezone}
                onChange={(e) =>
                  set("schedule", {
                    ...form.schedule,
                    timezone: e.target.value,
                  })
                }
              >
                <option value="Asia/Shanghai">北京时间</option>
                <option value="UTC">UTC</option>
                <option value="America/New_York">纽约时间</option>
              </select>
            </label>
          </div>
        )}
        <p className="field-note">
          上一轮未结束时保留最新待运行请求，不重复启动。
        </p>
      </details>
      {project?.status === "running" && (
        <label className="field">
          什么时候使用新安排？
          <select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="next">下一轮（保留本轮安排）</option>
            <option value="current">调整当前示例轮次（保留已有成果）</option>
          </select>
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span className="muted">手动确认安排 · 未调用 AI 拟稿</span>
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" type="submit">
          {project ? "保存工作安排" : "创建项目"}
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}
export function ManagementPage({ state, project, actions }) {
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState("rules"),
    [done, setDone] = useState(false),
    [review, setReview] = useState(null),
    [reviewText, setReviewText] = useState(""),
    [reviewResult, setReviewResult] = useState("insufficient");
  const {
    setModal,
    notify,
    decide,
    ruleAction,
    chooseProject,
    setState,
    updateProject,
  } = actions;
  const matches = (p) => filter === "all" || p.id === filter;
  const projects = state.projects.filter(matches);
  const search = (txt) =>
    String(txt).toLowerCase().includes(query.toLowerCase());
  const selector = (
    <select
      aria-label="筛选项目"
      className="filter-select"
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
  );
  const searchBox = (
    <label className="search page-search">
      <Search size={16} />
      <input
        aria-label="搜索当前页面"
        placeholder="搜索名称或内容"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </label>
  );
  return (
    <div className="management-scroll">
      <div className="management-content">
        {state.page === "decisions" ? (
          <>
            <PageHeader
              eyebrow="留给你的重要判断"
              title="待我决定"
              description="把问题、影响和依据放在一起，一次说清楚。"
            >
              <Badge tone="blue">
                {state.projects.reduce((n, p) => n + pendingCount(p), 0)}{" "}
                项待处理
              </Badge>
            </PageHeader>
            <div className="page-toolbar">
              <div className="segmented">
                <button
                  className={!done ? "active" : ""}
                  onClick={() => setDone(false)}
                >
                  待处理
                </button>
                <button
                  className={done ? "active" : ""}
                  onClick={() => setDone(true)}
                >
                  已处理
                </button>
              </div>
              {selector}
            </div>
            <div className="decision-list">
              {projects.flatMap((p) =>
                p.decisions
                  .filter((d) =>
                    done ? d.status !== "pending" : d.status === "pending",
                  )
                  .map((d) => (
                    <article className="decision-card" key={d.id}>
                      <div className="card-meta">
                        <span>
                          <FolderLabel name={p.name} />
                        </span>
                        <Badge
                          tone={d.status === "pending" ? "amber" : "neutral"}
                        >
                          {d.status === "pending"
                            ? "需要取舍"
                            : d.status === "waiting"
                              ? "待补充证据"
                              : "已决定"}
                        </Badge>
                      </div>
                      <h2>{d.title}</h2>
                      <p>{d.description}</p>
                      <div className="decision-evidence">
                        <BookOpen size={17} />
                        <div>
                          <strong>目前掌握的依据</strong>
                          <p>{d.evidence}</p>
                        </div>
                      </div>
                      {d.status === "pending" ? (
                        <div className="decision-choices">
                          {d.options.map((choice, i) => (
                            <button
                              key={choice}
                              className={`button ${i === 0 ? "primary" : ""}`}
                              onClick={() => decide(p.id, d.id, choice)}
                            >
                              {choice}
                              {i === 0 && <Check size={15} />}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="resolved-note">
                          <Check size={16} />
                          {d.choice}
                          {d.status === "waiting" ? " · 等待实际补查" : ""}
                          <button
                            className="text-button"
                            onClick={() => chooseProject(p.id)}
                          >
                            查看项目
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      )}
                    </article>
                  )),
              )}
              {!done &&
                projects.flatMap((p) =>
                  p.rules
                    .filter((r) => r.status === "proposed")
                    .map((r) => (
                      <article className="decision-card" key={r.id}>
                        <div className="card-meta">
                          <FolderLabel name={p.name} />
                          <Badge tone="purple">改进提案</Badge>
                        </div>
                        <h2>{r.title}</h2>
                        <p>{r.body}</p>
                        <div className="decision-evidence">
                          <Lightbulb size={17} />
                          <div>
                            <strong>为什么提出这条规则</strong>
                            <p>{r.evidence}</p>
                          </div>
                        </div>
                        <div className="rule-trial-note">
                          <Clock3 size={15} />
                          只在本项目的下一轮试行，验证前不自动保留。
                        </div>
                        <div className="decision-choices">
                          <button
                            className="button primary"
                            onClick={() => ruleAction(p.id, r.id, "trial")}
                          >
                            批准试行
                            <Check size={15} />
                          </button>
                          <button
                            className="button"
                            onClick={() =>
                              setModal({
                                type: "rule",
                                projectId: p.id,
                                ruleId: r.id,
                              })
                            }
                          >
                            修改提案
                          </button>
                          <button
                            className="button quiet"
                            onClick={() => ruleAction(p.id, r.id, "rejected")}
                          >
                            不采用
                          </button>
                        </div>
                      </article>
                    )),
                )}
              {projects.every(
                (p) =>
                  !p.decisions.some((d) =>
                    done ? d.status !== "pending" : d.status === "pending",
                  ) &&
                  (done || !p.rules.some((r) => r.status === "proposed")),
              ) && (
                <Empty
                  icon={CheckCheckIcon}
                  title={done ? "还没有处理记录" : "暂时没有需要你决定的事"}
                  description={
                    done
                      ? "你的选择会保留在对应项目里。"
                      : "普通交接继续推进，重要取舍才会出现在这里。"
                  }
                />
              )}
            </div>
          </>
        ) : state.page === "knowledge" ? (
          <>
            <PageHeader
              eyebrow="让下一次工作少走弯路"
              title="知识库"
              description="资料提供背景，规则影响工作方式；每条经验都保留来处。"
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
                <Plus size={16} />
                {tab === "rules" ? "新增规则" : "添加资料"}
              </button>
            </PageHeader>
            <div className="page-toolbar">
              <div className="segmented">
                <button
                  className={tab === "rules" ? "active" : ""}
                  onClick={() => setTab("rules")}
                >
                  规则与改进
                </button>
                <button
                  className={tab === "materials" ? "active" : ""}
                  onClick={() => setTab("materials")}
                >
                  项目资料
                </button>
              </div>
              <div className="toolbar-right">
                {searchBox}
                {selector}
              </div>
            </div>
            {tab === "rules" ? (
              <div className="knowledge-list">
                {projects.flatMap((p) =>
                  p.rules
                    .filter((r) => search(r.title + " " + r.body))
                    .map((r) => (
                      <article className="rule-card" key={r.id}>
                        <div className="rule-leading">
                          <span
                            className={`rule-symbol ${r.status === "proposed" ? "proposed" : ""}`}
                          >
                            <ShieldCheck size={20} />
                          </span>
                        </div>
                        <div className="rule-main">
                          <div className="card-meta">
                            <FolderLabel name={p.name} />
                            <span>v{r.revision}</span>
                            <Badge
                              tone={
                                {
                                  active: "green",
                                  trial: "blue",
                                  proposed: "amber",
                                }[r.status] || "neutral"
                              }
                            >
                              {ruleNames[r.status]}
                            </Badge>
                          </div>
                          <h3>{r.title}</h3>
                          <p>{r.body}</p>
                          <div className="rule-source">
                            <BookOpen size={14} />
                            {r.evidence}
                          </div>
                          {r.evaluation && (
                            <p className="evaluation-note">
                              复查记录：{r.evaluation}
                            </p>
                          )}
                          <div className="rule-actions">
                            {r.status === "proposed" && (
                              <button
                                className="button small primary"
                                onClick={() => ruleAction(p.id, r.id, "trial")}
                              >
                                批准试行
                              </button>
                            )}
                            {r.status === "trial" && (
                              <button
                                className="button small"
                                onClick={() => {
                                  setReview({ projectId: p.id, ruleId: r.id });
                                  setReviewText("");
                                  setReviewResult("insufficient");
                                }}
                              >
                                记录复查
                              </button>
                            )}
                            {["active", "trial"].includes(r.status) && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  ruleAction(p.id, r.id, "revoked")
                                }
                              >
                                撤回
                              </button>
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
                              {["active", "trial"].includes(r.status)
                                ? "提出修订"
                                : "查看与修改"}
                            </button>
                          </div>
                        </div>
                      </article>
                    )),
                )}
                {projects.every(
                  (p) => !p.rules.some((r) => search(r.title + " " + r.body)),
                ) && (
                  <Empty
                    title="没有匹配的规则"
                    description="从具体的反馈开始，不必为了积累而添加规则。"
                  />
                )}
              </div>
            ) : (
              <div className="materials-table">
                <div className="table-head">
                  <span>资料名称</span>
                  <span>所属项目</span>
                  <span>类型</span>
                </div>
                {projects.flatMap((p) =>
                  p.materials
                    .filter((m) => search(m.title + " " + m.body))
                    .map((m) => (
                      <button
                        className="material-table-row"
                        key={m.id}
                        onClick={() =>
                          setModal({ type: "material-detail", material: m })
                        }
                      >
                        <span>
                          <BookOpen size={17} />
                          <strong>{m.title}</strong>
                        </span>
                        <span>{p.name}</span>
                        <span>
                          {m.type}
                          <ChevronRight size={14} />
                        </span>
                      </button>
                    )),
                )}
                {projects.every(
                  (p) =>
                    !p.materials.some((m) => search(m.title + " " + m.body)),
                ) && (
                  <Empty
                    title="还没有匹配的资料"
                    description="把共同背景留在项目里，成员不必反复向你索要。"
                  />
                )}
              </div>
            )}
          </>
        ) : state.page === "members" ? (
          <>
            <PageHeader
              eyebrow="你的原生 Agent 团队"
              title="成员"
              description="保留各自的能力与身份；具体分工在项目里决定。"
            >
              <button
                className="button primary"
                onClick={() => setModal({ type: "member" })}
              >
                <Plus size={16} />
                添加成员
              </button>
            </PageHeader>
            <div className="members-notice">
              <Info size={17} />
              <p>
                这里是示例成员。接入状态没有与真实平台同步，添加或改名不会登录账号。
              </p>
            </div>
            <div className="page-toolbar">
              <span className="muted">
                {state.members.length} 位成员 · 可添加多个同平台成员
              </span>
              {searchBox}
            </div>
            {!state.members.some((m) => search(m.name + " " + m.platform)) && (
              <Empty
                title="没有匹配的成员"
                description="换个名称或平台搜索；也可以添加新的成员。"
              />
            )}
            <div className="members-grid">
              {state.members
                .filter((m) => search(m.name + " " + m.platform))
                .map((m) => (
                  <article className="member-card" key={m.id}>
                    <header>
                      <Avatar member={m} size={42} />
                      <div>
                        <h2>{m.name}</h2>
                        <span>{m.platform}</span>
                      </div>
                      <Badge>{m.paused ? "已暂停" : "示例成员"}</Badge>
                    </header>
                    <p>{m.about}</p>
                    <dl>
                      <div>
                        <dt>参与项目</dt>
                        <dd>
                          {
                            state.projects.filter((p) =>
                              p.members.includes(m.id),
                            ).length
                          }{" "}
                          个
                        </dd>
                      </div>
                      <div>
                        <dt>唤醒方式</dt>
                        <dd>{m.wake}</dd>
                      </div>
                      <div>
                        <dt>归属</dt>
                        <dd>{m.owner}</dd>
                      </div>
                    </dl>
                    <footer>
                      <button
                        className="button small"
                        onClick={() =>
                          setModal({ type: "member", memberId: m.id })
                        }
                      >
                        编辑备注
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          setState((s) => ({
                            ...s,
                            members: s.members.map((x) =>
                              x.id === m.id ? { ...x, paused: !x.paused } : x,
                            ),
                          }))
                        }
                      >
                        {m.paused ? <Play size={14} /> : <Pause size={14} />}{" "}
                        {m.paused ? "恢复参与" : "暂停参与"}
                      </button>
                    </footer>
                  </article>
                ))}
            </div>
          </>
        ) : (
          <>
            <PageHeader
              eyebrow="工作空间偏好"
              title="设置"
              description="安排自己的工作节奏，保留资料，也清楚运行在哪里。"
            />
            <section className="settings-section">
              <h2>日程与通知</h2>
              <div className="setting-row">
                <div>
                  <strong>完成与待决定提醒</strong>
                  <p>在此预览保存偏好；不申请系统通知权限。</p>
                </div>
                <button
                  className={`switch ${state.preferences.notifications ? "on" : ""}`}
                  role="switch"
                  aria-checked={state.preferences.notifications}
                  aria-label="完成与待决定提醒"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      preferences: {
                        ...s.preferences,
                        notifications: !s.preferences.notifications,
                      },
                    }))
                  }
                >
                  <span />
                </button>
              </div>
              {state.projects.map((p) => (
                <div className="setting-row" key={p.id}>
                  <div>
                    <strong>{p.name}</strong>
                    <p>
                      {p.schedule.enabled
                        ? `${p.schedule.times.join(" / ")} · ${p.schedule.timezone}（仅保存配置）`
                        : "按需开始 · 未开启日程"}
                    </p>
                  </div>
                  <button
                    className="button small"
                    onClick={() => {
                      chooseProject(p.id);
                      setModal({ type: "plan" });
                    }}
                  >
                    调整安排
                  </button>
                </div>
              ))}
            </section>
            <section className="settings-section">
              <h2>数据与运行</h2>
              <div className="setting-row">
                <div>
                  <strong>预览工作区备份</strong>
                  <p>
                    导出本页的项目、工作稿、要求与规则。不会读取正式账号资料。
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() => {
                    downloadText(
                      "agent-hub-2-preview.json",
                      JSON.stringify(state, null, 2),
                      "application/json",
                    );
                    notify("已导出预览工作区");
                  }}
                >
                  <Download size={16} />
                  导出工作区
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>当前运行环境</strong>
                  <p>浏览器本地预览 · 无外部 Agent 调用 · 未开启云端日程</p>
                </div>
                <Badge>2.0 UI</Badge>
              </div>
              <div className="setting-row">
                <div>
                  <strong>产品方案与评审</strong>
                  <p>功能、视觉和原生平台执行分别验收。</p>
                </div>
                <a
                  className="button"
                  href="https://github.com/duolaAmengweb3/agent-hub/issues/9"
                  target="_blank"
                  rel="noreferrer"
                >
                  查看评审
                  <ExternalLink size={14} />
                </a>
              </div>
            </section>
          </>
        )}
      </div>
      {review && (
        <Modal
          title="记录规则复查"
          description="写清实际观察到的变化。仅有执行记录，不等于规则有效。"
          onClose={() => setReview(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!reviewText.trim()) return;
              updateProject(review.projectId, (p) => {
                const previous = p.rules.find((r) => r.id === review.ruleId);
                return {
                  ...p,
                  rules: p.rules.map((r) =>
                    r.id === review.ruleId
                      ? {
                          ...r,
                          evaluation: reviewText,
                          status:
                            reviewResult === "keep"
                              ? "active"
                              : reviewResult === "revoke"
                                ? "revoked"
                                : "trial",
                          reviewedAt: now(),
                        }
                      : reviewResult === "revoke" &&
                          r.id === previous?.baseRuleId &&
                          r.supersededBy === review.ruleId
                        ? {
                            ...r,
                            status: r.priorStatus || "active",
                            supersededBy: null,
                          }
                        : r,
                  ),
                  messages: [
                    ...p.messages,
                    {
                      id: uid(),
                      type: "system",
                      time: now(),
                      text: `规则「${previous?.title}」复查已记录：${{ keep: "保留规则", revoke: "撤回并恢复原规则", insufficient: "证据不足，继续试行" }[reviewResult]}。`,
                    },
                  ],
                };
              });
              setReview(null);
              notify("复查记录已保留");
            }}
          >
            <label className="field">
              观察与依据
              <textarea
                required
                rows={4}
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
              />
            </label>
            <label className="field">
              你的结论
              <select
                aria-label="你的结论"
                value={reviewResult}
                onChange={(e) => setReviewResult(e.target.value)}
              >
                <option value="insufficient">证据不足，保留试行状态</option>
                <option value="keep">确认有用，保留规则</option>
                <option value="revoke">没有帮助或有副作用，撤回</option>
              </select>
            </label>
            <div className="form-actions">
              <button
                className="button"
                type="button"
                onClick={() => setReview(null)}
              >
                取消
              </button>
              <button className="button primary">保存复查</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function FolderLabel({ name }) {
  return (
    <span className="folder-label">
      <GitBranch size={13} />
      {name}
    </span>
  );
}
function CheckCheckIcon(props) {
  return <Check {...props} />;
}
export function RuleForm({ rule, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    title: rule?.title || "",
    body: rule?.body || "",
    evidence: rule?.evidence || "",
    type: rule?.type || "evidence",
    checks: rule?.checks || "sources",
  }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      {rule && ["active", "trial"].includes(rule.status) && (
        <p className="inline-note">
          保存为待批准的修订，不应直接修改正在使用的规则。原版本会保留。
        </p>
      )}
      <label className="field">
        规则名称
        <input
          required
          maxLength={120}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </label>
      <label className="field">
        具体怎么做
        <textarea
          required
          rows={4}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          placeholder="写清适用情况和实际动作，不用口号代替规则。"
        />
      </label>
      <label className="field">
        来自什么反馈或问题？
        <textarea
          required
          rows={2}
          value={form.evidence}
          onChange={(e) => setForm({ ...form, evidence: e.target.value })}
        />
      </label>
      <div className="form-row">
        <label className="field grow">
          规则类型
          <select
            aria-label="规则类型"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            <option value="evidence">证据与来源</option>
            <option value="freshness">时效性</option>
            <option value="style">表达偏好</option>
            <option value="handoff">交接与版本</option>
          </select>
        </label>
        <label className="field grow">
          执行方式
          <select
            aria-label="执行方式"
            value={form.checks}
            onChange={(e) => setForm({ ...form, checks: e.target.value })}
          >
            <option value="sources">必需来源字段检查</option>
            <option value="dates">事件时间字段检查</option>
            <option value="versions">版本一致性检查</option>
            <option value="guidance">作为工作指引</option>
          </select>
        </label>
      </div>
      <p className="field-note">
        限定在当前项目。文字不会变成可执行代码，也不能扩大成员权限。
      </p>
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button className="button primary">保存待批准提案</button>
      </div>
    </form>
  );
}
export function MemberForm({ member, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: member?.name || "",
    platform: member?.platform || "Grok Bot",
    about: member?.about || "",
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <label className="field">
        备注名称
        <input
          required
          maxLength={60}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="例如：我的研究助手"
        />
      </label>
      <label className="field">
        平台
        <select
          aria-label="平台"
          disabled={!!member}
          value={form.platform}
          onChange={(e) => setForm({ ...form, platform: e.target.value })}
        >
          {[
            "Grok Bot",
            "Muse",
            "Dots",
            "Perplexity Computer",
            "自定义平台",
          ].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="field">
        能力备注（选填）
        <textarea
          value={form.about}
          rows={3}
          onChange={(e) => setForm({ ...form, about: e.target.value })}
          placeholder="记下你了解的能力，具体职责在项目里安排。"
        />
      </label>
      <div className="inline-note">
        预览不会打开登录窗口或访问任何账号；同平台可以添加多个成员。
      </div>
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button className="button primary">
          {member ? "保存备注" : "添加示例成员"}
        </button>
      </div>
    </form>
  );
}
export function MaterialForm({ onSave, onCancel }) {
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (url && !/^https?:\/\//i.test(url)) {
          setError("只接受 http 或 https 链接");
          return;
        }
        onSave({ title, body, url, type: url ? "参考链接" : "用户资料" });
      }}
    >
      <label className="field">
        资料名称
        <input
          required
          maxLength={160}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        内容或说明
        <textarea
          required
          rows={7}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="field">
        原始链接（选填）
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
      </label>
      <label className="file-import">
        也可以导入文本文件
        <input
          aria-label="导入文本资料"
          type="file"
          accept=".txt,.md,.csv,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 256 * 1024) {
              setError("预览支持 256 KB 以内的文本资料");
              return;
            }
            try {
              const text = await f.text();
              setTitle(f.name);
              setBody(text);
              setError("");
            } catch {
              setError("读取失败，请重新选择");
            }
          }}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button className="button primary">保存项目资料</button>
      </div>
    </form>
  );
}
export function RunDetails({ project, members, onDemo, onClose }) {
  return (
    <div className="run-details">
      <div className="run-summary">
        <Badge tone="blue">
          {modes.find((m) => m.id === project.mode)?.label}
        </Badge>
        <span>安排版本 {project.planVersion}</span>
        <span>仅为示例记录</span>
      </div>
      <h3>{project.goal}</h3>
      <div className="run-steps">
        {planSteps(project, members).map((s, i) => (
          <div key={i}>
            <span className="step-index">{s.phase}</span>
            <Avatar member={s.member} />
            <span>
              <strong>{s.member?.name}</strong>
              <p>{s.title}</p>
              <small>{s.permission}</small>
            </span>
            <Badge>
              {project.status === "review"
                ? "示例已交付"
                : project.status === "running"
                  ? "示例推进中"
                  : "待开始"}
            </Badge>
          </div>
        ))}
      </div>
      <div className="run-log">
        {project.messages.map((m) => (
          <div key={m.id}>
            <time>{m.time}</time>
            <span>{m.text}</span>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <span className="muted">预览不产生实际调用费用。</span>
        <button className="button" onClick={onClose}>
          关闭
        </button>
        <button
          className="button primary"
          onClick={onDemo}
          disabled={project.status === "paused"}
        >
          {project.status === "running" ? "演示下一步" : "重新演示"}
          <Play size={14} />
        </button>
      </div>
    </div>
  );
}
