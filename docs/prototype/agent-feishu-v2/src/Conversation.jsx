import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  AtSign,
  Bold,
  Check,
  ChevronRight,
  FileText,
  Italic,
  Link,
  Paperclip,
  Send,
  Sparkles,
} from "lucide-react";
import { Avatar, IconButton } from "./common.jsx";
import { agents } from "./model.mjs";

function Message({ name, time, children }) {
  return (
    <div className="message">
      <Avatar name={name} />
      <div className="message-body">
        <div className="message-by">
          <strong>{agents[name]?.label || "我"}</strong>
          <time>{time}</time>
        </div>
        {children}
      </div>
    </div>
  );
}

function Handoff({ from, to, title, children, action, label }) {
  return (
    <div className="message-card">
      <div className="card-caption">
        <span>
          <Check size={13} />
          {title}
        </span>
        <span className="card-caption-status">已交接</span>
      </div>
      <div className="card-copy">{children}</div>
      <div className="handoff-line">
        <span>{from}</span>
        <ArrowRight size={12} />
        <span>{to}</span>
        <span className="handoff-detail">原始材料随任务传递</span>
      </div>
      <button className="card-action" onClick={action}>
        {label}
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

export default function Conversation({
  project,
  patch,
  openDoc,
  showSources,
  showToast,
  running,
}) {
  const [mentions, setMentions] = useState(false);
  const input = useRef(null);
  const end = useRef(null);
  const attach = useRef(null);
  const previousMessages = useRef(project.messages.length);
  useEffect(() => {
    if (project.messages.length > previousMessages.current)
      end.current?.scrollIntoView({ block: "nearest" });
    previousMessages.current = project.messages.length;
  }, [project.messages.length]);
  function send() {
    const text = project.composer.trim();
    if (!text) return;
    patch((p) => ({
      ...p,
      composer: "",
      messages: [
        ...p.messages,
        {
          id: crypto.randomUUID(),
          text,
          time: new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ],
    }));
    setMentions(false);
    showToast("补充已保存在示例群中；未向真实 Agent 发送");
  }
  function addMention(name) {
    patch((p) => ({ ...p, composer: p.composer + "@" + name + " " }));
    setMentions(false);
    input.current?.focus();
  }
  return (
    <section className="conversation" aria-label="项目群对话">
      <div className="message-scroll">
        <div className="date-separator">
          <span />
          今天 · 原型示例
          <span />
        </div>
        <div className="project-note">
          <Sparkles size={14} />
          <span>一个群，一份共同成果。交接自动推进，你随时可以补充。</span>
        </div>
        {project.status === "idle" ? (
          <div className="empty-conversation">
            <Paperclip size={27} />
            <h3>先把灵感放在这里</h3>
            <p>输入想法、添加本地资料，或从配方开始安排工作。</p>
          </div>
        ) : (
          <>
            <Message name="User" time="08:00">
              <p>
                今天重点看 AI Agent 的实操案例。别堆发布新闻，保留原始出处。
              </p>
            </Message>
            {project.stage >= 1 && (
              <Message name="Grok" time="08:02">
                <p>整理了 5 个候选，优先看有实际过程的案例。</p>
                <Handoff
                  from="Grok"
                  to={project.checker}
                  title="选题搜集完成"
                  action={showSources}
                  label="查看 5 个候选与来源"
                >
                  <strong>5 个候选选题</strong>
                  <p>案例、原始链接、可写角度已一并交接。</p>
                </Handoff>
              </Message>
            )}
            {project.stage >= 2 && (
              <Message name={project.checker} time="08:04">
                <Handoff
                  from={project.checker}
                  to={project.writer}
                  title="资料查证完成"
                  action={showSources}
                  label="查看查证材料"
                >
                  <strong>3 条进入写作，2 条暂存</strong>
                  <p>已区分原始材料与推断；资料不充分的候选不写成事实。</p>
                </Handoff>
              </Message>
            )}
            {project.stage >= 3 && (
              <Message name={project.writer} time="08:06">
                <p>内容包已整理好。你可以直接改稿，也可以 @我补充要求。</p>
                <div className="delivery-card">
                  <div className="delivery-heading">
                    <span className="doc-icon">
                      <FileText size={19} />
                    </span>
                    <div>
                      <strong>今日内容包</strong>
                      <small>3 条成稿 · 原始出处 · 可共同编辑</small>
                    </div>
                  </div>
                  <div className="delivery-files">
                    {project.docs.map((d, i) => (
                      <button key={d.id} onClick={() => openDoc(d.id)}>
                        <span className="file-order">0{i + 1}</span>
                        <span>{d.title}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                  <footer>
                    <span>保留 Agent 原稿，修改另存为工作稿</span>
                    <button
                      className="text-button"
                      onClick={() => openDoc(project.docs[0]?.id, true)}
                    >
                      开始审核
                      <ArrowRight size={13} />
                    </button>
                  </footer>
                </div>
              </Message>
            )}
            {running && (
              <div className="working-line">
                <span className="working-dot" />
                正在演示
                {project.stage === 0
                  ? "发现选题"
                  : project.stage === 1
                    ? "资料查证"
                    : "整理成稿"}
                <span>不会调用真实平台</span>
              </div>
            )}
          </>
        )}
        {project.messages.map((m) => (
          <Message key={m.id} name="User" time={m.time}>
            <p className="own-message">{m.text}</p>
            {m.attachment && (
              <span className="attachment-label">
                <Paperclip size={13} />
                {m.attachment}
              </span>
            )}
          </Message>
        ))}
        <div ref={end} />
      </div>
      <div className="composer-wrap">
        {mentions && (
          <div className="mention-menu">
            <span className="menu-label">提及项目成员</span>
            {["Grok", project.checker, project.writer]
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((name) => (
                <button key={name} onClick={() => addMention(name)}>
                  <Avatar name={name} size={25} />
                  {agents[name].label}
                  <small>{agents[name].role}</small>
                </button>
              ))}
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={input}
            value={project.composer}
            onChange={(e) => patch((p) => ({ ...p, composer: e.target.value }))}
            placeholder="发消息，或 @成员补充要求…"
            aria-label="项目群消息"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-tools">
            <div>
              <IconButton
                icon={AtSign}
                label="提及成员"
                active={mentions}
                onClick={() => setMentions((v) => !v)}
              />
              <IconButton
                icon={Paperclip}
                label="添加本地资料"
                onClick={() => attach.current.click()}
              />
              <span className="composer-divider" />
              <IconButton
                icon={Bold}
                label="插入加粗标记"
                onClick={() =>
                  patch((p) => ({ ...p, composer: p.composer + "**重点**" }))
                }
              />
              <IconButton
                icon={Italic}
                label="插入斜体标记"
                onClick={() =>
                  patch((p) => ({ ...p, composer: p.composer + "*补充*" }))
                }
              />
              <IconButton
                icon={Link}
                label="插入链接标记"
                onClick={() =>
                  patch((p) => ({
                    ...p,
                    composer: p.composer + "[资料名称](https://)",
                  }))
                }
              />
            </div>
            <span className="send-shortcut">⌘ / Ctrl ↵ 发送</span>
            <button
              className="send-button"
              aria-label="发送消息"
              disabled={!project.composer.trim()}
              onClick={send}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
        <input
          ref={attach}
          className="visually-hidden"
          type="file"
          accept=".txt,.md"
          onChange={async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            if (f.size > 200000) {
              showToast("原型只接收 200KB 以内的文本资料");
              return;
            }
            const text = await f.text();
            patch((p) => ({
              ...p,
              messages: [
                ...p.messages,
                {
                  id: crypto.randomUUID(),
                  text: text.slice(0, 5000),
                  attachment: f.name,
                  time: "刚刚",
                },
              ],
            }));
            showToast("资料已保存在此示例项目，不会上传");
            e.target.value = "";
          }}
        />
        <div className="composer-footnote">本地交互演示 · 不会自动发布内容</div>
      </div>
    </section>
  );
}
