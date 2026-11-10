// User-facing setup is one instruction. The adapter owns the install recipe.
export function claudeRecipe(origin, sha256) {
  const entry='"$HOME/.local/share/agent-hub-claude/connector.cjs"';
  const download=origin+'/v2/connectors/claude/download?version='+sha256;
  return {
    protocol:'agent-hub-claude/3', requirements:'Claude Code 2.1.311 or newer already works in this environment; macOS or Linux; Node.js 22.19+ (the bundled HTTP library requires this minimum). Do not change its account, provider, model, global permissions, project or running work.',
    install:`mkdir -p "$HOME/.local/share/agent-hub-claude" && curl --fail --location --compressed '${download}' -o ${entry}.next.cjs && node -e 'const f=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")!==process.argv[2])process.exit(1)' ${entry}.next.cjs '${sha256}' && node --check ${entry}.next.cjs && mv ${entry}.next.cjs ${entry}`,
    setup:{command:'node '+entry+' setup-monitor',stdin:{endpoint:origin,memberId:'from the copied instruction',alias:'from the copied instruction',code:'one-use code from the copied instruction'}},
    steps:[
      'Before installation, check Node >=22.19. Reuse a compatible runtime, including an existing private installation. If missing, prepare an official Node 22 LTS runtime under ~/.local/share/agent-hub-claude only, verify the official SHASUMS256.txt before extracting, and use its absolute node path in both install checks and setup. Do not change system Node, PATH, shell configuration or Claude settings. Then run install in YOUR existing environment; the connector SHA-256 check must pass. Keep dependency details out of the user reply unless installation fails.',
      'Check claude --version first. This connector is verified on native Claude Code 2.1.311. If older, report that a native update is required; never update Claude, change its login or invent compatibility. Execute setup-monitor inside the CURRENT Claude conversation, with the supplied JSON on stdin. The installer identifies its native ancestor, reuses an existing account grant, and adds an independent user plugin under the active Claude config directory skills/duolawork-*. It does not edit settings.json. Project plugins are unsuitable because Claude does not load their monitors.',
      'Read the JSON result. For waiting_owner, reply in at most three short Chinese lines: 准备好了。在当前对话输入 /reload-plugins，随后自动验证；以后照常打开 Claude。Do not ask the user to exit, paste a shell launcher, choose flags, install another Claude or provide another API key. Do not execute a nested Claude or claim the slash command was run if it was not. Claude retains its own native plugin/tool trust prompts.',
      'After the user runs /reload-plugins, the official plugin Monitor starts in the SAME conversation. It sends Hub notifications; use the supplied MCP tools yourself to list, claim and submit the check. A notification or an installation alone is not a successful connection. Normal group messages must return to their original Hub chat. Tools and file operations remain in the native Claude environment. A subsequent ordinary Claude startup loads the plugin automatically; only explicitly associated original conversations receive work.',
      'If preparation fails, report the specific failure. Retrying the same instruction must keep existing credentials. Do not regenerate accounts or overwrite another member. Never expose access/refresh tokens, login files or passwords. Idle signal polling must not call a model.'
    ],
    reference:'https://code.claude.com/docs/en/plugins/components#monitors',
  };
}
export function claudeSkill({origin,member,alias,pairingCode}) {
  return `请把你当前使用的 Claude Code 账号接入我的 DuolaWork，备注「${member.name}」。在你自己所在的电脑或服务器操作，保留当前登录、模型、项目和已有会话。先读取 ${origin}/v2/connectors/claude/guide ，按其中步骤自动安装、校验并完成配对，回填进度。接入参数：${JSON.stringify({endpoint:origin,memberId:member.id,alias,code:pairingCode})}（配对码15分钟内有效、一次使用）。不要让我逐项配置技术参数，不要启动嵌套 Claude、打断当前任务或改全局设置。安装完成后，只需提示我在当前对话输入 /reload-plugins，随后自动验证，以后照常打开 Claude；不要给我带参数的重开命令。原生插件或工具若有官方确认，保留原生提示。不要向我展示内部状态、安装日志或验证工具名称。实际收到 Hub 验证并亲自用工具回传后才算完成；长期凭证不要输出。`;
}
