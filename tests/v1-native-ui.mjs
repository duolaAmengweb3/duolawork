// Opt-in acceptance against an explicitly named controlled native run.
// Launches a fresh owned test Chrome; never attaches to user Chrome or reads credentials.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
if(!process.argv[2])throw new Error('Pass the JSON description of an authorized controlled native run.');
const spec=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const base='http://127.0.0.1:8766';
async function read(p){const r=await fetch(base+'/api'+p);assert(r.ok);return r.json()}
const run=await read('/v2/run?id='+spec.runId);assert.equal(run.run.status,'completed');
const ids=run.steps.filter(s=>s.deliverable).flatMap(s=>s.documentIds);assert.equal(ids.length,1);
let doc=await read('/v2/document?id='+ids[0]);
const decisions=(await read('/v2/records?kind=decision&projectId='+spec.projectId)).items.filter(d=>d.documentId===doc.id);
assert.equal(decisions.length,1);const decision=decisions[0];assert.equal(decision.status,'pending');
for(const option of decision.options){assert(option.memberId);assert(option.claimIds.length);assert(option.sourceUrls.length);for(const id of option.claimIds)assert(doc.sourceEvidence.claims.some(c=>c.id===id));}
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({projectId,documentId})=>{localStorage.setItem('agent-hub-current-project',projectId);localStorage.setItem('agent-hub-v1-view',JSON.stringify({projectId,docId:documentId}));},{projectId:spec.projectId,documentId:doc.id});
 await page.goto(base);const card=page.locator('.decision-inline').first();await card.waitFor();
 await card.scrollIntoViewIfNeeded();await page.screenshot({path:'evidence/v1-native-choice-before.png',fullPage:true});
 await card.getByText('同类问题以后都这样选',{exact:true}).click();
 await card.getByRole('button',{name:'采纳此方案',exact:true}).first().click();await card.getByRole('button',{name:'撤回',exact:true}).waitFor();
 const chosen=(await read('/v2/records?kind=decision&projectId='+spec.projectId)).items.find(d=>d.id===decision.id);assert.equal(chosen.status,'resolved');assert(chosen.ruleId);
 let rules=(await read('/v2/records?kind=knowledge&projectId='+spec.projectId)).items;assert.equal(rules.find(k=>k.id===chosen.ruleId)?.status,'approved');
 await page.waitForTimeout(900);
 const selected=await read('/v2/document?id='+doc.id);assert.match(selected.working.body,/data-selected=/);
 await page.screenshot({path:'evidence/v1-native-choice-selected.png',fullPage:true});
 await card.getByRole('button',{name:'撤回',exact:true}).click();await card.getByRole('heading',{name:/待你决定/}).waitFor();
 const undone=(await read('/v2/records?kind=decision&projectId='+spec.projectId)).items.find(d=>d.id===decision.id);assert.equal(undone.status,'pending');
 rules=(await read('/v2/records?kind=knowledge&projectId='+spec.projectId)).items;assert.equal(rules.find(k=>k.id===chosen.ruleId)?.status,'revoked');
 doc=await read('/v2/document?id='+doc.id);assert.notEqual(doc.workingVersionId,selected.workingVersionId);
 await page.reload();await page.locator('.decision-inline').getByRole('heading',{name:/待你决定/}).waitFor();
 assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(errors,[]);
 const report={at:new Date().toISOString(),buildId:JSON.parse(await fs.readFile('shared/build-info.json','utf8')).id,environment:'production native Grok + Dot artifact; controlled choices; owned fresh headless Chrome testing local product UI',...spec,status:run.run.status,documentId:doc.id,originalVersionId:doc.originalVersionId,selectedVersionId:selected.workingVersionId,restoredVersionId:doc.workingVersionId,decisionId:decision.id,ruleId:chosen.ruleId,memberAttribution:decision.options.map(o=>({memberId:o.memberId,claimIds:o.claimIds,sourceUrls:o.sourceUrls})),checks:['真实成员的取舍卡具有原始论断、来源及真实成员归属','原位采纳和长期规则原子保存','撤回后规则同步撤回，保留全部版本','刷新后仍待决定，没有页面错误'],nativeCommercialReplies:true,desktopAccessibilityRead:'separate CUA inspection timed out; not claimed as passed',errors};
 await fs.writeFile('evidence/v1-native-ui.json',JSON.stringify(report,null,2)+'\n');console.log(report);
}finally{await browser.close()}
