import {nativeForm} from '../../shared/native-forms.mjs';
export function runtimeRecipe(origin,sha256){
  const directory='"$HOME/.local/share/duolawork/runtime/'+sha256+'"',file='"$HOME/.local/share/duolawork/runtime/'+sha256+'.tgz"';
  return{protocol:'duolawork-native/1',
    requirements:'Node.js 22+, macOS or Linux. Run in the ORIGINAL Agent environment, under the ORIGINAL OS user. The Agent must already work there. Do not transfer login files, change model/provider, install a substitute model, or touch another account.',
    install:`mkdir -p ${directory} && curl --fail --location '${origin}/v2/connectors/native/download?version=${sha256}' -o ${file} && node -e 'const f=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")!==process.argv[2])process.exit(1)' ${file} '${sha256}' && tar -xzf ${file} -C ${directory}`,
    setup:{command:'node '+directory+'/connectors/runtime/cli.mjs setup',stdin:'The exact JSON object from the copied instruction. Never put long-lived credentials in command arguments or chat.'},
    steps:['Run the install command yourself, then setup with JSON on stdin. Repeated setup preserves the same account and saved conversation bindings. Never run a second account using the first account login.',
      'Setup installs only this member receiver as a per-user launchd/systemd service (system service for the current root user). It receives authorized Hub collaboration work in THIS environment. Do not open public ports or request SSH access to the Hub computer.',
      'Report the setup result plainly. Connecting or inventory appearing is not a model round-trip. The Hub must receive a real native reply before claiming collaboration verified.',
      'Do not terminate the current native task, switch model/API, clear history, or choose a random/latest session. Gemini CLI original interactive terminal must finish and close before the connector resumes the exact saved session. Desktop adapters use the original native queue. If unsupported form/version or missing prerequisite is reported, state it exactly; do not substitute a different product.'],
    documentation:{'antigravity-cli':'https://antigravity.google/docs/cli/acp/','gemini-cli':'https://geminicli.com/docs/cli/session-management/'},
    versions:{'antigravity-cli':'1.5.0 or later; agy acp must be available. Check agy --version before pairing. Do not replace Antigravity CLI with Gemini CLI or a separate ACP login profile.'}};
}
export function runtimeSkill({origin,member,form,pairingCode}){
  const f=nativeForm(form,member.platformId),alias=member.id;
  return `请把我现有的 ${f.name} 账号接入 DuolaWork，备注「${member.name}」。请在你自己运行的电脑或服务器、原系统用户下操作，保留登录、模型、项目和已有会话。读取 ${origin}/v2/connectors/native/guide 并自动执行安装、校验和 setup，把下面参数以 JSON 标准输入传给 setup：${JSON.stringify({endpoint:origin,memberId:member.id,platformId:member.platformId,alias,form,code:pairingCode})}。配对码15分钟有效。不要让我逐项填技术参数，不访问我的其他机器，不打断当前工作，不启动替代 Agent，不改全局权限或原生登录。不兼容就明确报告原因。连接器上线后，DuolaWork 会显示原环境的项目和对话；真正完成原生回复验证前不要宣称接入全部完成。`;
}
