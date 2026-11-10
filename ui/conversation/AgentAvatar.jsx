import React,{useState} from 'react';
import {Bot,UserRound} from 'lucide-react';
import openai from '../assets/brands/openai.png';
import codex from '../assets/brands/codex.png';
import dot from '../assets/brands/dot.svg';
import claude from '../assets/brands/claude.svg';
import deepseek from '../assets/brands/dsh.png';
import grok from '../assets/brands/grok-bot.png';
import gemini from '../assets/brands/gemini.png';
import antigravity from '../assets/brands/antigravity-app.png';
import muse from '../assets/brands/muse.svg';
import cursor from '../assets/brands/cursor.png';
import perplexity from '../assets/brands/perplexity.png';
import kimi from '../assets/brands/kimi.png';
import qwen from '../assets/brands/qwen.png';
import opencode from '../assets/brands/opencode.png';
import qoder from '../assets/brands/qoder.png';
import github from '../assets/brands/github.png';
import codebuddy from '../assets/brands/codebuddy.svg';

const brands={'cursor-cli':[cursor,'Cursor','cursor'],'perplexity-computer':[perplexity,'Perplexity','perplexity'],'kimi-code':[kimi,'Kimi','kimi'],'qwen-code':[qwen,'Qwen','qwen'],qwenwork:[qwen,'Qwen','qwen'],opencode:[opencode,'OpenCode','opencode'],'qoder-cli':[qoder,'Qoder','qoder'],'copilot-cli':[github,'GitHub','github'],'codebuddy-code':[codebuddy,'CodeBuddy','codebuddy'],codex:[codex,'Codex','codex','app-icon'],'claude-code':[claude,'Claude','claude'],'deepseek-harness':[deepseek,'DeepSeek Harness','deepseek','app-icon'],'grok-bot':[grok,'Grok Bot','grok','app-icon'],dots:[dot,'ChatGPT Dot','dot','mascot'],'chatgpt-agent':[openai,'ChatGPT','openai'],gemini:[gemini,'Gemini','gemini'],'gemini-cli':[gemini,'Gemini','gemini'],antigravity:[antigravity,'Antigravity','antigravity','app-icon'],muse:[muse,'Muse','muse']};
// Brand artwork is stored locally, unchanged. No remote image requests or
// inferred provider from a user's editable nickname.
export default function AgentAvatar({platformId,name,id,small=false,className=''}){
  const brand=brands[platformId],src=brand?.[0],[failed,setFailed]=useState(null);
  return <span className={`chat-face agent-avatar ${small?'small ':''}${id==='owner'?'mine ':''}${brand?'brand-'+brand[2]:''} ${className}`} title={brand?`${name||brand[1]} · ${brand[1]}`:name}>
    {id==='owner'?<UserRound aria-hidden="true"/>:src&&failed!==src?<img src={src} alt={brand[1]} data-artwork={brand[3]||'mark'} draggable={false} onError={()=>setFailed(src)}/>:<Bot aria-hidden="true"/>}
  </span>;
}
