import {fail} from './repository.mjs';
export async function workspaceGrant(repo,actor){
 if(actor.owner)return {owner:true};
 const grant=await repo.get('workspace_secretary','current',false);
 return actor.memberId&&grant?.status==='active'&&grant.memberId===actor.memberId?grant:null;
}
export async function requireManager(repo,actor){const grant=await workspaceGrant(repo,actor);if(!grant)fail('forbidden','只有用户或当前指定的秘书可以管理工作区',403);return grant;}
