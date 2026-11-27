import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { highlightCodeLine, MarkdownView } from './markdown.js';

export type RichTextFormat = 'markdown' | 'html' | 'csv' | 'json' | 'code' | 'plain';

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'cs', 'rb', 'php', 'sql', 'css', 'scss', 'less', 'sh', 'bash',
  'zsh', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'dockerfile', 'graphql'
]);

export function detectTextFileFormat(title: string, mimeType?: string): {
  format: RichTextFormat;
  lang: string;
} {
  const lower = (title || '').trim().toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';

  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || mime.includes('markdown')) {
    return { format: 'markdown', lang: 'markdown' };
  }
  if (ext === 'html' || ext === 'htm' || mime.includes('text/html')) {
    return { format: 'html', lang: 'html' };
  }
  if (ext === 'csv' || ext === 'tsv' || mime.includes('csv') || mime.includes('tab-separated')) {
    return { format: 'csv', lang: ext === 'tsv' ? 'tsv' : 'csv' };
  }
  if (ext === 'json' || ext === 'jsonl' || mime.includes('json')) {
    return { format: 'json', lang: 'json' };
  }
  if (CODE_EXTS.has(ext)) {
    return { format: 'code', lang: ext };
  }
  return { format: 'plain', lang: ext || 'text' };
}

function parseDelimitedRows(raw: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = raw.replace(/\r\n/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= 500) break;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  return rows;
}

export function RichTextFileViewer({
  title,
  mimeType,
  content,
  loading,
  error,
  readerStyle = false
}: {
  title: string;
  mimeType?: string;
  content: string;
  loading?: boolean;
  error?: boolean;
  readerStyle?: boolean;
}): React.JSX.Element {
  const { format, lang } = useMemo(() => detectTextFileFormat(title, mimeType), [title, mimeType]);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [copied, setCopied] = useState(false);

  const prettyJson = useMemo(() => {
    if (format !== 'json' || !content.trim()) return null;
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
  }, [format, content]);

  const csvRows = useMemo(() => {
    if (format !== 'csv' || !content.trim()) return [];
    const delimiter: ',' | '\t' = lang === 'tsv' ? '\t' : ',';
    return parseDelimitedRows(content, delimiter);
  }, [format, lang, content]);

  const handleCopy = () => {
    const payload = format === 'json' && viewMode === 'rendered' && prettyJson ? prettyJson : content;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  if (loading) {
    return <pre className="material-file-text">正在读取文件内容…</pre>;
  }
  if (error) {
    return <pre className="material-file-text">读取文件内容失败</pre>;
  }

  const canToggleRendered = format === 'markdown' || format === 'html' || format === 'csv' || (format === 'json' && Boolean(prettyJson));
  const renderedLabel =
    format === 'markdown'
      ? '排版预览'
      : format === 'html'
        ? '网页预览'
        : format === 'csv'
          ? '表格预览'
          : '格式化';

  const renderToolbar = () => (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {lang}
        {format === 'csv' && csvRows.length > 0 ? ` · ${Math.max(0, csvRows.length - 1)} 行` : ''}
      </span>
      <div className="flex items-center gap-1.5">
        {canToggleRendered && (
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('rendered')}
              className={
                viewMode === 'rendered'
                  ? 'rounded-md bg-background px-2 py-0.5 text-[11px] font-medium text-foreground shadow-xs/5 ring-1 ring-border/70'
                  : 'rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground'
              }
            >
              {renderedLabel}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              className={
                viewMode === 'source'
                  ? 'rounded-md bg-background px-2 py-0.5 text-[11px] font-medium text-foreground shadow-xs/5 ring-1 ring-border/70'
                  : 'rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground'
              }
            >
              源码
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
    </div>
  );

  // 1. Markdown file -> rich rendered typography by default!
  if (format === 'markdown' && viewMode === 'rendered') {
    return (
      <div className="flex flex-col">
        {renderToolbar()}
        <div className={readerStyle ? '' : 'rounded-xl border border-border bg-card p-4'}>
          <MarkdownView
            text={content || '(空文档)'}
            className={readerStyle ? 'dw-reader-prose' : ''}
          />
        </div>
      </div>
    );
  }

  // 2. HTML file -> sandboxed iframe preview
  if (format === 'html' && viewMode === 'rendered') {
    return (
      <div className="flex flex-col">
        {renderToolbar()}
        <iframe
          sandbox=""
          srcDoc={content}
          title={title}
          className={readerStyle ? 'h-[calc(100vh-170px)] w-full rounded-xl border border-border bg-white' : 'material-pdf-frame'}
        />
      </div>
    );
  }

  // 3. CSV / TSV file -> formatted scrollable table
  if (format === 'csv' && viewMode === 'rendered' && csvRows.length > 0) {
    const [header, ...body] = csvRows;
    return (
      <div className="flex flex-col">
        {renderToolbar()}
        <div className="dw-md-table-wrap max-h-[65vh] overflow-auto coss-scroll">
          <table className="dw-md-table">
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                {header.map((col, idx) => (
                  <th key={idx} className="text-left">
                    {col || `列 ${idx + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{r[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 4. JSON pretty-printed or Code file with line numbers
  if ((format === 'json' && viewMode === 'rendered' && prettyJson) || format === 'code') {
    const displayText = format === 'json' && prettyJson ? prettyJson : content || '(空文件)';
    const lines = displayText.replace(/\r\n/g, '\n').split('\n');
    return (
      <div className="flex flex-col">
        {renderToolbar()}
        <div className="overflow-auto rounded-xl border border-border bg-muted/45 font-mono text-xs leading-relaxed coss-scroll">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((ln, idx) => (
                <tr key={idx} className="hover:bg-muted/60">
                  <td className="w-10 select-none border-r border-border/60 px-2.5 py-0.5 text-right text-[10.5px] text-muted-foreground/70 tabular-nums">
                    {idx + 1}
                  </td>
                  <td className="whitespace-pre px-3 py-0.5 text-foreground">
                    {ln ? highlightCodeLine(ln) : ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 5. Source view or plain text file (preserves `.material-file-text` selector for E2E tests!)
  return (
    <div className="flex flex-col">
      {renderToolbar()}
      <pre className="material-file-text coss-scroll">{content || '(空文件)'}</pre>
    </div>
  );
}
