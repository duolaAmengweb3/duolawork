import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
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

export function ModelPicker({ threadId, memberId }: { threadId: string; memberId: string }) {
  const url =
    '/api/v2/threads/' + encodeURIComponent(threadId) + '/members/' + encodeURIComponent(memberId) + '/inference';
  const [saved, setSaved] = useState<ModelPreference | null>(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const seq = request.current;
    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (!controller.signal.aborted && v && seq === request.current) setSaved(v.preference);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      request.current++;
    };
  }, [url]);
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

  async function load(selected?: string) {
    if (selected) {
      setModel(selected);
      setEffort('');
    }
    const seq = ++request.current;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(url + '?catalog=1' + (selected ? '&model=' + encodeURIComponent(selected) : ''));
      if (!r.ok) throw new Error();
      const data = (await r.json()) as { catalog: ModelCatalog; preference: ModelPreference | null };
      if (seq !== request.current) return;
      const id = selected || data.preference?.model || data.catalog.defaultModel || data.catalog.models[0]?.id;
      const item = data.catalog.models.find((m) => m.id === id) ?? data.catalog.models[0];
      setCatalog(data.catalog);
      setSaved(data.preference);
      setModel(item?.id || '');
      setEffort(
        item && data.preference?.model === item.id && item.efforts.includes(data.preference.effort || '')
          ? data.preference.effort!
          : item?.defaultEffort || ''
      );
    } catch {
      if (seq === request.current) setError('暂时无法从执行端读取选项');
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
      setSaved((await r.json()).preference);
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
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        <SlidersHorizontal size={14} />
        <span>{saved ? saved.model + (saved.effort ? ' · ' + effortLabel(saved.effort) : '') : '模型'}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="模型与推理强度" className="inference-panel">
          {!!catalog?.models.length && (
            <fieldset disabled={busy} className="inference-models">
              <legend>模型</legend>
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
                      onChange={() => setEffort(value)}
                    />
                    <span>{effortLabel(value)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {busy && <span role="status">正在与执行端同步…</span>}
          {error && (
            <span role="alert">
              {error}{' '}
              <button type="button" onClick={() => void load()}>
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
