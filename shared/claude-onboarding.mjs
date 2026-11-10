export const CLAUDE_RESUME_HELP = '继续完成刚才 DuolaWork 的接入验证，保留现有配对和原会话。验证通过后告诉我。';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function claudeResumeAction(input) {
  const absolute = (value, name) => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw Error(name + '无效');
    return value;
  };
  const workspace = absolute(input.workspace, '原项目目录');
  const node = absolute(input.nodePath, '运行程序'), connector = absolute(input.connectorPath, '连接组件');
  if (!node.endsWith('/node') || !connector.endsWith('/connector.cjs')) throw Error('恢复程序路径无效');
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(input.alias || '')) throw Error('连接标识无效');
  if (input.sessionId && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.sessionId)) throw Error('原对话编号无效');
  return {type:'claude_resume', workspace, exactSession:!!input.sessionId,
    command:'cd -- ' + quote(workspace) + ' && ' + [node,connector,'start',input.alias,'--resume',...(input.sessionId?[input.sessionId]:[])].map(quote).join(' ')};
}
