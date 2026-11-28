import type { SpaceItemView } from './types.js';

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
    return { format: 'csv', lang: ext === 'tsv' || mime.includes('tab-separated') ? 'tsv' : 'csv' };
  }
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson' || mime.includes('json')) {
    return { format: 'json', lang: /^(jsonl|ndjson)$/.test(ext) || mime.includes('ndjson') ? 'jsonl' : 'json' };
  }
  if (CODE_EXTS.has(ext || lower)) {
    return { format: 'code', lang: ext || lower };
  }
  return { format: 'plain', lang: ext || 'text' };
}

export function detectPreviewKind(
  name: string,
  mimeType: string
): SpaceItemView['previewKind'] {
  const lower = name.toLowerCase();
  mimeType = mimeType.toLowerCase().split(';')[0].trim();
  if (/\.(docx|xlsx|pptx|docm|xlsm|pptm|zip|odt|ods|odp)$/i.test(lower) ||
      mimeType.includes('officedocument') || mimeType.includes('opendocument')) return 'binary';
  if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(lower)) return 'image';
  if (mimeType.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(lower)) return 'video';
  if (mimeType.startsWith('audio/') || /\.(mp3|wav|m4a)$/i.test(lower)) return 'audio';
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(lower)) return 'pdf';
  if (
    detectTextFileFormat(name, mimeType).format !== 'plain' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    (mimeType === 'application/xml' || mimeType.endsWith('+xml')) ||
    mimeType.includes('sql') ||
    /\.(txt|md|csv|json|log|html?|css|xml|sql|sh|toml|ts|tsx|js|jsx|py|yml|yaml)$/i.test(lower)
  ) {
    return 'text';
  }
  return 'binary';
}
