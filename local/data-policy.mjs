import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './storage.mjs';

export const protectedDataDirectories = () => [dataDir, path.join(os.homedir(), 'Library', 'Application Support', 'agent-hub-local')];
const contains = (parent, child) => {const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
async function canonical(filename){let current=path.resolve(filename),suffix=[];for(;;){try{return path.resolve(await fs.realpath(current),...suffix.reverse());}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;const parent=path.dirname(current);if(parent===current)throw e;suffix.push(path.basename(current));current=parent;}}}
// Build/reinstall output may never be a login-data directory, its parent, or a child.
export async function assertArtifactPath(output, protectedRoots=protectedDataDirectories()){
 const artifact=await canonical(output);
 for(const root of protectedRoots){const data=await canonical(root);if(contains(data,artifact)||contains(artifact,data))throw new Error('已阻止构建：安装包输出与持久登录资料目录重叠，不能清理或覆盖。');}
 return artifact;
}

export async function prepareBrowserProfile(directory,accountId,findBrowser,{requestedBrowser}={}){
 const info=path.join(directory,'hub-profile.json');let previous;
 try{previous=JSON.parse(await fs.readFile(info,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('专用浏览器配置无法读取，已保留原资料；不会创建空白登录环境。');}
 if(previous&&previous.accountId!==accountId)throw new Error('专用目录绑定了其他账号，已停止打开；不会覆盖登录资料。');
 const executable=previous?.browserExecutable||await findBrowser();
 if(previous&&requestedBrowser&&path.resolve(requestedBrowser)!==path.resolve(executable))throw new Error('账号已绑定原浏览器，禁止自动切换浏览器导致登录失效。');
 try{await fs.access(executable);}catch{throw new Error('原绑定的浏览器不可用，请恢复原浏览器；不会换浏览器或清空登录资料。');}
 return {info,previous,executable};
}

export function browserVersionRecord(profile,version){
 const match=version.trim().match(/^(.*?)\s+(\d+)\.(\d+(?:\.\d+)*)/);
 if(!match)throw new Error('无法核对浏览器版本，保留原资料并停止打开。');
 const product=match[1],major=Number(match[2]);
 if(profile.previous?.browserProduct&&profile.previous.browserProduct!==product)throw new Error('浏览器产品发生变化，禁止直接复用账号资料；原登录资料已保留。');
 if(profile.previous?.highestMajor>major)throw new Error('检测到浏览器降级，已阻止打开现有资料；请使用原版本或更新版本。');
 return {schemaVersion:1,accountId:profile.accountId,browserExecutable:profile.executable,browserProduct:product,highestMajor:Math.max(major,profile.previous?.highestMajor||0),lastBrowserVersion:version.trim()};
}
