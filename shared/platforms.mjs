export const BUILTIN_PLATFORMS = [
  { id: 'grok-bot', name: 'Grok Bot', color: '#25282a', initial: 'G', entryUrl: 'https://grok.com/', modes: ['webhook', 'connector'], nativeAgents: true, browserCollection: false, note: '使用原 Grok Bot 网页会话，保留其记忆、工具与权限；登录和真实任务往返分别验证，不改用普通聊天或模型 API。', docs: 'https://docs.x.ai/x-subscription/grok-bot-sign-in' },
  { id: 'chatgpt-agent', name: 'ChatGPT Agent', color: '#19735e', initial: 'O', entryUrl: 'https://chatgpt.com/', modes: ['connector', 'workspace-api'], nativeAgents: true, browserCollection: false, note: '按实际账号权限连接；工作区 API 不能套用到个人账号，成果通过工具提交。', docs: 'https://developers.openai.com/workspace-agents/trigger-runs' },
  { id: 'gemini', name: 'Gemini', color: '#536bd1', initial: '✧', entryUrl: 'https://gemini.google.com/', modes: ['connector', 'browser'], nativeAgents: false, browserCollection: false, note: '专用浏览器正常登录后验证自定义应用和必要批准；未验证不显示自动就绪。', docs: 'https://support.google.com/gemini/answer/17209137' },
  { id: 'muse', name: 'Muse', color: '#9b6bc0', initial: 'M', entryUrl: 'https://muse.ai/', modes: ['connector', 'browser'], nativeAgents: false, browserCollection: false, note: '在专用浏览器登录 Muse，登录资料保留在本机；自动派发与结果回传另行验证。', docs: 'https://www.meta.com/en-gb/help/superintelligence/1687253048996149/' },
];

// Refresh product-maintained entrypoints for existing workspaces without rewriting
// account IDs, profile bindings, verified capabilities or custom platforms.
export function maintainedPlatforms(platforms) {
  return platforms.map(platform => {
    const builtin = !platform.custom && BUILTIN_PLATFORMS.find(p => p.id === platform.id);
    return builtin ? {...platform, entryUrl: builtin.entryUrl, note: builtin.note, docs: builtin.docs} : platform;
  });
}

export const ROLE_TEMPLATES = [
  { id: 'research', name: '信息研究员', description: '寻找一手来源，整理事实、出处与待核实项。', color: '#5075b4' },
  { id: 'editor', name: '内容编辑', description: '按你的目标与文风，把已确认的素材变成可交付稿件。', color: '#997647' },
  { id: 'review', name: '核实与复盘', description: '核对引用、遗漏与成果清单，给出明确修改意见。', color: '#577a68' },
  { id: 'assistant', name: '行政与跟进', description: '整理待办与资料，按你明确授权的范围跟进。', color: '#8c6988' },
];

export const STATUS_LABELS = {
  ready: '可以开始', waiting: '等待前序', running: '进行中', dispatching: '正在派发',
  queued: '等待平台开始', verifying: '正在验收', completed: '已完成', needs_approval: '等你确认',
  needs_review: '待核对', failed: '执行失败', canceled: '已停止后续', paused: '已暂停',
  pending: '登录待确认', login_required: '需要登录', connected: '工具已连接', unverified: '协作未接通',
  disabled: '已停用', awaiting_result: '等待成果', offline: '执行端离线', delivery_incomplete: '交付不完整',
  connecting:'正在自动接入',restoring:'正在后台恢复',working:'正在执行',waiting_login:'等待登录',waiting_idle:'等待账号空闲',platform_approval:'等待平台批准',waiting_adapter:'任务接入未验证',choose_bot:'选择原生 Bot',
};

// A saved account, an open browser and a bare status flag are not evidence
// of a provider login or of the provider executing tasks for Hub.
export function hasVerifiedTools(member) {
  return member?.status === 'ready' && !!member.lastSeenAt &&
    !!member.evidence?.evidenceId && !!member.evidence?.at &&
    ['native_roundtrip', 'browser_roundtrip'].includes(member.evidence?.kind);
}

export function accountConnectionState(account, members = []) {
  const verified = members.filter(m => m.accountId === account.id && hasVerifiedTools(m));
  const browser=verified.some(m=>m.evidence.kind==='browser_roundtrip');
  return {
    value: verified.length ? 'connected' : 'unverified',
    label: browser?'任务连接已验证':verified.length ? '工具已验证' : '协作未接通',
    detail: browser?'已验证原 Agent 接收任务并回传结果，任务由工作台自动派发。':verified.length
      ? '已有真实工具读写回执；自动接单与交付仍需单独验证。'
      : '账号已添加，尚未验证自动接单与结果回传。',
    loginLabel: '网页登录未自动核验',
  };
}

export function loginPresentation(observation) {
  const labels={
    manual_login:['pending','纯手动登录中','工作台不读取或控制这个登录窗口。完成登录后，点击“登录完成，返回工作台”。'],
    authenticated:['connected','已登录','已从专用账号环境自动确认登录；协作状态见下方。'],
    saved:['pending','登录资料已保存','工作台会在后台复用原账号资料检查，无需重新打开窗口确认。'],
    signing_in:['pending','正在登录','请在原登录窗口继续，工作台会自动检查结果。'],
    login_required:['login_required','网站要求登录','请在原账号窗口处理；工作台不会清理资料或反复尝试登录。'],
    verification_required:['login_required','等待本人验证','平台要求本人验证，请在原账号窗口处理。'],
    unsupported:['pending','登录未自动核验','此平台的登录检测尚未适配，不代表登录失败。'],
    unknown:['pending','登录待确认','尚未观察到完整登录界面；网络错误不会触发清理或重新登录。'],
  };
  const [value,label,detail]=labels[observation?.status]||labels.unknown;
  return {value,label,detail,lastConfirmedAt:observation?.lastConfirmedAt||null};
}

export function assertHttpUrl(value, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的网站地址'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:'))) {
    throw new Error('仅接受 HTTPS 地址；凭证请填写到独立密钥字段');
  }
  if (/[?&](?:token|key|secret|access_token|api_key)=/i.test(url.search)) throw new Error('网站地址不能包含访问密钥');
  return url.href;
}
