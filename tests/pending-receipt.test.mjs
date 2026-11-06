import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingTurnState,pendingMemberActivity} from '../shared/chat-activity.mjs';
import {memberAvailability} from '../shared/member-availability.mjs';
const turn={id:'current',memberId:'agent',scopeId:'group',status:'ready',messageId:'question'};
const native=state=>({memberId:'agent',enabled:true,status:'working',assignments:[{channelId:'group',sessionId:'original',...state}]});

test('an unclaimed message does not imply a queue; started delivery appears before the claim',()=>{
 assert.equal(pendingTurnState(turn).kind,'waiting');
 const receiving=native({pendingStepId:'current',deliveryState:'working',workState:'working'});
 assert.equal(pendingTurnState(turn,undefined,receiving).kind,'receiving');
 assert.equal(pendingMemberActivity([turn],[],[receiving])[0].label,'1 条消息正在接收');
 assert.equal(pendingMemberActivity([turn],[],[receiving])[0].working,true);
 for(const platformId of ['codex','antigravity','gemini-cli','deepseek-harness','claude-code']){
  assert.equal(memberAvailability({id:'agent',platformId},{},receiving,'group',[turn]).label,'正在接收');
 }
});

test('sent, native queued, ambiguous delivery and confirmed processing are distinct',()=>{
 assert.equal(pendingTurnState(turn,undefined,native({pendingStepId:'current',deliveryState:'sent',workState:'working'})).kind,'delivered');
 assert.equal(pendingTurnState(turn,undefined,native({pendingStepId:'current',deliveryState:'queued',workState:'working'})).kind,'queued');
 assert.equal(pendingTurnState(turn,undefined,native({pendingStepId:'current',deliveryState:'uncertain',workState:'working'})).kind,'waiting');
 assert.equal(pendingTurnState({...turn,status:'active'},undefined,native({pendingStepId:'current',deliveryState:'queued'})).kind,'processing');
});

test('two, three or five other running conversations never imply this conversation is queued',()=>{
 for(const count of [2,3,5]){
  const state=native({});state.assignments.push(...Array.from({length:count},(_,i)=>({channelId:'other-'+i,sessionId:'different-'+i,pendingStepId:'work-'+i,deliveryState:'working',workState:'working'})));
  const active=state.assignments.slice(1).map(a=>({id:a.pendingStepId,memberId:'agent',scopeId:a.channelId,status:'active'}));
  assert.equal(pendingTurnState(turn,undefined,state,active).kind,'waiting');
  assert.equal(pendingMemberActivity([turn],[],[state])[0].label,'1 条消息等待接收');
  assert.equal(memberAvailability({id:'agent',platformId:'antigravity'},{},state,'group',[turn,...active]).label,'等待接收');
 }
});

test('only the same bound conversation can explain a queue, with a link to its preceding message',()=>{
 const state=native({pendingStepId:'previous',workState:'working'});
 const previous={...turn,id:'previous',messageId:'previous-question',status:'active'};
 const queued=pendingTurnState(turn,undefined,state,[previous]);
 assert.equal(queued.kind,'queued');assert.equal(queued.waitingForMessageId,'previous-question');
 for(const status of ['done','silent','removed','stalled'])assert.equal(pendingTurnState(turn,undefined,state,[{...previous,status}]).kind,'waiting');
 assert.equal(pendingTurnState(turn,undefined,state,[{...previous,memberId:'someone-else'}]).kind,'waiting');
});

test('mixed pending states keep their own counts and a reply removes stale native delivery',()=>{
 const waiting={...turn,id:'later'};const state=native({pendingStepId:'current',deliveryState:'working'});
 const row=pendingMemberActivity([turn,waiting],[],[state])[0];
 assert.equal(row.label,'1 条消息正在接收 · 1 条消息等待接收');
 assert.deepEqual(pendingMemberActivity([{...turn,status:'done'}],[],[state]),[]);
 assert.equal(pendingTurnState({...turn,status:'done'},undefined,state),null);
 assert.equal(pendingTurnState({...turn,status:'limited',resumeAfter:new Date().toISOString()}).kind,'delayed');
});
