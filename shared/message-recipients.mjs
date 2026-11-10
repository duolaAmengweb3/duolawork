// A name appearing in prose is not proof that a notification was delivered.
// Historical records without recipientIds remain unknown rather than guessed.
export function notificationRecipients(message) {
 return {
  known: Array.isArray(message.recipientIds),
  ids: [...new Set((message.recipientIds||[]).filter(id=>id!=='owner'&&id!==message.authorId))],
  humanMentioned: !!message.mentionAll || !!message.mentions?.includes('owner'),
 };
}
