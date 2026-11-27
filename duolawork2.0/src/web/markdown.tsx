import React, { useState } from 'react';
import { Check, Download, ExternalLink, FolderPlus, Maximize2, X } from 'lucide-react';

export interface MarkdownImageActions {
  onSaveToSpace?: (src: string, alt: string) => Promise<'saved' | 'already' | 'error'>;
  onOpenInSpace?: (fileId: string) => void;
  onDownloadLocal?: (src: string, alt: string) => void;
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
  return m ? decodeURIComponent(m[1]) : null;
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
        <div className="dw-chat-image-stage" onClick={() => setLightboxOpen(true)} title="点击查看大图">
          <img src={src} alt={label || '图片'} loading="lazy" />
          <span className="dw-chat-image-zoom" aria-hidden="true">
            <Maximize2 size={12} />
          </span>
        </div>
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

function renderInline(
  text: string,
  keyPrefix: string,
  imageActions?: MarkdownImageActions
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const tokenRegex =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!\[([^\]]*)\]\(([^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      out.push(<code key={`${keyPrefix}-c-${part++}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b-${part++}`}>{token.slice(2, -2)}</strong>);
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
      out.push(
        <a key={`${keyPrefix}-a-${part++}`} href={match[5]} target="_blank" rel="noreferrer">
          {match[4]}
        </a>
      );
    } else {
      out.push(token);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }
  return out.length > 0 ? out : [text];
}

export function MarkdownView({
  text,
  className = '',
  imageActions
}: {
  text: string;
  className?: string;
  imageActions?: MarkdownImageActions;
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
    if (standaloneImg && isAllowedImageSrc(standaloneImg[2])) {
      blocks.push(
        <ChatImageCard
          key={`blk-${key++}`}
          src={standaloneImg[2]}
          alt={standaloneImg[1] || ''}
          actions={imageActions}
        />
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
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = renderInline(headingMatch[2].trim(), `h-${key}`, imageActions);
      if (level === 1) blocks.push(<h1 key={`blk-${key++}`}>{body}</h1>);
      else if (level === 2) blocks.push(<h2 key={`blk-${key++}`}>{body}</h2>);
      else blocks.push(<h3 key={`blk-${key++}`}>{body}</h3>);
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
            <p key={idx}>{renderInline(ql, `q-${key}-${idx}`, imageActions)}</p>
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
            <li key={idx}>{renderInline(it, `ul-${key}-${idx}`, imageActions)}</li>
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
            <li key={idx}>{renderInline(it, `ol-${key}-${idx}`, imageActions)}</li>
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
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^!\[([^\]]*)\]\(([^\s)]+)\)$/.test(lines[i].trim()) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('>') &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`blk-${key++}`}>
        {renderInline(pLines.join(' '), `p-${key}`, imageActions)}
      </p>
    );
  }

  return <div className={`dw-prose ${className}`}>{blocks}</div>;
}
