import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.id===undefined)continue;
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'isolated subprocess',version:'1'}}:m.method==='tools/list'?{tools:[{name:'write',description:'Return test text',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:m.method==='tools/call'?{content:[{type:'text',text:m.params.arguments.text}]}:{};
 if(m.method==='tools/call'&&m.params.arguments.repeat)result.content[0].text=m.params.arguments.text.repeat(m.params.arguments.repeat);
 if(m.method==='tools/call'&&m.params.arguments.fail)result.isError=true;
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
}
