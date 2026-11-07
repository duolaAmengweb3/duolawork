import {recordMemoryEvent} from './memory-context.mjs';
import {ownerRequirementChanged} from './coordination.mjs';
import {fail,required} from './repository.mjs';

// Human read cursors never share storage or acknowledgements with agent inboxes.
export async function channelUnread(repo,cursors) {
  if(!cursors||typeof cursors!=='object'||Array.isArray(cursors)||Object.keys(cursors).length>500||Object.values(cursors).some(n=>!Number.isSafeInteger(n)||n<0)) fail('invalid_cursor','未读位置无效');
  const now=new Date().toISOString();
  // Baseline only genuinely new clients/chats. An old offline window cannot move
  // a durable cursor backwards or overwrite unread messages observed elsewhere.
  await repo.db.prepare(`INSERT INTO hub_human_read(workspace_id,user_id,channel_id,number,updated_at)
    SELECT workspace_id,'owner',id,COALESCE(json_extract(body,'$.messageSequence'),0),? FROM hub_v2_records WHERE workspace_id=? AND kind='channel' AND id NOT IN (SELECT key FROM json_each(?))
    ON CONFLICT(workspace_id,user_id,channel_id) DO NOTHING`).bind(now,repo.workspaceId,JSON.stringify(cursors)).run();
  await repo.db.prepare(`INSERT INTO hub_human_read(workspace_id,user_id,channel_id,number,updated_at)
    SELECT r.workspace_id,'owner',r.id,MIN(CAST(c.value AS INTEGER),COALESCE(json_extract(r.body,'$.messageSequence'),0)),? FROM json_each(?) c JOIN hub_v2_records r ON r.workspace_id=? AND r.kind='channel' AND r.id=c.key
    ON CONFLICT(workspace_id,user_id,channel_id) DO UPDATE SET number=MAX(hub_human_read.number,excluded.number),updated_at=excluded.updated_at`).bind(now,JSON.stringify(cursors),repo.workspaceId).run();
  const stored=await repo.db.prepare("SELECT channel_id,number FROM hub_human_read WHERE workspace_id=? AND user_id='owner'").bind(repo.workspaceId).all();
  cursors=Object.fromEntries(stored.results.map(r=>[r.channel_id,r.number]));
  const rows=await repo.db.prepare(`SELECT r.scope_id AS channelId,COUNT(*) AS count,
    MIN(CAST(json_extract(r.body,'$.number') AS INTEGER)) AS firstNumber,
    MAX(CAST(json_extract(r.body,'$.number') AS INTEGER)) AS lastNumber,
    MAX(CASE WHEN json_extract(r.body,'$.mentionAll')=1 OR EXISTS(SELECT 1 FROM json_each(r.body,'$.mentions') WHERE value='owner') THEN 1 ELSE 0 END) AS mentioned
    FROM hub_v2_records r JOIN json_each(?) c ON c.key=r.scope_id
    WHERE r.workspace_id=? AND r.kind='channel_message'
    AND CAST(json_extract(r.body,'$.number') AS INTEGER)>CAST(c.value AS INTEGER)
    AND COALESCE(json_extract(r.body,'$.hidden'),0)=0
    AND json_extract(r.body,'$.authorId') NOT IN ('owner','system')
    GROUP BY r.scope_id`).bind(JSON.stringify(cursors),repo.workspaceId).all();
  return {items:rows.results,cursors};
}

export async function editMessage(tx,identity,actor,cmd,channel,helpers) {
  const {channelMessage,enqueue}=helpers;
  const message=await tx.get('channel_message',cmd.messageId);
  if(message.scopeId!==channel.id||!actor.owner||message.authorId!=='owner')fail('forbidden','只能修改自己发出的消息',403);
  if(message.type!=='message')fail('invalid_input','此类消息不能直接修改');
  if((message.version||1)!==cmd.expectedVersion)fail('version_conflict','消息已有新的修改，请重新打开',409);
  const body=required(cmd.body,'消息',24000);
  if(body===message.body)return message;
  const raw=await tx.repo.db.prepare("SELECT id FROM hub_v2_records WHERE workspace_id=? AND kind='channel_turn' AND scope_id=? AND json_extract(body,'$.messageId')=?").bind(tx.repo.workspaceId,channel.id,message.id).all();
  const turns=await Promise.all(raw.results.map(r=>tx.get('channel_turn',r.id)));
  const notices=await Promise.all(turns.map(t=>tx.get('outbox',`notice_${t.id}`,false)));
  const delivered=turns.some(t=>!['ready','unavailable','limited'].includes(t.status))||notices.some(n=>n&&!['awaiting_poll','pending','coalesced'].includes(n.status));
  tx.put('channel_message_version',{id:`${message.id}:${message.version||1}`,scopeId:channel.id,parentId:message.id,body:message.body,version:message.version||1,authorId:message.authorId,createdAt:message.editedAt||message.createdAt});
  const updated=tx.put('channel_message',{...message,body,version:(message.version||1)+1,editedAt:tx.now});
  await recordMemoryEvent(tx,channel,updated,'message');
  await ownerRequirementChanged(tx,identity,channel,updated,message,helpers);
  if(delivered){
    const change=await channelMessage(tx,channel,actor,`更新了要求：\n${body}`,{type:'message',replyTo:message.id,replySnapshot:{body:message.body,version:message.version||1,authorId:message.authorId},editedMessageId:message.id,editedVersion:updated.version,rootId:message.rootId||message.id,hops:0,mentions:message.mentions||[],recipientIds:message.recipientIds||[],requestId:cmd.requestId});
    for(const mid of new Set(turns.map(t=>t.memberId).filter(mid=>channel.memberIds.includes(mid)))){
      await enqueue(tx,identity,channel,change,mid);
      for(const turn of turns.filter(t=>t.memberId===mid&&['ready','unavailable','limited'].includes(t.status))){
        tx.put('channel_turn',{...turn,status:'merged',mergedInto:`turn_${change.id}_${mid}`,reason:'用户更新了要求，已保留新旧版本'});
        const notice=await tx.get('outbox',`notice_${turn.id}`,false);if(notice)tx.put('outbox',{...notice,status:'coalesced'});
      }
    }
    return {...updated,updateMessageId:change.id};
  }
  for(const turn of turns)tx.put('channel_turn',{...turn,messageVersion:updated.version});
  return updated;
}
