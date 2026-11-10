// Methods offered to agents, never mandatory roles or a second orchestration engine.
const methods=[
 ['independent-check','独立核查','在容易从众或已有答案可能出错时，先查原文、代码或可复现实验，再比较各自判断。','先明确待核实的具体说法和当前资料版本。独立完成一次可复核检查，保留原始发现、来源和限制。再阅读其他成员结论，说明哪些得到支持、哪些被修正。没有发现问题可以直说，不制造分歧。原会话可能已见他人意见，不能声称物理双盲。'],
 ['evidence-review','证据核对','对事实与技术方案做原文、源码和可复现实验核验。','区分直接证据、推断和未知。优先读取实际原文、代码和版本；运行可复现实验时报告输入、环境、结果与限制。发现明确错误直接修正对应对象，给出修改前后差异。两人赞同不构成验证。资料不足就给出最小缺口和取得方法，不包装成共识。'],
 ['complementary-work','互补协作','利用不同成员的工具、资料和环境共同形成完整产物。','先理解用户需要的结果和范围。仅在确有互补价值时请其他成员完成具体检查或产物，说明输入与可合并的输出，不要求用户理解固定岗位。保留原生工作环境、引用具体版本。回传后负责人接着整合，核对遗漏；不能以已经分派或收到当完成。'],
 ['decision-comparison','方案取舍','比较多个可行选项的代价、适用条件和证据。','先列用户真正关心的约束。用同一组标准比较各选项：成本、风险、效果、可逆性和证据。给出有条件的建议；只把必须由用户决定的取舍交还用户，提具体问题。不要为显得客观硬凑多个方案，不把尚未验证的路线说成已可用。'],
 ['artifact-review','产物评审','针对现有文稿、代码或方案做具体检查和修改。','读取实际对象与确切版本，按用户需求核对准确性、可用性和遗漏。能够解决的问题直接修改并复核，输出改动与证据；未解决的问题留下明确原因。没有增量时简短说明或记录暂无补充，不重复称赞、复述或套模板。'],
 ['conditional-retrospective','经验复盘','对重复问题形成带来源和适用条件的共享记忆。','先还原实际过程，区分需求误解、信息缺失、工具故障与判断错误。找出可验证的改进，留下适用条件和反例。使用 remember 保存有来源的观察；用户明确约定附原话，不把成员建议升级成用户指令。旧记忆不适用时修订，不按时间盲目覆盖。']
];
export const BUILTIN_SKILLS=methods.map(([name,title,description,body])=>({id:'builtin:'+name,name,description:title+'：'+description,files:{'SKILL.md':`---\nname: ${name}\ndescription: ${description}\n---\n# ${title}\n\n${body}\n\n方法按任务需要选用。保持自由交流，不强制开会、分工、固定讨论轮数或反复征求确认。给用户直接可用的结果。`},compatibility:'所有可读取共享工具的原生 Agent',hasScripts:false,source:'DuolaWork 协作研究与已评审产品方案',status:'enabled',version:1,channelIds:[],memberIds:[],builtin:true}));
export async function seedSkills(repo){
 for(const skill of BUILTIN_SKILLS)if(!await repo.get('workspace_skill',skill.id,false))await repo.transact('builtin-skill:v1:'+skill.id,{},async tx=>{if(await tx.get('workspace_skill',skill.id,false))return;const next=tx.put('workspace_skill',{...skill,createdAt:tx.now});tx.put('skill_version',{...next,id:next.id+':1',parentId:next.id});});
}
