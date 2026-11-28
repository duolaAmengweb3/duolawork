import type * as React from 'react';
import { cn } from '../../lib/cn.js';

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: 'sm' | 'default' | 'lg';
  unstyled?: boolean;
  nativeInput?: boolean;
};

export function Input({
  className,
  size = 'default',
  unstyled = false,
  nativeInput: _nativeInput,
  ...props
}: InputProps): React.ReactElement {
  const inputClassName = cn(
    'h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] text-foreground leading-8.5 outline-none placeholder:text-muted-foreground/72 sm:h-7.5 sm:leading-7.5',
    size === 'sm' && 'h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-7 sm:leading-7 text-xs',
    size === 'lg' && 'h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5'
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            'relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:border-ring has-disabled:opacity-64 has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:not-has-disabled:not-has-focus-visible:before:shadow-[0_-1px_--theme(--color-white/6%)]',
          className
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      <input className={inputClassName} data-slot="input" {...props} />
    </span>
  );
}
