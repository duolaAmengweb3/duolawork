import React, { useEffect, useRef, useId } from "react";
import { X, Inbox } from "lucide-react";
export function Avatar({ member, size = 32 }) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: member?.color || "#DDE6F5",
        color: member ? "#fff" : "#365577",
      }}
      aria-label={member?.name || "我"}
    >
      {member?.initial || "我"}
    </span>
  );
}
export function IconButton({ icon: Icon, label, active, ...props }) {
  return (
    <button
      type="button"
      className={`icon-button${active ? " active" : ""}`}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={18} strokeWidth={1.7} />
    </button>
  );
}
export function Badge({ children, tone = "neutral" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({ title, description, action, icon: Icon = Inbox }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={28} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Modal({ title, description, children, onClose, wide }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement;
    el.showModal();
    return () => {
      if (el.open) el.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal${wide ? " wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton icon={X} label="关闭弹窗" onClick={onClose} />
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function PageHeader({ eyebrow, title, description, children }) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
