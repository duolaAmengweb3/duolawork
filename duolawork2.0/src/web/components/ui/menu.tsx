import * as React from 'react';
import { cn } from '../../lib/cn.js';

const MenuCtx = React.createContext<{
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}>({
  open: false,
  setOpen: () => {}
});

export function Menu({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <MenuCtx.Provider value={{ open, setOpen }}>
      <div ref={ref} className="relative inline-flex" data-slot="menu">
        {children}
      </div>
    </MenuCtx.Provider>
  );
}

export function MenuTrigger({
  render,
  children
}: {
  render?: React.ReactElement<{ onClick?: React.MouseEventHandler }>;
  children?: React.ReactNode;
}): React.ReactElement {
  const { open, setOpen } = React.useContext(MenuCtx);
  const toggle: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };
  if (render) {
    return React.cloneElement(render, {
      onClick: (e) => {
        render.props.onClick?.(e);
        toggle(e);
      }
    });
  }
  return (
    <button type="button" aria-expanded={open} onClick={toggle} data-slot="menu-trigger">
      {children}
    </button>
  );
}

export function MenuPopup({
  children,
  className,
  align = 'end'
}: {
  children: React.ReactNode;
  className?: string;
  align?: 'start' | 'end' | 'center';
}): React.ReactElement | null {
  const { open } = React.useContext(MenuCtx);
  if (!open) return null;
  return (
    <div
      role="menu"
      data-slot="menu-popup"
      className={cn(
        'absolute top-full z-50 mt-1 flex min-w-32 flex-col rounded-lg border border-border bg-popover p-1 not-dark:bg-clip-padding shadow-lg/5 outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]',
        align === 'end' ? 'right-0' : align === 'start' ? 'left-0' : 'left-1/2 -translate-x-1/2',
        className
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  className,
  variant = 'default',
  onClick,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'destructive';
}): React.ReactElement {
  const { setOpen } = React.useContext(MenuCtx);
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="menu-item"
      data-variant={variant}
      onClick={(e) => {
        setOpen(false);
        onClick?.(e);
      }}
      className={cn(
        "flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-64 data-[variant=destructive]:text-destructive-foreground [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:opacity-80",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function MenuSeparator({ className }: { className?: string }): React.ReactElement {
  return <div role="separator" className={cn('mx-1.5 my-1 h-px bg-border', className)} />;
}
