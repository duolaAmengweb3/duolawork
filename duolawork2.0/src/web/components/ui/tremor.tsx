import React from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Tremor Raw inspired Tracker component (tremor.so)
 * Compact uptime / execution history bar with hover tooltips.
 */
export interface TrackerBlockProps {
  key?: string | number;
  color?: 'emerald' | 'rose' | 'amber' | 'blue' | 'neutral';
  tooltip?: string;
}

const TRACKER_COLORS: Record<NonNullable<TrackerBlockProps['color']>, string> = {
  emerald: 'bg-emerald-500/85 dark:bg-emerald-400/80',
  rose: 'bg-rose-500/85 dark:bg-rose-400/85',
  amber: 'bg-amber-500/85 dark:bg-amber-400/85',
  blue: 'bg-blue-500/85 dark:bg-blue-400/85',
  neutral: 'bg-foreground/10 dark:bg-foreground/12'
};

export function Tracker({
  data,
  className
}: {
  data: TrackerBlockProps[];
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('group flex h-5 items-center gap-[3px]', className)}>
      {data.map((item, idx) => (
        <div
          key={item.key ?? idx}
          title={item.tooltip}
          className={cn(
            'h-full w-1.5 rounded-[2px] transition-opacity hover:opacity-75',
            TRACKER_COLORS[item.color ?? 'neutral']
          )}
        />
      ))}
    </div>
  );
}

/**
 * Tremor Raw inspired CategoryBar component (tremor.so)
 * Proportional multi-segment distribution bar with hairline rounding.
 */
export interface CategorySegment {
  value: number;
  color: string;
  label?: string;
}

export function CategoryBar({
  segments,
  className
}: {
  segments: CategorySegment[];
  className?: string;
}): React.JSX.Element {
  const total = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  return (
    <div
      className={cn(
        'flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07] gap-[1.5px]',
        className
      )}
    >
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((seg, i) => (
            <div
              key={i}
              title={seg.label}
              className={cn('h-full rounded-full transition-all', seg.color)}
              style={{ width: `${Math.max(2, (seg.value / total) * 100)}%` }}
            />
          ))}
    </div>
  );
}

/**
 * Tremor Raw inspired inline ProgressBar for BarList / usage proportion.
 */
export function UsageProportionBar({
  value,
  max,
  colorClass = 'bg-neutral-800 dark:bg-neutral-200',
  className
}: {
  value: number;
  max: number;
  colorClass?: string;
  className?: string;
}): React.JSX.Element {
  const pct = max > 0 && value > 0 ? Math.max(3, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]',
        className
      )}
    >
      {pct > 0 && (
        <div
          className={cn('h-full rounded-full transition-all duration-300', colorClass)}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}
