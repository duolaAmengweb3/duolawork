export interface PopoutTarget {
  kind: 'document' | 'file';
  id: string;
  threadId?: string;
  title?: string;
  mimeType?: string;
  previewKind?: string;
}

export function popoutTabKey(t: Pick<PopoutTarget, 'kind' | 'id'>): string {
  return `${t.kind}:${t.id}`;
}

interface DesktopPopoutBridge {
  isDesktop?: boolean;
  openPopoutWindow?: (opts: {
    path: string;
    title: string;
    key: string;
    tabPayload?: PopoutTarget;
    width?: number;
    height?: number;
  }) => Promise<{ ok?: boolean }>;
  setAlwaysOnTop?: (alwaysOnTop: boolean) => Promise<{ ok?: boolean; alwaysOnTop?: boolean }>;
  setTheme?: (theme: 'light' | 'dark') => Promise<unknown>;
  onReaderOpenTab?: (cb: (target: PopoutTarget) => void) => () => void;
}

export function getPopoutDesktopBridge(): DesktopPopoutBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { duolaworkDesktop?: DesktopPopoutBridge }).duolaworkDesktop;
}

export function parsePopoutParams(): PopoutTarget | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('popout');
  const id = params.get('id')?.trim();
  if ((kind !== 'document' && kind !== 'file') || !id) return null;
  return {
    kind,
    id,
    threadId: params.get('threadId') || undefined,
    title: params.get('title') || undefined,
    mimeType: params.get('mime') || undefined,
    previewKind: params.get('preview') || undefined
  };
}

export function buildPopoutPath(target: PopoutTarget): string {
  const qs = new URLSearchParams();
  qs.set('popout', target.kind);
  qs.set('id', target.id);
  if (target.threadId) qs.set('threadId', target.threadId);
  if (target.title) qs.set('title', target.title);
  if (target.mimeType) qs.set('mime', target.mimeType);
  if (target.previewKind) qs.set('preview', target.previewKind);
  return `/?${qs.toString()}`;
}

let cachedWebReaderWin: Window | null = null;

function tryFocusExistingWebReader(target: PopoutTarget): Promise<boolean> {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel('dw2-reader-tabs');
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'open_tab_ack' && ev.data?.reqId === reqId && !settled) {
          settled = true;
          ch?.close();
          if (cachedWebReaderWin && !cachedWebReaderWin.closed) {
            try {
              cachedWebReaderWin.focus();
            } catch {
              // ignore focus restriction
            }
          }
          resolve(true);
        }
      };
      ch.postMessage({ type: 'open_tab', reqId, target });
    } catch {
      ch?.close();
      resolve(false);
      return;
    }
    setTimeout(() => {
      if (!settled) {
        settled = true;
        ch?.close();
        resolve(false);
      }
    }, 90);
  });
}

export async function openMaterialPopout(target: PopoutTarget): Promise<void> {
  if (typeof window === 'undefined') return;
  const relPath = buildPopoutPath(target);
  const title = target.title || (target.kind === 'document' ? '文档阅读器' : '文件预览');
  const bridge = getPopoutDesktopBridge();

  // Mac Electron desktop: single shared tabbed reader BrowserWindow
  if (bridge?.openPopoutWindow) {
    try {
      const res = await bridge.openPopoutWindow({
        path: relPath,
        title,
        key: 'reader-workspace',
        tabPayload: target,
        width: 1160,
        height: 820
      });
      if (res?.ok) return;
    } catch {
      // fall back to browser popup below
    }
  }

  // Web browser: if reader window already open, add/activate tab inside it!
  const handledByExisting = await tryFocusExistingWebReader(target);
  if (handledByExisting) return;

  const fullUrl = new URL(relPath, window.location.origin).toString();
  const opened = window.open(
    fullUrl,
    'dw2_reader_workspace',
    'popup,width=1160,height=820,resizable=yes,scrollbars=yes'
  );
  if (opened) {
    cachedWebReaderWin = opened;
    opened.focus();
  } else {
    window.open(fullUrl, '_blank', 'noopener,noreferrer');
  }
}

export interface SpaceSyncBroadcast {
  type: 'artifact_saved';
  artifactId: string;
  threadId?: string;
  headVersion?: number;
}

export function broadcastSpaceSync(msg: SpaceSyncBroadcast): void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel('dw2-space-sync');
    ch.postMessage(msg);
    ch.close();
  } catch {
    // ignore unsupported BroadcastChannel
  }
}
