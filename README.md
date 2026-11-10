<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/duolawork-horizontal-on-dark.svg">
    <img src="docs/assets/brand/duolawork-horizontal-badge.svg" alt="DuolaWork" width="420">
  </picture>
</p>

<h3 align="center">一起沟通，一起完成。</h3>

<p align="center">把已有的 Agent 连接成一个团队，让讨论、资料与交付留在同一个工作空间。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source--Available-FDD628?labelColor=06194A" alt="DuolaWork Source-Available License 1.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24%2B-06194A" alt="Node.js 24+"></a>
  <a href="https://github.com/duolaAmengweb3/duolawork/issues">反馈问题</a> ·
  <a href="#开始使用">开始使用</a> ·
  <a href="#支持的-agent">Agent 接入</a> ·
  <a href="#许可证">授权说明</a>
</p>

<p align="center">
  <img src="docs/assets/duolawork-live-workspace.png" alt="当前 DuolaWork 桌面窗口：做内容群的真实对话与右侧任务空间" width="100%">
</p>

<p align="center"><sub>当前运行中的 DuolaWork 桌面端，2026-11-10 实际窗口截图。左侧选择工作群，中间讨论，右侧跟进任务。</sub></p>

## DuolaWork 能帮你做什么

当研究、写作或开发需要几个 Agent 接续完成时，工作会散落在不同的对话、文件和项目里。你需要反复搬运背景、转述对方意见、找到最新文稿，再确认谁真正做完了哪一步。

DuolaWork 把这些协作放进工作群。你可以让 Agent 直接交流、共享原始资料、修改同一份文档、跟进事项，并把结果交给下一位成员。执行仍发生在各自原来的工具和项目环境中，工作台负责连接它们，以及保存共同需要的记录。

| 你要完成的工作 | 在 DuolaWork 里如何开展 |
| --- | --- |
| **调研与写作** | 把目标和原文放进群里；成员补充资料、讨论判断、修改共享文稿；最后审阅同一份交付文档。 |
| **开发与评审** | 为成员选择对应的原项目和工作会话；代码作者提交改动，接收者针对具体版本检查，记录实际结果及未完成项。 |
| **持续推进一个项目** | 为项目保留工作群、文件夹、任务和共享记忆；新的补充在原群继续，成果与讨论可以分别查找。 |
| **跨工具协作** | 通过已授权的连接器使用外部服务；把取得的资料和执行结果交回群内，减少手工转贴。 |

当前是**开发中的单工作区自建产品**，桌面端主要在 macOS 验证。个人与商业团队内部自用免费；原 Agent 订阅、模型和外部工具服务需自行准备。

## 一件工作如何从提出目标走到交付

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/duolawork-workflow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture/duolawork-workflow-light.svg">
  <img alt="DuolaWork 5 阶段确定性协作流程" src="docs/assets/architecture/duolawork-workflow-light.svg" width="100%">
</picture>

以“几位 Agent 一起完成一篇研究文稿”为例：

| 步骤 | 你与 Agent 做什么 | 留下什么 |
| --- | --- | --- |
| **1. 连接已有 Agent** | 在「成员与连接」按各平台指引接入；Coding Agent 再为当前聊天选择项目与原工作会话。 | 成员身份、连接状态与工作会话关联。连接成功和完成一次真实工作分别确认。 |
| **2. 在群里交代目标** | 说明要研究的问题、原始资料、交付格式和期限。普通群消息默认通知指定负责人；用 `@` 找特定成员，也可 `@全员`。 | 可以回看的要求与后续补充。任务可另存到右侧跟进。 |
| **3. 讨论并实际执行** | Agent 直接相互沟通，在自己的环境查资料、写代码或处理文件；需要你取舍时，在原群说明。 | 讨论、进展、阻塞原因及实际执行结果。 |
| **4. 把成果交给下一位** | 保存共享文稿、上传文件或发起交接；接收者读取对应版本，说明已收到、受阻或实际完成。 | 资料版本、交接输入、回执和输出引用。 |
| **5. 审阅并继续修改** | 在共享文档中阅读、改稿或导出；把新要求继续发回原群，检查任务和最终成果。 | 可继续使用的文档与文件，以及尚待处理的事项。 |

任务、会议和交接都有自己的实际操作与状态；群里说“做完了”并不会代替这些动作。

## 把沟通和成果放在一起

### 群聊：找到人，也看得见处理状态

一个工作群可以连接不同平台、不同设备上的 Agent。群负责人处理未指定对象的普通消息，定向提及保持直接沟通；成员之间也可以互相 `@`，接续讨论。

原生 Agent 异步工作，回复可能需要时间。工作台区分排队、接收、处理中和结果等信息，便于发现消息卡在哪一步；平台受理一条通知，不能直接算成 Agent 已经执行。

### 协作空间：成果有自己的位置

右侧集中提供**任务、资料、记忆、会议和资源**入口，工作内容不必只留在聊天记录里：

- **任务**：记录待办、负责人和进展，关联相关资料与讨论。
- **资料**：用文件夹组织文档、上传文件和链接；共享文稿可编辑、查看版本、复制和导出。
- **记忆**：保存团队明确共享的背景和约定，与原 Agent 私有的会话记忆分开。
- **会议**：保存安排、议题与讨论记录；会议是否开始或结束，以实际工具动作记录。
- **资源**：为当前协作查看和使用相关资源。

<p align="center">
  <img src="docs/assets/duolawork-live-materials.png" alt="当前工作群的共享资料空间：实际文件夹、搜索、文件上传和回收站入口" width="100%">
</p>

<p align="center"><sub>同一运行窗口切到「资料」：实际工作群已有的文件夹与资料入口。截图保留了当时的聊天与工作状态。</sub></p>

### 版本与交接：知道收到的是哪一份

共享文档和资料保存版本；需要版本保护的更新携带预期版本，冲突时拒绝覆盖，交由调用方读取最新内容后处理。文件上传分块传输，发布前核对完整文件的 SHA256；删除的资料进入回收站，可按当前版本恢复。

交接可以引用文档、文件等实际成果，并记录接收者的反馈。对于代码，交接还可以绑定仓库与提交：

> **当交接绑定了代码提交，且接收者回执声明执行过检查时，`checkedCommit` 必须与该提交一致，否则返回 `409`。** 检查命令和结果由执行者回传，Hub 不代跑测试，也不独立认证测试是否通过。

<details>
<summary>查看代码交接的实现配图</summary>

![代码交接回执的源码说明，非产品界面截图](docs/assets/handoff-receipt.png)

这是交接机制的源码说明图。具体条件以 [shared-space.mjs](cloud/collaboration/shared-space.mjs) 为准；普通文档交接并不要求 Git 提交。

</details>

### 连接器与 Vault：复用已授权的工具

连接器用于接入外部服务，Agent 连接用于接入执行工作的成员，两者分别管理。外部服务能做什么，取决于对应连接器、本人账号实际权限和授权结果。

Vault 加密保存凭证，并按工作区设置提供给获准使用的成员和工具。加密存储不能代替权限控制：具有凭证访问权限的 Agent 可以使用相应能力，管理员需要了解并管理这一范围。实现与验证范围见 [Vault 说明](docs/Vault产品方案与实施-20261108.md) 和 [通用连接器记录](docs/通用连接器实施与验收-20261108.md)。

## 支持的 Agent

DuolaWork 连接已有 Agent 的运行环境；各平台的账号、订阅或模型需自行准备。

| Agent / 运行方式 | 接入方式 | 使用前需要知道 |
| --- | --- | --- |
| **Codex** | 原项目、原工作会话连接 | 已有原生往返记录；不同客户端版本仍需分别核验。 |
| **Claude Code** | 原环境插件与 Monitor 接收 | 需平台允许加载插件；首次接入可能需要 reload。 |
| **DeepSeek Harness / Antigravity** | 官方桌面 Host 等适配 | 具体桌面、CLI 与远端形态的支持范围分别记录，不推断所有 Host 和版本通用。 |
| **Grok / ChatGPT Work（Dot）** | 官方 Routine / Events 接收 | 平台受理、Agent 领取与实际回复分别记录；第三方平台可能延迟。 |

接入与历史验证见 [Agent 接入记录](Agent接入/03-实现状态与验收记录.md)、[原生接收稳定性记录](docs/原生接收稳定性修复-20261109.md)。这些记录说明特定版本和环境的验证范围，不代表所有账号、平台或并发规模都已验收。

## 它在哪里运行

桌面工作台通过本地网关连接协作服务。Agent 可以在本机、自己的远端环境或官方平台工作；共享的群消息、资料和协作状态存放在你配置的服务中。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/duolawork-architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture/duolawork-architecture-light.svg">
  <img alt="DuolaWork 系统架构拓扑与异构 Agent 运行时" src="docs/assets/architecture/duolawork-architecture-light.svg" width="100%">
</picture>

自建 Node.js 服务复用协作接口，使用 SQLite 与文件对象目录；仓库也保留 Cloudflare Worker / D1 实现。「本地优先」不表示所有数据都只在本机：共享数据的位置由部署决定，Agent 和连接器还会使用各自平台。

<details>
<summary>仓库结构与实现入口</summary>

```text
desktop/              Electron 桌面进程与图标
ui/conversation/      群聊、协作空间与连接管理界面
local/                本地网关、运行端接收与会话调度
connectors/           分发的接收组件与运行时
cloud/collaboration/  协作接口、状态与存储逻辑
server/               独立 Node.js / SQLite 服务
shared/               连接器目录、授权等共享逻辑
docs/                 设计说明、接入和实施记录
tests/                自动化测试与专项验证脚本
```

</details>

## 开始使用

需要 **Node.js 24+、npm**、自己的 Agent 账号及运行环境。以下桌面步骤以 macOS 为例；浏览器适配还需要完整 Chrome。首次安装需要联网下载依赖及 Electron 二进制。

**先配置自己的协作服务，再启动客户端。** 当前没有免服务配置的一键演示环境，也没有内置共享账号或模型密钥。

### 1. 获取源码并构建

```sh
git clone https://github.com/duolaAmengweb3/duolawork.git
cd duolawork
npm ci
npm run build
```

### 2. 准备协作服务和独立资料目录

按 [自建服务说明](server/README.md) 配置自己的 HTTPS 域名、数据库、对象存储与管理密钥。服务构建与运行入口：

```sh
node scripts/build-server.mjs
HUB_SERVER_CONFIG=/private/path/server.json node release/server/main.mjs
```

服务配置文件位于仓库之外。部署、反向代理、备份与恢复要求见上述说明。

创建客户端目录 `~/.local/share/duolawork-dev`，在其中保存 `config.json`，将占位值替换为自己的服务配置：

```json
{
  "endpoint": "https://hub.example.com",
  "adminKey": "REPLACE_WITH_YOUR_SERVER_ADMIN_KEY",
  "port": 18766,
  "runnerId": "duolawork-dev"
}
```

```sh
chmod 600 ~/.local/share/duolawork-dev/config.json
```

### 3. 打开工作台并接入 Agent

```sh
AGENT_HUB_DATA_DIR="$HOME/.local/share/duolawork-dev" npm run desktop
```

独立目录用于本次 Electron 资料和本地配置，避免复用日常安装的工作区。打开「成员与连接」，按原平台指引接入；为聊天选择对应项目与工作会话，完成一次实际领取与回传，再开始安排工作。

<details>
<summary>首次下载 Electron 遇到代理问题</summary>

若已设置 `HTTP_PROXY` / `HTTPS_PROXY`，但 Electron 下载仍失败，可在支持 `--use-env-proxy` 的 Node.js 中运行：

```sh
node --use-env-proxy node_modules/electron/install.js
```

这让本次下载使用现有环境代理，不需要修改系统代理。

</details>

## 当前边界

- **部署**：当前独立实例以单工作区为单位；SQLite 为单个主节点存储。多租户、横向扩容和商业规模容量尚不能由现有部署推定。
- **桌面端**：主要验证 macOS，目前不提供已公证的公开桌面安装包；不将构建脚本存在视为 Windows / Linux 桌面体验已验收。
- **Agent 执行**：受原平台登录、权限、工具及可用性影响；接通工具或送达通知不等于完整工作已经完成。
- **结果质量**：版本与回执帮助核对输入和过程，事实正确性、代码质量和测试结果仍需要实际审阅与验证。
- **共享记忆**：显式保存的共同记录，不等于读取所有原 Agent 私有记忆，也不等于已交付自动语义学习。

## 开发与贡献

```sh
npm run typecheck
npm test
```

欢迎用 [Issue](https://github.com/duolaAmengweb3/duolawork/issues) 描述真实场景、复现步骤和使用环境，或用 Pull Request 提交改进。专项验证脚本见 `package.json`；协议、界面测试与真实原生 Agent 验证应分别报告。

本页两张产品图取自实际运行窗口，未使用旧 Agent Hub 设计预览或测试夹具作为当前产品图。品牌使用已定稿的「回应口」Logo；源码机制图单独标注。

## 许可证

本项目采用 **[DuolaWork Source-Available License 1.0](LICENSE)**，属于带使用条件的源码可用许可。

| 场景 | 授权方式 |
| --- | --- |
| 个人使用；企业内部自用、修改和自建，包括内部生产部署 | 免费，不按人数、收入、实例数或部署规模收费。 |
| 内部使用 Agent 为客户制作报告、内容或其他独立业务成果 | 允许；交付这些成果本身不等于向客户提供 DuolaWork 软件服务。 |
| 对外转售、套壳分发、提供托管 / SaaS，或通过 API 向外提供软件功能 | 需要另行取得书面商业授权；改名或免费提供不自动成为内部使用。 |
| 非商业源码评审、研究和贡献补丁 | 可按 LICENSE 第 4 条共享源码 fork 和补丁。 |

它不是 MIT、ELv2、BSL 或 OSI 认可的开源许可，也没有约定未来自动转为开源。现有文件的权利以许可证为准；第三方组件、素材和原平台服务继续适用各自条款，已有效授予的旧版本许可不被追溯撤销。

商业授权与合作请通过 [项目 Issue](https://github.com/duolaAmengweb3/duolawork/issues) 或 [@hunterweb303](https://x.com/hunterweb303) 联系维护者。
