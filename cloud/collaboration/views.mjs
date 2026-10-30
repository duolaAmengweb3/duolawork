import { fail } from "./repository.mjs";
import { memberSetKey } from "../../shared/policies.mjs";

export async function projectPage(repo,params,cursor) {
  let sql="SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='project' AND COALESCE(json_extract(body,'$.hidden'),0)=0";
  const values=[repo.workspaceId],q=params.get("q")?.trim();
  if(q){if(q.length>200)fail("invalid_query","搜索内容最多200字");const like="%"+q.replace(/[\\%_]/g,"\\$&")+"%";sql+=" AND (json_extract(body,'$.name') LIKE ? ESCAPE '\\' OR json_extract(body,'$.topic') LIKE ? ESCAPE '\\')";values.push(like,like);}
  if(cursor){sql+=" AND (updated_at<? OR(updated_at=? AND id<?))";values.push(cursor.updatedAt,cursor.updatedAt,cursor.id);}
  const rows=await repo.db.prepare(sql+" ORDER BY updated_at DESC,id DESC LIMIT 101").bind(...values).all();
  return rows.results.map(r=>JSON.parse(r.body));
}

export async function resultPage(repo, params, cursor) {
  const values = [repo.workspaceId];
  let where = "d.workspace_id=? AND d.kind='document' AND json_extract(d.body,'$.deliverable')=1";
  const q = params.get("q")?.trim();
  if (q && q.length > 200) fail("invalid_query", "搜索内容最多200字");
  if (q) {
    const needle = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    where += " AND (json_extract(d.body,'$.title') LIKE ? ESCAPE '\\' OR json_extract(v.body,'$.body') LIKE ? ESCAPE '\\')";
    values.push(needle, needle);
  }
  if (params.get("projectId")) { where += " AND d.scope_id=?"; values.push(params.get("projectId")); }
  const state = params.get("status");
  if (state && state !== "all") {
    if (!["pending", "adopted", "discarded", "partially_met"].includes(state)) fail("invalid_status", "成果状态无效");
    where += " AND (CASE WHEN json_extract(d.body,'$.status')='partially_met' THEN 'partially_met' WHEN json_extract(d.body,'$.evaluatedVersionId')=json_extract(d.body,'$.workingVersionId') THEN COALESCE(json_extract(d.body,'$.feedback'),'pending') ELSE 'pending' END)=?";
    values.push(state);
  }
  for (const [name, comparison] of [["from", ">="], ["to", "<="]]) {
    const date = params.get(name);
    if (!date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) fail("invalid_date", "日期格式应为有效的YYYY-MM-DD");
    const offset=Number(params.get("offset")||0);
    if(!Number.isInteger(offset)||Math.abs(offset)>840)fail("invalid_date","时区偏移无效");
    const boundary=new Date(Date.parse(date)-offset*60000+(name==="to"?86400000:0)).toISOString();
    where += ` AND COALESCE(json_extract(d.body,'$.createdAt'),d.updated_at)${name==="to"?"<":comparison}?`;
    values.push(boundary);
  }
  if (cursor) { where += " AND (d.updated_at<? OR (d.updated_at=? AND d.id<?))"; values.push(cursor.updatedAt,cursor.updatedAt,cursor.id); }
  // No copies or truncated previews: search the current authoritative version.
  const sql = `SELECT d.body,(SELECT COUNT(*) FROM hub_v2_records x WHERE x.workspace_id=d.workspace_id AND x.kind='document_version' AND x.parent_id=d.id) AS version_count FROM hub_v2_records d LEFT JOIN hub_v2_records v ON v.workspace_id=d.workspace_id AND v.kind='document_version' AND v.id=json_extract(d.body,'$.workingVersionId') WHERE ${where} ORDER BY d.updated_at DESC,d.id DESC LIMIT 101`;
  const result = await repo.db.prepare(sql).bind(...values).all();
  return result.results.map(row => ({...JSON.parse(row.body), versionCount:row.version_count}));
}

export async function ruleUsage(repo) {
  const rows=await repo.db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='run' AND json_extract(body,'$.purpose')='goal' AND COALESCE(json_extract(body,'$.probe'),0)=0").bind(repo.workspaceId).all();
  const usage={};
  for(const row of rows.results)for(const k of JSON.parse(row.body).knowledge||[]){const value=usage[k.id] ||= {rounds:0,latest:null};value.rounds++;}
  const documents=await repo.db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='document' AND json_extract(body,'$.deliverable')=1 ORDER BY updated_at DESC,id DESC").bind(repo.workspaceId).all();
  for(const row of documents.results){const d=JSON.parse(row.body);for(const r of d.ruleReceipts||[]){const value=usage[r.ruleId] ||= {rounds:0,latest:null};if(value.latest)continue;const current=(d.ruleReceiptVersionId || d.selfCheckVersionId)===d.workingVersionId;value.latest={documentId:d.id,revision:r.revision,status:!current?"unconfirmed":r.followed?"followed":"deviated",paragraph:r.paragraph,reason:r.reason,checkedBy:r.checkedBy};}}
  return usage;
}

export async function allPairingFacts(repo) {
  const rows=await repo.db.prepare("SELECT r.id AS run_id,r.scope_id,json_extract(r.body,'$.arrangement.members') AS members,json_extract(r.body,'$.projectType') AS project_type,d.id AS document_id,COALESCE(json_extract(d.body,'$.record.independent'),0) AS independent_count,COALESCE(json_extract(d.body,'$.record.corrections'),0) AS correction_count,COALESCE(json_extract(d.body,'$.record.unique'),0) AS unique_count FROM hub_v2_records r LEFT JOIN hub_v2_records d ON d.workspace_id=r.workspace_id AND d.kind='document' AND d.parent_id=r.id AND json_extract(d.body,'$.deliverable')=1 WHERE r.workspace_id=? AND r.kind='run' AND r.status IN ('completed','partially_met') AND json_extract(r.body,'$.purpose')='goal' AND COALESCE(json_extract(r.body,'$.probe'),0)=0").bind(repo.workspaceId).all();
  const groups=new Map();
  for(const row of rows.results){
    const members=JSON.parse(row.members||"[]");if(members.length<2)continue;
    const key=memberSetKey(members)+"::"+(row.project_type?"type:"+row.project_type:"project:"+row.scope_id);
    const g=groups.get(key)||{key,memberIds:members,projectType:row.project_type||null,projectId:row.project_type?null:row.scope_id,scope:row.project_type?"同类型项目":"本项目",runs:new Set(),independent:0,corrections:0,unique:0};
    g.runs.add(row.run_id);g.independent+=Number(row.independent_count);g.corrections+=Number(row.correction_count);g.unique+=Number(row.unique_count);groups.set(key,g);
  }
  return [...groups.values()].filter(g=>g.runs.size>=3).map(({runs,...g})=>({...g,samples:runs.size}));
}
export async function pairingFacts(repo, project) {
  const key=memberSetKey(project.arrangement?.members)+"::"+(project.projectType?"type:"+project.projectType:"project:"+project.id);
  return (await allPairingFacts(repo)).find(g=>g.key===key)||null;
}
