export function compareChats(a,b){
 return Number(!!b.pinnedAt)-Number(!!a.pinnedAt) ||
  (a.pinnedAt&&b.pinnedAt?b.pinnedAt.localeCompare(a.pinnedAt):0) ||
  (b.lastMessageAt||b.createdAt||'').localeCompare(a.lastMessageAt||a.createdAt||'') || a.id.localeCompare(b.id);
}
