# Claude Code 接入：保留原环境与原对话

更新：2026-11-05 18:40。**新版连接器和公开指南已部署，桌面新版已安装启用。** 真实 Linux Claude Code 2.1.311 首次接入、原对话热加载、正常重开自动接收均通过。原用户成员仍需本人在原对话执行一次新版接入说明；未冒充原成员已经完成。

## 用户操作

新流程：

1. 在 DuolaWork「成员与连接」复制接入说明，发到自己正在使用的 Claude Code 对话。
2. Claude 安装独立的 DuolaWork 个人插件，保留已有账号配对。首次只在当前对话输入一次 `/reload-plugins`；原生插件/工具如需确认，使用 Claude 原有提示。
3. Claude 自动领取并完成真实往返验证，DuolaWork 自动显示可聊天。以后照常打开 Claude、恢复原对话，不需要 Hub 专用启动器或长参数。

安装只创建 DuolaWork 自己的插件与私有连接文件，不编辑原登录、模型或 settings.json。重复安装不重建账号；更新连接时保留已有 grant 和群绑定。关闭 Claude 后不代替用户启动另一个 Claude；群消息排队，打开已关联原对话后继续处理。

账号接入与选会话仍分开。不同群可以选同一账号的不同原对话；也可把群里的关联说明发到正在工作的对话，用已装插件关联它。关联不新建成员，不扫描其他对话正文。新项目仍在用户自己的电脑或服务器创建。

## 如何实现

| 部分 | 作用 | 来自哪里 |
|---|---|---|
| 个人插件 | 普通 Claude 启动时加载；首次支持原生 `/reload-plugins` | Claude 官方插件机制 |
| Plugin Monitor | 常驻监听已关联对话的 Hub 待办，stdout 事件唤醒原会话；空闲不调用模型 | Claude 官方机制 |
| MCP 工具 | 原 Claude 自己领取工作、使用原生工具处理、回群/交付 | 标准 MCP + 现有 Hub 协议 |
| 对话对应关系 | 只识别启动插件的当前 Claude 原生进程；群绑定、领取、回执仍由 Hub 管理 | DuolaWork 适配代码 |

文件修改、终端、依赖仍在 Claude 自己的环境执行。VPS 上的 Claude 不会因此获得 Mac 终端接口；群消息与获授权的共享资料照常可见。连接由原环境主动请求 HTTPS，不需要开放 VPS 入站端口。

原生会话身份目前读取当前祖先进程对应的 Claude 元数据登记，再使用官方 SDK 获取该对话标题。该登记格式属于版本适配点，并非声称跨所有版本的稳定公开接口；拿不到准确身份时明确停止，不猜最新会话。当前真实验证为 Linux Claude Code 2.1.311；macOS 与其他版本不能冒充已经进行相同原生联测。安装指南要求原生版本至少为本次验证版本，不自动升级用户的 Claude。

## 为什么采用这个方案

[agent-intercom](https://github.com/iambashar/agent-intercom) 的 MIT 实现使用 Claude Monitor 监听消息，再调用工具处理。借鉴其接收方式，继续复用 Hub 的账号、群、工作领取与回执，不另造邮箱系统。该项目规模小，不能以它证明行业普遍稳定。

[官方 Monitor 说明](https://code.claude.com/docs/en/tools-reference#monitor-tool) 区分临时工具监听与插件监听。常驻接收采用插件监听，不拿最长约半小时的临时任务当永久后台。

[官方加载限制](https://code.claude.com/docs/en/plugins/loading#trust-check-and-component-limits-for-repository-plugins) 明确项目级插件不能加载 monitor。因此将插件放进个人 skills 目录；[个人插件加载方式](https://code.claude.com/docs/en/plugins/create#make-a-plugin-load-in-every-session) 支持普通启动加载及原生重载。没有继续使用先前被原生身份检查阻止的 Inbox/socket 试探路径。

## 已通过与未通过的验收

真实 VPS 独立测试对话使用原订阅、原工具，未改变权限模式。早期临时 `--plugin-dir` 仅用于隔离探索；最终通过的是普通 `claude` 启动和个人插件热加载，不带 Hub 参数。

| 检查 | 当前证据 |
|---|---|
| Monitor 自动唤醒原对话 | 通过，普通无参数原生会话内的短时 Monitor 实测 |
| 插件接收 Hub 验证、原生工具提交 | 通过，临时插件真实往返 |
| 群消息 → 原生 Write/Edit → 回到正确群 | 通过，测试文件实读及 Hub 回帖核对 |
| 接入前上下文保留、同 ID 恢复 | 通过，回忆原信息并继续读写测试文件 |
| 重开积压消息及时重发 | 通过，修复实例重试冷却后样本 19.957 秒 |
| 多会话路由、关联码、重复安装不重配 | 隔离真实 Worker/MCP 协议测试通过 |
| 一段说明安装个人插件、一次原生重载 | 通过，公开指引下载校验、原生安装与回传；隔离测试安装目录 |
| 不带 Hub 参数普通打开后自动上线 | 通过，普通启动、原生恢复准确原对话，自动回到原群 |
| 新版软件已对用户生效 | 通过，桌面与本地后台构建一致，云端公开指南为 v3 |

最终验收使用独立测试成员与对话。测试结束后，两条测试成员从正式列表移除，两个测试个人插件与临时目录均清理；只留下用户原来的 ClaudeVPS，原 settings.json 和登录凭证哈希不变。用户原工作对话没有被发送测试/安装指令。

## 工程与证据

- `connectors/claude/monitor.mjs`：原对话识别、插件生成、自动收信、MCP、原对话关联。
- `connectors/claude/cli.mjs` 的 `setup-monitor`：复用账号授权，安装个人插件，回填首次加载步骤。
- `cloud/collaboration/claude-setup.mjs`、`onboarding.mjs`：一段话接入指引与原生 reload 提示。
- `ui/conversation/RemoteClaudeConnect.jsx`：复制 reload、自动等待真实回复、旧版更新入口。
- `tests/claude-monitor.test.mjs`、`claude-remote.test.mjs`、`claude-onboarding.test.mjs`：共 10 项通过。
- `tests/claude-connect-ui.mjs`：隔离页面点击、剪贴板、首次验证与离线状态通过；`evidence/claude-monitor-installed-ui.json` 另有已安装服务的真实首次加载和成功状态。
- `evidence/claude-monitor-native.json`：原生测试会话、消息 ID、时间、实际测试包与后续候选包分别记录。

旧 Channels 启动器仅保留已有连接兼容；主流程已切到官方个人插件。302 项回归、完整打包、登录资料保护、桌面重开和激活检查通过。原用户的待接入成员使用“复制新版接入说明”完成一次升级，不重新创建账号。
