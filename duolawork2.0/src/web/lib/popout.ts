export interface PopoutTarget {
  kind: 'document' | 'file';
  id: string;
  threadId?: string;
  title?: string;
  mimeType?: string;
  previewKind?: string;
}

interface DesktopPopoutBridge {
  isDesktop?: boolean;
  openPopoutWindow?: (opts: {
    path: string;
    title: string;
    key: string;
    width?: number;
    height?: number;
  }) => Promise<{ ok?: boolean }>;
  setAlwaysOnTop?: (alwaysOnTop: boolean) => Promise<{ ok?: boolean; alwaysOnTop?: boolean }>;
  setTheme?: (theme: 'light' | 'dark') => Promise<unknown>;
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

export async function openMaterialPopout(target: PopoutTarget): Promise<void> {
  if (typeof window === 'undefined') return;
  const relPath = buildPopoutPath(target);
  const title = target.title || (target.kind === 'document' ? '文档阅读器' : '文件预览');
  const key = `${target.kind}:${target.id}`;
  const bridge = getPopoutDesktopBridge();

  if (bridge?.openPopoutWindow) {
    try {
      const res = await bridge.openPopoutWindow({
        path: relPath,
        title,
        key,
        width: 1080,
        height: 800
      });
      if (res?.ok) return;
    } catch {
      // fall back to browser popup below
    }
  }

  const fullUrl = new URL(relPath, window.location.origin).toString();
  const winName = `dw2_popout_${target.kind}_${target.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const opened = window.open(fullUrl, winName, 'popup,width=1080,height=800,resizable=yes,scrollbars=yes');
  if (opened) {
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
