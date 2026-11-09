#!/usr/bin/env node
import fs from 'node:fs';
const a=process.argv.slice(2),at=a.indexOf('--profile'),profile=at<0?'wrong-default':a[at+1];
const state=JSON.parse(fs.readFileSync(process.env.FEISHU_TEST_STATE,'utf8'));
fs.appendFileSync(process.env.FEISHU_TEST_STATE+'.calls',JSON.stringify(a)+'\n');
if(a[0]==='profile'&&a[1]==='list'){console.log(JSON.stringify([{name:'one',brand:'feishu',user:'一号'},{name:'two',brand:'feishu',user:'二号'},{name:'bot-only',brand:'feishu'}]));}
else if(a.includes('whoami'))console.log(JSON.stringify({profile,appId:'app-'+profile,identity:'user',available:!state.logout,onBehalfOf:{openId:state.changed?'someone-else':'user-'+profile,userName:profile==='one'?'一号':'二号'}}));
else if(a.includes('--help'))console.log('Usage: official command help');
else if(a.includes('schema'))console.log(JSON.stringify({params:['doc'],scopes:['docs:read']}));
else if(a.some(x=>x==='--command=gate')){console.log(JSON.stringify({ok:false,error:{code:'confirmation_required'}}));process.exitCode=10;}
else if(a.some(x=>x==='--doc=missing-scope')){console.error(JSON.stringify({ok:false,error:{type:'authorization',subtype:'missing_scope',missing_scopes:['search:docs:read'],hint:'internal auth instructions'}}));process.exitCode=3;}
else console.log(JSON.stringify({ok:true,identity:'user',data:{profile,text:a.find(x=>x.startsWith('--content='))?.slice(10)||'document',access_token:'never-return'}}));
