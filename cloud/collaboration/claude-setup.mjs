// User-facing setup is one instruction. The adapter owns the install recipe.
export function claudeRecipe(origin, sha256) {
  const entry='"$HOME/.local/share/agent-hub-claude/connector.cjs"';
  const download=origin+'/v2/connectors/claude/download?version='+sha256;
  return {
    protocol:'agent-hub-claude/2', requirements:'Claude Code already works in this environment; macOS or Linux; Node.js 22.19+ (the bundled HTTP library requires this minimum). Do not change its account, provider, model, global permissions, project or running work.',
    install:`mkdir -p "$HOME/.local/share/agent-hub-claude" && curl --fail --location --compressed '${download}' -o ${entry}.next.cjs && node -e 'const f=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")!==process.argv[2])process.exit(1)' ${entry}.next.cjs '${sha256}' && node --check ${entry}.next.cjs && mv ${entry}.next.cjs ${entry}`,
    setup:{command:'node '+entry+' setup',stdin:{endpoint:origin,memberId:'from the copied instruction',alias:'from the copied instruction',code:'one-use code from the copied instruction',sessionId:'optional: exact CURRENT native session ID only if available; never guess or choose latest'}},
    steps:[
      'Before installation, check Node >=22.19. Reuse a compatible runtime, including an existing private installation. If missing, prepare an official Node 22 LTS runtime under ~/.local/share/agent-hub-claude only, verify the official SHASUMS256.txt before extracting, and use its absolute node path in both install checks and setup. Do not change system Node, PATH, shell configuration or Claude settings. Then run install in YOUR existing environment; the connector SHA-256 check must pass. Keep dependency details out of the user reply unless installation fails.',
      'Run setup with the JSON object on stdin (not argv). Do not run the older interactive pair command. Setup is idempotent for this member and reports progress to Hub. It never launches Claude, changes provider login or reads transcript files.',
      'Read the JSON result. If stage is ready, the existing native session has actually completed the Hub check. If stage is waiting_owner, reply in at most four short Chinese lines: prepared but not connected; enter /exit when current work is done; paste the returned resumeCommand into the terminal; confirm the native prompt and wait for automatic Hub verification. Also tell them the command is available in DuolaWork connection page. Never show JSON, waiting_owner, needs_input, tool names, dependency installation logs or claims of successful connection in that reply. Do not launch nested Claude, kill the current session, automatically exit, or claim ready. The user can finish this turn and resume the original session with that command; first-time custom Channels consent belongs to Claude itself.',
      'Once resumed with the connector, its official Channel delivers a Hub verification. Use the supplied MCP list_work, claim_work and submit_work tools to complete it yourself. Do not synthesize a receipt or submit it from this setup script. Subsequent group messages use the bound working session; the account connection is not a project choice.',
      'If preparation fails, report the specific failure. Retrying the same instruction must keep existing credentials. Do not regenerate accounts or overwrite another member. Never expose access/refresh tokens, login files or passwords. Idle signal polling must not call a model.'
    ],
    reference:'https://code.claude.com/docs/en/channels-reference',
  };
}
export function claudeSkill({origin,member,alias,pairingCode}) {
  return `请把你当前使用的 Claude Code 账号接入我的 Agent Hub，备注「${member.name}」。在你自己所在的电脑或服务器操作，保留当前登录、模型、项目和已有会话。先读取 ${origin}/v2/connectors/claude/guide ，按其中步骤自动安装、校验并完成配对，回填进度。接入参数：${JSON.stringify({endpoint:origin,memberId:member.id,alias,code:pairingCode})}（配对码15分钟内有效、一次使用）。不要让我逐项配置技术参数，不要启动嵌套 Claude、打断当前任务或改全局设置。若官方要求恢复原会话或本人确认，只用简短步骤说明：工作结束后输入 /exit → 在退出后的终端粘贴准备好的恢复命令 → 确认连接提示 → 等待自动验证。恢复后不需要用户再发配对码。不要向我展示内部状态、安装日志或验证工具名称。实际收到 Hub 验证并亲自用工具回传后才算完成；长期凭证不要输出。`;
}
