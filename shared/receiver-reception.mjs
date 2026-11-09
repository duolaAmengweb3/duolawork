// Keep independent group failures while retaining setup as a legacy summary.
export function receptionIssues(connection) {
  const issues = {...connection?.receptionIssues};
  const setup = connection?.setup;
  if (setup?.stage === 'blocked' && (!connection?.verifiedAt || !setup.at || setup.at > connection.verifiedAt))
    issues[setup.channelId || '*'] = setup;
  return Object.fromEntries(Object.entries(issues).filter(([, issue]) => issue?.stage === 'blocked'));
}

export function receptionIssue(connection, channelId) {
  const issues = receptionIssues(connection);
  return issues['*'] || (channelId ? issues[channelId] :
    Object.values(issues).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0]);
}
