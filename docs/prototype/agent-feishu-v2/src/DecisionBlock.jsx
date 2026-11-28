import React, { createContext, useContext, useState } from "react";
import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { Avatar } from "./common.jsx";
import { GitCompareArrows, Undo2 } from "lucide-react";
export const DecisionContext = createContext(null);
function DecisionView({ node, updateAttributes }) {
  const context = useContext(DecisionContext);
  const item = context?.project.decisions.find((d) => d.id === node.attrs.id);
  const [writing, setWriting] = useState(false),
    [text, setText] = useState(""),
    [remember, setRemember] = useState(false);
  if (!item)
    return (
      <NodeViewWrapper className="decision-inline" contentEditable={false}>
        这条决定的上下文暂不可用，原稿已保留。
      </NodeViewWrapper>
    );
  const positions = item.positions || [];
  function select(value, label) {
    if (!value.trim() || context.storageError) return;
    updateAttributes({ selected: value, choice: label });
    context.onChoose(item.id, label, value, remember);
    setWriting(false);
  }
  return (
    <NodeViewWrapper
      className={`decision-inline ${node.attrs.selected ? "resolved" : ""}`}
      data-decision-id={item.id}
      contentEditable={false}
    >
      {node.attrs.selected ? (
        <>
          <p className="decision-chosen">{node.attrs.selected}</p>
          <div className="decision-undo">
            已按你的选择 · {node.attrs.choice}
            <button
              onClick={() => {
                updateAttributes({ selected: null, choice: null });
                context.onChoose(item.id, null, null, false);
              }}
            >
              <Undo2 size={13} />
              撤回
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>
            <GitCompareArrows size={18} />
            待你决定：{item.title}
          </h3>
          <p className="decision-description">{item.description}</p>
          {writing ? (
            <div className="decision-writing">
              <label>
                你的写法
                <textarea
                  aria-label="我的决定写法"
                  rows={5}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={!text.trim() || context.storageError}
                onClick={() => select(text, "我自己写")}
              >
                确定
              </button>
              <button
                className="button quiet"
                onClick={() => setWriting(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <>
              <div className="decision-positions">
                {positions.map((p, i) => (
                  <section key={i}>
                    <header>
                      <Avatar
                        member={context.members.find((m) => m.id === p.member)}
                        size={25}
                      />
                      <strong>
                        {context.members.find((m) => m.id === p.member)?.name}
                      </strong>
                    </header>
                    <p>{p.text}</p>
                    <details>
                      <summary>查看依据</summary>
                      <p>{p.evidence}</p>
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          原始材料 ↗
                        </a>
                      )}
                    </details>
                    <button
                      className="button small"
                      disabled={context.storageError}
                      onClick={() => select(p.text, p.label)}
                    >
                      采纳此方案
                    </button>
                  </section>
                ))}
              </div>
              {item.recommendation && (
                <p className="decision-recommendation">
                  整合者建议：{item.recommendation}
                </p>
              )}
              <div className="decision-alternatives">
                <button onClick={() => select(item.conditional, "两种都保留")}>
                  两种都保留
                </button>
                <button
                  onClick={() => {
                    setText(positions.map((p) => p.text).join("\n\n"));
                    setWriting(true);
                  }}
                >
                  我自己写
                </button>
              </div>
            </>
          )}
          <label className="remember-choice">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            同类问题以后都这样选
          </label>
        </>
      )}
    </NodeViewWrapper>
  );
}
export const DecisionNode = Node.create({
  name: "hubDecision",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-id"),
        renderHTML: (a) => ({ "data-id": a.id }),
      },
      selected: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-selected"),
        renderHTML: (a) => (a.selected ? { "data-selected": a.selected } : {}),
      },
      choice: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-choice"),
        renderHTML: (a) => (a.choice ? { "data-choice": a.choice } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "hub-decision" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "hub-decision",
      HTMLAttributes,
      [
        "p",
        {},
        HTMLAttributes["data-selected"] ||
          "待决定：请在 Agent Hub 中查看双方依据并选择。",
      ],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DecisionView);
  },
});
