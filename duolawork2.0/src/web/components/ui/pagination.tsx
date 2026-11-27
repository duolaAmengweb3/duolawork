import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { Button } from './button.js';

export function usePagination<T>(
  items: readonly T[],
  pageSize: number,
  resetKey?: string | number
): {
  page: number;
  totalPages: number;
  pageItems: T[];
  startIndex: number;
  endIndex: number;
  total: number;
  pageSize: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
} {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, safePage, pageSize]);

  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(total, safePage * pageSize);

  return {
    page: safePage,
    totalPages,
    pageItems,
    startIndex,
    endIndex,
    total,
    pageSize,
    setPage
  };
}

export function PaginationBar({
  page,
  totalPages,
  startIndex,
  endIndex,
  total,
  onPageChange,
  compact = false,
  className
}: {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  total: number;
  onPageChange: (nextPage: number) => void;
  compact?: boolean;
  className?: string;
}): React.JSX.Element | null {
  if (totalPages <= 1) return null;

  return (
    <div
      className={cn(
        'flex w-full flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground',
        compact ? 'px-1 py-1 text-[11px]' : '',
        className
      )}
    >
      <span className="font-mono tabular-nums">
        {compact ? `${startIndex}–${endIndex} / ${total}` : `显示 ${startIndex}–${endIndex} 条，共 ${total} 条`}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          aria-label="上一页"
        >
          <ChevronLeft size={12} />
          {!compact && <span>上一页</span>}
        </Button>
        <span className="min-w-[44px] text-center font-mono text-[11px] font-medium text-foreground tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          aria-label="下一页"
        >
          {!compact && <span>下一页</span>}
          <ChevronRight size={12} />
        </Button>
      </div>
    </div>
  );
}
