import { cva, type VariantProps } from 'class-variance-authority';
import type React from 'react';
import { cn } from '../../lib/cn.js';

export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default'
    },
    variants: {
      size: {
        default: 'h-5.5 min-w-5.5 px-[calc(--spacing(1.5)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs',
        lg: 'h-6.5 min-w-6.5 px-[calc(--spacing(2)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm',
        sm: 'h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1.5)-1px)] text-xs sm:h-4.5 sm:min-w-4.5 sm:text-[11px]'
      },
      variant: {
        default: 'bg-primary text-primary-foreground',
        destructive: 'bg-destructive text-white',
        error: 'bg-destructive/8 text-destructive-foreground dark:bg-destructive/16',
        info: 'bg-info/8 text-info-foreground dark:bg-info/16',
        outline: 'border-input bg-background text-foreground dark:bg-input/32',
        secondary: 'bg-secondary text-secondary-foreground',
        success: 'bg-success/10 text-success-foreground dark:bg-success/16',
        warning: 'bg-warning/10 text-warning-foreground dark:bg-warning/16'
      }
    }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps): React.ReactElement {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}
