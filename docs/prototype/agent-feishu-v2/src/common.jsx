import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { agents } from "./model.mjs";

export function Avatar({ name, size = 32 }) {
  const a = agents[name];
  return (
    <span
      className={"avatar avatar-" + name}
      style={{ width: size, height: size, background: a?.color }}
      aria-label={a?.label || "我"}
    >
      {name === "Grok" ? (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M7 23 24 6M8 7h5l12 18h-5L8 7ZM6 16a10 10 0 0 0 14 10M26 16A10 10 0 0 0 12 6" />
        </svg>
      ) : name === "Perplexity" ? (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M8 5 16 11 24 5v22l-8-7-8 7V5Zm8-1v24M5 12h22v10l-11-9L5 22V12Z" />
        </svg>
      ) : name === "Dot" ? (
        <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
          {[
            [11, 8],
            [21, 8],
            [6, 16],
            [16, 16],
            [26, 16],
            [11, 24],
            [21, 24],
          ].map(([x, y]) => (
            <circle key={x + ":" + y} cx={x} cy={y} r="2.6" />
          ))}
        </svg>
      ) : name === "Muse" ? (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M5 22V10c0-3 4-3 6 1l5 10 5-10c2-4 6-4 6-1v12M5 22c0 3 4 3 6-1l5-10 5 10c2 4 6 4 6 1" />
        </svg>
      ) : (
        <span className="user-glyph">朵</span>
      )}
    </span>
  );
}

export function IconButton({ icon: Icon, label, onClick, active, ...props }) {
  return (
    <button
      type="button"
      className={"icon-button" + (active ? " is-active" : "")}
      title={label}
      aria-label={label}
      onClick={onClick}
      {...props}
    >
      <Icon size={17} strokeWidth={1.7} />
    </button>
  );
}

export function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    const cancel = (e) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", cancel);
    return () => el.removeEventListener("cancel", cancel);
  }, [onClose]);
  return (
    <dialog
      className={"dialog" + (wide ? " dialog-wide" : "")}
      ref={ref}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton icon={X} label="关闭弹窗" onClick={onClose} />
      </header>
      <div className="dialog-content">{children}</div>
    </dialog>
  );
}

export function SectionTitle({ eyebrow, title, description, action }) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
