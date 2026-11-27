import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent } from 'react';

type Side = 'sidebar' | 'space';
type Widths = Record<Side, number | null>;
const minimum = { sidebar: 180, space: 280 };
const centerMin = 360;
const label = { sidebar: '对话列表宽度', space: '协作空间宽度' };
const storageKey = (side: Side) => 'dw2-column-width-' + side;

function savedWidth(side: Side) {
  try {
    const value = Number(localStorage.getItem(storageKey(side)));
    return Number.isFinite(value) && value >= minimum[side] ? value : null;
  } catch {
    return null;
  }
}

const Columns = createContext<{
  current: Record<Side, number>;
  maximum: Record<Side, number>;
  change: (side: Side, value: number | null) => void;
  save: () => void;
} | null>(null);

type WorkbenchProps = ComponentProps<'div'> & {
  spaceVisible: boolean;
  wideSpace: boolean;
  leaveWideSpace: () => void;
};

export function WorkbenchColumns({ spaceVisible, wideSpace, leaveWideSpace, children, ...props }: WorkbenchProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState<Widths>(() => ({
    sidebar: savedWidth('sidebar'), space: savedWidth('space')
  }));

  const pending = useRef(preferred);

  useLayoutEffect(() => {
    const root = container.current!;
    setWidth(root.clientWidth);
    const observer = new ResizeObserver(() => setWidth(root.clientWidth));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const sidebarLimit = Math.max(minimum.sidebar, width - centerMin - (spaceVisible ? minimum.space : 0));
  const sidebar = Math.min(preferred.sidebar ?? (width <= 1150 ? 210 : 244), sidebarLimit);
  const spaceLimit = Math.max(minimum.space, width - sidebar - centerMin);
  const space = wideSpace ? spaceLimit : Math.min(preferred.space ?? (width <= 1050 ? 365 : 410), spaceLimit);
  const maximum = { sidebar: sidebarLimit, space: Math.max(minimum.space, width - centerMin - minimum.sidebar) };

  function change(side: Side, value: number | null) {
    const available = (container.current?.clientWidth ?? width) - centerMin;
    if (value !== null) {
      const reserved = side === 'space' ? minimum.sidebar : spaceVisible ? minimum.space : 0;
      value = Math.max(minimum[side], Math.min(value, available - reserved));
    }
    if (side === 'space' && wideSpace) leaveWideSpace();
    const next = { ...pending.current, [side]: value };
    if (value !== null && spaceVisible) {
      // Once the chat reaches its minimum, the other outer pane can yield the remaining space.
      const room = available - value;
      if (side === 'space' && room < sidebar) next.sidebar = room;
      if (side === 'sidebar' && !wideSpace && room < space) next.space = room;
    }
    pending.current = next;
    setPreferred(next);
  }

  function save() {
    try {
      for (const side of ['sidebar', 'space'] as const) {
        const value = pending.current[side];
        if (value === null) localStorage.removeItem(storageKey(side));
        else localStorage.setItem(storageKey(side), String(value));
      }
    } catch { /* Widths remain usable for this window when storage is unavailable. */ }
  }

  return (
    <Columns.Provider value={{ current: { sidebar, space }, maximum, change, save }}>
      <div {...props} ref={container} style={{
        '--dw-sidebar-width': sidebar + 'px', '--dw-space-width': space + 'px',
        '--dw-center-min': centerMin + 'px', '--dw-sidebar-min': minimum.sidebar + 'px',
        '--dw-space-min': minimum.space + 'px', '--dw-reserved-space': (spaceVisible ? minimum.space : 0) + 'px'
      } as CSSProperties}>
        {children}
      </div>
    </Columns.Provider>
  );
}

export function ColumnDivider({ side }: { side: Side }) {
  const { current, maximum, change, save } = useContext(Columns)!;
  const drag = useRef<{ id: number; x: number; start: number; last: number | null } | null>(null);
  const sign = side === 'sidebar' ? 1 : -1;
  const clamp = (v: number) => Math.min(maximum[side], Math.max(minimum[side], Math.round(v)));

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const next = clamp(active.start + sign * (event.clientX - active.x));
    if (next === (active.last ?? active.start)) return;
    active.last = next;
    change(side, next);
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    if (drag.current.last !== null) save();
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
  }

  return (
    <div
      className="workbench-divider" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={label[side]} aria-controls={side === 'sidebar' ? 'workbench-sidebar' : 'workbench-space'}
      aria-valuemin={minimum[side]} aria-valuemax={maximum[side]} aria-valuenow={current[side]}
      aria-valuetext={current[side] + ' 像素'} title={'拖动调整' + label[side] + '，双击恢复默认宽度'}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = '';
        drag.current = { id: event.pointerId, x: event.clientX, start: current[side], last: null };
      }}
      onPointerMove={(event) => { if (event.buttons & 1) move(event); }}
      onPointerUp={(event) => { move(event); finish(event); }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => { change(side, null); save(); }}
      onKeyDown={(event) => {
        let value: number;
        if (event.key === 'ArrowLeft') value = current[side] - sign * 16;
        else if (event.key === 'ArrowRight') value = current[side] + sign * 16;
        else if (event.key === 'Home') value = minimum[side];
        else if (event.key === 'End') value = maximum[side];
        else return;
        event.preventDefault();
        const next = clamp(value);
        change(side, next);
        save();
      }}
    />
  );
}
