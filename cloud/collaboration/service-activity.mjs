import {id} from './repository.mjs';

// No credentials, response bodies or private native-environment data belong here.
export async function appendActivity(repo,kind,record,requestId){
 return repo.transact(requestId||id(kind),record,tx=>tx.put(kind,{...record,id:id(kind),createdAt:tx.now}));
}
export async function activityPage(repo,kind,{parent,scope,memberId,taskId,after}={}){
 const legacy=kind==='skill_activity';
 let sql='SELECT body,kind,rowid FROM hub_v2_records WHERE workspace_id=? AND '+(legacy?'kind IN (?,?)':'kind=?');
 const values=legacy?[repo.workspaceId,kind,'skill_use']:[repo.workspaceId,kind];
 for(const [column,value] of [['parent_id',parent],['scope_id',scope]])if(value){sql+=' AND '+column+'=?';values.push(value);}
 if(memberId){sql+=" AND json_extract(body,'$.memberId')=?";values.push(memberId);}
 if(taskId){sql+=" AND json_extract(body,'$.taskId')=?";values.push(taskId);}
 // Immutable events may share a millisecond; insertion order keeps the latest
 // real receipt first instead of sorting randomly generated IDs.
 if(after){const cursor=await repo.db.prepare(sql+' AND id=? LIMIT 1').bind(...values,after).first();if(cursor){const at=JSON.parse(cursor.body).updatedAt;sql+=' AND (updated_at<? OR (updated_at=? AND rowid<?))';values.push(at,at,cursor.rowid);}}
 const rows=(await repo.db.prepare(sql+' ORDER BY updated_at DESC,rowid DESC LIMIT 51').bind(...values).all()).results.map(r=>{const body=JSON.parse(r.body);return r.kind==='skill_use'?{...body,event:'use',outcome:'used',legacy:true,environment:'未报告',dependencyStatus:'unknown'}:body;});
 return {items:rows.slice(0,50),next:rows.length>50?rows[49].id:null};
}
