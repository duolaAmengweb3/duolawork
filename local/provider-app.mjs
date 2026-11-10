import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Only known native applications; no arbitrary command, URL or profile path.
export async function openProviderApp(platformId, { platform = process.platform, exec = execute } = {}) {
  if (platformId !== 'grok-bot') throw new Error('此平台暂无桌面打开入口，请在自己的 Agent 中查看接入说明。');
  if (platform !== 'darwin') throw new Error('请手动打开官方 Grok Bot 桌面版，选择正在接入的 Bot。');
  try { await exec('/usr/bin/open', ['-b', 'com.anysphere.sand'], { timeout: 10000 }); }
  catch { throw new Error('未能打开 Grok Bot 桌面版。请先从官方入门页安装或手动打开，不要在网页版寻找密钥。'); }
  return { opened: true };
}
