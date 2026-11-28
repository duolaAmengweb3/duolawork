import type React from 'react';
import { cn } from '../../lib/cn.js';

export function Card({
  className,
  render,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  render?: React.ReactElement;
}): React.ReactElement {
  const classes = cn(
    'relative flex flex-col rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]',
    className
  );
  if (render?.type === 'article') {
    return <article data-slot="card" className={classes} {...props} />;
  }
  return <div data-slot="card" className={classes} {...props} />;
}
