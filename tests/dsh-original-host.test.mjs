import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {originalDshContext,DshOriginalHost} from '../local/dsh-original-host.mjs';

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-original-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const home=path.join(dir,'native'),profile=path.join(home,'profiles/web');await fs.mkdir(profile,{recursive:true});
 await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}}}));
 await fs.writeFile(path.join(profile,'cordis.patch.yml'),'# original native settings\n[]\n');
 const env={DSH_SHELL:'1',DSH_HOME:home,DSH_PROFILE_DIR:profile,DSH_PROFILE:'web',DSH_SESSION_ID:'session-original'};
 return{dir,home,profile,env};
}
test('original Harness context requires official native facts and does not guess another project or profile',async t=>{
 const f=await fixture(t);const c=await originalDshContext(f.env);assert.equal(c.profile,await fs.realpath(f.profile));assert.equal(c.sessionId,'session-original');
 await assert.rejects(originalDshContext({...f.env,DSH_SHELL:''}),/原对话/);
 await assert.rejects(originalDshContext({...f.env,DSH_PROFILE:'../web'}),/原对话/);
 await assert.rejects(originalDshContext({...f.env,DSH_PROFILE_DIR:f.home}),/无法核对/);
});
test('original Harness registration preserves settings, rejects another member and remains tied to its original profile',async t=>{
 const f=await fixture(t),host=new DshOriginalHost(path.join(f.dir,'receiver'));
 host.startOnce=async()=>({ready:true});host.sessions=async()=>({items:[{id:'session-original'}]});
 await host.register(f.env);const before=await fs.readFile(path.join(f.profile,'cordis.patch.yml'),'utf8');await host.register(f.env);assert.equal(await fs.readFile(path.join(f.profile,'cordis.patch.yml'),'utf8'),before);
 assert.match(before,/original native settings/);assert.equal((await host.discover()).running,false);
 const other=new DshOriginalHost(path.join(f.dir,'another-member'));await assert.rejects(other.register(f.env),/其他连接/);
 assert.equal(await fs.readFile(path.join(f.profile,'cordis.patch.yml'),'utf8'),before);
 await assert.rejects(host.open(),/原电脑或服务器/);
});
