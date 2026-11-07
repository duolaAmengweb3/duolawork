import {fail} from './repository.mjs';
export const skillAllowed=(s,actor,channelId)=>s.status==='enabled'&&(!s.channelIds?.length||s.channelIds.includes(channelId))&&(!s.memberIds?.length||actor.owner||s.memberIds.includes(actor.memberId));
export const skillRefsSchema={type:'array',maxItems:12,items:{type:'object',properties:{skillId:{type:'string'},version:{type:'integer',minimum:1}},required:['skillId','version'],additionalProperties:false}};
export async function bindTaskSkills(tx,actor,channel,next,old,cmd){
 let refs=cmd.skillRefs;
 if(refs===undefined){
  if(old)return;
  next.skillRefs=next.parentTaskId?(await tx.get('channel_task',next.parentTaskId)).skillRefs||[]:[];
  return;
 }
 if(!Array.isArray(refs)||refs.length>12)fail('invalid_skills','每项任务最多选用12个技能');
 next.skillRefs=[];
 for(const ref of refs){
  if(!ref||typeof ref.skillId!=='string'||!Number.isInteger(ref.version)||ref.version<1)fail('invalid_skills','请选择有效技能版本');
  const current=await tx.get('workspace_skill',ref.skillId);
  if(!skillAllowed(current,actor,channel.id))fail('skill_unavailable','技能在当前范围不可用，请检查使用范围',403);
  const version=current.version===ref.version?current:await tx.get('skill_version',ref.skillId+':'+ref.version,false);
  if(!version)fail('invalid_version','技能版本不存在');
  if(!next.skillRefs.some(x=>x.skillId===ref.skillId))next.skillRefs.push({skillId:ref.skillId,version:ref.version,name:version.name});
 }
}
