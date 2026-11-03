// Small stdio MCP bridge: no provider credentials, administrator grant or model API.
import readline from 'node:readline';
import {CodingMemberClient} from './coding-client.mjs';
import {safeError} from './native-agent.mjs';
const file=process.argv[2];if(!file)throw new Error('缺少成员私有配置路径');
const client=new CodingMemberClient(file);
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{
 if(line.length>1000000)return;
 let message;try{message=JSON.parse(line);}catch{return;}
 if(message.id===undefined)return;
 const respond=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...value})+'\n');
 try{
  let result;
  if(message.method==='initialize')result={protocolVersion:message.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'agent-hub',version:'1.0.0'}};
  else if(message.method==='ping')result={};
  else if(message.method==='tools/list')result={tools:await client.tools()};
  else if(message.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(await client.tool(message.params.name,message.params.arguments||{}))}]};
  else return respond({error:{code:-32601,message:'Unsupported method'}});
  respond({result});
 }catch(e){respond(message.method==='tools/call'?{result:{isError:true,content:[{type:'text',text:safeError(e)}]}}:{error:{code:-32000,message:safeError(e)}});}
});
lines.on('close',()=>process.exit(0));
const parent=process.ppid;
const monitor=setInterval(()=>{if(process.ppid!==parent||process.ppid===1)process.exit(0);try{process.kill(parent,0);}catch{process.exit(0);}},3000);monitor.unref();
