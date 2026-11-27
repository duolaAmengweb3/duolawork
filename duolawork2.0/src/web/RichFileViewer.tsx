import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { highlightCodeLine, MarkdownView } from './markdown.js';
import { useI18n } from './lib/i18n.js';

import { detectTextFileFormat } from '../shared/file-format.js';
export { detectTextFileFormat } from '../shared/file-format.js';

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
      if (rows.length >= 502) break;
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
  const { L } = useI18n();
  const { format, lang } = useMemo(() => detectTextFileFormat(title, mimeType), [title, mimeType]);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [copied, setCopied] = useState(false);

  const prettyJson = useMemo(() => {
    if (format !== 'json' || !content.trim()) return null;
    try {
      if (lang === 'jsonl') {
        return content.split(/\r?\n/).filter(line => line.trim()).map(line =>
          JSON.stringify(JSON.parse(line), null, 2)
        ).join('\n');
      }
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
  }, [format, lang, content]);

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
    return <pre className="material-file-text">{L('正在读取文件内容…', 'Loading file content…')}</pre>;
  }
  if (error) {
    return <pre className="material-file-text">{L('读取文件内容失败', 'Failed to read file content')}</pre>;
  }

  const canToggleRendered = format === 'markdown' || format === 'html' || format === 'csv' || (format === 'json' && Boolean(prettyJson));
  const renderedLabel =
    format === 'markdown'
      ? L('排版预览', 'Formatted')
      : format === 'html'
        ? L('网页预览', 'Preview')
        : format === 'csv'
          ? L('表格预览', 'Table')
          : L('格式化', 'Formatted');

  const renderToolbar = () => (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {lang}
        {format === 'csv' && csvRows.length > 0
          ? ` · ${
              csvRows.length > 501
                ? L('仅显示前 500 行，完整内容可下载', 'Showing first 500 rows; download for full file')
                : `${csvRows.length - 1} ${L('行', 'rows')}`
            }`
          : ''}
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
              {L('源码', 'Source')}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? L('已复制', 'Copied') : L('复制', 'Copy')}</span>
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
            text={content || L('(空文档)', '(Empty document)')}
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
                    {col || L(`列 ${idx + 1}`, `Col ${idx + 1}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.slice(0, 500).map((r, ri) => (
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
    const displayText = format === 'json' && prettyJson ? prettyJson : content || L('(空文件)', '(Empty file)');
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
      <pre className="material-file-text coss-scroll">{content || L('(空文件)', '(Empty file)')}</pre>
    </div>
  );
}
