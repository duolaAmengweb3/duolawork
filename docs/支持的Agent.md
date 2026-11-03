# Agent 接入清单与验收状态

> **11月3日维护入口已统一：** 后续接入研发从 [Agent接入/README.md](../Agent接入/README.md) 开始，工程路线、开源依据、Grok 已有实现和真实验收均在同一文件夹维护，不再重开相互冲突的方案。Codex 官方 App Server 与 Gemini 官方 Antigravity ACP 1.4.5 已在安装版通过真实回群、原生文件读写和完整重开续接，默认完整授权、可选权限管理；原 IDE 会话与全局设置独立。具体场景及速度见[验收记录](../Agent接入/03-实现状态与验收记录.md)。下文其他品牌仍是逐家适配目标，不因本次结果一并变成已支持。

## 2026-11-02 当前范围：Personal Agent 与 Coding Agent 混编

所有者本轮明确：不再限定 Personal Agent；Coding Agent 是正式场景，国内外都覆盖。默认接入体验是用户复制一段带短时配对码的 Skill，由原 Agent 自己完成接入、配置和验证。此决定取代 10 月 28—30 日“先只做个人 Agent”的范围限制；不恢复已废弃的固定步骤编排。

**下面是明确的产品适配目标，不是全部已可用的宣传清单。** 对外“已支持”必须依据当前产品的真实往返记录；支持 CLI 不等于已接管用户某个 IDE 窗口，也不等于更换成该品牌的模型 API。

| 类别 | 明确进入适配与验收的产品 | 主接法 | 当前工程状态 |
|---|---|---|---|
| 海外 Coding Agent | Codex、Claude Code、Gemini CLI、Cursor CLI、OpenCode、GitHub Copilot CLI | 官方 CLI / SDK / 会话服务；保留各自登录、模型、工具和会话 | 已有历史接口研究及有限旧测试；当前自由群聊版的持续会话与自动协作尚未整组验收 |
| 国内 Coding Agent | Kimi Code CLI、Qwen Code、CodeBuddy Code、Qoder CLI | 官方 CLI / SDK；支持时采用原生会话协议，避免操作 IDE 页面 | Kimi 已有前轮研究；本轮补核 Qwen/Qoder 的官方非交互与 MCP 文档、CodeBuddy 官方资料。未冒充真实账号测试通过 |
| 海外 Personal Agent | Grok Bot、ChatGPT Dot、Muse、Perplexity Computer、OpenClaw、Hermes | 各平台原生事件、Webhook、SDK 或服务接口 | Dot 与 Grok 账号 Automation 已做真实协作；指定原生 Bot「Duola2号」也已通过唤醒自检、普通群聊、连续追问及向 Dot 发起 @ 并收到回复。其余逐家验收，不混称全部已接通 |
| 国内 Personal Agent | WorkBuddy、千问办公 QwenWork | 官方连接器与后台任务；依能力选择事件或检查机制 | 有官方路线研究，尚未完成当前产品的真实账号验收 |

补充候选：Devin、Jules、Manus 等云端执行产品继续保留在接口台账中；需分别核实账户/API用量与产品权益，不能假定网页订阅包含外部调用。TRAE IDE、Antigravity、Cursor IDE 等现有界面会话单列核验，不用“能加 MCP”或“同品牌 CLI 能跑”直接推成可在后台接收消息。

### 当前实测与未通过项

- **11月3日真实新成员验收通过：** 独立新 Bot「Hub 首次接入验收」仅发送一次 Skill，自行配对和创建接收器；默认页填一次平台信息后自动验证，群聊、追问及软件重开后继续回群均通过。没有用开发者管理接口代配，原 Grok2/Dot 未重建。首次自检约68秒、群聊首句68.468秒、追问17.033秒、重开后82.436秒；不承诺秒回，也不代表其他17个目标均已验收。

- **11月3日默认接入更新：** 新增成员后直接显示接入页。用户复制一段 Skill 发给原 Agent；Grok 创建自己的接收例程后，主动把准确名称和“需要本人确认”状态回报到 Hub。默认页直接提供桌面版入口、步骤和 URL/密钥安全输入框，保存后自动启动真实往返验证，不必进入高级配置或另找测试按钮。失败可在同页修正重试；只有原成员正确回传才显示已接入。其他平台继续按各自原生接法报告进度，不套用 Grok 表单。

- 18家是明确适配目标，不是18家全量支持。国内外 Coding 都进入产品目录；当前通用协议的 Codex/Qwen fixture 不能替代原 CLI 的真实验收。
- Duola2号已通过原生 Routine 唤醒及真实成员回传。此前“没有接收地址/密钥”的判断是检查了不提供这些字段的网页入口；官方 Grok Bot 桌面版 0.78.1 的例程面板实际提供 URL 与发送密钥。Hub 同时修复了漏放行 `api2.cursor.sh/automations/webhook/<id>` 的问题。没有使用 grok1 的账号 Automation 顶替，也未改成定时模型空跑。
- 本轮新 Bot 的普通消息到回群为26.506秒，连续追问14.625秒；它结构化 @Dot 后，Dot 在252.917秒后回到同一群。没有人工转述。少量样本不是稳定性能或P95承诺，原生首次唤醒时延 Issue #23 仍开放。新 Bot 的长任务、自身全部工具、重启后的原生会话继承仍须单独验收。
- 只能用户在平台面板取得的配置，当前仍可能需要一次平台操作；不能宣传所有目标都已达到一段话全自动接入。产品会在同一入口呈现具体卡点，不让用户猜是否就绪。

### Grok 原生接入的源码核对结果

逐文件核对了 [botline 的原生 Grok Bot 配方](https://github.com/sabotage-dev/botline/blob/c27a93b5177cf3c057ae84463b12df586eb710ab/docs/recipes/grokbot.md)、[Webhook 适配器](https://github.com/sabotage-dev/botline/blob/c27a93b5177cf3c057ae84463b12df586eb710ab/src/adapters/grokbot_webhook.ts)，以及 [Paperclip 的 Grok 桌面版接入界面](https://github.com/paperclipai/paperclip/blob/8ea240218dc1d3a94afea1294b377021045dd9c9/ui/src/components/new-agent/GrokBotSetupContent.tsx) 和对应服务端发送实现。两家都使用指定 Bot 的原生 Routine，而非模型 API；首次从官方桌面面板取得 URL/key，并不靠 Bot 的 create-routine 工具返回密钥。HTTP200仅表示受理，仍须原成员自行领取、回应。

Hub 借鉴其原生唤醒方法，保留自己的成员配对、群聊与共享工具。默认一段 Skill 完成能由 Agent 执行的配置；Grok 首次把本人可见的 URL 与发送密钥填到默认页，属于一次性操作，不能宣传成完全无需本人操作。多个同类 Bot 的私有凭证按 Hub 地址与成员 ID 分开，不能共用一个全局令牌文件。后续复用既有配置，不按群或每次聊天重新建立例程。

### 通用性落实在哪里

- **一个用户入口：** 选具体 Agent，复制接入 Skill；命令、地址、接收参数和自检由 Agent 与 Hub 处理。默认不再摊出四步技术表单，保留高级入口处理平台明确要求的授权。
- **一套协作能力：** 持续群聊、定向 @、共享文档、事项、会议及资料访问，对 Personal 与 Coding Agent 一致。谁负责、如何分工由用户与 Agent 决定，不按产品类别写死岗位。
- **可替换适配器：** 平台差异放在启动/唤醒、会话续接、进度与结果、取消/恢复中；每位成员只有一条生效执行通道，不因超时偷偷换模型或重发到另一个入口。
- **Coding Agent 的完整能力：** 沿用用户原订阅或已配置服务、原技能/MCP、仓库和明确绑定的会话。多人改代码默认各自工作区，交换改动和验证结果，不让互相覆盖成为协作机制。不能把新增 CLI 会话宣称为继承了旧 IDE 的全部聊天。
- **同类多个成员：** 同品牌多个 Agent、多个账号和不同品牌混编都进入设计；凭证、会话、工作区和运行状态各自绑定。共享账号的额度及资源限制按实际平台计算，不虚构独立额度。

### 同一份验收口径

每家分别记录：① 身份配对与一次真实工具调用；② 从 Hub 发消息到正确原 Agent 被唤醒并回群；③ 同会话追问和双向 @；④ 使用自身工具完成真实任务并交回完整产物；⑤ 重启后保留登录和会话，断线/重复消息不重复执行。Coding 另验仓库修改、测试结果与工作区隔离。五项通过前，不把“已配对”或“命令可运行”展示成完整支持。

### 本轮核对依据

- 既有研究：[Codex 原生范围核验](../collab/codex/2026-10-28-原生接入范围核验.md)、[Claude 通用接入方案](../collab/claude/通用接入方案.md)、[竞品源码拆解](../collab/claude/2026-10-28-竞品实现拆解与复用清单.md)。这些是研究或历史测试，不能替代当前实现验收。
- [Qwen Code 非交互与会话续接](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)、[Qwen MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/)。
- [Kimi Code 命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)、[会话](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)。
- [CodeBuddy Code 官方实践](https://www.codebuddy.ai/docs/cli/best-practices)；本轮搜索索引可读，页面直读返回502，具体参数仍需继续核对。
- [Qoder CLI 参数与会话](https://docs.qoder.com/cli/cli-reference)、[Qoder MCP](https://docs.qoder.com/cli/mcp-servers)。
- [Cursor CLI](https://cursor.com/docs/cli/overview)；逐版本核对，不混用旧版 cursor-agent 与新版 agent 命令。

---

## 历史调研档案（下面旧的范围与优先级不覆盖本轮决定）

> **2026-10-28 更新：本文保留历史调研，不能当作“已支持”白名单。** 最新逐家能力、原生接入限制和实际测试见 [Codex 原生接入范围核验](../collab/codex/2026-10-28-原生接入范围核验.md)。旧文关于 Dots 只能 Slack、WorkBuddy/千问缺少官方组合依据、Kimi 只有 Code 支持 MCP 等结论需要按新证据更正；本项目尚未完成商业云端 Agent 原生自动接力验收。

- 日期：2026-10-26
- 方法：先摸底，再逐家对照官方文档。**"官方确认"= 读过官方页面原文；"第三方"= 只有博客、教程或评测的说法；"你确认"= 你在自己账号里确认过。**
- 本轮 v0.5 已选择客户端管理普通完整浏览器 + 独立资料目录 + 云端工作台，后做托管，不以指纹浏览器为前提。P0 对所有已适配平台支持同类多成员、多账号及混合团队；Grok/Muse 和“10+10”仅是用户举例，不限定接入品牌或数量。本文旧分档只是线索，当前决定见 PRD v0.5 与验证文档第 11—13 节；新平台须适配和验证，资料隔离不自动获得原生多 Agent 或额外额度。

## 关键结论

**标准 MCP 能复用工具接口，但不能自动解决主动开工、后台权限和结果回传。** 每个平台需要验证：原生工具及认证、当前账号的官方触发入口；没有合适入口时实现本地浏览器适配器并验证发送和完整结果采集。支持自定义 MCP 不等于已经支持自动接力。

## 2026-10-27 补充：Muse 接入 Hermes 的开源实现

结论：有参考价值，尤其是官方 Gadget SDK 的消息通道。Muse 应优先验证原生消息发送、事件订阅这条路径；浏览器保留为备选。以下是源码和文档核查，不是本产品的真实账号联测结果。用户提到的评论没有提供链接，不能声称已确认评论具体指哪一个仓库。

| 项目与核查版本 | 实际实现 | 对 Agent Hub 的意义 |
|---|---|---|
| [www222fff/muse2api](https://github.com/www222fff/muse2api/tree/618aeb0d569e71a8e57d3e4724015b0e18d3ac03) | FastAPI 对外提供 OpenAI 兼容接口；browser 驱动用 Chromium/CDP 操作 muse.ai，导入账号 Cookie，发送输入并轮询页面回复。直接 HTTP 驱动仍返回 501；默认是 mock；README 明确真实账号待测 | 可参考账号租用、会话绑定、限流和错误分类；不能拿 mock 测试证明 Muse 真实可用 |
| [uezo/muse-proxy](https://github.com/uezo/muse-proxy/tree/627fbfbee3593a54862122eb50ff28c299b5836f) | 依赖 Meta 官方 Muse Gadget SDK，使用已配对的设备身份，经 WebSocket/Noise 连接 Muse；发送消息并订阅原生进度、回复和任务状态；对外包装成 Chat Completions | 与调用账号里的 Muse 更接近，值得优先验证；可以直接借鉴消息通道，无需为了 Hub 再套一层模型接口 |
| [evangit2/muse-sub-proxy](https://github.com/evangit2/muse-sub-proxy/tree/1a45866e1fbec4de3bdb9f795722816cadbb0188) | 单文件 Python，将 Chat Completions 请求转为 `api.meta.ai/v1/responses` 模型请求，使用已有 Meta API 凭证 | 代码更轻，但取得的是模型推理，不能据此宣称取得网页 Muse 的记忆、已连接应用和完整执行环境 |
| [danny-hines/muse-code-bridge](https://github.com/danny-hines/muse-code-bridge/tree/58165874f5b83da80e31c0d91ab8f30f8998101c) | 启动官方 `muse serve`，用结构化会话协议驱动 Muse Code，再通过 MCP 暴露委派、续聊、轮询、取消和批准 | 可参考原生 CLI Agent 适配器；这是 Muse Code，不能混写成网页 Muse。其 Hermes 接入文档明确标记尚未在 Hermes 宿主实测 |

### Hermes 为什么能连

Hermes 支持自定义 OpenAI 兼容端点，配置本地网关的 `base_url`、代理访问密钥和模型别名即可接协议。`muse2api` 没有专门实现一套 Hermes 协作系统。协议兼容也不等于 Hermes 的全部工具流程可用：该仓库把模拟 tool calling 列在 TODO；`uezo/muse-proxy` 则明确不支持客户端传入 tools/functions，不能当成可任意替换 Hermes 主模型的完整工具调用后端。Hub 可以把它视为接收任务、交回成果的原生 Agent 通道，验收目标不同。

### SDK 路线已确认的条件和限制

- [Meta 官方 Linux SDK](https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/README.md) 确认支持程序发送聊天消息、指定 session ID 和订阅通道。首次按官方流程配对需要 SDK Token、Linux + 蓝牙 LE、手机 Muse App；配对后的代理聊天和令牌刷新不再依赖手机或蓝牙。不能直接向 Mac 用户宣传“登录网页就能装好这条 SDK 通道”。
- `uezo/muse-proxy` 的源码调用 `send_chat` / `subscribe_chat`，保留发送回执并区分进度、回复与完成。它发送最后一条用户文本，由 Muse 维护历史和 persona；客户端传入的 model 不会选中另一个 Muse 模型。
- 代理本身是第三方项目，依赖官方 SDK 不等于整个代理经过 Meta 官方认证。SDK 的设备会话是否继承本账号所需的已连接应用、文件能力和授权仍需按任务核实。
- `muse2api` 的浏览器驱动通过回复文本稳定和 Stop 按钮判断结束；源码还会自动拒绝待批准动作。Hub 不能直接套用这两个行为：长任务应依据真实任务结束或明确验收，批准请求应进入确认中心。
- 同一账号的不同 session 是不同任务上下文，不自动获得多个独立原生 Muse、独立额度或互不影响的资源。

### 对当前方案的具体调整建议

接入优先级保持“原生协议 / SDK / 官方 CLI → 已验证连接器 → 网页适配”。对 Muse 新增 SDK 直连验证候选，暂不更改当前运行中的成员就绪状态。最小真实验收是一份账号授权、两轮同会话任务、发送回执与结果关联、原生进度及完成状态、断线后检查原任务而不重复发送，以及完整成果进入 Hub；再核实该任务实际调用了哪些 Muse 原生能力。当前未安装这些代理、未读取用户凭证、未修改登录资料，真实账号可用性仍待验证。

源码依据：[浏览器发送与采集](https://github.com/www222fff/muse2api/blob/618aeb0d569e71a8e57d3e4724015b0e18d3ac03/src/muse2api/drivers/browser/driver.py)、[SDK 消息通道](https://github.com/uezo/muse-proxy/blob/627fbfbee3593a54862122eb50ff28c299b5836f/src/muse_proxy/muse.py)、[代理参数与配对条件](https://github.com/uezo/muse-proxy/blob/627fbfbee3593a54862122eb50ff28c299b5836f/docs/reference.md)、[Hermes 自定义端点官方说明](https://hermes-agent.nousresearch.com/docs/reference/faq)。

## 2026-10-27 补充：币安 Agent

用户要接入的是币安自己的 Agent，候选为 **Binance AI Pro**，不是币安钱包，也不是给其他 Agent 提供交易工具的 Agent OS MCP。

| 核实项 | 当前结论 |
|---|---|
| 官方入口 | `https://ai.binance.com/`，入口由产品维护，不让用户猜地址 |
| 产品能力 | 官方确认可做市场研究、监控、提醒、信号和策略生成；支持模拟盘。当前版本未提供历史回测，自动代码测试不能写成回测 |
| 账号条件 | 使用币安主账号；账号和地区资格仍需在真实账号中验证 |
| 当前免费额度 | 2026-10-19 FAQ：每月 250,000 credits；付费为 19.99 USDC/月、1,000 万 credits。套餐不是接入证明 |
| 原生 Agent 调用接口 | 本轮所查官方文档未找到可从外部派发 AI Pro 对话任务并取回完整结果的公开接口；不能据此断言绝对没有 |
| 自定义连接器 / MCP | 尚未在当前账号内核实 AI Pro 是否能配置 Agent Hub 工具。Binance MCP 文档描述的是其他 Agent 调用币安行情、账户和交易工具，方向不同 |
| 网页现场 | 已通过 Chrome 访问 AI Pro，正常跳转到 `accounts.binance.com` 官方登录页；尚未登录，未发送任务 |
| 当前接入状态 | **待登录验证，未接通。** 不加入“已可用”名单，不创建就绪成员，不拿通用模型 API 代替币安 Agent |

登录后的验收顺序：核实原生聊天和连接器能力；优先验证官方任务触发与成果提交路径。若只能走网页，则单独实现浏览器适配器，用无资金操作的研究任务验证“派发 → 真实运行 → 完整结果 → Hub 验收”。只打开网页、展示回复片段或接通行情 MCP 都不能算通过。浏览器测试使用 Hub 的独立持久资料目录，不复制日常 Chrome 的登录资料。

依据：[当前 AI Pro FAQ（2026-10-19）](https://www.binance.com/en/support/faq/detail/252ea010e543488f87292c1ab27f82b2)、[Binance MCP 文档（2026-10-26 更新）](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic)。旧版 AI Pro Beta 的价格、能力和限制不能直接套用到新版。

---

## 第一档：能接，而且有官方依据（或你已确认）

| Agent | 能接吗（自定义 MCP） | 能被什么叫醒 | 主要限制 | 依据 |
|---|---|---|---|---|
| **Grok Bot**（xAI，由 Cursor 提供） | 你确认能加 | 定时（最短 5 分钟）、Slack、**webhook**（官方确认） | 长时间不理会，定时任务会被暂停 | 官方 + 你确认 |
| **ChatGPT Dots**（OpenAI） | 你确认能加 | 定时；Slack 里 @它（第三方） | 官方帮助页打不开，叫醒方式待实测；Pro、Business Premium 才有 | 你确认 + 第三方 |
| **Gemini Tasks**（原 Spark，Google） | 官方确认（已连接应用 → 自定义应用） | 定时（最短每小时）、Gmail 邮件触发、话题触发 | **写入必须手动确认**；仅美国、英文；需 AI Pro / Ultra；时间不精确 | 官方 |
| **Perplexity Computer** | **官方确认**：Pro、Max、企业版都能"填 MCP 地址添加自定义连接器"，支持 OAuth、API Key 或无认证 | 能定时运行（"recurring workflows"）；企业版能在 Slack 里被私信、被 @ | 个人版的 Slack 触发未确认；Personal Computer（本地版）还在候补名单 | 官方 |
| **腾讯 WorkBuddy** | **官方确认**：连接器页面右上角"自定义连接器"，"配置方式与 MCP 配置类似" | 定时自动化（第三方教程） | 写入类操作"需您明确指令确认"；个人版 / 企业版是否都有，官方没写 | 官方 + 第三方 |
| **千问办公 QwenWork**（阿里） | 第三方教程：连接器页有"自定义 MCP"；官方页面写了定时任务"可以调用 MCP 工具、使用连接器" | 定时任务（不重复、间隔、每小时、每天、每周、每月） | **定时任务由电脑客户端调度，电脑睡眠或关机就不执行**；每次执行消耗 Credits | 官方（定时）+ 第三方（自定义 MCP） |
| **OpenClaw**（开源，自己部署） | 能配置 MCP 服务器 | 自带 cron 定时（例子里有每 90 秒）；运行完能往外发 webhook | 需要自己部署和维护；"从外部用 webhook 叫醒"官方页面没写清 | 官方（定时）+ 第三方（MCP） |
| **Hermes Agent**（Nous Research，开源） | 支持 MCP（第三方指南） | 自带 cron（网关每 60 秒检查一次）；事件钩子 | 需要自己部署 | 官方（钩子）+ 第三方 |

## 第二档：大概率能接，但官方没写清，需要实测

| Agent | 情况 | 依据 |
|---|---|---|
| **Meta Muse** | 官方确认能让 Muse 自己搭"自定义连接器"（通过对方的 API）；官方没提 MCP。工作台给它准备普通接口 | 官方 + 第三方 |
| **豆包工作**（字节） | 第三方教程：「技能 · 连接器 · 伙伴」里能新建自定义连接器（名称、传输类型、地址、请求头）；**只能在电脑版用**；定时任务也只在电脑版 | 第三方，没找到官方帮助页 |
| **Kimi**（月之暗面） | Kimi Code 命令行工具支持 MCP 和定时任务；Kimi Agent（网页版）官方页面没提自定义 MCP | 官方 |

## 第三档：目前接不了

| Agent | 原因 | 依据 |
|---|---|---|
| **Instinct** | 只能用短信或电话找它；**没有公开的接口、没有 MCP**，多个来源一致；只能邀请加入 | 第三方（多方一致） |
| **Microsoft Copilot（Cowork）** | 个人版还在预览；没找到自定义 MCP 的资料 | 没找到依据 |
| **智谱 AutoGLM** | 定时任务官方说"即将上线"，自定义 MCP 没找到官方说明 | 没找到依据 |

## 不做（你的决定）

| Agent | 说明 |
|---|---|
| **Claude Duet**（Anthropic） | 2026-10-26 你决定不做。调研记录保留：官方页面写了"能用 6000 多个连接器和插件"，没提自定义连接器；有早期评测说它的定时运行用不了自定义连接器；仅美国 Pro、Max，候补名单 |

---

## 对产品的影响

1. **第一版仍然先做你手上的四家**，但工作台按"任何支持 MCP 的 Agent 都能接"来设计，不为某一家写死。
2. **"成员"页面要能选更多平台**：每个平台一份接入指引、一个默认的叫醒方式、一段限制说明。第一档的平台在第一版就给出接入指引。
3. **国内的三家（千问办公、豆包工作、WorkBuddy）都是电脑客户端**：它们只能靠自己的定时任务来查，而且电脑要开着。工作台要在成员页面明确提示这一点。
4. **对第三档，工作台不做接入**，在添加成员时如实标"暂不支持"，以及原因。

## 来源

官方：
- [xAI：Grok Bot 技能和定时任务](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Google：Gemini Tasks](https://support.google.com/gemini/answer/17094507?hl=en)、[Google：自定义应用](https://support.google.com/gemini/answer/17209137)
- [Perplexity：3 月 13 日更新（自定义 MCP 连接器、Slack）](https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026)
- [腾讯云：WorkBuddy 连接器](https://cloud.tencent.com/document/product/1831/134525)
- [阿里云：千问办公定时任务](https://help.aliyun.com/zh/qwenwork/qwenwork-scheduled-tasks-desktop)
- [OpenClaw：定时自动化](https://docs.openclaw.ai/cli/cron)、[OpenClaw：MCP 事件](https://docs.openclaw.ai/automation/mcp-events)
- [Hermes Agent：事件钩子](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Meta：Muse 连接器](https://www.meta.com/help/artificial-intelligence/1687253048996149/)
- [Anthropic：Claude Duet](https://claude.com/product/claude-duet)
- [Kimi：Agent 概览](https://www.kimi.ai/help/agent/agent-overview)、[Kimi Code 更新日志](https://www.kimi.com/code/docs/kimi-code/whats-new.html)

第三方：
- [Bland：Instinct 集成说明](https://docs.bland.ai/integrations/mcp/instinct)、[Crosswalk：Instinct](https://crosswalk.to/agents/instinct/personal-agent-protocol)、[CellCog：Instinct 是什么](https://cellcog.ai/blog/what-is-instinct-ai/)
- [Superpower Daily：Duet 定时运行用不了自定义连接器](https://superpowerdaily.com/posts/anthropic-opens-claude-duet-preview-for-ai-work-that-keeps-going-between-chats)
- [千问办公小绿书：连接器与 MCP](https://qwenwork.org/docs/features/connector-pages)
- [腾讯云社区：WorkBuddy 使用 MCP](https://developer.cloud.tencent.com/article/2698011)
- [知乎：豆包工作的连接器和 MCP](https://zhuanlan.zhihu.com/p/2083071595309015063)、[知乎：豆包定时任务](https://zhuanlan.zhihu.com/p/2075621426086801506)
- [Apidog：Hermes 与 OpenClaw](https://apidog.com/blog/hermes-agent-vs-openclaw/)
- [IT 之家：AutoGLM 2.0](https://www.ithome.com/0/876/731.htm)
- [Eesel：Perplexity Comet 价格](https://www.eesel.ai/blog/perplexity-comet-pricing)
