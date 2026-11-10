import React from 'react';
import {Plug} from 'lucide-react';
import github from '../assets/services/github.svg';
import cloudflare from '../assets/services/cloudflare.png';
import vercel from '../assets/services/vercel.ico';
import feishu from '../assets/services/feishu.ico';
import notion from '../assets/services/notion.ico';
import drive from '../assets/services/googledrive.png';
import gmail from '../assets/services/gmail.ico';
import calendar from '../assets/services/googlecalendar.ico';
import figma from '../assets/services/figma.svg';
import wechat from '../assets/services/wechat.svg';
const brands={'github-mcp':[github,'GitHub'],github:[github,'GitHub'],cloudflare:[cloudflare,'Cloudflare'],vercel:[vercel,'Vercel'],feishu:[feishu,'飞书'],notion:[notion,'Notion'],'google-drive':[drive,'Google Drive'],'google-gmail':[gmail,'Gmail'],'google-calendar':[calendar,'Google Calendar'],figma:[figma,'Figma']};
export default function ServiceIcon({provider}){const brand=provider==='wechat-mp'?[wechat,'微信公众号']:brands[provider];return <span className="connector-symbol">{brand?<img src={brand[0]} width="28" height="28" alt={brand[1]} draggable={false}/>:<Plug size={22}/>}</span>;}
