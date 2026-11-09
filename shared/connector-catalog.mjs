// Presets are connection instructions, never a claim that an account is connected.
export const CONNECTOR_CATALOG = [
 {id:'github-mcp',name:'GitHub',category:'开发',url:'https://api.githubcopilot.com/mcp/x/all',description:'仓库、Issue、Pull Request 与工作流',docs:'https://github.com/github/github-mcp-server'},
 {id:'cloudflare',name:'Cloudflare',category:'开发',url:'https://mcp.cloudflare.com/mcp',description:'Workers、DNS、R2 与云资源',docs:'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/'},
 {id:'vercel',name:'Vercel',category:'开发',url:'https://mcp.vercel.com',description:'项目、部署与运行日志',docs:'https://vercel.com/docs/agent-resources/vercel-mcp'},
 {id:'feishu',name:'飞书',category:'办公',url:'',description:'复用这台电脑已登录的飞书账号，文档、表格与任务按原授权使用',docs:'https://github.com/larksuite/cli'},
 {id:'wechat-mp',name:'微信公众号',category:'办公',url:'',description:'素材、草稿、排版与公众号业务接口；由共享服务器统一执行，支持多个公众号',docs:'https://developers.weixin.qq.com/platform'},
 {id:'notion',name:'Notion',category:'办公',url:'https://mcp.notion.com/mcp',description:'文档、知识库与数据库',docs:'https://developers.notion.com/guides/mcp/overview'},
 {id:'google-drive',name:'Google Drive',category:'办公',url:'https://drivemcp.googleapis.com/mcp/v1',description:'云盘资料 · 官方开发者预览，需具备准入资格',preview:true,docs:'https://developers.google.com/workspace/guides/configure-mcp-servers'},
 {id:'google-gmail',name:'Gmail',category:'办公',url:'https://gmailmcp.googleapis.com/mcp/v1',description:'邮件 · 官方开发者预览，需具备准入资格',preview:true,docs:'https://developers.google.com/workspace/guides/configure-mcp-servers'},
 {id:'google-calendar',name:'Google Calendar',category:'办公',url:'https://calendarmcp.googleapis.com/mcp/v1',description:'日程 · 官方开发者预览，需具备准入资格',preview:true,docs:'https://developers.google.com/workspace/guides/configure-mcp-servers'},
 {id:'figma',name:'Figma',category:'设计',url:'https://mcp.figma.com/mcp',description:'设计稿、组件与素材',availability:'approval',requirement:'Figma 目前只允许其目录中的客户端连接。DuolaWork 尚需官方准入，重复登录无法解决。',docs:'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/'},
 {id:'custom',name:'其他服务',category:'自定义',url:'',description:'添加远程服务，或导入本机 / VPS 的 MCP 配置'},
];
export function importConnectorConfig(raw){
 const source=typeof raw==='string'?JSON.parse(raw):raw;
 const entries=Object.entries(source?.mcpServers||source?.servers||{});
 if(!entries.length||entries.length>40)throw Error('配置需要包含 mcpServers 或 servers，最多一次导入 40 项');
 return entries.map(([name,v])=>{
  if(!v||typeof v!=='object')throw Error('连接配置无效：'+name);
  if(v.disabled)return null;
  if(v.url||v.serverUrl)return {name,provider:'custom',transport:'http',url:v.url||v.serverUrl,headers:v.headers||{}};
  if(v.command)return {name,provider:'custom',transport:'stdio',command:v.command,args:v.args||[],env:v.env||{},cwd:v.cwd||''};
  throw Error('缺少服务地址或启动命令：'+name);
 }).filter(Boolean);
}
export function connectorAllowed(c,actor,channelId){
 return c.status!=='disconnected' && !c.blockedChannelIds?.includes(channelId) &&
  !c.blockedMemberIds?.includes(actor.memberId) &&
  (!c.channelIds?.length||c.channelIds.includes(channelId)) &&
  (!c.memberIds?.length||actor.owner||c.memberIds.includes(actor.memberId));
}
