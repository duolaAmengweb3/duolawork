import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function forgottenLedger(db,workspaceId,database,{restore=false}={}) {
  const file=path.join(path.dirname(database),'memory-forgotten.json');
  let saved=[];try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const dir=path.join(path.dirname(database),'memory-forgotten.d');await fs.mkdir(dir,{recursive:true,mode:0o700});
  for(const name of await fs.readdir(dir))if(/^[a-f0-9]{64}\.json$/.test(name))saved.push(JSON.parse(await fs.readFile(path.join(dir,name),'utf8')));
  const rows=await db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='memory_tombstone'").bind(workspaceId).all();
  const records=[...new Map([...saved,...rows.results.map(r=>JSON.parse(r.body))].map(({id,scopeId,contentHash,sourceKeys,deletedAt,deletedBy})=>[id,{id,scopeId,contentHash,sourceKeys,deletedAt,deletedBy}])).values()];
  // One immutable deletion-intent file per memory avoids lost updates between
  // API and indexer processes; these files are never rolled back with SQLite.
  for(const record of records){const final=path.join(dir,createHash('sha256').update(record.id).digest('hex')+'.json');try{await fs.access(final);}catch(e){if(e.code!=='ENOENT')throw e;const temp=final+'.'+randomUUID()+'.tmp';const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}await fs.rename(temp,final);}}
  if(restore)for(const item of records){
    // Before the API starts serving, an older backup must lose all forgotten
    // bodies and revisions. The independent ledger is not rolled back with DB.
    await db.prepare("INSERT INTO hub_v2_records(workspace_id,kind,id,revision,scope_id,parent_id,status,updated_at,body) VALUES(?,'memory_tombstone',?,1,?,?,'forgotten',?,?) ON CONFLICT(workspace_id,kind,id) DO NOTHING").bind(workspaceId,item.id,item.scopeId,item.id,item.deletedAt,JSON.stringify({...item,status:'forgotten',revision:1})).run();
    const current=await db.prepare("SELECT body,revision FROM hub_v2_records WHERE workspace_id=? AND kind='channel_memory' AND id=?").bind(workspaceId,item.id).first();
    if(!current)continue;const memory=JSON.parse(current.body);if(memory.status==='deleted')continue;
    const tombstone={id:item.id,scopeId:item.scopeId,version:(memory.version||0)+1,status:'deleted',deletedAt:item.deletedAt,revision:current.revision+1};
    await db.batch([
      db.prepare("UPDATE hub_v2_records SET body=?,status='deleted',revision=revision+1 WHERE workspace_id=? AND kind='channel_memory' AND id=?").bind(JSON.stringify(tombstone),workspaceId,item.id),
      db.prepare("UPDATE hub_v2_records SET body=json_object('id',id,'scopeId',scope_id,'parentId',parent_id,'status','deleted','revision',revision+1,'version',json_extract(body,'$.version')),status='deleted',revision=revision+1 WHERE workspace_id=? AND kind='channel_memory_version' AND parent_id=?").bind(workspaceId,item.id),
      db.prepare("UPDATE hub_v2_records SET status='pending',body=json_set(body,'$.status','pending','$.revision',revision+1,'$.retryAt',NULL,'$.attempts',0),revision=revision+1 WHERE workspace_id=? AND kind='memory_index_job' AND id=?").bind(workspaceId,item.id)
    ]);
  }
  return records;
}

export async function scrubMemoryReceipts(db,workspaceId,memoryId){
  const scrub=value=>{if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object'){if(value.id===memoryId)return {id:memoryId,status:'deleted',forgotten:true};return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,scrub(v)]));}return value;};
  let after='';for(;;){
    const rows=await db.prepare('SELECT request_id,result FROM hub_v2_receipts WHERE workspace_id=? AND request_id>? AND instr(result,?)>0 ORDER BY request_id LIMIT 100').bind(workspaceId,after,memoryId).all();
    const statements=[];for(const row of rows.results){const result=JSON.stringify(scrub(JSON.parse(row.result)));if(result!==row.result)statements.push(db.prepare('UPDATE hub_v2_receipts SET result=? WHERE workspace_id=? AND request_id=?').bind(result,workspaceId,row.request_id));}
    if(statements.length)await db.batch(statements);if(rows.results.length<100)break;after=rows.results.at(-1).request_id;
  }
}
