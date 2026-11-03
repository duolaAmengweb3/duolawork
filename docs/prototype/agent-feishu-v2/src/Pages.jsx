import React, { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Layers,
  Link2,
  Search,
  Users,
} from "lucide-react";
import { Avatar, SectionTitle } from "./common.jsx";
import { agents, topics } from "./model.mjs";

export function Recipes({ setup }) {
  return (
    <main className="full-page">
      <SectionTitle
        eyebrow="RECIPES"
        title="从一件想做成的事开始"
        description="配方把目标、成员和步骤安排好。你的 Agent 在项目群里接力完成。"
      />
      <div className="recipe-feature">
        <div className="recipe-main">
          <span className="tag blue">首个配方 · 内容创作</span>
          <h2>每日 X 内容包</h2>
          <p>从值得看的讨论，到你愿意发出去的内容。</p>
          <div className="recipe-output">
            <strong>5</strong> 个选题 <i />
            <strong>3</strong> 条成稿 <i />
            每条附来源
          </div>
          <button className="button primary" onClick={setup}>
            使用配方
            <ArrowRight size={16} />
          </button>
          <small>先试跑一次，再决定是否每天自动运行。</small>
        </div>
        <div className="recipe-flow">
          <h3>项目群将如何协作</h3>
          {[
            ["Grok", "发现热点"],
            ["Perplexity", "核对原始资料"],
            ["Dot", "整理成稿"],
          ].map(([name, job], i) => (
            <div className="recipe-step" key={name}>
              <span className="step-index">{i + 1}</span>
              <Avatar name={name} />
              <div>
                <strong>{job}</strong>
                <small>{agents[name].label}</small>
              </div>
              <span className="tag">可替换</span>
            </div>
          ))}
          <p>
            <Users size={14} />
            按实际能力分工，不需要买齐所有订阅。
          </p>
        </div>
      </div>
      <div className="section-line">
        <h3>第一次，你会得到什么</h3>
        <span className="muted">成品结构示例</span>
      </div>
      <div className="preview-drafts">
        {topics.slice(0, 3).map(([title, category, desc], i) => (
          <article key={title}>
            <span className="preview-number">0{i + 1}</span>
            <span className="eyebrow">{category}</span>
            <h3>{title}</h3>
            <p>{desc}</p>
            <span className="preview-source">
              <Link2 size={13} />
              原始出处随稿交付
            </span>
          </article>
        ))}
      </div>
      <div className="recipe-footer">
        <BookOpen size={16} />
        <span>从你的修改里积累项目规则，经你批准后再用于下一次。</span>
        <span>默认不发布</span>
      </div>
    </main>
  );
}

export function KnowledgePage({ projects, openProject }) {
  return (
    <main className="full-page">
      <SectionTitle
        eyebrow="KNOWLEDGE"
        title="让经验留下来"
        description="项目资料、共同成果和工作规则放在一起。批准后的规则才会影响之后的任务。"
      />
      <div className="knowledge-table">
        <div className="table-head">
          <span>项目</span>
          <span>已生效规则</span>
          <span>成果归档</span>
          <span />
        </div>
        {projects.map((p) => (
          <button
            className="table-row"
            key={p.id}
            onClick={() => openProject(p.id, "项目知识")}
          >
            <span>
              <BookOpen size={19} />
              <strong>{p.name}</strong>
            </span>
            <span>{p.rules.length + (p.approved ? 1 : 0)} 条</span>
            <span>{p.docs.length} 份</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      <div className="quiet-explainer">
        <Layers size={22} />
        <h3>资料不自动变成指令</h3>
        <p>
          保存一份交付用于回看；批准一条规则用于指导下一次工作。项目之间保持独立。
        </p>
      </div>
    </main>
  );
}

export function MembersPage({ showModal }) {
  return (
    <main className="full-page">
      <SectionTitle
        eyebrow="MEMBERS"
        title="你的 Agent 成员"
        description="每个成员保留原来的工具和能力。在不同项目里，安排不同的工作。"
      />
      <div className="members-table">
        <div className="table-head">
          <span>成员</span>
          <span>擅长什么</span>
          <span>示例连接</span>
          <span />
        </div>
        {Object.entries(agents).map(([name, a]) => (
          <div className="table-row" key={name}>
            <span>
              <Avatar name={name} size={38} />
              <strong>{a.label}</strong>
            </span>
            <span>{a.detail}</span>
            <span className={a.connected ? "subtle-success" : "muted"}>
              {a.connected ? "示例就绪" : "待连接"}
            </span>
            <button
              className="text-button"
              onClick={() =>
                showModal({
                  type: "connection",
                  title: a.label + " · 连接演示",
                  agent: name,
                })
              }
            >
              查看
              <ChevronRight size={14} />
            </button>
          </div>
        ))}
      </div>
      <p className="subtle-note">
        这里展示首版计划接入的平台。全部是原型数据，不代表你的真实账号已接通。
      </p>
    </main>
  );
}

export function SetupForm({ project, editing, onSubmit, showToast }) {
  const [name, setName] = useState(editing ? project.name : "每日 X 内容包");
  const [topic, setTopic] = useState(
    project?.topic || "AI Agent 的实操案例与产品观察",
  );
  const [checker, setChecker] = useState(project?.checker || "Perplexity");
  const [writer, setWriter] = useState(project?.writer || "Dot");
  const [connected, setConnected] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (writer === "Muse" && !connected) {
          showToast("请完成 Muse 示例连接，或选择现有成员");
          return;
        }
        onSubmit({ name: name.trim(), topic: topic.trim(), checker, writer });
      }}
    >
      <p className="dialog-intro">
        选择成员，配方会安排交接。所有连接与执行均为本地演示。
      </p>
      <label className="field">
        项目群名称
        <input
          required
          maxLength={36}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        你想关注什么
        <textarea
          required
          rows={2}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </label>
      <div className="assignment-row">
        <Avatar name="Grok" />
        <div>
          <strong>热点发现</strong>
          <small>原始讨论与案例</small>
        </div>
        <span>Grok Bot</span>
      </div>
      <div className="assignment-row">
        <Avatar name={checker} />
        <div>
          <strong>资料查证</strong>
          <small>核对来源与疑点</small>
        </div>
        <select
          aria-label="查证成员"
          value={checker}
          onChange={(e) => setChecker(e.target.value)}
        >
          <option>Perplexity</option>
          <option>Dot</option>
        </select>
      </div>
      <div className="assignment-row">
        <Avatar name={writer} />
        <div>
          <strong>写作与编辑</strong>
          <small>3 条成稿，保留出处</small>
        </div>
        <select
          aria-label="写作成员"
          value={writer}
          onChange={(e) => setWriter(e.target.value)}
        >
          <option>Dot</option>
          <option>Muse</option>
        </select>
      </div>
      {writer === "Muse" && (
        <div className="connection-guide">
          <span>{connected ? "Muse 示例连接就绪" : "Muse 需要先连接"}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => setConnected(true)}
          >
            {connected ? <Check size={15} /> : "演示连接"}
          </button>
        </div>
      )}
      <div className="dialog-actions">
        <span className="muted">不开启自动发布</span>
        <button
          className="button primary"
          disabled={!name.trim() || !topic.trim()}
        >
          {editing ? "保存分工" : "创建项目群"}
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}

export function RulesForm({ project, save }) {
  const [value, setValue] = useState(project.rules.join("\n"));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(
          value
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
        );
      }}
    >
      <p>一行一条，只应用于「{project.name}」。</p>
      <label className="field">
        项目规则
        <textarea
          rows={7}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button className="button primary">保存规则</button>
      </div>
    </form>
  );
}

export function Sources() {
  return (
    <>
      <p className="dialog-intro">
        以下是结构演示，选题不是实时新闻。正式产品须逐条保留原帖、采集时间和查证依据。
      </p>
      <div className="topic-list">
        {topics.map(([title, category, desc], i) => (
          <article key={title}>
            <span>0{i + 1}</span>
            <div>
              <small>{category} · 示例素材</small>
              <h3>{title}</h3>
              <p>{desc}</p>
              <span className="tag">{i < 3 ? "进入成稿" : "留作备选"}</span>
            </div>
          </article>
        ))}
      </div>
      <div className="reference-links">
        <strong>本原型的设计参考</strong>
        <a
          href="https://open.feishu.cn/document/ukTMukTMukTM/ugDOwYjL4gDM24CO4AjN"
          target="_blank"
          rel="noreferrer"
        >
          飞书官方消息卡片设计规范 ↗
        </a>
        <a
          href="https://tiptap.dev/docs/editor/getting-started/install/react"
          target="_blank"
          rel="noreferrer"
        >
          TipTap 编辑器文档 ↗
        </a>
      </div>
    </>
  );
}
