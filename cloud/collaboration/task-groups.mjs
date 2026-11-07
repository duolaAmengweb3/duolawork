import {fail} from './repository.mjs';

// One task and its concrete Todos. Existing ungrouped records remain standalone.
export async function childrenOf(repo, taskId) {
  const items=[];let after='';
  for (;;) {
    const page=await repo.list('channel_task',{parent:taskId,after,limit:500});
    items.push(...page);if(page.length<500)return items;after=page.at(-1).id;
  }
}

export async function validateTaskGroup(tx, channel, next, old, cmd) {
  if(cmd.parentTaskId!==undefined && cmd.parentTaskId!==null && typeof cmd.parentTaskId!=='string')fail('invalid_parent','请选择所属任务');
  next.parentTaskId=cmd.parentTaskId===undefined?(old?.parentTaskId||null):(cmd.parentTaskId||null);
  next.parentId=next.parentTaskId||channel.id;
  const children=old?await childrenOf(tx,old.id):[];
  if(next.parentTaskId){
    if(next.parentTaskId===next.id)fail('invalid_parent','不能把任务放到自己下面');
    const parent=await tx.get('channel_task',next.parentTaskId);
    if(parent.scopeId!==channel.id)fail('forbidden','所属任务必须在同一个群',403);
    if(parent.parentTaskId||children.length)fail('invalid_parent','只分任务和 Todo 两层；请选一个独立任务');
    if(['done','canceled'].includes(parent.status) && (old?.parentTaskId!==parent.id||!['done','canceled'].includes(next.status)))fail('task_closed','这项任务已结束，请先重新打开任务',409);
    // Parent revision serializes additions/reopening against concurrent closure.
    tx.put('channel_task',{...parent,updatedAt:tx.now});
  }
  if(old?.parentTaskId && old.parentTaskId!==next.parentTaskId){
    const previous=await tx.get('channel_task',old.parentTaskId);
    tx.put('channel_task',{...previous,updatedAt:tx.now});
  }
  if(children.length && ['done','canceled'].includes(next.status)){
    if(children.some(t=>!['done','canceled'].includes(t.status)))fail('unfinished_todos','还有未结束的 Todo，请先核对处理结果',409);
    if(next.status==='done'&&!next.result?.trim())fail('result_required','请记录任务的交付与验收结果；Todo 全部结束不代表已交付');
  }
}

export async function taskSummaries(repo, items) {
  if(!items.length)return items;
  const db=repo.db||repo.repo.db, workspaceId=repo.workspaceId||repo.repo.workspaceId;
  const rows=await db.prepare(`SELECT parent_id,COUNT(*) AS total,
    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled,
    SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN status NOT IN ('done','canceled') THEN 1 ELSE 0 END) AS active
    FROM hub_v2_records WHERE workspace_id=? AND kind='channel_task' AND parent_id IN (${items.map(()=>'?').join(',')}) GROUP BY parent_id`)
    .bind(workspaceId,...items.map(t=>t.id)).all();
  const counts=new Map(rows.results.map(({parent_id,...stats})=>[parent_id,stats]));
  return items.map(t=>({...t,subtasks:counts.get(t.id)||{total:0,done:0,canceled:0,blocked:0,active:0}}));
}

export async function listTaskGroups(repo, channelId, args={}) {
  const parentId=args.parentTaskId||channelId;
  if(args.parentTaskId){
    const parent=await repo.get('channel_task',args.parentTaskId);
    if(parent.scopeId!==channelId)fail('forbidden','所属任务不在本群',403);
  }
  const query=typeof args.query==='string'?args.query.trim().toLocaleLowerCase().slice(0,300):'';
  const params=[repo.workspaceId,channelId,parentId,args.after||''];
  let sql="SELECT t.body FROM hub_v2_records t WHERE t.workspace_id=? AND t.kind='channel_task' AND t.scope_id=? AND t.parent_id=? AND t.id>?";
  if(args.filter==='active')sql+=" AND t.status NOT IN ('done','canceled')";
  if(args.filter==='done')sql+=" AND t.status IN ('done','canceled')";
  if(query){
    sql+=" AND (instr(lower(COALESCE(json_extract(t.body,'$.title'),'')||' '||COALESCE(json_extract(t.body,'$.body'),'')||' '||COALESCE(json_extract(t.body,'$.progress'),'')),?)>0 OR EXISTS(SELECT 1 FROM hub_v2_records c WHERE c.workspace_id=t.workspace_id AND c.kind='channel_task' AND c.scope_id=t.scope_id AND c.parent_id=t.id AND instr(lower(COALESCE(json_extract(c.body,'$.title'),'')||' '||COALESCE(json_extract(c.body,'$.body'),'')||' '||COALESCE(json_extract(c.body,'$.progress'),'')),?)>0))";
    params.push(query,query);
  }
  const rows=(await repo.db.prepare(sql+' ORDER BY t.id LIMIT 101').bind(...params).all()).results.map(r=>JSON.parse(r.body));
  return {items:await taskSummaries(repo,rows.slice(0,100)),next:rows.length>100?rows[99].id:null};
}
