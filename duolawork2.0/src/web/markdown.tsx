import React, { useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Maximize2,
  X
} from 'lucide-react';

export interface MarkdownImageActions {
  onSaveToSpace?: (src: string, alt: string) => Promise<'saved' | 'already' | 'error'>;
  onOpenInSpace?: (fileId: string) => void;
  onDownloadLocal?: (src: string, alt: string) => void;
}

export interface MarkdownSpaceItemRef {
  kind: 'document' | 'file' | 'link';
  id: string;
  title: string;
  folderPath?: string;
  previewKind?: string;
  url?: string;
}

export interface MarkdownSpaceFolderRef {
  id: string;
  title: string;
  path: string;
}

export interface MarkdownSpaceResolver {
  items: MarkdownSpaceItemRef[];
  folders: MarkdownSpaceFolderRef[];
  onOpenItem: (item: MarkdownSpaceItemRef) => void;
  onOpenFolder: (folderId: string) => void;
}

type ResolvedSpaceTarget =
  | { type: 'item'; item: MarkdownSpaceItemRef }
  | { type: 'folder'; folder: MarkdownSpaceFolderRef };

function normalizeRefPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^资料\//, '')
    .replace(/\/+$/, '');
}

function resolveSpaceRef(
  rawToken: string,
  resolver?: MarkdownSpaceResolver
): ResolvedSpaceTarget | null {
  if (!resolver) return null;
  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.length > 220) return null;
  const explicitlyFolder = trimmed.endsWith('/');
  const norm = normalizeRefPath(trimmed);
  if (!norm) return null;
  const lower = norm.toLowerCase();

  // 1. Folder match first if token explicitly ends with `/`
  if (explicitlyFolder) {
    const byPath = resolver.folders.find((f) => normalizeRefPath(f.path).toLowerCase() === lower);
    if (byPath) return { type: 'folder', folder: byPath };
    const byTitle = resolver.folders.find((f) => f.title.trim().toLowerCase() === lower);
    if (byTitle) return { type: 'folder', folder: byTitle };
    return null;
  }

  // 2. Match explicit item ID (`art_...`, `fil_...`, `lnk_...`)
  if (/^(?:art|fil|lnk)_[a-zA-Z0-9_-]{6,}$/.test(norm)) {
    const byId = resolver.items.find((it) => it.id === norm);
    if (byId) return { type: 'item', item: byId };
  }

  // 3. Exact full path match (`folderPath/title`)
  for (const it of resolver.items) {
    const fullPath = it.folderPath ? `${normalizeRefPath(it.folderPath)}/${it.title}` : it.title;
    if (fullPath.toLowerCase() === lower) {
      return { type: 'item', item: it };
    }
  }

  // 4. Exact title match (or basename match when path prefix differs, e.g. moved out of subfolder)
  const baseName = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1).toLowerCase() : lower;
  for (const it of resolver.items) {
    if (it.title.trim().toLowerCase() === lower) {
      return { type: 'item', item: it };
    }
  }
  if (baseName !== lower && baseName.length >= 3) {
    for (const it of resolver.items) {
      if (it.title.trim().toLowerCase() === baseName) {
        return { type: 'item', item: it };
      }
    }
  }

  // 5. Match document title without `.md` extension (avoid short generic words)
  if (lower.length >= 4) {
    for (const it of resolver.items) {
      const noExt = it.title.trim().toLowerCase().replace(/\.md$/i, '');
      if (noExt.length >= 4 && noExt === lower) {
        return { type: 'item', item: it };
      }
    }
  }

  // 6. Match folder by path or title
  const fldByPath = resolver.folders.find((f) => normalizeRefPath(f.path).toLowerCase() === lower);
  if (fldByPath) return { type: 'folder', folder: fldByPath };
  if (lower.length >= 2) {
    const fldByTitle = resolver.folders.find((f) => f.title.trim().toLowerCase() === lower);
    if (fldByTitle) return { type: 'folder', folder: fldByTitle };
  }

  return null;
}

function renderSpaceRefChip(
  target: ResolvedSpaceTarget,
  displayText: string,
  resolver: MarkdownSpaceResolver,
  key: string
): React.JSX.Element {
  if (target.type === 'folder') {
    return (
      <button
        key={key}
        type="button"
        className="dw-space-ref-chip is-folder"
        data-space-ref-folder={target.folder.id}
        onClick={() => resolver.onOpenFolder(target.folder.id)}
        title={`点击在右侧文档管理打开文件夹「${target.folder.path}」`}
      >
        <Folder size={12} />
        <span>{displayText}</span>
      </button>
    );
  }
  const it = target.item;
  const Icon =
    it.kind === 'document'
      ? FileText
      : it.kind === 'link'
        ? Link2
        : it.previewKind === 'image'
          ? ImageIcon
          : File;
  return (
    <button
      key={key}
      type="button"
      className="dw-space-ref-chip"
      data-space-ref-item={`${it.kind}:${it.id}`}
      onClick={() => resolver.onOpenItem(it)}
      title={`点击在右侧协作空间直接打开「${it.title}」`}
    >
      <Icon size={12} />
      <span>{displayText}</span>
    </button>
  );
}

function isAllowedImageSrc(raw: string): boolean {
  const s = raw.trim();
  return (
    s.startsWith('https://') ||
    s.startsWith('http://') ||
    s.startsWith('/api/v2/space/files/') ||
    s.startsWith('/api/v2/chat-images/') ||
    /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(s)
  );
}

function extractSpaceFileId(src: string): string | null {
  const m = src.trim().match(/^\/api\/v2\/space\/files\/([^?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function ChatImageCard({
  src,
  alt,
  actions
}: {
  src: string;
  alt: string;
  actions?: MarkdownImageActions;
}): React.JSX.Element {
  const spaceFileId = extractSpaceFileId(src);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    spaceFileId ? 'saved' : 'idle'
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const label = alt.trim() && alt.trim() !== src ? alt.trim() : '';

  const handleSave = async () => {
    if (spaceFileId && actions?.onOpenInSpace) {
      actions.onOpenInSpace(spaceFileId);
      return;
    }
    if (!actions?.onSaveToSpace || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const res = await actions.onSaveToSpace(src, label);
      setSaveState(res === 'error' ? 'error' : 'saved');
    } catch {
      setSaveState('error');
    }
  };

  const handleDownload = () => {
    if (actions?.onDownloadLocal) {
      actions.onDownloadLocal(src, label);
      return;
    }
    const href = src.startsWith('/api/v2/')
      ? `${src}${src.includes('?') ? '&' : '?'}download=1`
      : `/api/v2/media/download?url=${encodeURIComponent(src)}${label ? `&name=${encodeURIComponent(label)}` : ''}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = label || 'image';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <>
      <figure className="dw-chat-image-card" data-testid="chat-image-card">
        <button type="button" className="dw-chat-image-stage" onClick={() => setLightboxOpen(true)} aria-label={`查看大图：${label || '图片'}`} title="点击查看大图">
          <img src={src} alt={label || '图片'} loading="lazy" />
          <span className="dw-chat-image-zoom" aria-hidden="true">
            <Maximize2 size={12} />
          </span>
        </button>
        {(actions || label) && (
          <figcaption className="dw-chat-image-bar">
            {label && (
              <span className="dw-chat-image-caption" title={label}>
                {label}
              </span>
            )}
            {actions && (
              <div className="dw-chat-image-actions">
                {(actions.onSaveToSpace || (spaceFileId && actions.onOpenInSpace)) && (
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saveState === 'saving'}
                    className={`dw-chat-img-btn ${saveState === 'saved' && !spaceFileId ? 'is-saved' : ''}`}
                    title={spaceFileId ? '在右侧协作空间中打开' : '保存到当前对话右侧协作空间'}
                  >
                    {spaceFileId ? (
                      <>
                        <ExternalLink size={11} />
                        <span>在资料区查看</span>
                      </>
                    ) : saveState === 'saved' ? (
                      <>
                        <Check size={11} />
                        <span>已存入资料区</span>
                      </>
                    ) : (
                      <>
                        <FolderPlus size={11} />
                        <span>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '重试存入' : '保存到资料区'}</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDownload}
                  className="dw-chat-img-btn"
                  title="下载图片到本地设备"
                >
                  <Download size={11} />
                  <span>保存到本地</span>
                </button>
              </div>
            )}
          </figcaption>
        )}
      </figure>

      {lightboxOpen && (
        <div
          className="dw-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="大图预览"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="dw-image-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="dw-image-lightbox-close"
              onClick={() => setLightboxOpen(false)}
              aria-label="关闭大图预览"
            >
              <X size={18} />
            </button>
            <img src={src} alt={label || '大图预览'} />
            <div className="dw-image-lightbox-bar">
              {label && <span>{label}</span>}
              <div className="dw-chat-image-actions">
                {actions && (actions.onSaveToSpace || (spaceFileId && actions.onOpenInSpace)) && (
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saveState === 'saving'}
                    className="dw-chat-img-btn"
                  >
                    {spaceFileId ? (
                      <>
                        <ExternalLink size={12} />
                        <span>在资料区查看</span>
                      </>
                    ) : saveState === 'saved' ? (
                      <>
                        <Check size={12} />
                        <span>已存入资料区</span>
                      </>
                    ) : (
                      <>
                        <FolderPlus size={12} />
                        <span>保存到资料区</span>
                      </>
                    )}
                  </button>
                )}
                <button type="button" onClick={handleDownload} className="dw-chat-img-btn">
                  <Download size={12} />
                  <span>保存到本地</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const filenamePatterns = new WeakMap<MarkdownSpaceResolver, RegExp>();
function filenamePattern(resolver: MarkdownSpaceResolver) {
    const cached = filenamePatterns.get(resolver);
    if (cached) return cached;
    const names = resolver.items.map(it => it.title).filter(name => /\.[a-z0-9]{1,12}$/i.test(name));
    if (!names.length) return null;
    const byLength = [...new Set(names)].sort((a,b) => b.length - a.length);
    const options = byLength.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp('(?<![\\w./-])(?:' + options + ')(?![\\w/-]|\\.[a-z0-9])', 'gi');
    filenamePatterns.set(resolver,pattern);
    return pattern;
}

function renderInline(
  text: string,
  keyPrefix: string,
  imageActions?: MarkdownImageActions,
  spaceResolver?: MarkdownSpaceResolver,
  depth = 0
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const tokenRegex =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!\[([^\]]*)\]\(([^\s)]+)\)|\[([^\]]+)\]\(((?:https?:\/\/|\/api\/v2\/(?:space\/files|chat-images)\/)[^\s)]+)\)|《([^《》\n]{2,140})》|「([^「」\n]{2,140})」|(https?:\/\/[^\s<>()[\]"'，。；、！？）】》]+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  const appendPlain = (plain: string) => {
    if (!spaceResolver) { out.push(plain); return; }
    const pattern = filenamePattern(spaceResolver);
    if (!pattern) { out.push(plain); return; }
    let from = 0;
    for (const match of plain.matchAll(pattern)) {
      const exact = spaceResolver.items.filter(it => it.title.toLowerCase() === match[0].toLowerCase());
      if (exact.length !== 1) continue;
      out.push(plain.slice(from,match.index), renderSpaceRefChip({type:'item', item:exact[0]}, match[0], spaceResolver, keyPrefix + '-file-' + part++));
      from = match.index + match[0].length;
    }
    out.push(plain.slice(from));
  };
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendPlain(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      const inner = token.slice(1, -1);
      const resolved = resolveSpaceRef(inner, spaceResolver);
      if (resolved && spaceResolver) {
        out.push(renderSpaceRefChip(resolved, inner, spaceResolver, `${keyPrefix}-sr-${part++}`));
      } else {
        out.push(<code key={`${keyPrefix}-c-${part++}`}>{inner}</code>);
      }
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const inner = token.slice(2, -2);
      out.push(
        <strong key={`${keyPrefix}-b-${part++}`}>
          {depth < 2
            ? renderInline(inner, `${keyPrefix}-bi-${part}`, imageActions, spaceResolver, depth + 1)
            : inner}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      out.push(<em key={`${keyPrefix}-i-${part++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('![') && match[3] && isAllowedImageSrc(match[3])) {
      out.push(
        <ChatImageCard
          key={`${keyPrefix}-img-${part++}`}
          src={match[3]}
          alt={match[2] || ''}
          actions={imageActions}
        />
      );
    } else if (match[4] && match[5]) {
      const href = match[5];
      const spaceFileId = extractSpaceFileId(href);
      if (spaceFileId && spaceResolver) {
        const matchedItem = spaceResolver.items.find((it) => it.kind === 'file' && it.id === spaceFileId);
        if (matchedItem) {
          out.push(
            renderSpaceRefChip(
              { type: 'item', item: matchedItem },
              match[4],
              spaceResolver,
              `${keyPrefix}-ml-${part++}`
            )
          );
        } else {
          out.push(
            <a key={`${keyPrefix}-a-${part++}`} href={href} target="_blank" rel="noreferrer">
              {match[4]}
            </a>
          );
        }
      } else {
        out.push(
          <a key={`${keyPrefix}-a-${part++}`} href={href} target="_blank" rel="noreferrer">
            {match[4]}
          </a>
        );
      }
    } else if (match[6] || match[7]) {
      const quoted = (match[6] || match[7] || '').trim();
      const resolved = resolveSpaceRef(quoted, spaceResolver);
      if (resolved && spaceResolver) {
        out.push(renderSpaceRefChip(resolved, quoted, spaceResolver, `${keyPrefix}-qr-${part++}`));
      } else {
        out.push(token);
      }
    } else if (match[8]) {
      const cleanedUrl = match[8].replace(/[.,;:!?)]+$/, '');
      const trailing = match[8].slice(cleanedUrl.length);
      out.push(
        <a
          key={`${keyPrefix}-u-${part++}`}
          href={cleanedUrl}
          target="_blank"
          rel="noreferrer"
          className="dw-bare-link"
        >
          {cleanedUrl}
        </a>
      );
      if (trailing) out.push(trailing);
    } else {
      out.push(token);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    appendPlain(text.slice(lastIndex));
  }
  return out.length > 0 ? out : [text];
}

export function MarkdownView({
  text,
  className = '',
  imageActions,
  spaceResolver
}: {
  text: string;
  className?: string;
  imageActions?: MarkdownImageActions;
  spaceResolver?: MarkdownSpaceResolver;
}): React.JSX.Element {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      blocks.push(
        <pre key={`blk-${key++}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Standalone image line -> render directly as figure without wrapping in <p>
    const standaloneImg = line.trim().match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (standaloneImg) {
      blocks.push(
        isAllowedImageSrc(standaloneImg[2]) ? (
          <ChatImageCard
            key={`blk-${key++}`}
            src={standaloneImg[2]}
            alt={standaloneImg[1] || ''}
            actions={imageActions}
          />
        ) : (
          <p key={`blk-${key++}`}>{standaloneImg[1] || '图片'}（图片地址无法在此打开）</p>
        )
      );
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`blk-${key++}`} />);
      i += 1;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = renderInline(headingMatch[2].trim(), `h-${key}`, imageActions, spaceResolver);
      blocks.push(React.createElement('h' + level, {key:'blk-' + key++}, body));
      i += 1;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('>')) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote key={`blk-${key++}`}>
          {qLines.map((ql, idx) => (
            <p key={idx}>{renderInline(ql, `q-${key}-${idx}`, imageActions, spaceResolver)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={`blk-${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ul-${key}-${idx}`, imageActions, spaceResolver)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`blk-${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol-${key}-${idx}`, imageActions, spaceResolver)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Paragraph (consume consecutive plain lines, stopping at standalone image lines)
    // Always consume the current line, including unrecognized Markdown.
    const pLines: string[] = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^!\[([^\]]*)\]\(([^\s)]+)\)$/.test(lines[i].trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('>') &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`blk-${key++}`}>
        {renderInline(pLines.join(' '), `p-${key}`, imageActions, spaceResolver)}
      </p>
    );
  }

  return <div className={`dw-prose ${className}`}>{blocks}</div>;
}
