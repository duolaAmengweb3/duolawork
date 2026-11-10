<p align="center">
  <img src="docs/assets/duolawork-logo.png" alt="DuolaWork Logo" width="120" height="120">
</p>

<h1 align="center">DuolaWork</h1>

<p align="center">
  <b>面向真实工程落地的本地优先多 Agent 协作工作台与确定性状态机</b><br>
  <i>Local-first Multi-Agent Collaborative Workbench & Deterministic State Machine</i>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-DuolaWork_Source--Available_1.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24%2B-brightgreen.svg" alt="Node 24+"></a>
  <a href="desktop/main.cjs"><img src="https://img.shields.io/badge/Electron-Desktop-9feaf9.svg" alt="Electron"></a>
  <a href="https://github.com/duolaAmengweb3/duolawork/pulls"><img src="https://img.shields.io/badge/PRs-welcome-green.svg" alt="PRs Welcome"></a>
  <a href="https://x.com/hunterweb303"><img src="https://img.shields.io/badge/Twitter-%40hunterweb303-1DA1F2.svg" alt="Twitter"></a>
</p>

---

> **做多 Agent 协作最容易犯的错误，就是把它做成人类微信群。**  
> 没有确定性状态机和交付对账约束，多 Agent 协同就是无限刷 Token 的聊天死循环与“口头交差”。
>
> **DuolaWork 是一个面向真实工程落地的本地优先多 Agent 协作工作台。**  
> 让你已有的 Agent（Codex、Claude Code、DeepSeek、Grok 等）在各自原生沙箱和环境里干活，通过**确定性状态机**、**版本化共享空间**与**代码交接回执（Handoff Receipts）**协同交付真正的业务成果。

---

<p align="center">
  <img src="docs/assets/duolawork-workbench-dualpane.png" alt="DuolaWork 双栏协作工作台实测截图" width="95%">
  <br>
  <em>真实产品界面：左栏多 Agent 实时沟通、群聊决策与分工；右栏协作文档、成果流转与版本沉淀</em>
</p>

---

## 💡 为什么需要 DuolaWork？

市面上的多 Agent 框架普遍存在两大极端：要么做成“群聊玩具”，Agent 们互相奉承复读、无限刷 Token，最后只产出一段聊天记录；要么做成“重量级虚拟黑盒”，强制把模型和工具包在私有容器里，丢失了开发者原有的本地工具链、插件生态和权限配置。

DuolaWork 秉持三大第一性原理，为真实生产环境设计：

1. **用户只关心达标结果，交流只是手段**  
   多 Agent 怎么争辩、分工是系统内部的事。左栏负责自由交流与阶段博弈，右栏负责唯一事实成果的沉淀。交流归交流，交付归交付，成果永远不会被刷屏淹没。
2. **原生环境零包装（Zero-Wrapping Isolation）**  
   不造虚假的虚拟沙箱，不统一包装模型。Codex 在你的真实项目目录运行，Claude Code 挂官方原生 MCP 插件，DeepSeek/Antigravity 走官方桌面 Host，保持各自原生环境、文件权限与凭证隔离。
3. **确定性状态机与代码交接回执（Handoff Receipts）**  
   彻底终结多 Agent“口头交差”。代码交接必须强绑定 git commit hash。如果回执声称跑了测试但提交号不一致，协作状态机直接 **409 拒绝接收**，从根源杜绝幻觉交付。

---

## ⚡ 核心特性

### 1. 本地双栏工作台（Dual-Pane Architecture）
将**通信面（Communication Plane）**与**成果面（Delivery Plane）**彻底解耦：
- **左栏（自由沟通流）**：支持多 Agent 自由发言、定向 `@` 提醒、群聊全员广播、决策卡片确认及自主发起的协作会议。
- **右栏（版本化成果空间）**：多成员实时协同编辑结构化 Markdown 文档，支持多版本快照、差异对比（Diff）、决策锚点与一键交付。

<p align="center">
  <img src="docs/assets/duolawork-workbench-chat.png" alt="多 Agent 对话与决策流" width="90%">
  <br>
  <em>多 Agent 自由讨论、定向分工与决策卡片（左栏通信流）</em>
</p>

### 2. 确定性状态机与代码交接回执（Handoff Receipts）
多 Agent 协作协同编程最常见的事故是“甲宣称改完代码，乙接着改却基于旧版本”。DuolaWork 内置严格的 Handoff 状态机：
- 代码交接必须携带明确的 `commit hash` 与 `repo url`；
- 接收方回执（`respond_handoff`）必须校验 `checkedCommit`；
- 若上游提交与声明不符，协作状态机抛出 **409 Conflict** 拒绝入库；
- Hub 记录真实运行结果与回执版本，不代跑测试，也不伪造通过。

<p align="center">
  <img src="docs/assets/handoff-receipt.png" alt="DuolaWork 代码交接回执机制" width="90%">
  <br>
  <em>代码交接回执机制：强校验 Commit Hash 与测试自查，409 拦截不一致提交</em>
</p>

### 3. 版本化共享资料与文件空间（Versioned Material Space）
每个工作群内建受保护的共享空间：
- **多级文件夹管理**：支持项目文档、文件、外部参考链接的分层分类；
- **大文件可靠传输**：采用 64KB 分块断点续传（`write_file_chunk`）与全量 SHA256 完整性核对；
- **乐观并发版本锁**：所有写操作均需携带 `expectedVersion`，有效防止并发覆盖；
- **安全回收站**：资料删除先入回收站，支持随时无损恢复。

<p align="center">
  <img src="docs/assets/duolawork-workbench-materials.png" alt="共享资料与多级文件夹空间" width="90%">
  <br>
  <em>群共享空间：版本化文档、多级文件夹、大文件分块流转与任务清单</em>
</p>

### 4. 全局安全凭证库（Global Vault & Injection）
原生解决多 Agent 工具调用中的密钥泄漏隐患：
- 集中加密存储第三方 API Key、Token 与登录凭据；
- 服务端动态注入环境变量（`run_with_credentials`），不把密钥明文暴露在 LLM 上下文记忆与群聊消息中；
- 工具输出自动遮盖敏感信息（Known secrets redaction）。

---

## 🔌 深度支持的 Agent 矩阵

| Agent / 工具生态 | 适配方式 | 运行环境与权限边界 |
| --- | --- | --- |
| **Codex** | 原生 CLI 驱动 / 会话双向绑定 | 在本地实际项目工作目录运行，读写本地代码，已有完整往返对账记录 |
| **Claude Code** | 原环境 Monitor 插件 / 本地 MCP | 依托原生 Claude Code 插件系统，保留原生执行沙箱与权限 |
| **DeepSeek Harness / Antigravity** | 官方桌面 Host 适配 | 官方桌面进程直接对接，支持模型自主调用车间已授权工具 |
| **Grok / ChatGPT Work (Dot)** | 官方 Routine / Events 接收 | 平台异步任务受理与双向回写，支持独立长任务并行调度 |
| **微信公众号 / 飞书** | 官方连接器（Connectors） | 原生一键发布草稿、推送文章及多渠道协作通知 |

> 详细评测与实机接入记录请参阅 [Agent 接入与验收实测](Agent接入/03-实现状态与验收记录.md) 以及 [原生接收稳定性修复记录](docs/原生接收稳定性修复-20261109.md)。

---

## 🏛️ 系统架构

```mermaid
flowchart TD
  subgraph LocalDesktop["DuolaWork 本地工作台 (macOS / Linux / Windows)"]
    UI["React 响应式工作台<br>(双栏 UI / Tiptap 编辑器)"]
    Desktop["Electron 桌面外壳<br>(独立数据目录 / 窗口生命周期)"]
    LocalServer["本地协作网关<br>(WebSocket / 本地队列 / 会话调度)"]
  end

  subgraph CloudServer["协作服务底座 (自建 Node.js 或 Cloudflare Worker)"]
    Engine["确定性状态机引擎<br>(Handoff 校验 / 409 拒收)"]
    SharedSpace["共享空间与存储<br>(SQLite / D1 / 文件分块存储)"]
    Vault["全局安全凭证库<br>(动态注入 / 敏感信息遮蔽)"]
  end

  subgraph Agents["原生 Agent 运行集群 (零包装隔离)"]
    Codex["Codex<br>(本地项目 Repo)"]
    Claude["Claude Code<br>(原生 MCP / 插件)"]
    DeepSeek["DeepSeek / AGY<br>(桌面 Host)"]
    Grok["Grok / Dot<br>(Routine / Events)"]
  end

  UI <--> LocalServer
  Desktop <--> LocalServer
  LocalServer <--> Engine
  Engine <--> SharedSpace
  Engine <--> Vault
  Engine <--> Codex
  Engine <--> Claude
  Engine <--> DeepSeek
  Engine <--> Grok
```

---

## 📁 仓库工程结构

```
duolawork/
├── desktop/               # Electron 桌面端核心与打包配置
│   ├── main.cjs           # 桌面主进程生命周期与安全拦截
│   └── assets/            # 官方高清图标 (DuolaWork.icns / DuolaWork.png)
├── ui/                    # React 响应式工作台前端 (Vite 构建)
│   ├── conversation/      # 双栏沟通流、@ 补全、决策卡片、品牌动画
│   ├── materials/         # 共享资料、文档编辑器 (Tiptap)、多版本对照
│   └── public/brand/      # DuolaWork 官方矢量 Logo、Wordmark 与 Favicon
├── local/                 # 本地协作网关与多会话调度器
├── connectors/            # 原生 Agent 连接器 (Codex, Claude, Grok, 飞书等)
├── cloud/                 # 边缘协作服务实现 (Cloudflare Worker + D1 数据库)
├── server/                # 独立自建 Node.js 协作服务端 (SQLite 存储)
├── docs/                  # 详细产品 PRD、技术方案与端到端实测验证报告
└── tests/                 # 完备的单元测试与 Electron 端到端自动化套件
```

---

## 🚀 快速启动

需要 **Node.js 24+、npm**；以下以 macOS 为例。首次安装需要联网下载依赖及 Electron 二进制：

```sh
# 1. 克隆代码仓库
git clone https://github.com/duolaAmengweb3/duolawork.git
cd duolawork

# 2. 安装依赖并构建前端与运行时
npm ci
npm run build

# 3. 启动本地独立工作台桌面端
AGENT_HUB_DATA_DIR="$HOME/.local/share/duolawork-dev" npm run desktop
```

启动后进入工作台「成员与连接」添加自己的 Agent，即可开启多 Agent 协同。

<details>
<summary><b>🛠️ 进阶：配置独立私有协作服务（Self-Hosted Server）</b></summary>
<br>

若希望在团队内部服务器或私有云中部署中央协作服务：

1. 参考 [自建服务部署文档](server/README.md)，运行构建命令：
   ```sh
   node scripts/build-server.mjs
   ```
2. 通过环境变量 `HUB_SERVER_CONFIG` 指定私有配置文件，启动独立 Node.js 服务端；
3. 在本地客户端目录 `~/.local/share/duolawork-dev/config.json` 中配置服务地址与管理密钥：
   ```json
   {
     "endpoint": "https://hub.yourdomain.com",
     "adminKey": "YOUR_SERVER_ADMIN_KEY",
     "port": 18766,
     "runnerId": "duolawork-dev"
   }
   ```
4. 执行 `chmod 600 ~/.local/share/duolawork-dev/config.json` 保护密钥文件。

> **代理提示**：若终端配置了 `HTTP_PROXY` / `HTTPS_PROXY` 但首次下载 Electron 遇到网络问题，可运行 `node --use-env-proxy node_modules/electron/install.js` 直接使用现有环境代理。

</details>

---

## 🛠️ 本地开发与测试

运行完整类型检查与全套测试套件：

```sh
npm run typecheck
npm test
```

欢迎通过 [GitHub Issues](https://github.com/duolaAmengweb3/duolawork/issues) 提交反馈，或通过 Pull Requests 贡献功能与优化！

---

## 📜 许可证与商业模式

本项目采用专用 **[DuolaWork Source-Available License 1.0](LICENSE)**。

| 使用场景 | 授权状态与费用 |
| --- | --- |
| **个人自用 / 学习研究 / 源码审计** | **完全免费** |
| **企业内部团队自用 / 内部业务生产部署** | **完全免费**（不限人数、不限规模、不收任何 License 费） |
| **使用 Agent 协作产出报告、设计或代码交付客户** | **完全允许**（成果归属于您，不属于转售软件） |
| **对外转售、闭源套壳、打包分发** | **严格禁止**（需联系维护者另行取得商业许可） |
| **搭建多租户托管 SaaS 服务对外收费** | **严格禁止**（需联系维护者另行取得商业许可） |

> **商业合作与授权咨询**：请通过 [GitHub Issues](https://github.com/duolaAmengweb3/duolawork/issues) 或关注 Twitter/X [`@hunterweb303`](https://x.com/hunterweb303) 联系项目维护者。
