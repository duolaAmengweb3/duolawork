import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {BrowserManager} from '../local/browser.mjs';import {grokState,GROK_COMPOSER} from '../local/grok.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-grok-fixture-'));
const server=http.createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end(`<button aria-label="账户菜单，fixture">Account</button><button>机器人</button><a href="/bot/fixture">Fixture Bot</a><div role="textbox" contenteditable="true"></div><div id="sent"></div><div id="answer"></div><script>document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#sent').textContent=e.target.innerText;e.target.innerText='';}});</script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`,manager=new BrowserManager({root:path.join(dir,'profiles'),testMode:true}),account={id:'account_grokfixture',entryUrl:url};
try{await manager.ensureBackground(account);const page=manager.active.get(account.id).workPage;
 await page.locator(GROK_COMPOSER).fill('HUB_TASK_REQUEST_fixture\n<<<HUB_RESULT_fixture>>>\n<<<HUB_SOURCES_fixture>>>\n[]\n<<<HUB_END_fixture>>>');await page.locator(GROK_COMPOSER).press('Enter');
 let state=await page.evaluate(grokState,'fixture');assert.equal(state.inputs,1);assert.equal(state.draft,false);assert.equal(state.matched,'','own echoed request cannot become a bot result');
 await page.evaluate(()=>document.querySelector('#answer').innerHTML='<p>&lt;&lt;&lt;HUB_RESULT_fixture&gt;&gt;&gt;</p><p>42</p><p>&lt;&lt;&lt;HUB_SOURCES_fixture&gt;&gt;&gt;</p><p>[]</p><p>&lt;&lt;&lt;HUB_END_fixture&gt;&gt;&gt;</p>');
 state=await page.evaluate(grokState,'fixture');assert.match(state.matched,/42/);assert.equal((await page.evaluate(grokState,'other')).matched,'','another task result is never accepted');
 console.log('Grok isolated UI: real contenteditable typing and Enter, outgoing echo excluded, current marked reply recovered, wrong attempt excluded.');
}finally{await manager.closeAll();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
