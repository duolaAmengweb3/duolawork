// A vendor is not a runtime. Capabilities are selected by the actual host,
// never inferred from a member's display name or the Mac running DuolaWork.
export const NATIVE_FORMS = {
  'codex': { platformIds:['codex'], name:'Codex', systems:['darwin','linux'], manager:'coding', engine:'codex', create:true },
  'antigravity-cli': { platformIds:['gemini-cli','antigravity'], name:'Antigravity CLI', systems:['darwin','linux'], manager:'coding', engine:'antigravity-cli', create:true },
  'gemini-cli': { platformIds:['gemini-cli','antigravity'], name:'Gemini CLI', systems:['darwin','linux'], manager:'coding', engine:'gemini-cli', create:true },
  'antigravity-desktop': { platformIds:['antigravity','gemini-cli'], name:'Antigravity 桌面版', systems:['darwin'], manager:'antigravity', create:false },
  'deepseek-desktop': { platformIds:['deepseek-harness'], name:'DeepSeek Harness 桌面版', systems:['darwin'], manager:'dsh', create:true },
  'deepseek-harness': { platformIds:['deepseek-harness'], name:'DeepSeek Harness（原服务器或终端）', systems:['darwin','linux'], manager:'dsh-original', create:true },
  'claude-code': { platformIds:['claude-code'], name:'Claude Code', systems:['darwin','linux'], manager:'claude', create:false },
};
export function formsFor(platformId){ return Object.entries(NATIVE_FORMS).filter(([,f])=>f.platformIds.includes(platformId)).map(([id,f])=>({id,...f})); }
export function nativeForm(form,platformId){const f=NATIVE_FORMS[form];if(!f||!f.platformIds.includes(platformId))throw Error('请选择该账号实际使用的 Agent 软件');return f;}
