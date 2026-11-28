import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentDriver, GeneratedImage, TurnDispatchInput, TurnStreamEvent } from './types.js';

const maxImageBytes = 24 * 1024 * 1024;

function localPath(src: string, cwd: string): string | null {
  try {
    if (src.startsWith('file:')) return fileURLToPath(src);
    if (src.startsWith('//') || src.startsWith('/api/')) return null;
    if (!path.isAbsolute(src) && /^[a-z][a-z\d+.-]*:/i.test(src)) return null;
    return path.resolve(cwd, decodeURIComponent(src));
  } catch {
    return null;
  }
}

// Resolve Markdown on the executing machine, confined to its assigned workspace.
export function readTurnExport(file: string, cwd: string, maxBytes = 24 * 1024 * 1024): Buffer {
  const root = fs.realpathSync(cwd);
  const real = fs.realpathSync(path.resolve(root, file));
  if (root === path.parse(root).root || root === os.homedir() || root === fs.realpathSync(os.tmpdir()) || !real.startsWith(root + path.sep)) {
    throw new Error('请将文件保存到本回合工作目录后上传');
  }
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error('文件为空、过大或不是普通文件');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!n) throw new Error('读取时文件已变化');
      offset += n;
    }
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function rasterMime(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(data.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

function embed(alt: string, url: string) {
  return `![${alt.replace(/[\[\]\r\n]/g, ' ') || '图片'}](${url})`;
}

export class ChatImageDelivery {
  private readonly uploaded = new Map<string, { url: string; alt: string }>();
  private readonly byPath = new Map<string, string>();

  constructor(private readonly input: TurnDispatchInput) {}

  toolResult(tool: string, args: Record<string, unknown>, result: unknown) {
    if (tool !== 'chat_attach_image' && tool !== 'space_save_file') return;
    if (!result || typeof result !== 'object' || !('markdownEmbed' in result)) return;
    const match = String(result.markdownEmbed).match(/\]\((\/api\/v2\/(?:chat-images|space\/files)\/[\w-]+)\)$/);
    if (!match) return;
    const url = match[1];
    const alt = String(args.alt || args.name || '图片');
    if (tool === 'chat_attach_image') this.uploaded.set(url, { url, alt });
    if (typeof args.localPath === 'string') {
      const file = path.resolve(this.input.cwd, args.localPath);
      if (tool === 'chat_attach_image' || !this.byPath.has(file)) this.byPath.set(file, url);
    }
  }

  private async upload(data: Buffer | null, name: string, alt: string): Promise<string | null> {
    if (!data || data.length > maxImageBytes) return null;
    const mimeType = rasterMime(data);
    if (!mimeType) return null;
    const res = await this.input.onToolCall!('chat_attach_image', {
      dataBase64: data.toString('base64'), name, mimeType, alt
    }) as { url?: string } | null;
    return res?.url && /^\/api\/v2\/chat-images\/[\w-]+$/.test(res.url) ? res.url : null;
  }

  async finish(text: string, nodes: GeneratedImage[] = []): Promise<string> {
    if (!this.input.onToolCall || !this.input.dynamicTools?.some(t => t.name === 'chat_attach_image')) return text;
    const remaining = new Set(nodes);
    const represented = new Set<string>();
    const parts: string[] = [];
    let end = 0;
    let missing = 0;
    // Leave examples inside Markdown code spans and fenced blocks untouched.
    const tokens = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[([^\]\n]*)\]\((?:<([^>\n]+)>|((?:[^()\n]|\([^()\n]*\))+))\)/g;
    for (const match of text.matchAll(tokens)) {
      const src = match[2] ?? match[3];
      if (src === undefined) continue;
      const [raw, alt] = match;
      const imageSyntax = raw.startsWith('!');
      const chatImage = /^\/api\/v2\/chat-images\/[\w-]+$/.test(src);
      if (!imageSyntax && !chatImage && !this.uploaded.has(src) &&
          !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(src)) continue;
      parts.push(text.slice(end, match.index));
      end = match.index + raw.length;
      const file = localPath(src, this.input.cwd);
      if (!file) {
        parts.push(!imageSyntax && (chatImage || this.uploaded.has(src)) ? embed(alt, src) : raw);
        if (this.uploaded.has(src)) represented.add(src);
        continue;
      }
      let url = this.byPath.get(file);
      const native = nodes.find(item => item.localPath === file);
      if (!url) {
        try {
          const data = native ? this.nativeBytes(native) : readTurnExport(file, this.input.cwd);
          url = await this.upload(data, path.basename(file), alt) || undefined;
        } catch { /* Keep the reply and report the undelivered image. */ }
      }
      if (url) {
        this.byPath.set(file, url);
        represented.add(url);
        if (native) remaining.delete(native);
        parts.push(embed(alt, url));
      } else {
        missing++;
        parts.push(raw);
      }
    }
    parts.push(text.slice(end));
    for (const { url, alt } of this.uploaded.values()) {
      if (!represented.has(url)) parts.push('\n\n' + embed(alt, url));
      represented.add(url);
    }
    for (const item of remaining) {
      const receipt = item.localPath && this.byPath.get(item.localPath);
      if (receipt && represented.has(receipt)) remaining.delete(item);
    }
    // Compare actual receipts, so one successful image cannot hide a missing sibling.
    for (const item of remaining) {
      try {
        const alt = `生成图 ${nodes.indexOf(item) + 1}`;
        const url = await this.upload(this.nativeBytes(item), `generated-${item.id}.png`, alt);
        if (!url) { missing++; continue; }
        if (!represented.has(url)) parts.push('\n\n' + embed(alt, url));
        represented.add(url);
      } catch { missing++; }
    }
    if (missing) parts.push(`\n\n有 ${missing} 个图片引用未能上传到当前对话。`);
    return parts.join('').trim();
  }

  private nativeBytes(item: GeneratedImage): Buffer | null {
    if (!item.dataBase64) {
      if (!item.localPath) return null;
      // A native Codex event can refer to its own generated-image store outside the workspace.
      const store = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
      if (path.resolve(item.localPath).startsWith(store + path.sep)) return readTurnExport(item.localPath, store);
      return readTurnExport(item.localPath, this.input.cwd);
    }
    if (item.dataBase64.length > 4 * Math.ceil(maxImageBytes / 3)) return null;
    return Buffer.from(item.dataBase64, 'base64');
  }
}

export async function runWithChatImages(
  driver: AgentDriver,
  input: TurnDispatchInput,
  onEvent?: (ev: TurnStreamEvent) => void,
  observeDelivery?: (delivery: ChatImageDelivery) => void
) {
  // Remote transports finalize on the executor that owns the files.
  if (driver.kind === 'remote-node' || driver.kind === 'remote-bridge' || driver.kind === 'webhook-bot' ||
      !input.onToolCall || !input.dynamicTools?.some(t => t.name === 'chat_attach_image')) {
    return driver.runTurn(input, onEvent);
  }
  const delivery = new ChatImageDelivery(input);
  observeDelivery?.(delivery);
  const invoke = input.onToolCall;
  const { generatedImages, ...result } = await driver.runTurn({
    ...input,
    onToolCall: async (tool, args) => {
      const receipt = await invoke(tool, args);
      delivery.toolResult(tool, args, receipt);
      return receipt;
    }
  }, onEvent);
  return { ...result, text: await delivery.finish(result.text, generatedImages) };
}
