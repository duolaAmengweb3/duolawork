import { useViewCache } from './view-cache.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import type { ModelCatalog, ModelPreference } from '../shared/types.js';

const strengthNames: Record<string, string> = {
  '': '默认',
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极高',
  auto: '自动'
};
function effortLabel(effort: string) {
  return strengthNames[effort.toLowerCase()] ?? effort;
}

type ConfigView = { catalog: ModelCatalog; preference: ModelPreference | null };
export function ModelPicker({
  threadId,
  memberId,
  perModel
}: {
  threadId: string;
  memberId: string;
  perModel: boolean;
}) {
  const views = useViewCache();
  const url =
    '/api/v2/threads/' +
    encodeURIComponent(threadId) +
    '/members/' +
    encodeURIComponent(memberId) +
    '/inference';
  const [saved, setSaved] = useState<ModelPreference | null>(
    () => views.peek<{ preference: ModelPreference | null }>(url)?.preference ?? null
  );
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = root.current;
    const menu = panel.current;
    if (!open || !anchor || !menu) return;
    const position = () => {
      const x = anchor.getBoundingClientRect().left;
      const left = Math.max(12, Math.min(x, document.documentElement.clientWidth - menu.offsetWidth - 12));
      menu.style.left = left - x + 'px';
    };
    position();
    const observer = new ResizeObserver(position);
    const composer = anchor.closest('.chat-composer');
    if (composer) observer.observe(composer);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [open]);

  useEffect(() => {
    let active = true;
    const seq = request.current;
    void views
      .json<{ preference: ModelPreference | null }>(url, 15000)
      .then((data) => {
        if (active && seq === request.current) setSaved(data.preference);
      })
      .catch(() => {});
    return () => {
      active = false;
      request.current++;
    };
  }, [url, views]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const menuKey = url + '?catalog=1';
  const catalogFor = (id?: string) => menuKey + (perModel && id ? '&model=' + encodeURIComponent(id) : '');
  const warm = () => {
    void views
      .json<ConfigView>(
        catalogFor(views.peek<{ preference: ModelPreference | null }>(url)?.preference?.model),
        120000
      )
      .catch(() => {});
  };

  async function load(id?: string, retry = false) {
    const seq = ++request.current;
    const key = catalogFor(
      id ??
        (perModel ? views.peek<{ preference: ModelPreference | null }>(url)?.preference?.model : undefined)
    );
    const cached = views.peek<ConfigView>(key);
    const preference = views.peek<{ preference: ModelPreference | null }>(url)?.preference;
    const show = (data: ConfigView) => {
      const pref = preference === undefined ? data.preference : preference;
      const requested = id ?? pref?.model ?? data.catalog.defaultModel;
      const item = data.catalog.models.find((m) => m.id === requested) ?? data.catalog.models[0];
      setCatalog(data.catalog);
      setModel(item?.id ?? '');
      setSaved(pref);
      setEffort(
        item && pref?.model === item.id && item.efforts.includes(pref.effort || '')
          ? pref.effort!
          : (item?.defaultEffort ?? '')
      );
    };
    if (cached) show(cached);
    else if (id) {
      setModel(id);
      setEffort('');
    }
    setBusy(!cached);
    setError('');
    if (retry) views.invalidate(key);
    try {
      const data = await views.json<ConfigView>(key, 120000);
      if (seq !== request.current) return;
      if (!cached || data !== cached) show(data);
    } catch {
      if (seq === request.current) setError('暂时无法更新模型列表');
    } finally {
      if (seq === request.current) setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort: effort || null })
      });
      if (!r.ok) throw new Error();
      const { preference } = await r.json();
      views.put(url, { preference });
      if (catalog) {
        const result = { catalog, preference };
        views.put(menuKey, result);
        views.put(catalogFor(model), result);
      }
      setSaved(preference);
      setOpen(false);
      trigger.current?.focus();
    } catch {
      setError('设置未保存，请重新读取执行端选项');
    } finally {
      setBusy(false);
    }
  }
  const selected = catalog?.models.find((m) => m.id === model);
  return (
    <div className="inference-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="inference-trigger"
        aria-label="模型与推理强度"
        title={saved ? saved.model + ' · ' + (saved.effort || '默认强度') : '模型与推理强度'}
        onPointerEnter={warm}
        onFocus={warm}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        <SlidersHorizontal size={14} />
        <span>{saved ? saved.model + (saved.effort ? ' · ' + effortLabel(saved.effort) : '') : '模型'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div ref={panel} role="dialog" aria-label="模型与推理强度" className="inference-panel">
          <header>
            <strong>模型</strong>
            <button
              type="button"
              aria-label="关闭模型设置"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </header>
          {!!catalog?.models.length && (
            <fieldset disabled={busy} className="inference-models">
              <legend className="inference-sr-only">模型</legend>
              <div>
                {catalog.models.map((item) => (
                  <label key={item.id}>
                    <input
                      type="radio"
                      name="inference-model"
                      value={item.id}
                      checked={item.id === model}
                      onChange={() => void load(item.id)}
                    />
                    <span>{item.label}</span>
                    <Check size={14} aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!!selected?.efforts.length && (
            <fieldset disabled={busy} className="inference-efforts">
              <legend>推理强度</legend>
              <div>
                {(selected.defaultEffort ? selected.efforts : ['', ...selected.efforts]).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="inference-effort"
                      value={value}
                      checked={value === effort}
                      onChange={() => {
                        request.current++;
                        setEffort(value);
                      }}
                    />
                    <span>{effortLabel(value)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {busy && !catalog && (
            <span className="inference-pending" role="status">
              正在读取模型…
            </span>
          )}
          {error && (
            <span role="alert">
              {error}{' '}
              <button type="button" onClick={() => void load(model || undefined, true)}>
                重试
              </button>
            </span>
          )}
          {!busy && !error && catalog && !catalog.models.length && <span>此执行端自行管理模型</span>}
          {selected && (
            <button
              type="button"
              className="inference-save"
              disabled={busy || !!error}
              onClick={() => void save()}
            >
              应用到下次执行
            </button>
          )}
        </div>
      )}
    </div>
  );
}
