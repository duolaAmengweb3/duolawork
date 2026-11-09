import fs from 'node:fs/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {callFeishu,feishuIdentity,FEISHU_TOOLS} from './feishu-cli.mjs';
async function main(){
const binding=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const server=new Server({name:'DuolaWork Feishu',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>{await feishuIdentity(binding);return {tools:FEISHU_TOOLS};});
server.setRequestHandler(CallToolRequestSchema,async r=>{try{return await callFeishu(binding,r.params.name,r.params.arguments);}catch(e){return {isError:true,...(e.code==='authorization_required'?{structuredContent:{duolawork:{code:e.code,message:e.message}}}:{}),content:[{type:'text',text:e.message}]};}});
await server.connect(new StdioServerTransport());
}
main().catch(()=>{console.error('飞书连接未启动，请检查原账号与本地配置');process.exitCode=1;});
