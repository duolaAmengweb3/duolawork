import {access} from './workspace-objects.mjs';
// Read-only diagnostics. A visible response is not an automated judgment of usefulness.
export async function responseMetrics(repo,actor,{channelId}){
 await access(repo,channelId,actor);
 const turns=await repo.list('channel_turn',{scope:channelId,...(!actor.owner?{parent:actor.memberId}:{}),order:'recent',limit:100});
 const contexts=await repo.list('context_metrics',{scope:channelId,...(!actor.owner?{parent:actor.memberId}:{}),order:'recent',limit:100});
 const milliseconds=(a,b)=>a&&b&&Date.parse(b)>=Date.parse(a)?Date.parse(b)-Date.parse(a):null;
 return{measuredAt:new Date().toISOString(),channelId,sampleWindow:'latest 100 updated turns; includes pending/errors, not all historical traffic',samples:turns.map(t=>({turnId:t.id,memberId:t.memberId,status:t.status,createdAt:t.createdAt,claimedAt:t.claimedAt||null,completedAt:t.completedAt||null,saveToClaimMs:milliseconds(t.createdAt,t.claimedAt),claimToReceiptMs:milliseconds(t.claimedAt,t.completedAt),totalMs:milliseconds(t.createdAt,t.completedAt),context:contexts.find(c=>c.id===t.id)||null,modelTokens:null,modelCost:null,firstUsefulReplyMs:null})),limits:['Claim-to-receipt includes native tools, external services, user permissions and model work; it is not pure inference time','First useful response needs output review; absent native usage is unknown, not zero','Recent-window estimates are descriptive, not a platform-wide SLA']};
}
