import * as React from 'react';
import { cn } from '../../lib/cn.js';

type TabsSize = 'sm' | 'default' | 'lg';
type TabsVariant = 'default' | 'underline';

const TabsCtx = React.createContext<{
  value: string;
  onValueChange: (val: string) => void;
  size: TabsSize;
  variant: TabsVariant;
}>({
  value: '',
  onValueChange: () => {},
  size: 'default',
  variant: 'default'
});

export function Tabs({
  value,
  onValueChange,
  className,
  children
}: {
  value: string;
  onValueChange: (val: string) => void;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <TabsCtx.Provider value={{ value, onValueChange, size: 'default', variant: 'default' }}>
      <div className={cn('flex flex-col gap-2', className)} data-slot="tabs">
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function TabsList({
  variant = 'default',
  size = 'default',
  className,
  children
}: {
  variant?: TabsVariant;
  size?: TabsSize;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const parent = React.useContext(TabsCtx);
  return (
    <TabsCtx.Provider value={{ ...parent, size, variant }}>
      <div
        role="tablist"
        data-size={size}
        data-slot="tabs-list"
        className={cn(
          'relative inline-flex w-fit items-center gap-0.5 text-muted-foreground',
          variant === 'default'
            ? 'rounded-lg bg-muted p-0.5'
            : 'border-b border-border gap-3',
          className
        )}
      >
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function TabsTab({
  value,
  className,
  children
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { value: activeVal, onValueChange, size, variant } = React.useContext(TabsCtx);
  const active = activeVal === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active ? '' : undefined}
      onClick={() => onValueChange(value)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        variant === 'default'
          ? active
            ? 'bg-background text-foreground shadow-xs/5 ring-1 ring-border/70 dark:bg-card'
            : 'text-muted-foreground hover:text-foreground'
          : active
            ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary'
            : 'text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  );
}
