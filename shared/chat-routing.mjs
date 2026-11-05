// Owner messages have a default recipient; Agent replies only wake explicit
// addressees. Reading the group and speaking never require coordinator approval.
export function messageRecipients(channel, { owner = false, memberId, mentions = [], mentionAll = false } = {}) {
  if (mentionAll) return channel.memberIds.filter(id => id !== memberId);
  if (mentions.length) return [...new Set(mentions)].filter(id => id !== memberId);
  if (!owner) return [];
  if (channel.memberIds.length === 1) return channel.memberIds;
  return channel.memberIds.includes(channel.coordinatorId) ? [channel.coordinatorId] : [];
}

export function mentionableText(body) {
  return body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    .split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n');
}

export function hasAllMention(body) {
  return /(^|\s)@(?:全员|所有人)(?=$|[\s，。,:：?？!！;；])/u.test(mentionableText(body));
}

export function namedMentions(body, members) {
  const plain = mentionableText(body);
  const names = new Map();
  for (const {id: mid, name} of members) {
    if (name) names.set(name, [...(names.get(name) || []), mid]);
  }
  return [...names]
    .filter(
      ([name, ids]) =>
        ids.length === 1 &&
        new RegExp(
          `(^|[\\s])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s，。,:：?？!！;；])`,
          "u",
        ).test(plain),
    )
    .map(([, ids]) => ids[0]);
}
