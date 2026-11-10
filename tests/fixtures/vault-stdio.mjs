import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.id===undefined)continue;
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Vault isolated subprocess',version:'1'}}:m.method==='tools/list'?{tools:[{name:'probe',inputSchema:{type:'object',properties:{}}}]}:m.method==='tools/call'?{content:[{type:'text',text:process.env.DW_VAULT_TOKEN||'missing'}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
}
