import {HubError} from '../../shared/domain.mjs';

// Durable invalidations, not a second message store. Only these public resource
// names enter the journal; credentials, document contents and native history do not.
const channelKinds = new Set(['channel','channel_message','channel_turn','channel_doc','channel_task','channel_memory','channel_question','channel_meeting','channel_suggestion','channel_coordination','channel_delivery_issue','channel_link','shared_file','shared_handoff','channel_folder','material_placement','execution_binding','outbox']);
const memberKinds = new Set(['connection','native-command','session-link','step']);
const serviceKinds = new Set(['service_connection','service_host','workspace_skill','vault_entry']);
export function changeDescriptor(record) {
  if(channelKinds.has(record.kind))return {kind:record.kind,id:record.id,channelId:record.kind==='channel'?record.id:record.scopeId||'',memberId:record.memberId||record.parentId||''};
  if(memberKinds.has(record.kind))return {kind:record.kind,id:record.id,memberId:record.kind==='connection'?record.id:record.memberId||record.parentId||''};
  // Workspace-wide UI lists are owner-only hints: no credential fields,
  // connector configuration, names, or bodies enter this journal. Non-owner
  // delivery below already requires channel membership or an exact memberId.
  if(serviceKinds.has(record.kind))return {kind:record.kind,id:record.id};
  return null;
}
const buses = new WeakMap();
function bus(db,workspaceId){let workspaces=buses.get(db);if(!workspaces)buses.set(db,workspaces=new Map());let state=workspaces.get(workspaceId);if(!state)workspaces.set(workspaceId,state={version:0,listeners:new Set()});return state;}
export function publishChanges(db,workspaceId){const state=bus(db,workspaceId);state.version++;for(const wake of [...state.listeners])wake();}
function wait(state,version,ms,signal){return new Promise((resolve,reject)=>{
  let timer;const finish=()=>{clearTimeout(timer);state.listeners.delete(finish);signal?.removeEventListener('abort',abort);resolve();};
  const abort=()=>{finish();reject(signal.reason||new Error('Aborted'));};
  if(signal?.aborted)return abort();
  state.listeners.add(finish);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(finish,ms);
  if(state.version!==version)finish();
});}
const head=async repo=>Number((await repo.db.prepare('SELECT revision FROM hub_v2_clock WHERE workspace_id=?').bind(repo.workspaceId).first())?.revision??-1);

export async function changes(repo,actor,{after,waitMs=8000,signal,authorize=async()=>actor}={}){
  const bootstrap=after===undefined||after===null||after==='';
  let cursor=bootstrap?-1:Number(after);
  if(!Number.isSafeInteger(cursor)||cursor< -1)throw new HubError('invalid_cursor','更新位置无效，请重新同步',400);
  if(!Number.isFinite(waitMs)||waitMs<0)throw new HubError('invalid_wait','更新等待时间无效',400);
  const until=Date.now()+Math.max(0,Math.min(8000,waitMs)),state=bus(repo.db,repo.workspaceId);
  while(true){
    signal?.throwIfAborted();const version=state.version;
    const top=await head(repo);
    if(bootstrap||cursor>top||cursor<top-10000){await authorize();return {cursor:top,reset:true,changes:[],serverTime:new Date().toISOString()};}
    const rows=await repo.db.prepare("SELECT sequence,body FROM hub_v2_records WHERE workspace_id=? AND kind='change_event' AND scope_id='' AND sequence>? ORDER BY sequence LIMIT 100")
      .bind(repo.workspaceId,cursor).all();
    // Fresh authorization at delivery: membership/token revocation during a
    // held request must not leak even resource identifiers.
    actor=await authorize();
    const visible=[],channels=new Map();
    for(const row of rows.results){
      for(const item of JSON.parse(row.body).changes){
        if(actor.owner){visible.push(item);continue;}
        if(item.channelId){
          if(!channels.has(item.channelId))channels.set(item.channelId,await repo.get('channel',item.channelId,false));
          if(!channels.get(item.channelId)?.memberIds.includes(actor.memberId))continue;
          if(['channel_turn','execution_binding','outbox'].includes(item.kind)&&item.memberId!==actor.memberId)continue;
          visible.push(item);
        }else if(item.memberId===actor.memberId)visible.push(item);
      }
      cursor=Number(row.sequence);
    }
    if(rows.results.length<100)cursor=Math.max(cursor,top);
    const unique=[...new Map(visible.map(c=>[c.kind+':'+c.id,c])).values()];
    if(unique.length||Date.now()>=until)return {cursor,reset:false,changes:unique,serverTime:new Date().toISOString()};
    if(rows.results.length===100)continue;
    // Same-process commits wake immediately. The bounded DB check recovers
    // missed hints, another server process or a Worker without a shared bus.
    await wait(state,version,Math.min(1000,Math.max(1,until-Date.now())),signal);
  }
}
