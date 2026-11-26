import React from 'react';

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
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
    } else if (match[2] && match[3]) {
      out.push(
        <a
          key={`${keyPrefix}-a-${part++}`}
          href={match[3]}
          target="_blank"
          rel="noreferrer"
        >
          {match[2]}
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
  className = ''
}: {
  text: string;
  className?: string;
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
      const body = renderInline(headingMatch[2].trim(), `h-${key}`);
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
            <p key={idx}>{renderInline(ql, `q-${key}-${idx}`)}</p>
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
            <li key={idx}>{renderInline(it, `ul-${key}-${idx}`)}</li>
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
            <li key={idx}>{renderInline(it, `ol-${key}-${idx}`)}</li>
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

    // Paragraph (consume consecutive plain lines)
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
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
        {renderInline(pLines.join(' '), `p-${key}`)}
      </p>
    );
  }

  return <div className={`dw-prose ${className}`}>{blocks}</div>;
}
