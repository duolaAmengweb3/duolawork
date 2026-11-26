import React, { useState } from 'react';
import { Bot, UserRound } from 'lucide-react';
import openai from './assets/brands/openai.png';
import codex from './assets/brands/codex.png';
import dot from './assets/brands/dot.svg';
import claude from './assets/brands/claude.svg';
import deepseek from './assets/brands/dsh.png';
import grok from './assets/brands/grok-bot.png';
import gemini from './assets/brands/gemini.png';
import antigravity from './assets/brands/antigravity-app.png';
import muse from './assets/brands/muse.svg';
import cursor from './assets/brands/cursor.png';
import perplexity from './assets/brands/perplexity.png';
import kimi from './assets/brands/kimi.png';
import qwen from './assets/brands/qwen.png';
import opencode from './assets/brands/opencode.png';
import qoder from './assets/brands/qoder.png';
import github from './assets/brands/github.png';
import codebuddy from './assets/brands/codebuddy.svg';
import type { MemberStatus } from '../shared/types.js';

const BRANDS: Record<string, [string, string, string, string?]> = {
  'cursor-cli': [cursor, 'Cursor', 'cursor'],
  'perplexity-computer': [perplexity, 'Perplexity', 'perplexity'],
  'kimi-code': [kimi, 'Kimi', 'kimi'],
  'qwen-code': [qwen, 'Qwen', 'qwen'],
  qwenwork: [qwen, 'Qwen', 'qwen'],
  opencode: [opencode, 'OpenCode', 'opencode'],
  'qoder-cli': [qoder, 'Qoder', 'qoder'],
  'copilot-cli': [github, 'GitHub', 'github'],
  'codebuddy-code': [codebuddy, 'CodeBuddy', 'codebuddy'],
  codex: [codex, 'Codex', 'codex', 'app-icon'],
  'claude-code': [claude, 'Claude', 'claude'],
  'deepseek-harness': [deepseek, 'DeepSeek Harness', 'deepseek', 'app-icon'],
  'grok-bot': [grok, 'Grok Bot', 'grok', 'app-icon'],
  dots: [dot, 'ChatGPT Dot', 'dot', 'mascot'],
  'chatgpt-agent': [openai, 'ChatGPT', 'openai'],
  openai: [openai, 'ChatGPT', 'openai'],
  gemini: [gemini, 'Gemini', 'gemini'],
  'gemini-cli': [gemini, 'Gemini', 'gemini'],
  antigravity: [antigravity, 'Antigravity', 'antigravity', 'app-icon'],
  muse: [muse, 'Muse', 'muse']
};

export function BrandLogo({
  motion = 'bell',
  loop = true,
  size = 38,
  className = '',
  alt = 'DuolaWork'
}: {
  motion?: 'bell' | 'hand' | 'static';
  loop?: boolean;
  size?: number;
  className?: string;
  alt?: string;
}): React.JSX.Element {
  const file =
    motion === 'static'
      ? 'duolawork-app-primary.svg'
      : `duolawork-${motion === 'hand' ? 'hand-reach' : 'bell-swing'}-primary-${loop ? 'loop' : 'once'}.svg`;
  return (
    <img
      className={`brand-mark ${className}`.trim()}
      src={`/brand/${file}`}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
    />
  );
}

export const BrandMark = BrandLogo;

export function AgentAvatar({
  platformId,
  name,
  id,
  small = false,
  status,
  className = ''
}: {
  platformId?: string;
  name?: string;
  id?: string;
  small?: boolean;
  status?: MemberStatus;
  className?: string;
}): React.JSX.Element {
  const brand =
    platformId === 'chatgpt-agent' && name?.trim().toLowerCase() === 'dot'
      ? BRANDS.dots
      : platformId
        ? BRANDS[platformId]
        : undefined;
  const src = brand?.[0];
  const [failed, setFailed] = useState<string | null>(null);

  const face = (
    <span
      className={`chat-face agent-avatar ${small ? 'small ' : ''}${id === 'owner' ? 'mine ' : ''}${brand ? `brand-${brand[2]} ` : ''}${className}`.trim()}
      title={brand ? `${name || brand[1]} · ${brand[1]}` : name}
    >
      {id === 'owner' ? (
        <UserRound aria-hidden="true" />
      ) : src && failed !== src ? (
        <img
          src={src}
          alt={brand[1]}
          data-artwork={brand[3] || 'mark'}
          draggable={false}
          onError={() => setFailed(src)}
        />
      ) : (
        <Bot aria-hidden="true" />
      )}
    </span>
  );

  if (status) {
    const dotClass =
      status === 'ready'
        ? 'connected'
        : status === 'auth_required'
          ? 'waiting'
          : 'unbound';
    return (
      <span className="avatar-availability" title={name}>
        {face}
        <i className={dotClass} aria-hidden="true" />
      </span>
    );
  }

  return face;
}
