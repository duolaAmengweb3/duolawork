import {Repository} from '../cloud/collaboration/repository.mjs';
// Only clean objects owned by a durable upload record. Never scan/delete unknown paths.
export async function cleanUploads(db,workspaceId,store,now=new Date().toISOString()){
 const repo=new Repository(db,workspaceId),cutoff=new Date(Date.parse(now)-7*86400000).toISOString();
 const {results}=await db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='shared_upload' AND updated_at<? AND json_extract(body,'$.chunksCleanedAt') IS NULL AND status IN ('uploading','canceled','published','expired') ORDER BY updated_at LIMIT 25").bind(workspaceId,cutoff).all();
 let cleaned=0;
 for(const row of results){const upload=JSON.parse(row.body),chunks=[];let after='';do{const page=await repo.list('shared_chunk',{parent:upload.id,after,limit:500});chunks.push(...page);after=page.length===500?page.at(-1).id:'';}while(after);
  if(upload.storage!=='disk')continue;
  await repo.transact('upload-expire:'+upload.id,{uploadId:upload.id},async tx=>{const u=await tx.get('shared_upload',upload.id);if(u.status==='uploading'){const usage=await tx.get('shared_usage','bytes');tx.put('shared_usage',{...usage,reserved:Math.max(0,usage.reserved-u.size)});}tx.put('shared_upload',{...u,status:u.status==='published'?'published':'expired',chunksCleanedAt:now});return {};},now);
  for(const chunk of chunks){await repo.transact('chunk-clean:'+chunk.id,{},tx=>tx.put('shared_chunk',{...chunk,status:'cleaned'}),now);await store.delete(chunk.objectKey);}
  const current=await repo.get('shared_upload',upload.id);if(current.status!=='published')await store.delete(`${workspaceId}/shared/${upload.id}/complete-${upload.sha256}`);
  cleaned++;
 }return {cleaned};
}
