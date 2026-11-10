import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {claudeResumeAction} from '../shared/claude-onboarding.mjs';
test('copied Claude resume restores the exact directory/session and shell-quotes all native paths',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hub-claude-guide-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,"project's $(false) `false`"),connector=path.join(root,'connector.cjs');await fs.mkdir(workspace);
 await fs.writeFile(connector,'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
 const result=claudeResumeAction({nodePath:process.execPath,connectorPath:connector,workspace,alias:'claude1',sessionId:'exact-original'});
 const observed=JSON.parse(execFileSync('/bin/sh',['-c',result.command],{encoding:'utf8'}));assert.equal(observed.cwd,await fs.realpath(workspace));assert.deepEqual(observed.args,['start','claude1','--resume','exact-original']);assert.equal(result.exactSession,true);
 assert.throws(()=>claudeResumeAction({nodePath:process.execPath,connectorPath:connector,workspace:'/tmp\nmalformed',alias:'a'}));
});
